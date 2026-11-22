mod audit;
mod gen;
mod import;
mod otp_import;
mod quick;
mod qr;
mod totp;
mod vault;

use arboard::{Clipboard, SetExtWindows};
use serde::Serialize;
use std::{path::PathBuf, process::{Command, Stdio}, sync::Mutex, time::Duration};
use tauri::{Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use vault::{Item, Session, Settings, KDF};

struct App(Mutex<Option<Session>>);
type St<'a> = State<'a, App>;

const MIN_MASTER: usize = 10;

/// `VAULT_DIR` overrides the folder (tests, scratch copies); default `%APPDATA%\Vault`.
fn vault_dir() -> PathBuf {
    std::env::var_os("VAULT_DIR").map(PathBuf::from)
        .or_else(|| std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Vault")))
        .unwrap_or_else(|| PathBuf::from("Vault"))
}
fn vault_path() -> PathBuf { vault_dir().join("vault.bin") }
fn quick_path() -> PathBuf { vault_dir().join("quick.bin") }

fn with<T>(st: &St, f: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
    f(st.0.lock().unwrap().as_mut().ok_or("vault is locked")?)
}

fn check_master(pw: &str) -> Result<(), String> {
    if pw.chars().count() < MIN_MASTER { return Err(format!("master password needs at least {MIN_MASTER} characters")); }
    Ok(())
}

#[derive(Serialize)]
struct Status { exists: bool, unlocked: bool, quick: bool }

#[derive(Serialize)]
struct Summary { id: String, kind: String, title: String, sub: String, folder: String, favorite: bool, deleted: bool }

#[derive(Serialize)]
struct Code { code: String, left: u64, period: u64 }

#[derive(Serialize)]
struct Strength { bits: f64, level: &'static str }

#[tauri::command]
fn status(st: St) -> Status {
    Status { exists: vault_path().exists(), unlocked: st.0.lock().unwrap().is_some(), quick: quick_path().exists() }
}

// Argon2 takes a few hundred ms: async commands keep it off the UI thread.
#[tauri::command]
async fn create_vault(st: St<'_>, password: String) -> Result<(), String> {
    check_master(&password)?;
    let s = Session::create(&vault_path(), &password, KDF)?;
    *st.0.lock().unwrap() = Some(s);
    Ok(())
}

#[tauri::command]
async fn unlock(st: St<'_>, password: String) -> Result<(), String> {
    let s = Session::open(&vault_path(), &password)?;
    *st.0.lock().unwrap() = Some(s);
    Ok(())
}

fn quick_write(s: &Session) -> Result<(), String> {
    let blob = quick::protect(&s.key()[..])?;
    let tmp = quick_path().with_extension("tmp");
    std::fs::write(&tmp, blob).and_then(|_| std::fs::rename(&tmp, quick_path())).map_err(|e| e.to_string())
}

/// Stay signed in on this PC: needs the vault to be unlocked right now.
#[tauri::command]
fn quick_enable(st: St) -> Result<(), String> { with(&st, |s| quick_write(s)) }

#[tauri::command]
fn quick_disable() -> Result<(), String> {
    match std::fs::remove_file(quick_path()) { Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()), _ => Ok(()) }
}

#[tauri::command]
fn quick_unlock(st: St) -> Result<(), String> {
    let blob = std::fs::read(quick_path()).map_err(|_| "quick unlock is not set up".to_string())?;
    let key = zeroize::Zeroizing::new(quick::unprotect(&blob)?);
    let key: [u8; 32] = key[..].try_into().map_err(|_| "saved key is damaged".to_string())?;
    let s = Session::open_with_key(&vault_path(), &key)?;
    *st.0.lock().unwrap() = Some(s);
    Ok(())
}

#[tauri::command]
fn lock(st: St) { *st.0.lock().unwrap() = None; }

#[tauri::command]
fn list(st: St) -> Result<Vec<Summary>, String> {
    with(&st, |s| Ok(s.data.items.iter().map(|i| {
        let val = |l: &str| i.fields.iter().find(|f| f.label == l).map(|f| f.value.clone()).unwrap_or_default();
        let sub = match i.kind.as_str() {
            "login" => val("Username"),
            "card" => { let n: String = val("Card number").chars().filter(|c| c.is_ascii_digit()).collect(); if n.len() >= 4 { format!("•••• {}", &n[n.len() - 4..]) } else { String::new() } }
            "api" => val("Endpoint"),
            "wifi" => val("Network name"),
            _ => String::new(),
        };
        Summary { id: i.id.clone(), kind: i.kind.clone(), title: i.title.clone(), sub, folder: i.folder.clone(), favorite: i.favorite, deleted: i.deleted > 0 }
    }).collect()))
}

#[tauri::command]
fn get_item(st: St, id: String) -> Result<Item, String> {
    with(&st, |s| s.data.items.iter().find(|i| i.id == id).cloned().ok_or("item not found".into()))
}

#[tauri::command]
fn save_item(st: St, item: Item) -> Result<String, String> { with(&st, |s| s.upsert(item)) }

/// Moves to the trash; an item already in the trash is deleted for good.
#[tauri::command]
fn delete_item(st: St, id: String) -> Result<(), String> { with(&st, |s| s.remove(&id)) }

#[tauri::command]
fn restore_item(st: St, id: String) -> Result<(), String> { with(&st, |s| s.restore(&id)) }

#[tauri::command]
fn empty_trash(st: St) -> Result<usize, String> { with(&st, |s| s.empty_trash()) }

#[tauri::command]
fn totp(secret: String) -> Result<Code, String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
    totp::code(&secret, now).map(|o| Code { code: o.code, left: o.left, period: o.period })
}

#[tauri::command]
fn generate(len: usize, lower: bool, upper: bool, digits: bool, symbols: bool) -> Result<String, String> {
    gen::password(len, lower, upper, digits, symbols)
}

#[tauri::command]
fn strength(password: String) -> Strength {
    let bits = gen::bits(&password);
    Strength { bits, level: gen::level(bits) }
}

#[tauri::command]
fn security_audit(st: St) -> Result<audit::Audit, String> {
    with(&st, |s| Ok(audit::run(&s.data.items, vault::now())))
}

/// Opt-in, online: sends 5-character SHA-1 prefixes to api.pwnedpasswords.com.
#[tauri::command]
async fn breach_check(st: St<'_>) -> Result<Vec<audit::Ref>, String> {
    let list: Vec<(String, String, String)> = with(&st, |s| Ok(s.data.items.iter().filter(|i| i.deleted == 0 && i.kind == "login")
        .filter_map(|i| i.fields.iter().find(|f| f.label == "Password" && !f.value.is_empty()).map(|f| (i.id.clone(), i.title.clone(), f.value.clone()))).collect()))?;
    tauri::async_runtime::spawn_blocking(move || audit::breaches(list)).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct Live { id: String, title: String, sub: String, label: String, code: String, left: u64, period: u64 }

/// Every one-time code in the vault, computed here so the secrets never reach the page.
#[tauri::command]
fn totp_all(st: St) -> Result<Vec<Live>, String> {
    with(&st, |s| {
        let now = vault::now();
        let mut v = vec![];
        for i in s.data.items.iter().filter(|i| i.deleted == 0) {
            let sub = i.fields.iter().find(|f| f.label == "Username").map(|f| f.value.clone()).unwrap_or_default();
            for f in i.fields.iter().filter(|f| f.kind == "totp" && !f.value.is_empty()) {
                if let Ok(o) = totp::code(&f.value, now) {
                    v.push(Live { id: i.id.clone(), title: i.title.clone(), sub: sub.clone(), label: f.label.clone(), code: o.code, left: o.left, period: o.period });
                }
            }
        }
        v.sort_by_key(|l| l.title.to_lowercase());
        Ok(v)
    })
}

#[tauri::command]
fn parse_2fa(text: String) -> otp_import::Parsed { otp_import::parse_text(&text) }

fn from_codes(raw: Vec<String>) -> Result<otp_import::Parsed, String> {
    let p = otp_import::parse_text(&raw.join("\n"));
    if p.accounts.is_empty() && p.skipped == 0 {
        return Err(if raw.is_empty() { "No QR code found. Make sure it is fully visible and not tiny.".into() } else { "A QR code was found, but it is not a 2FA setup code.".into() });
    }
    Ok(p)
}

/// Hides the window, reads QR codes on every monitor, brings the window back.
#[tauri::command]
async fn scan_screen(app: tauri::AppHandle) -> Result<otp_import::Parsed, String> {
    let w = app.get_webview_window("main").ok_or("no window")?;
    let _ = w.minimize();
    let found = tauri::async_runtime::spawn_blocking(|| { std::thread::sleep(Duration::from_millis(900)); qr::capture_screens() }).await.map_err(|e| e.to_string());
    let _ = w.unminimize();
    let _ = w.set_focus();
    from_codes(found??)
}

/// `data` is the image file, base64 encoded.
#[tauri::command]
fn scan_image(data: String) -> Result<otp_import::Parsed, String> {
    let bytes = data_encoding::BASE64.decode(data.trim().as_bytes()).map_err(|_| "could not read the image data")?;
    from_codes(qr::decode_image(&bytes)?)
}

#[tauri::command]
fn import_items(st: St, items: Vec<Item>) -> Result<usize, String> { with(&st, |s| s.add_many(items)) }

/// Copies the (encrypted) vault file to a place the user picked, e.g. a USB stick.
#[tauri::command]
fn export_backup(st: St, path: String) -> Result<(), String> {
    with(&st, |_| Ok(()))?;
    let to = PathBuf::from(&path);
    if to == vault_path() { return Err("choose a different place".into()); }
    std::fs::copy(vault_path(), to).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn wifi_qr(ssid: String, password: String, security: String) -> Result<String, String> { qr::wifi(&ssid, &password, &security) }

#[tauri::command]
fn import_csv(st: St, text: String) -> Result<usize, String> {
    let items = import::parse(&text)?;
    with(&st, |s| s.add_many(items))
}

#[tauri::command]
async fn change_password(st: St<'_>, old_password: String, new_password: String) -> Result<(), String> {
    check_master(&new_password)?;
    with(&st, |s| {
        s.change_password(&old_password, &new_password, KDF)?;
        if quick_path().exists() { quick_write(s)?; } // the key changed: keep quick unlock working
        Ok(())
    })
}

#[tauri::command]
fn get_settings(st: St) -> Result<Settings, String> { with(&st, |s| Ok(s.data.settings.clone())) }

#[tauri::command]
fn set_settings(st: St, settings: Settings) -> Result<(), String> {
    if settings.autolock_min > 1440 || settings.clip_secs > 600 { return Err("setting out of range".into()); }
    with(&st, |s| { s.data.settings = settings; s.save() })
}

#[tauri::command]
fn backup_dir() -> String { vault_dir().join("backups").to_string_lossy().into_owned() }

#[tauri::command]
fn open_backups() -> Result<(), String> {
    let d = vault_dir().join("backups");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    // GUI process has no console: give the child a null stdin
    Command::new("explorer").arg(&d).stdin(Stdio::null()).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Copies without Windows clipboard history or cloud sync, and clears it after the configured time if it is still ours.
#[tauri::command]
fn copy(st: St, text: String) -> Result<(), String> {
    let secs = st.0.lock().unwrap().as_ref().map(|s| s.data.settings.clip_secs).unwrap_or(20);
    Clipboard::new().and_then(|mut c| c.set().exclude_from_history().exclude_from_cloud().text(text.clone())).map_err(|e| e.to_string())?;
    if secs > 0 {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(secs));
            if let Ok(mut c) = Clipboard::new() {
                if c.get_text().ok().as_deref() == Some(text.as_str()) { let _ = c.clear(); }
            }
        });
    }
    Ok(())
}

fn show(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") { let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus(); }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _, ev| {
            if ev.state() == ShortcutState::Pressed { show(app); let _ = app.emit("quick-search", ()); }
        }).build())
        .manage(App(Mutex::new(None)))
        .setup(|app| { let _ = app.global_shortcut().register("ctrl+alt+k"); Ok(()) }) // already taken by another app: not fatal
        .invoke_handler(tauri::generate_handler![status, create_vault, unlock, quick_enable, quick_disable, quick_unlock, lock, list, get_item, save_item, delete_item, restore_item, empty_trash,
            totp, totp_all, parse_2fa, scan_screen, scan_image, import_items, export_backup, generate, strength, security_audit, breach_check, wifi_qr, import_csv, change_password, get_settings, set_settings, backup_dir, open_backups, copy])
        .run(tauri::generate_context!())
        .expect("error while running Vault");
}
