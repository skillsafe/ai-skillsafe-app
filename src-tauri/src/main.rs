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
        .invoke_handler(tauri::generate_handler![create_symlink, remove_if_symlink])
        .run(tauri::generate_context!())
        .expect("error while running skillsafe");
}
