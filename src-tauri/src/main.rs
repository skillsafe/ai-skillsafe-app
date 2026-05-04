#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
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

    builder = builder.setup(|app| {
        #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
        {
            app.deep_link().register("skillsafe")?;
        }

        let handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
            let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
            let _ = handle.emit("deep-link://new-url", urls);
        });

        Ok(())
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running skillsafe");
}
