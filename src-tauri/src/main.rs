#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
use tauri_plugin_deep_link::DeepLinkExt;

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
        .run(tauri::generate_context!())
        .expect("error while running skillsafe");
}
