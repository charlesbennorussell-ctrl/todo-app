// Desktop binary entry — defers to lib.rs so a future mobile target shares the
// same setup. cfg attribute hides the console window on Windows release builds
// (otherwise the app would launch with an extra terminal popup).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ctrl_project_lib::run()
}
