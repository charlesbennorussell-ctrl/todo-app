// Tauri 2 entry point. Kept intentionally minimal — the entire app lives in
// the React/Vite codebase and is loaded from the hosted URL configured in
// tauri.conf.json. The Rust shell opens the main window and owns one native
// feature: the PIP quick-view — a tall always-on-top window pointed at the
// hosted app with ?pip=1 (the web side renders just the three focus day
// columns there). A global shortcut toggles it; the combo is customizable
// from the web Settings page via the `set_pip_shortcut` command and persists
// in app-config. The app autostarts hidden at login and the main window
// close button hides instead of quitting, so the shortcut keeps working
// without the app being visibly launched.

use std::fs;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const PIP_URL: &str = "https://charlesbennorussell-ctrl.github.io/todo-app/?pip=1";
const PIP_LABEL: &str = "pip";
const PIP_WIDTH: f64 = 1080.0;
// Fallback chain when no saved combo (or the saved one stops working). Note
// Ctrl+Space / Ctrl+Win+Space are grabbed by the Windows IME — avoid them.
const DEFAULT_COMBOS: [&str; 3] = ["ctrl+alt+f", "ctrl+alt+space", "ctrl+shift+space"];

fn shortcut_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("pip-shortcut.txt"))
}

fn saved_shortcut(app: &AppHandle) -> Option<String> {
    let p = shortcut_file(app)?;
    fs::read_to_string(p)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

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
    // First summon — full height (minus a taskbar margin), fixed width sized
    // for the three day columns, centered horizontally. Monitor size is
    // physical pixels; the builder wants logical, so go through to_logical.
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
    match built {
        Ok(win) => {
            // Click-away dismiss: hide whenever the quick window loses focus
            // (clicking anywhere outside it). The web × calls hide() too.
            let w = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = w.hide();
                }
            });
        }
        Err(e) => eprintln!("[pip] failed to create window: {e}"),
    }
}

#[cfg(desktop)]
fn register_first_working<'a>(
    app: &AppHandle,
    combos: impl IntoIterator<Item = &'a str>,
) -> Option<String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let shortcuts = app.global_shortcut();
    for combo in combos {
        match shortcuts.register(combo) {
            Ok(()) => return Some(combo.to_string()),
            Err(e) => eprintln!("[pip] {combo} registration failed: {e}"),
        }
    }
    None
}

// Invoked from the web Settings page. Re-registers the global toggle live and
// persists the combo; on failure restores the previous (or default) binding.
#[tauri::command]
fn set_pip_shortcut(app: AppHandle, combo: String) -> Result<String, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let previous = saved_shortcut(&app);
        let _ = app.global_shortcut().unregister_all();
        match app.global_shortcut().register(combo.as_str()) {
            Ok(()) => {
                if let Some(p) = shortcut_file(&app) {
                    if let Some(dir) = p.parent() {
                        let _ = fs::create_dir_all(dir);
                    }
                    let _ = fs::write(p, &combo);
                }
                Ok(combo)
            }
            Err(e) => {
                let restored = register_first_working(
                    &app,
                    previous.as_deref().into_iter().chain(DEFAULT_COMBOS),
                );
                Err(format!(
                    "could not register {combo}: {e} (kept: {})",
                    restored.unwrap_or_else(|| "none".into())
                ))
            }
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, combo);
        Err("desktop only".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_pip_shortcut])
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{
                    Builder as ShortcutPluginBuilder, ShortcutState,
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
                // Saved combo first, then the fallback chain.
                let saved = saved_shortcut(app.handle());
                match register_first_working(
                    app.handle(),
                    saved.as_deref().into_iter().chain(DEFAULT_COMBOS),
                ) {
                    Some(c) => eprintln!("[pip] toggle shortcut registered: {c}"),
                    None => eprintln!("[pip] no toggle shortcut could be registered"),
                }

                // Background persistence: launch hidden at login and keep
                // running when the main window is closed, so the shortcut
                // works without the app being visibly launched.
                use tauri_plugin_autostart::MacosLauncher;
                let _ = app.handle().plugin(tauri_plugin_autostart::init(
                    MacosLauncher::LaunchAgent,
                    Some(vec!["--hidden"]),
                ));
                {
                    use tauri_plugin_autostart::ManagerExt;
                    let _ = app.autolaunch().enable();
                }
                // Default window size via raw Win32 SetWindowPos — every Tauri/tao sizing
                // path on this machine mis-scales (corrupted DPI bookkeeping: requests land
                // as physical-at-scale-1), and the webview's innerWidth agrees with the
                // REQUEST rather than reality, so closed-loop correction through those
                // sensors is blind. SetWindowPos is physical-in/physical-out (the process is
                // per-monitor-DPI aware): width = the user's measured 1579px, height = the
                // monitor work area ("almost top to bottom"), centered horizontally.
                #[cfg(windows)]
                if let Some(main) = app.get_webview_window("main") {
                    let m2 = main.clone();
                    std::thread::spawn(move || {
                        // Re-assert loop, not a one-shot: the webview's late DPI initialization
                        // re-mangles the window AFTER an early SetWindowPos (measured: config
                        // height x1.5^2, width at scale 1.0 — different axes, different scales).
                        // For the first ~10s, read the TRUE rect (GetWindowRect — raw, unlying)
                        // every 700ms and re-apply the target whenever it drifts. Last word wins.
                        use windows_sys::Win32::Foundation::RECT;
                        use windows_sys::Win32::UI::WindowsAndMessaging::{
                            GetWindowRect, SetWindowPos, SystemParametersInfoW, SPI_GETWORKAREA,
                            SWP_NOZORDER,
                        };
                        // THE ROOT CAUSE, proven by probe: an external DPI-aware process's
                        // SetWindowPos(1579) sticks perfectly, while this process's identical
                        // call lands at 1053 — the OS virtualizes coordinates for non-DPI-aware
                        // processes. Make THIS THREAD per-monitor-aware so every Win32 call
                        // below (workarea, rect reads, sets) speaks raw physical pixels.
                        unsafe {
                            use windows_sys::Win32::UI::HiDpi::{
                                SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
                            };
                            SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(700));
                        let Ok(hwnd) = m2.hwnd() else { return };
                        // ADAPTIVE width request: the DPI layer deterministically re-scales the
                        // width we set (measured: request 1579 → true width 1579/1.5 = 1053,
                        // stable across rounds; height passes through untouched). So correct
                        // the REQUEST by the observed error ratio each round — GetWindowRect is
                        // the truthful sensor — and the mangler itself lands us on target
                        // (ask ~2368, get 1579). Converges in 2 rounds; also self-corrects on
                        // machines with no mangle at all.
                        let mut req_w: f64 = 1579.0;
                        for _ in 0..15 {
                            unsafe {
                                let mut wa = RECT { left: 0, top: 0, right: 1920, bottom: 1040 };
                                SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut wa as *mut RECT as *mut _, 0);
                                let wa_w = wa.right - wa.left;
                                let wa_h = wa.bottom - wa.top;
                                let target_w: i32 = if wa_w < 1579 { wa_w } else { 1579 };
                                let h: i32 = wa_h;
                                let x = wa.left + (wa_w - target_w) / 2;
                                let y = wa.top;
                                let mut cur = RECT { left: 0, top: 0, right: 0, bottom: 0 };
                                GetWindowRect(hwnd.0 as _, &mut cur);
                                let cw = cur.right - cur.left;
                                let ch = cur.bottom - cur.top;
                                if (cw - target_w).abs() > 4 || (ch - h).abs() > 4 || (cur.left - x).abs() > 8 || (cur.top - y).abs() > 8 {
                                    if cw > 0 && (cw - target_w).abs() > 4 {
                                        req_w = (req_w * target_w as f64 / cw as f64).clamp(400.0, 4000.0);
                                    }
                                    SetWindowPos(hwnd.0 as _, std::ptr::null_mut(), x, y, req_w.round() as i32, h, SWP_NOZORDER);
                                }
                            }
                            std::thread::sleep(std::time::Duration::from_millis(700));
                        }
                    });
                }
                if std::env::args().any(|a| a == "--hidden") {
                    if let Some(main) = app.get_webview_window("main") {
                        let _ = main.hide();
                    }
                }
                if let Some(main) = app.get_webview_window("main") {
                    let m = main.clone();
                    main.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = m.hide();
                        }
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
