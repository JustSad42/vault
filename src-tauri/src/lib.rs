mod sleep;
mod audit;
mod autotype;
mod bridge;
mod categories;
mod domain;
mod extension;
mod gen;
mod hello;
mod import;
mod native_host;
mod otp_import;
mod passkey;
mod quick;
mod qr;
mod search;
mod share;
mod sync;
mod totp;
mod vault;
mod winevents;

use arboard::{Clipboard, SetExtWindows};
use serde::Serialize;
use std::{path::PathBuf, process::{Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::Duration};
use tauri::{Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Code as Key, GlobalShortcutExt, Modifiers, ShortcutState};
use vault::{Item, Session, Settings, KDF};

struct App(Mutex<Option<Session>>);

// Window behaviour must work before the vault is unlocked, so these live in plain `prefs.json` (not secret) as well as in the vault.
static TRAY: AtomicBool = AtomicBool::new(false);
static LOCK_ON_WINDOWS_LOCK: AtomicBool = AtomicBool::new(true);
static SYNCING: AtomicBool = AtomicBool::new(false);
static MISSED_SYNC: AtomicBool = AtomicBool::new(false);
static SYNC_NOTE: Mutex<(u64, bool, String)> = Mutex::new((0, true, String::new()));

fn prefs_path() -> PathBuf { vault_dir().join("prefs.json") }
fn prefs_load() {
    if let Some(v) = std::fs::read(prefs_path()).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) {
        TRAY.store(v["tray"].as_bool().unwrap_or(false), Ordering::Relaxed);
        LOCK_ON_WINDOWS_LOCK.store(v["lock_on_windows_lock"].as_bool().unwrap_or(true), Ordering::Relaxed);
    }
}
fn prefs_save(tray: bool, lock: bool) {
    TRAY.store(tray, Ordering::Relaxed);
    LOCK_ON_WINDOWS_LOCK.store(lock, Ordering::Relaxed);
    let _ = std::fs::create_dir_all(vault_dir());
    let _ = std::fs::write(prefs_path(), serde_json::json!({ "tray": tray, "lock_on_windows_lock": lock }).to_string());
}

/// A command run for the user without flashing a console window.
fn quiet(c: &mut Command) -> &mut Command {
    c.stdin(Stdio::null());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
    c
}

/// True while the Windows lock screen (or another secure desktop) is up.
#[cfg(windows)]
fn workstation_locked() -> bool {
    use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop};
    // SAFETY: plain Win32 calls; the handle is closed right away.
    unsafe { let d = OpenInputDesktop(0, 0, 0x0100); if d.is_null() { true } else { CloseDesktop(d); false } }
}
#[cfg(not(windows))]
fn workstation_locked() -> bool { false }
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

/// When the user last did something in an unlocked vault. The idle lock runs here: a timer in the
/// page would stop while the window sleeps in the tray.
static LAST_ACTIVITY: Mutex<Option<std::time::Instant>> = Mutex::new(None);

#[tauri::command]
fn touch() { *LAST_ACTIVITY.lock().unwrap() = Some(std::time::Instant::now()); }

fn unlocked(st: &St, s: Session) {
    touch();
    *st.0.lock().unwrap() = Some(s);
}

fn idle_expired(minutes: u32, idle: Duration) -> bool { minutes > 0 && idle >= Duration::from_secs(u64::from(minutes) * 60) }

fn with<T>(st: &St, f: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
    f(st.0.lock().unwrap().as_mut().ok_or("vault is locked")?)
}

fn check_master(pw: &str) -> Result<(), String> {
    if pw.chars().count() < MIN_MASTER { return Err(format!("master password needs at least {MIN_MASTER} characters")); }
    Ok(())
}

#[derive(Serialize)]
struct Status { exists: bool, unlocked: bool, quick: bool, recovery: bool, hello: bool }

#[derive(Serialize)]
struct Summary { updated: u64, id: String, kind: String, title: String, sub: String, folder: String, favorite: bool, deleted: bool, tags: Vec<String>, expires: String, files: usize, category: String, domain: String, flags: Vec<&'static str>, versions: usize, tail: String }

#[derive(Serialize)]
struct Code { code: String, left: u64, period: u64 }

#[derive(Serialize)]
struct Strength { bits: f64, level: &'static str }

#[tauri::command]
fn status(st: St) -> Status {
    Status { exists: vault_path().exists(), unlocked: st.0.lock().unwrap().is_some(), quick: quick_path().exists(), recovery: vault_dir().join("recovery.bin").exists(), hello: quick_hello_on() }
}

// Argon2 takes a few hundred ms: async commands keep it off the UI thread.
#[tauri::command]
async fn create_vault(st: St<'_>, password: String) -> Result<(), String> {
    check_master(&password)?;
    let s = Session::create(&vault_path(), &password, KDF)?;
    unlocked(&st, s);
    Ok(())
}

#[tauri::command]
async fn unlock(st: St<'_>, password: String) -> Result<(), String> {
    let mut s = Session::open(&vault_path(), &password)?;
    // a vault made with a cheaper key derivation is re-encrypted with today's; not being able to is no reason to stay locked
    if let Ok(true) = s.upgrade_kdf(&password, KDF) { if quick_path().exists() { let _ = quick_write(&s, quick_hello_on()); } }
    unlocked(&st, s);
    Ok(())
}

fn quick_write(s: &Session, hello: bool) -> Result<(), String> {
    vault::write_atomic(&quick_path(), &quick::seal(&s.key()[..], hello)?)
}

/// "Stay signed in" is on and asks for Windows Hello first.
fn quick_hello_on() -> bool { std::fs::read(quick_path()).is_ok_and(|b| quick::needs_hello(&b)) }

fn main_hwnd(app: &tauri::AppHandle) -> isize {
    #[cfg(windows)]
    { app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize).unwrap_or(0) }
    #[cfg(not(windows))]
    { let _ = app; 0 }
}

/// Stay signed in on this PC: needs the vault to be unlocked right now.
#[tauri::command]
fn quick_enable(st: St) -> Result<(), String> { with(&st, |s| quick_write(s, false)) }

#[tauri::command]
async fn hello_available() -> bool { tauri::async_runtime::spawn_blocking(hello::available).await.unwrap_or(false) }

/// Turns "ask for Windows Hello" on or off for stay-signed-in. Turning it on checks Hello once, so a broken setup is
/// found now rather than at the next start.
#[tauri::command]
async fn quick_hello_set(app: tauri::AppHandle, st: St<'_>, on: bool) -> Result<(), String> {
    with(&st, |_| Ok(()))?;
    if !quick_path().exists() { return Err("turn on stay signed in first".into()); }
    if on {
        let h = main_hwnd(&app);
        tauri::async_runtime::spawn_blocking(move || hello::verify(h, "Confirm it is you to use Windows Hello with Vault")).await.map_err(|e| e.to_string())??;
    }
    with(&st, |s| quick_write(s, on))
}

#[tauri::command]
fn quick_disable() -> Result<(), String> {
    match std::fs::remove_file(quick_path()) { Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()), _ => Ok(()) }
}

#[tauri::command]
async fn quick_unlock(app: tauri::AppHandle, st: St<'_>) -> Result<(), String> {
    let blob = std::fs::read(quick_path()).map_err(|_| "quick unlock is not set up".to_string())?;
    if quick::needs_hello(&blob) {
        let h = main_hwnd(&app);
        tauri::async_runtime::spawn_blocking(move || hello::verify(h, "Unlock Vault")).await.map_err(|e| e.to_string())??;
    }
    let key = zeroize::Zeroizing::new(quick::open(&blob)?);
    let key: [u8; 32] = key[..].try_into().map_err(|_| "saved key is damaged".to_string())?;
    let s = Session::open_with_key(&vault_path(), &key)?;
    unlocked(&st, s);
    Ok(())
}

#[tauri::command]
fn lock(st: St) { *st.0.lock().unwrap() = None; clear_open_dir(); }

#[tauri::command]
fn list(st: St) -> Result<Vec<Summary>, String> {
    with(&st, |s| { let fl = s.flags(); Ok(s.data.items.iter().map(|i| {
        let val = |l: &str| i.fields.iter().find(|f| f.label == l).map(|f| f.value.clone()).unwrap_or_default();
        let sub = match i.kind.as_str() {
            "login" => val("Username"),
            "card" => { let n: String = val("Card number").chars().filter(|c| c.is_ascii_digit()).collect(); if n.len() >= 4 { format!("•••• {}", &n[n.len() - 4..]) } else { String::new() } }
            "api" => val("Endpoint"),
            "wifi" => val("Network name"),
            "bank" => { let a: String = val("Account number").chars().filter(|c| !c.is_whitespace()).collect(); if a.len() >= 4 { format!("{} •••• {}", val("Bank name"), &a[a.len() - 4..]) } else { val("Bank name") } }
            "identity" => val("Email"),
            "document" => val("Document type"),
            _ => String::new(),
        };
        // the last four characters of the card, IBAN or account number: the page shows them on the wallet card without the secret
        let tail = ["Card number", "IBAN", "Account number"].iter().map(|l| val(l).chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>()).find(|v| v.len() >= 4)
            .map(|v| v[v.len() - 4..].to_string()).unwrap_or_default();
        Summary { updated: i.updated, id: i.id.clone(), kind: i.kind.clone(), title: i.title.clone(), sub, folder: i.folder.clone(), favorite: i.favorite, deleted: i.deleted > 0, tags: i.tags.clone(), expires: i.expires.clone(), files: i.attachments.len(), category: categories::of(i),
            domain: domain::host_of(&categories::website(i)).map(|h| domain::etld1(&h)).unwrap_or_default(), flags: fl.get(&i.id).cloned().unwrap_or_default(), versions: i.versions.len(), tail }
    }).collect()) })
}

/// Ids of matching items, best first (see search.rs for the query language).
#[tauri::command]
fn search(st: St, query: String, trash: bool) -> Result<Vec<String>, String> {
    with(&st, |s| Ok(search::run(&s.data.items, &s.flags(), &query, trash)))
}

#[tauri::command]
fn restore_version(st: St, id: String, at: u64) -> Result<(), String> { with(&st, |s| s.restore_version(&id, at)) }

#[tauri::command]
fn categories_list() -> &'static [&'static str] { categories::ALL }

/// The item for showing: secrets replaced by markers (see `Session::view`); `reveal` fetches one when asked.
#[tauri::command]
fn get_item(st: St, id: String) -> Result<Item, String> {
    with(&st, |s| s.data.items.iter().find(|i| i.id == id).map(|i| s.view(i)).ok_or("item not found".into()))
}

/// The whole item, secrets included: only for the editor.
#[tauri::command]
fn get_item_full(st: St, id: String) -> Result<Item, String> {
    with(&st, |s| s.data.items.iter().find(|i| i.id == id).cloned().ok_or("item not found".into()))
}

#[tauri::command]
fn save_item(st: St, mut item: Item) -> Result<String, String> { with(&st, |s| { s.unhide(&mut item)?; s.upsert(item) }) }

/// One secret, on an explicit "show": `src` field | hist | version (see `Session::secret`).
#[tauri::command]
fn reveal(st: St, id: String, src: String, at: u64, idx: usize) -> Result<String, String> { with(&st, |s| s.secret(&id, &src, at, idx)) }

/// Copies one secret without it passing through the page. `fmt` may wrap it, `{v}` standing for the value (`export KEY={v}`).
#[tauri::command]
fn reveal_copy(st: St, id: String, src: String, at: u64, idx: usize, fmt: Option<String>) -> Result<(), String> {
    let (v, secs) = with(&st, |s| Ok((s.secret(&id, &src, at, idx)?, s.data.settings.clip_secs)))?;
    let v = zeroize::Zeroizing::new(match fmt { Some(f) if f.contains("{v}") => f.replace("{v}", &v), _ => v });
    put_clipboard(&v, secs)
}

/// The current one-time code of an item's TOTP field.
#[tauri::command]
fn field_totp(st: St, id: String, idx: usize) -> Result<Code, String> {
    let secret = zeroize::Zeroizing::new(with(&st, |s| s.secret(&id, "field", 0, idx))?);
    totp::code(&secret, vault::now()).map(|o| Code { code: o.code, left: o.left, period: o.period })
}

/// The join-this-network QR code of a Wi-Fi item, made here so the password stays out of the page.
#[tauri::command]
fn wifi_qr_item(st: St, id: String) -> Result<String, String> {
    let (ssid, pw, sec) = with(&st, |s| {
        let i = s.data.items.iter().find(|i| i.id == id).ok_or("item not found")?;
        let g = |l: &str| i.fields.iter().find(|f| f.label == l).map(|f| f.value.clone()).unwrap_or_default();
        Ok((g("Network name"), zeroize::Zeroizing::new(g("Password")), g("Security")))
    })?;
    qr::wifi(&ssid, &pw, &sec)
}

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
fn generate_passphrase(words: usize, sep: String, capitalize: bool, number: bool) -> Result<String, String> { gen::passphrase(words, &sep, capitalize, number) }

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

/// One camera frame: raw 8-bit grayscale as the binary body, width and height in the `x-w` / `x-h` headers.
/// No QR code in the frame is the normal case and is not an error.
#[tauri::command]
fn scan_luma(request: tauri::ipc::Request<'_>) -> Result<otp_import::Parsed, String> {
    let tauri::ipc::InvokeBody::Raw(frame) = request.body() else { return Err("bad frame".into()) };
    let dim = |n: &str| request.headers().get(n).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok());
    let (Some(w), Some(h)) = (dim("x-w"), dim("x-h")) else { return Err("bad frame".into()) };
    if w * h != frame.len() || w > 8192 || h > 8192 { return Err("bad frame".into()); }
    let raw = qr::decode_luma(w, h, frame);
    let mut p = otp_import::parse_text(&raw.join("\n"));
    p.foreign = p.accounts.is_empty() && p.skipped == 0 && !raw.is_empty();
    Ok(p)
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
fn import_bitwarden(st: St, text: String) -> Result<usize, String> {
    let items = import::bitwarden_json(&text)?;
    with(&st, |s| s.add_many(items))
}

/// `data` is the .kdbx file, base64 encoded. Opening it runs KeePass's own key derivation, so it is kept off the UI thread.
#[tauri::command]
async fn import_keepass(st: St<'_>, data: String, password: String) -> Result<usize, String> {
    let bytes = data_encoding::BASE64.decode(data.trim().as_bytes()).map_err(|_| "could not read the file data".to_string())?;
    let items = tauri::async_runtime::spawn_blocking(move || import::keepass(&bytes, &password)).await.map_err(|e| e.to_string())??;
    with(&st, |s| s.add_with_files(items))
}

#[tauri::command]
async fn change_password(st: St<'_>, old_password: String, new_password: String) -> Result<(), String> {
    check_master(&new_password)?;
    let hello = quick_hello_on();
    with(&st, |s| {
        s.change_password(&old_password, &new_password, KDF)?;
        if quick_path().exists() { quick_write(s, hello)?; } // the key changed: keep quick unlock working
        Ok(())
    })
}

#[tauri::command]
fn get_settings(st: St) -> Result<Settings, String> {
    with(&st, |s| { let mut c = s.data.settings.clone(); c.sync_token.clear(); c.recovery_phrase.clear(); c.paired.clear(); Ok(c) }) // secrets never reach the page
}

#[tauri::command]
fn set_settings(st: St, settings: Settings) -> Result<(), String> {
    if settings.autolock_min > 1440 || settings.clip_secs > 600 { return Err("setting out of range".into()); }
    with(&st, |s| {
        let keep = s.data.settings.clone();
        s.data.settings = Settings { sync_token: keep.sync_token, recovery_phrase: keep.recovery_phrase, paired: keep.paired, ..settings };
        prefs_save(s.data.settings.tray, s.data.settings.lock_on_windows_lock);
        s.save()
    })
}

#[tauri::command]
fn recovery_enable(st: St) -> Result<String, String> { with(&st, |s| s.enable_recovery()) }

#[tauri::command]
fn recovery_phrase(st: St) -> Result<String, String> { with(&st, |s| Ok(s.data.settings.recovery_phrase.clone())) }

/// Forgot the master password: needs only the recovery key, no unlock.
#[tauri::command]
async fn recover_vault(st: St<'_>, phrase: String, new_password: String) -> Result<(), String> {
    check_master(&new_password)?;
    let s = Session::recover(&vault_path(), &phrase, &new_password, KDF)?;
    if quick_path().exists() { quick_write(&s, quick_hello_on())?; }
    unlocked(&st, s);
    Ok(())
}

#[tauri::command]
fn att_add(st: St, item_id: String, name: String, data: String) -> Result<vault::Att, String> {
    let bytes = data_encoding::BASE64.decode(data.trim().as_bytes()).map_err(|_| "could not read the file data".to_string())?;
    with(&st, |s| s.att_add(&item_id, &name, &bytes))
}

/// The decrypted file as base64, for showing photos in the page.
#[tauri::command]
fn att_data(st: St, att_id: String) -> Result<String, String> { with(&st, |s| s.att_get(&att_id)).map(|b| data_encoding::BASE64.encode(&b)) }

fn open_dir() -> PathBuf { std::env::temp_dir().join("Vault-open") }
fn clear_open_dir() { let _ = std::fs::remove_dir_all(open_dir()); }

/// Opens a file with its default program from a temporary decrypted copy, deleted when the vault locks or the app closes.
#[tauri::command]
fn att_open(st: St, att_id: String, name: String) -> Result<(), String> {
    let bytes = with(&st, |s| s.att_get(&att_id))?;
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || ".-_ ()".contains(c) { c } else { '_' }).collect();
    let dir = open_dir().join(&att_id[..8.min(att_id.len())]);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(if safe.is_empty() { "file".to_string() } else { safe });
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    quiet(Command::new("cmd").args(["/C", "start", ""]).arg(&path)).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn att_save(st: St, att_id: String, path: String) -> Result<(), String> {
    let bytes = with(&st, |s| s.att_get(&att_id))?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn att_remove(st: St, item_id: String, att_id: String) -> Result<(), String> { with(&st, |s| s.att_remove(&item_id, &att_id)) }

#[tauri::command]
fn bulk(st: St, ids: Vec<String>, op: String, value: String) -> Result<usize, String> { with(&st, |s| s.bulk(&ids, &op, &value)) }

#[tauri::command]
fn duplicate_item(st: St, id: String) -> Result<String, String> { with(&st, |s| s.duplicate(&id)) }

#[derive(Serialize)]
struct BackupInfo { name: String, path: String, size: u64, modified: u64 }

#[tauri::command]
fn list_backups() -> Vec<BackupInfo> {
    let mut v: Vec<BackupInfo> = std::fs::read_dir(vault_dir().join("backups")).into_iter().flatten().flatten().filter_map(|e| {
        let m = e.metadata().ok()?;
        Some(BackupInfo { name: e.file_name().to_string_lossy().into_owned(), path: e.path().to_string_lossy().into_owned(), size: m.len(),
            modified: m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() })
    }).collect();
    v.sort_by(|a, b| b.modified.cmp(&a.modified));
    v
}

/// Replaces the vault with a backup file (a safety copy of the current one is kept) and locks.
/// The backup opens with the master password it had when it was made.
#[tauri::command]
fn restore_backup(st: St, path: String) -> Result<(), String> {
    with(&st, |_| Ok(()))?; // only while unlocked
    vault::restore_file(&vault_path(), &PathBuf::from(path))?;
    let _ = quick_disable(); // the saved key belongs to the old file
    *st.0.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
fn share_save(st: St, id: String, passphrase: String, path: String) -> Result<(), String> {
    let it = with(&st, |s| s.data.items.iter().find(|i| i.id == id).cloned().ok_or("item not found".to_string()))?;
    std::fs::write(path, share::export(&it, &passphrase, KDF)?).map_err(|e| e.to_string())
}

#[tauri::command]
fn share_load(st: St, path: String, passphrase: String) -> Result<String, String> {
    let mut it = share::import(&std::fs::read(path).map_err(|e| e.to_string())?, &passphrase)?;
    if it.folder.is_empty() { it.folder = "Received".into(); }
    with(&st, |s| s.upsert(it))
}

#[tauri::command]
fn backup_dir() -> String { vault_dir().join("backups").to_string_lossy().into_owned() }

#[tauri::command]
fn open_backups() -> Result<(), String> {
    let d = vault_dir().join("backups");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    quiet(Command::new("explorer").arg(&d)).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Copies without Windows clipboard history or cloud sync, and clears it after the configured time if it is still ours.
#[tauri::command]
fn copy(st: St, text: String) -> Result<(), String> {
    let secs = st.0.lock().unwrap().as_ref().map(|s| s.data.settings.clip_secs).unwrap_or(20);
    put_clipboard(&text, secs)
}

fn put_clipboard(text: &str, secs: u64) -> Result<(), String> {
    Clipboard::new().and_then(|mut c| c.set().exclude_from_history().exclude_from_cloud().text(text.to_string())).map_err(|e| e.to_string())?;
    if secs > 0 {
        let text = zeroize::Zeroizing::new(text.to_string());
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(secs));
            if let Ok(mut c) = Clipboard::new() {
                if c.get_text().ok().as_deref() == Some(text.as_str()) { let _ = c.clear(); }
            }
        });
    }
    Ok(())
}

// ---------- auto-type ----------
/// The window that was in front when Ctrl+Alt+A was pressed, waiting for the user to pick a login in Vault.
static AUTOTYPE_TARGET: Mutex<Option<isize>> = Mutex::new(None);

#[derive(Serialize, Clone)]
struct Pick { id: String, title: String, username: String }

fn autotype_hotkey(app: &tauri::AppHandle) {
    let (hwnd, title) = autotype::foreground();
    if hwnd == 0 || hwnd == main_hwnd(app) { return; }
    let st = app.state::<App>();
    let g = st.0.lock().unwrap();
    let Some(s) = g.as_ref() else {
        drop(g);
        *AUTOTYPE_TARGET.lock().unwrap() = Some(hwnd);
        show(app);
        let _ = app.emit("autotype-pick", serde_json::json!({ "title": title, "items": [], "locked": true }));
        return;
    };
    let found = autotype::candidates(&s.data.items, &title);
    let field = |i: &Item, l: &str| i.fields.iter().find(|f| f.label == l).map(|f| f.value.clone()).unwrap_or_default();
    if let [one] = found.as_slice() {
        let (user, pass) = (field(one, "Username"), zeroize::Zeroizing::new(field(one, "Password")));
        drop(g);
        let h = app.clone();
        std::thread::spawn(move || { if let Err(e) = autotype::type_into(hwnd, &user, &pass) { let _ = h.emit("autotype-error", e); } });
        return;
    }
    let items: Vec<Pick> = found.iter().map(|i| Pick { id: i.id.clone(), title: i.title.clone(), username: field(i, "Username") }).collect();
    drop(g);
    *AUTOTYPE_TARGET.lock().unwrap() = Some(hwnd);
    show(app);
    let _ = app.emit("autotype-pick", serde_json::json!({ "title": title, "items": items, "locked": false }));
}

/// Types the chosen login into the window that was in front when the hotkey was pressed.
#[tauri::command]
async fn autotype_item(app: tauri::AppHandle, st: St<'_>, id: String) -> Result<(), String> {
    let hwnd = AUTOTYPE_TARGET.lock().unwrap().take().ok_or("press Ctrl+Alt+A in the window to type into first")?;
    let (user, pass) = with(&st, |s| {
        let i = s.data.items.iter().find(|i| i.id == id && i.deleted == 0).ok_or("item not found")?;
        let g = |l: &str| i.fields.iter().find(|f| f.label == l).map(|f| f.value.clone()).unwrap_or_default();
        Ok((g("Username"), zeroize::Zeroizing::new(g("Password"))))
    })?;
    if let Some(w) = app.get_webview_window("main") { let _ = w.minimize(); }
    tauri::async_runtime::spawn_blocking(move || autotype::type_into(hwnd, &user, &pass)).await.map_err(|e| e.to_string())?
}

// ---------- sync with the user's own server ----------
fn sync_run(app: &tauri::AppHandle) -> Result<sync::Outcome, String> {
    let st = app.state::<App>();
    let (url, token, key) = {
        let g = st.0.lock().unwrap();
        let s = g.as_ref().ok_or("the vault is locked")?;
        if s.data.settings.sync_url.is_empty() || s.data.settings.sync_token.is_empty() { return Err("sync is off".into()); }
        (s.data.settings.sync_url.clone(), s.data.settings.sync_token.clone(), s.key())
    };
    let remote = sync::HttpRemote::new(&url, &token)?;
    let dir = vault_dir();
    for _ in 0..3 {
        let plan = sync::plan(&dir, &remote, &key)?;
        if matches!(plan, sync::Plan::Adopt { .. } | sync::Plan::Merge { .. }) {
            let mut g = st.0.lock().unwrap(); // under the session lock, so a save cannot slip in between
            sync::apply(&dir, &plan)?;
            match Session::open_with_key(&vault_path(), &key) {
                Ok(s) => *g = Some(s),
                Err(_) => { *g = None; drop(g); lock_now(app); } // the master password was changed on another PC
            }
        }
        match sync::finish(&dir, &remote, &plan, &key)? { sync::Outcome::Retry => continue, o => return Ok(o) }
    }
    Err("the server keeps changing; try again in a moment".into())
}

fn sync_guarded(app: &tauri::AppHandle) -> Result<sync::Outcome, String> {
    if SYNCING.swap(true, Ordering::SeqCst) { return Err("a sync is already running".into()); }
    let r = sync_run(app);
    SYNCING.store(false, Ordering::SeqCst);
    *SYNC_NOTE.lock().unwrap() = (vault::now(), r.is_ok(), match &r { Ok(o) => format!("{o:?}"), Err(e) => e.clone() });
    if matches!(r, Ok(sync::Outcome::Pulled) | Ok(sync::Outcome::Merged)) {
        // a hidden window is told when it comes back
        if app.get_webview_window("main").is_some_and(|w| !w.is_visible().unwrap_or(true)) { MISSED_SYNC.store(true, Ordering::SeqCst); }
        else { let _ = app.emit("vault-synced", ()); }
    }
    r
}

#[tauri::command]
fn sync_status(st: St) -> Result<serde_json::Value, String> {
    let (url, on) = with(&st, |s| Ok((s.data.settings.sync_url.clone(), !s.data.settings.sync_token.is_empty())))?;
    let state = sync::load_state(&vault_dir());
    let note = SYNC_NOTE.lock().unwrap().clone();
    Ok(serde_json::json!({ "configured": on && !url.is_empty(), "url": url, "rev": state.rev, "last_ok_at": state.at, "pending": sync::pending(&vault_dir()), "note_at": note.0, "note_ok": note.1, "note": note.2 }))
}

/// Turns sync on: remembers the server address, makes a random sync key (shown to the user so another PC can restore) and syncs once.
#[tauri::command]
async fn sync_enable(app: tauri::AppHandle, st: St<'_>, url: String) -> Result<String, String> {
    sync::HttpRemote::new(&url, "x")?; // validates the address format
    let key = {
        let mut raw = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut raw);
        let k = data_encoding::HEXLOWER.encode(&raw);
        with(&st, |s| { if s.data.settings.sync_token.is_empty() { s.data.settings.sync_token = k; } s.data.settings.sync_url = url.trim().trim_end_matches('/').into(); s.save()?; Ok(s.data.settings.sync_token.clone()) })?
    };
    let h = app.clone();
    tauri::async_runtime::spawn_blocking(move || sync_guarded(&h)).await.map_err(|e| e.to_string())??;
    Ok(key)
}

#[tauri::command]
fn sync_disable(st: St) -> Result<(), String> {
    with(&st, |s| { s.data.settings.sync_url.clear(); s.data.settings.sync_token.clear(); s.save() })?;
    let _ = std::fs::remove_file(vault_dir().join("sync.json"));
    Ok(())
}

/// The sync key, only on an explicit click: it is needed to restore the vault on another PC.
#[tauri::command]
fn sync_key(st: St) -> Result<String, String> { with(&st, |s| Ok(s.data.settings.sync_token.clone())) }

#[tauri::command]
async fn sync_now(app: tauri::AppHandle) -> Result<String, String> {
    let o = tauri::async_runtime::spawn_blocking(move || sync_guarded(&app)).await.map_err(|e| e.to_string())??;
    Ok(format!("{o:?}"))
}

/// New PC: download the vault from the server before the first unlock.
#[tauri::command]
async fn sync_restore(url: String, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sync::restore(&vault_dir(), &sync::HttpRemote::new(&url, key.trim())?)).await.map_err(|e| e.to_string())?
}

/// A six-digit code to type into the browser extension (valid for two minutes).
#[tauri::command]
fn bridge_pair_start(st: St) -> Result<String, String> { with(&st, |_| Ok(()))?; Ok(bridge::start_pairing()) }

#[tauri::command]
fn bridge_paired(st: St) -> Result<Vec<serde_json::Value>, String> {
    with(&st, |s| Ok(s.data.settings.paired.iter().map(|p| serde_json::json!({ "name": p.name, "created": p.created })).collect()))
}

#[tauri::command]
/// One pairing: several can share a name (the same browser paired again, or two profiles).
fn bridge_revoke(st: St, name: String, created: u64) -> Result<(), String> { with(&st, |s| { s.data.settings.paired.retain(|p| !(p.name == name && p.created == created)); s.save() }) }

/// Writes the extension to a folder (for "Load unpacked") and opens it.
#[tauri::command]
fn extension_install() -> Result<String, String> {
    let dir = vault_dir().join("extension");
    extension::install(&dir)?;
    let _ = quiet(Command::new("explorer").arg(&dir)).spawn();
    Ok(dir.to_string_lossy().into_owned())
}

/// Entry point when the browser starts `vault.exe --native-host`.
pub fn native_host() { native_host::run() }

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[tauri::command]
fn autostart_get() -> bool {
    quiet(Command::new("reg").args(["query", RUN_KEY, "/v", "Vault"])).output().map(|o| o.status.success()).unwrap_or(false)
}

#[tauri::command]
fn autostart_set(on: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let out = if on {
        quiet(Command::new("reg").args(["add", RUN_KEY, "/v", "Vault", "/t", "REG_SZ", "/d"]).arg(format!("\"{}\" --minimized", exe.display())).arg("/f")).output()
    } else {
        quiet(Command::new("reg").args(["delete", RUN_KEY, "/v", "Vault", "/f"])).output()
    }.map_err(|e| e.to_string())?;
    if out.status.success() || !on { Ok(()) } else { Err("Windows would not save the startup entry".into()) }
}

fn lock_now(app: &tauri::AppHandle) {
    if let Some(st) = app.try_state::<App>() { *st.0.lock().unwrap() = None; }
    clear_open_dir();
    // A sleeping page would miss this and still show the vault when it wakes: wake it to tell it.
    let hidden = app.get_webview_window("main").filter(|w| !w.is_visible().unwrap_or(true));
    if let Some(w) = &hidden { sleep::wake(w); }
    let _ = app.emit("vault-locked", ());
    if let Some(w) = &hidden { sleep::later(w, Duration::from_secs(5)); }
}

fn show(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") { sleep::wake(&w); let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus(); }
    if MISSED_SYNC.swap(false, Ordering::SeqCst) { let _ = app.emit("vault-synced", ()); }
}

/// `VAULT_TEST_COPY=1` (with its own `VAULT_DIR`): an end-to-end test copy that can run next to the real Vault. It
/// skips the single-instance hand-off, the global hotkeys and the browser's native-host registration, which all
/// belong to the real app.
fn test_copy() -> bool { std::env::var_os("VAULT_TEST_COPY").is_some() }

pub fn run() {
    let mut builder = tauri::Builder::default();
    if !test_copy() { builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| show(app))); }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, sc, ev| {
            if ev.state() != ShortcutState::Pressed { return; }
            if sc.matches(Modifiers::CONTROL | Modifiers::ALT, Key::KeyA) { autotype_hotkey(app); } else { show(app); let _ = app.emit("quick-search", ()); }
        }).build())
        .manage(App(Mutex::new(None)))
        .on_window_event(|w, ev| {
            if let tauri::WindowEvent::Focused(true) = ev {
                if let Some(w) = w.app_handle().get_webview_window(w.label()) { sleep::focused(&w); }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                if TRAY.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = w.hide();
                    if let Some(w) = w.app_handle().get_webview_window(w.label()) { sleep::later(&w, Duration::from_secs(5)); }
                }
            }
        })
        .setup(|app| {
            clear_open_dir();
            prefs_load();
            { let h = app.handle().clone(); std::thread::spawn(move || bridge::serve(h)); }
            if !test_copy() {
                std::thread::spawn(|| extension::register_native_host(&vault_dir(), &std::env::var("VAULT_NATIVE_HOST_NAME").unwrap_or_else(|_| "local.vault".into())));
                let _ = app.global_shortcut().register("ctrl+alt+k"); // already taken by another app: not fatal
                let _ = app.global_shortcut().register("ctrl+alt+a"); // auto-type
            }
            // tray icon: Open / Lock / Quit
            let open = tauri::menu::MenuItem::with_id(app, "open", "Open Vault", true, None::<&str>)?;
            let lock = tauri::menu::MenuItem::with_id(app, "lock", "Lock", true, None::<&str>)?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&open, &lock, &quit])?;
            let mut tray = tauri::tray::TrayIconBuilder::new().tooltip("Vault").menu(&menu).show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() { "open" => show(app), "lock" => lock_now(app), "quit" => app.exit(0), _ => {} })
                .on_tray_icon_event(|t, ev| { if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = ev { show(t.app_handle()); } });
            if let Some(i) = app.default_window_icon() { tray = tray.icon(i.clone()); }
            tray.build(app)?;
            // sync: a few seconds after a change, and every two minutes to pick up changes from other PCs
            let hs = app.handle().clone();
            std::thread::spawn(move || {
                let mut last = std::time::Instant::now();
                loop {
                    std::thread::sleep(Duration::from_secs(5));
                    let on = hs.try_state::<App>().is_some_and(|st| st.0.lock().unwrap().as_ref().is_some_and(|s| !s.data.settings.sync_url.is_empty() && !s.data.settings.sync_token.is_empty()));
                    if on && (sync::pending(&vault_dir()) || last.elapsed() > Duration::from_secs(120)) { last = std::time::Instant::now(); let _ = sync_guarded(&hs); }
                }
            });
            // lock the vault when Windows locks or the PC goes to sleep: told by Windows, or (if that cannot be set up) by polling
            let handle = app.handle().clone();
            let evh = handle.clone();
            if !winevents::watch(move || { if LOCK_ON_WINDOWS_LOCK.load(Ordering::Relaxed) { lock_now(&evh); } }) {
                std::thread::spawn(move || {
                    let mut was = false;
                    loop {
                        std::thread::sleep(Duration::from_millis(1500));
                        let now = workstation_locked();
                        if now && !was && LOCK_ON_WINDOWS_LOCK.load(Ordering::Relaxed) { lock_now(&handle); }
                        was = now;
                    }
                });
            }
            if std::env::args().any(|a| a == "--minimized") {
                // later than usual: the page first loads and may sign in by itself
                if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); sleep::later(&w, Duration::from_secs(30)); }
            }
            // lock after the chosen idle time
            let hi = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(2));
                let idle = LAST_ACTIVITY.lock().unwrap().map(|t| t.elapsed());
                let due = idle.is_some_and(|idle| hi.try_state::<App>().is_some_and(|st| st.0.lock().unwrap().as_ref().is_some_and(|s| idle_expired(s.data.settings.autolock_min, idle))));
                if due { lock_now(&hi); }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![touch, get_item_full, reveal, reveal_copy, field_totp, wifi_qr_item, generate_passphrase, import_bitwarden, import_keepass, hello_available, quick_hello_set, autotype_item, sync_status, sync_enable, sync_disable, sync_key, sync_now, sync_restore, bridge_pair_start, bridge_paired, bridge_revoke, extension_install, status, create_vault, unlock, quick_enable, quick_disable, quick_unlock, lock, list, get_item, save_item, delete_item, restore_item, empty_trash,
            totp, totp_all, search, restore_version, categories_list, autostart_get, autostart_set, recovery_enable, recovery_phrase, recover_vault, att_add, att_data, att_open, att_save, att_remove, bulk, duplicate_item, list_backups, restore_backup, share_save, share_load, parse_2fa, scan_screen, scan_image, scan_luma, import_items, export_backup, generate, strength, security_audit, breach_check, wifi_qr, import_csv, change_password, get_settings, set_settings, backup_dir, open_backups, copy])
        .build(tauri::generate_context!())
        .expect("error while building Vault")
        .run(|_app, event| { if let tauri::RunEvent::Exit = event { clear_open_dir(); } });
}

#[cfg(test)]
mod idle_tests {
    use super::idle_expired;
    use std::time::Duration;

    #[test]
    fn locks_only_after_the_chosen_time() {
        assert!(!idle_expired(0, Duration::from_secs(1_000_000))); // never
        assert!(!idle_expired(5, Duration::from_secs(299)));
        assert!(idle_expired(5, Duration::from_secs(300)));
    }
}
