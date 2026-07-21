// Tauri's pre-build hook: generates the platform-specific bindings + bundles
// the icon assets the cargo build needs. Runs automatically as part of
// `tauri build` / `tauri dev` — you don't invoke it directly.
//
// The app_manifest declares the app's OWN invoke commands so tauri-build
// generates `allow-…` ACL permissions for them. Required because the webview
// content is REMOTE (the hosted site): remote origins get no implicit command
// access, so without this the Settings page's set_pip_shortcut invoke fails
// with "not allowed by ACL". The generated allow-set-pip-shortcut permission
// is granted in capabilities/default.json.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["set_pip_shortcut", "show_main_window", "hide_pip"])),
    )
    .expect("failed to run tauri-build");
}
