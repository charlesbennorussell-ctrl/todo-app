// Tauri 2 entry point. Kept intentionally minimal — the entire app lives in
// the React/Vite codebase and is loaded from the hosted URL configured in
// tauri.conf.json. The Rust shell opens the main window and owns one native
// feature: the PIP quick-view. A global shortcut (Ctrl+Space, falling back to
// Ctrl+Win+Space then Ctrl+Alt+Space if the OS refuses) toggles a tall,
// narrow, always-on-top window pointed at the hosted app with ?pip=1 — the
// web side sees the flag and renders only the daily Dashboard stack.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const PIP_URL: &str = "https://charlesbennorussell-ctrl.github.io/todo-app/?pip=1";
const PIP_LABEL: &str = "pip";
const PIP_WIDTH: f64 = 1080.0;

fn toggle_pip(app: &AppHandle) {
    // Window already exists → toggle visibility. Hidden (not destroyed) so
    // re-summoning is instant and the webview keeps its Liveblocks socket.
    if let Some(win) = app.get_webview_window(PIP_LABEL) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
        return;
    }
    // First summon — size to the primary monitor: full height (minus a small
    // margin so the OS taskbar stays reachable), fixed narrow width, centered
    // horizontally. Monitor size is physical pixels; the builder wants logical,
    // so divide through the scale factor via to_logical.
    let mut width = PIP_WIDTH;
    let mut height = 900.0_f64;
    let mut x = 100.0_f64;
    let mut y = 16.0_f64;
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size().to_logical::<f64>(scale);
        width = PIP_WIDTH.min(size.width * 0.9);
        height = (size.height - 72.0).max(480.0);
        x = ((size.width - width) / 2.0).max(0.0);
        y = 16.0;
    }
    let built = WebviewWindowBuilder::new(
        app,
        PIP_LABEL,
        WebviewUrl::External(PIP_URL.parse().expect("PIP_URL is a valid URL")),
    )
    .title("Ctrl-Project — Focus")
    .inner_size(width, height)
    .position(x, y)
    .always_on_top(true)
    .decorations(false)
    .resizable(true)
    .build();
    if let Err(e) = built {
        eprintln!("[pip] failed to create window: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{
                    Builder as ShortcutPluginBuilder, GlobalShortcutExt, ShortcutState,
                };
                app.handle().plugin(
                    ShortcutPluginBuilder::new()
                        .with_handler(|app, _shortcut, event| {
                            // Fire on press only — the release event would
                            // otherwise immediately re-toggle the window.
                            if event.state() == ShortcutState::Pressed {
                                toggle_pip(app);
                            }
                        })
                        .build(),
                )?;
                // Primary combo: Ctrl+Space (user-confirmed free on their setup).
                // Fallback chain if the OS reserves it: Ctrl+Win+Space, then
                // Ctrl+Alt+Space.
                let shortcuts = app.global_shortcut();
                let combos = ["ctrl+alt+f", "ctrl+alt+space", "ctrl+shift+space"];
                let mut registered = None;
                for combo in combos {
                    match shortcuts.register(combo) {
                        Ok(()) => {
                            registered = Some(combo);
                            break;
                        }
                        Err(e) => eprintln!("[pip] {combo} registration failed: {e}"),
                    }
                }
                match registered {
                    Some(combo) => eprintln!("[pip] toggle shortcut registered: {combo}"),
                    None => eprintln!("[pip] no toggle shortcut could be registered"),
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
