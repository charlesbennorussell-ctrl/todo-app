// Tauri 2 entry point. Kept intentionally minimal — the entire app lives in
// the React/Vite codebase and is loaded from the hosted URL configured in
// tauri.conf.json. The Rust shell only opens a window. Future native features
// (filesystem-backed backups, OS notifications, default-browser link
// handling) can be plumbed in here as Tauri commands or plugins without
// touching the React app.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
