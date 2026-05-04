// Tauri's pre-build hook: generates the platform-specific bindings + bundles
// the icon assets the cargo build needs. Runs automatically as part of
// `tauri build` / `tauri dev` — you don't invoke it directly.
fn main() {
    tauri_build::build()
}
