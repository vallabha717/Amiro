// Amiro desktop main entry point (Tauri shell over the backend sidecar).
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    amiro_desktop::run();
}
