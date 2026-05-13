#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
use tauri_plugin_deep_link::DeepLinkExt;

// Create a symlink at `link` pointing to `target`. Used to bridge SkillSafe's
// universal `<project>/.agents/skills/<name>` install location to Claude
// Code's required `<project>/.claude/skills/<name>` discovery location, so a
// single project install is picked up by both. `target` may be relative to
// `link`'s parent — callers pass `../../.agents/skills/<name>` so the link
// survives moving/renaming the project root.
#[tauri::command]
fn create_symlink(target: String, link: String) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, &link).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        // symlink_dir requires admin or Developer Mode on Windows; if it
        // fails the caller falls back to leaving the file copy in place,
        // which means Claude Code won't see it but SkillSafe still works.
        std::os::windows::fs::symlink_dir(&target, &link).map_err(|e| e.to_string())
    }
}

// On Linux, reports how the running app was installed so JS can decide
// which update path to take. The `APPIMAGE` env var is set by AppImageKit
// when the AppImage launches itself; its absence on Linux means we're
// running from a system install (.deb / .rpm). Other platforms always
// return "supported".
//
// Routing on Linux:
//   "appimage" → run bundled appimageupdatetool ($APPIMAGE → zsync delta
//      update → atomic rename, prompts user to restart)
//   "system"   → ManualUpdate sentinel → open download page
#[tauri::command]
fn linux_installer_kind() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_some() {
            "appimage"
        } else {
            "system"
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        "supported"
    }
}

// Run `appimageupdatetool` against the currently-running AppImage, then
// relaunch from the on-disk path so the new SquashFS payload is mounted.
//
// The tool reads update info embedded in our AppImage's `.upd_info` ELF
// section (`gh-releases-zsync|skillsafe|ai-skillsafe-app|latest|AI.SkillSafe_*_<arch>.AppImage.zsync`),
// downloads the zsync sidecar, computes the diff against the local file,
// fetches only the changed chunks, writes the new bytes to a temp file
// (`<APPIMAGE>.zs-tmp.*`), and atomically renames it over $APPIMAGE. The
// running FUSE mount keeps serving the old inode until process exit, so
// there's no race during the write.
//
// For relaunch we deliberately do NOT use Tauri's `process::relaunch` (or
// `current_exe()`): those resolve to a path INSIDE the still-mounted old
// SquashFS (e.g. `/tmp/.mount_XXXXX/usr/bin/app`), so the new child would
// re-exec the old bytes. Spawning $APPIMAGE directly (the on-disk path)
// invokes the AppImage runtime, which mounts a fresh SquashFS from the
// updated file at a NEW mount point — picking up the new version.
//
// The tool ships inside our AppImage at `usr/bin/appimageupdatetool` (added
// by the CI post-build step). We try $APPDIR (set by AppImage runtime)
// first so we always use the bundled copy, then fall back to PATH so dev
// runs still work.
//
// Returns Ok with the tool's stdout (so the UI can show "Already on the
// latest version" vs. "Updated to X" hints from zsync2). Rejects with
// stderr+exitcode on failure so the UI can surface real errors (network,
// signature mismatch) instead of a generic "update failed".
#[tauri::command]
fn linux_appimage_update(_app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        let appimage = std::env::var("APPIMAGE")
            .map_err(|_| "$APPIMAGE not set — not running as AppImage".to_string())?;

        // Prefer the bundled copy. AppImage's runtime sets $APPDIR to the
        // mount root; the tool lives at <APPDIR>/usr/bin/appimageupdatetool.
        let tool = if let Some(appdir) = std::env::var_os("APPDIR") {
            let bundled = std::path::PathBuf::from(appdir).join("usr/bin/appimageupdatetool");
            if bundled.exists() {
                bundled.into_os_string()
            } else {
                std::ffi::OsString::from("appimageupdatetool")
            }
        } else {
            std::ffi::OsString::from("appimageupdatetool")
        };

        let output = std::process::Command::new(&tool)
            // `-O` writes back to $APPIMAGE (atomic rename, see above).
            // Without it the tool picks an alongside filename, leaving two
            // AppImages on disk with no automatic swap.
            .args(["-O", &appimage])
            .output()
            .map_err(|e| format!("spawn {}: {}", tool.to_string_lossy(), e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(format!(
                "appimageupdatetool exited {} — {}{}",
                output.status.code().unwrap_or(-1),
                stderr.trim(),
                if stdout.trim().is_empty() {
                    String::new()
                } else {
                    format!(" (stdout: {})", stdout.trim())
                },
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();

        // Spawn the new instance from $APPIMAGE (disk path), detached from
        // this process so it survives our exit. Then schedule a graceful
        // exit via Tauri so plugins shut down cleanly.
        std::process::Command::new(&appimage)
            .spawn()
            .map_err(|e| format!("relaunch from {}: {}", appimage, e))?;
        _app.exit(0);

        Ok(stdout)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = _app;
        Err("AppImage update only applies on Linux".to_string())
    }
}

// Removes `path` only when it is a symlink. Returns true if a symlink was
// removed, false if the path didn't exist or wasn't a symlink. Used during
// Claude project skill uninstall so we never delete a real `.claude/skills/<n>`
// directory the user might have populated themselves.
#[tauri::command]
fn remove_if_symlink(path: String) -> Result<bool, String> {
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.file_type().is_symlink() {
        return Ok(false);
    }
    // On Unix, remove_file unlinks symlinks (including those pointing at
    // directories). On Windows, symlink_dir links are removed via remove_dir.
    #[cfg(unix)]
    {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        std::fs::remove_dir(&path).map_err(|e| e.to_string())?;
    }
    Ok(true)
}

fn main() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Second-launch URL on Linux/Windows arrives as a CLI arg. Forward
            // it to the running instance and bring its window forward so the
            // user sees the install dialog land in their existing session.
            if let Some(url) = args.iter().find(|a| a.starts_with("skillsafe://")) {
                let _ = app.emit("deep-link://new-url", vec![url.clone()]);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
                let _ = w.unminimize();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder = builder.setup(|_app| {
        // Linux: register the URL scheme handler at runtime (macOS/Windows
        // installers wire it up via Info.plist / registry). Debug Windows
        // builds register too so `cargo tauri dev` can test deep links.
        #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
        {
            _app.deep_link().register("skillsafe")?;
        }
        // Note: do NOT call `app.deep_link().on_open_url(...)` here. The plugin
        // itself emits `deep-link://new-url` on every URL delivery path
        // (RunEvent::Opened on macOS, single-launch CLI args on Linux/Windows),
        // and `on_open_url(f)` registers `f` as a listener on that same event.
        // Re-emitting the event from inside `f` made the listener fire itself
        // until the stack guard aborted (SIGABRT, ~14k recursion levels). JS
        // already subscribes via `onOpenUrl()` (see App.tsx) which is a thin
        // wrapper around `listen('deep-link://new-url')`, so URLs reach the
        // frontend through the plugin's own emits without any Rust forwarding.

        Ok(())
    });

    builder
        .invoke_handler(tauri::generate_handler![create_symlink, remove_if_symlink, linux_installer_kind, linux_appimage_update])
        .run(tauri::generate_context!())
        .expect("error while running skillsafe");
}
