#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    // the browser starts us as a native-messaging host with the extension origin as an argument
    if std::env::args().any(|a| a == "--native-host" || a.starts_with("chrome-extension://")) { vault_lib::native_host() } else { vault_lib::run() }
}
