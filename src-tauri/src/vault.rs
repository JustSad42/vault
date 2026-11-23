//! Encrypted vault file: Argon2id -> XChaCha20-Poly1305. The header (magic, KDF cost, salt) is
//! authenticated as AAD, so a tampered cost or salt fails to open instead of being trusted.
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{aead::{Aead, Payload}, Key, KeyInit, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use zeroize::Zeroizing;

const MAGIC: &[u8; 4] = b"VLT1";
const HDR: usize = 32; // magic 4 + m,t,p 12 + salt 16
const NONCE: usize = 24;
const KEEP_BACKUPS: usize = 14;
const TRASH_DAYS: u64 = 30;
const KEEP_HISTORY: usize = 20;
const KEEP_VERSIONS: usize = 25;
const MAX_ATT: usize = 25 * 1024 * 1024;
const RMAGIC: &[u8; 4] = b"VRC1";

#[derive(Clone, Copy)]
pub struct Kdf { pub m: u32, pub t: u32, pub p: u32 }
/// 64 MiB, 3 passes: about 0.3 s per unlock on a desktop.
pub const KDF: Kdf = Kdf { m: 65536, t: 3, p: 1 };

#[derive(Serialize, Deserialize, Clone, Default, PartialEq)]
pub struct Field { pub label: String, pub value: String, pub kind: String } // kind: text | secret | totp

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Hist { pub label: String, pub value: String, pub at: u64 }

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Att { pub id: String, pub name: String, pub size: u64 }

/// A past state of an item: everything you can edit, as it was before a change.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ItemVersion { pub at: u64, pub title: String, pub folder: String, pub tags: Vec<String>, pub notes: String, pub expires: String, pub category: String, pub fields: Vec<Field> }

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Item {
    #[serde(default)] pub id: String,
    pub kind: String, // login | card | note | other
    pub title: String,
    #[serde(default)] pub folder: String,
    #[serde(default)] pub fields: Vec<Field>,
    #[serde(default)] pub notes: String,
    #[serde(default)] pub favorite: bool,
    #[serde(default)] pub updated: u64,
    #[serde(default)] pub history: Vec<Hist>, // earlier values of secret fields, newest last
    #[serde(default)] pub deleted: u64,       // 0 = alive, else when it went to the trash
    #[serde(default)] pub tags: Vec<String>,
    #[serde(default)] pub expires: String,    // YYYY-MM-DD or empty
    #[serde(default)] pub attachments: Vec<Att>, // files live encrypted in attachments/<id>.bin
    #[serde(default)] pub category: String,   // empty = automatic
    #[serde(default)] pub versions: Vec<ItemVersion>, // newest last
}

impl Item {
    fn snapshot(&self) -> ItemVersion {
        ItemVersion { at: self.updated, title: self.title.clone(), folder: self.folder.clone(), tags: self.tags.clone(), notes: self.notes.clone(), expires: self.expires.clone(), category: self.category.clone(), fields: self.fields.clone() }
    }
    fn same_content(&self, o: &Item) -> bool {
        (&self.title, &self.folder, &self.tags, &self.notes, &self.expires, &self.category, &self.fields) == (&o.title, &o.folder, &o.tags, &o.notes, &o.expires, &o.category, &o.fields)
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Paired { pub name: String, pub hash: String, pub created: u64 }

#[derive(Serialize, Deserialize, Clone)]
pub struct TplField { pub label: String, pub kind: String }

#[derive(Serialize, Deserialize, Clone)]
pub struct Template { pub name: String, pub kind: String, pub fields: Vec<TplField> }

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub autolock_min: u32, // 0 = never
    pub clip_secs: u64,    // 0 = never clear
    pub accent: String,
    pub theme: String, // auto | dark | light
    pub templates: Vec<Template>,
    pub lock_on_windows_lock: bool,
    pub tray: bool,          // keep running in the tray when the window is closed
    pub check_updates: bool,
    pub sync_url: String,
    pub sync_token: String,      // never sent to the page
    pub recovery_phrase: String, // never sent to the page except by recovery_phrase
    pub paired: Vec<Paired>,     // browser extensions allowed to talk to the app (token hashes)
}
impl Default for Settings {
    fn default() -> Self {
        Settings { autolock_min: 5, clip_secs: 20, accent: "indigo".into(), theme: "auto".into(), templates: vec![], lock_on_windows_lock: true, tray: false,
            check_updates: true, sync_url: String::new(), sync_token: String::new(), recovery_phrase: String::new(), paired: vec![] }
    }
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Data {
    pub items: Vec<Item>,
    #[serde(default)] pub settings: Settings,
}

pub fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

fn new_id() -> String {
    let mut b = [0u8; 12];
    OsRng.fill_bytes(&mut b);
    data_encoding::HEXLOWER.encode(&b)
}

fn derive(pw: &str, salt: &[u8], k: Kdf) -> Result<Zeroizing<[u8; 32]>, String> {
    let params = Params::new(k.m, k.t, k.p, Some(32)).map_err(|e| e.to_string())?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(pw.as_bytes(), salt, &mut *out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn seal(key: &[u8; 32], salt: &[u8; 16], k: Kdf, data: &Data) -> Result<Vec<u8>, String> {
    let plain = Zeroizing::new(serde_json::to_vec(data).map_err(|e| e.to_string())?);
    let mut out = Vec::with_capacity(HDR + NONCE + plain.len() + 16);
    out.extend_from_slice(MAGIC);
    for v in [k.m, k.t, k.p] { out.extend_from_slice(&v.to_le_bytes()); }
    out.extend_from_slice(salt);
    let mut nonce = [0u8; NONCE]; // fresh per save
    OsRng.fill_bytes(&mut nonce);
    let ct = XChaCha20Poly1305::new(Key::from_slice(key))
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: &plain, aad: &out[..HDR] })
        .map_err(|_| "encryption failed".to_string())?;
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn read_header(b: &[u8]) -> Result<(Kdf, [u8; 16]), String> {
    if b.len() < HDR + NONCE + 16 || &b[..4] != MAGIC { return Err("not a vault file".into()); }
    let u = |i: usize| u32::from_le_bytes(b[4 + i * 4..8 + i * 4].try_into().unwrap());
    let k = Kdf { m: u(0), t: u(1), p: u(2) };
    if k.m > 1 << 20 || k.t > 20 || k.p > 16 { return Err("unreasonable KDF settings".into()); }
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&b[16..32]);
    Ok((k, salt))
}

fn decrypt(key: &[u8; 32], b: &[u8]) -> Result<Data, String> {
    let pt = XChaCha20Poly1305::new(Key::from_slice(key))
        .decrypt(XNonce::from_slice(&b[HDR..HDR + NONCE]), Payload { msg: &b[HDR + NONCE..], aad: &b[..HDR] })
        .map_err(|_| "wrong password or damaged vault".to_string())?;
    let pt = Zeroizing::new(pt);
    serde_json::from_slice(&pt).map_err(|e| e.to_string())
}

fn ymd(z: i64) -> (i64, i64, i64) { // days since 1970-01-01 -> civil date
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + (m <= 2) as i64, m, d)
}

/// Inverse of `ymd`: civil date -> days since 1970-01-01.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - (m <= 2) as i64;
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468
}

/// "YYYY-MM-DD" -> days since 1970-01-01.
pub fn parse_date(s: &str) -> Option<i64> {
    let mut it = s.trim().split('-');
    let (y, m, d): (i64, i64, i64) = (it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next()?.parse().ok()?);
    if it.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) { return None; }
    Some(days_from_civil(y, m, d))
}

fn recovery_key(phrase: &str) -> Zeroizing<[u8; 32]> {
    let norm: String = phrase.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_uppercase();
    let mut h = Sha256::new();
    h.update(b"vault recovery v1");
    h.update(norm.as_bytes());
    Zeroizing::new(h.finalize().into())
}

/// 160 random bits as 8 groups of 4 base32 characters.
pub fn new_phrase() -> String {
    let mut b = [0u8; 20];
    OsRng.fill_bytes(&mut b);
    data_encoding::BASE32_NOPAD.encode(&b).as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-")
}

/// Writes through a temporary file, flushed to disk, then renames it over `path`: a crash leaves the old file or the new one, never half of one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let tmp = path.with_extension("tmp");
    let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| e.to_string())?;
    drop(f);
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Puts a chosen backup file in place of the vault (keeping a safety copy of the current one).
pub fn restore_file(vault: &Path, from: &Path) -> Result<(), String> {
    let b = fs::read(from).map_err(|e| e.to_string())?;
    read_header(&b)?;
    if from == vault { return Err("that is the current vault".into()); }
    if let (true, Some(dir)) = (vault.exists(), vault.parent().map(|d| d.join("backups"))) {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let (y, m, d) = ymd((now() / 86400) as i64);
        fs::copy(vault, dir.join(format!("pre-restore-{y:04}-{m:02}-{d:02}-{}.bin", now() % 86400))).map_err(|e| e.to_string())?;
    }
    write_atomic(vault, &b)
}

/// Decrypts vault-file bytes with a key (used by sync to look inside the server's copy).
pub fn read_data(bytes: &[u8], key: &[u8; 32]) -> Result<Data, String> { read_header(bytes)?; decrypt(key, bytes) }

/// Encrypts `data` with the same key, salt and cost as the vault file in `like`, so the result opens with the same master password.
pub fn reseal(like: &[u8], key: &[u8; 32], data: &Data) -> Result<Vec<u8>, String> { let (kdf, salt) = read_header(like)?; seal(key, &salt, kdf, data) }

/// Two copies of one vault that were changed on different PCs: every item once, the more recently changed copy wins; settings stay local.
pub fn merge_data(local: Data, remote: Data) -> Data {
    let mut by_id: std::collections::HashMap<String, Item> = remote.items.into_iter().map(|i| (i.id.clone(), i)).collect();
    for l in local.items { match by_id.get(&l.id) { Some(r) if r.updated > l.updated => {} _ => { by_id.insert(l.id.clone(), l); } } }
    let mut items: Vec<Item> = by_id.into_values().collect();
    items.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()).then(a.id.cmp(&b.id)));
    Data { items, settings: local.settings }
}

pub struct Session { key: Zeroizing<[u8; 32]>, salt: [u8; 16], kdf: Kdf, pub data: Data, path: PathBuf }

impl Session {
    pub fn create(path: &Path, pw: &str, kdf: Kdf) -> Result<Self, String> {
        if path.exists() { return Err("a vault already exists".into()); }
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let key = derive(pw, &salt, kdf)?;
        let s = Session { key, salt, kdf, data: Data::default(), path: path.to_path_buf() };
        s.save()?;
        Ok(s)
    }

    pub fn open(path: &Path, pw: &str) -> Result<Self, String> {
        let b = fs::read(path).map_err(|e| e.to_string())?;
        let (kdf, salt) = read_header(&b)?;
        let key = derive(pw, &salt, kdf)?;
        Self::load(path, &b, key, kdf, salt)
    }

    /// Opens with the already-derived key (quick unlock): no password, no Argon2.
    pub fn open_with_key(path: &Path, key: &[u8; 32]) -> Result<Self, String> {
        let b = fs::read(path).map_err(|e| e.to_string())?;
        let (kdf, salt) = read_header(&b)?;
        Self::load(path, &b, Zeroizing::new(*key), kdf, salt)
    }

    fn load(path: &Path, b: &[u8], key: Zeroizing<[u8; 32]>, kdf: Kdf, salt: [u8; 16]) -> Result<Self, String> {
        let mut data = decrypt(&key, b)?;
        data.items.retain(|i| i.deleted == 0 || now().saturating_sub(i.deleted) < TRASH_DAYS * 86400);
        Ok(Session { key, salt, kdf, data, path: path.to_path_buf() })
    }

    pub fn key(&self) -> Zeroizing<[u8; 32]> { Zeroizing::new(*self.key) }

    /// One backup per day (the file as it was before today's first save), newest 14 kept.
    fn backup(&self) {
        let Some(dir) = self.path.parent().map(|d| d.join("backups")) else { return };
        let _ = fs::create_dir_all(&dir);
        let (y, m, d) = ymd((now() / 86400) as i64);
        let f = dir.join(format!("vault-{y:04}-{m:02}-{d:02}.bin"));
        if !f.exists() { let _ = fs::copy(&self.path, &f); }
        let mut all: Vec<PathBuf> = fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.path())
            .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("vault-"))).collect(); // pre-restore copies are never pruned
        all.sort();
        while all.len() > KEEP_BACKUPS { let _ = fs::remove_file(all.remove(0)); }
    }

    pub fn save(&self) -> Result<(), String> {
        let bytes = seal(&self.key, &self.salt, self.kdf, &self.data)?;
        if self.path.exists() { self.backup(); }
        write_atomic(&self.path, &bytes)?;
        self.gc_attachments();
        Ok(())
    }

    pub fn upsert(&mut self, mut item: Item) -> Result<String, String> {
        if item.title.trim().is_empty() { return Err("title is required".into()); }
        item.updated = now();
        if item.id.is_empty() {
            item.id = new_id();
            item.history.clear();
            item.deleted = 0;
            item.attachments.clear();
            item.versions.clear();
            self.data.items.push(item.clone());
        } else {
            let slot = self.data.items.iter_mut().find(|i| i.id == item.id).ok_or("item not found")?;
            // history and trash state are the server's, never the client's
            let mut hist = slot.history.clone();
            for old in slot.fields.iter().filter(|f| f.kind != "text" && !f.value.is_empty()) {
                if item.fields.iter().any(|f| f.label == old.label && f.value != old.value) {
                    hist.push(Hist { label: old.label.clone(), value: old.value.clone(), at: item.updated });
                }
            }
            hist.drain(..hist.len().saturating_sub(KEEP_HISTORY));
            item.history = hist;
            item.deleted = slot.deleted;
            item.attachments = slot.attachments.clone();
            let mut versions = slot.versions.clone();
            if !slot.same_content(&item) { versions.push(slot.snapshot()); }
            versions.drain(..versions.len().saturating_sub(KEEP_VERSIONS));
            item.versions = versions;
            *slot = item.clone();
        }
        self.save()?;
        Ok(item.id)
    }

    /// First call moves the item to the trash, a second call (from the trash) deletes it for good.
    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        let it = self.data.items.iter_mut().find(|i| i.id == id).ok_or("item not found")?;
        // bumping `updated` lets a sync merge carry the trashing over to other PCs
        if it.deleted == 0 { it.deleted = now(); it.updated = it.deleted; } else { self.data.items.retain(|i| i.id != id); }
        self.save()
    }

    pub fn restore(&mut self, id: &str) -> Result<(), String> {
        let it = self.data.items.iter_mut().find(|i| i.id == id).ok_or("item not found")?;
        it.deleted = 0;
        it.updated = now();
        self.save()
    }

    pub fn empty_trash(&mut self) -> Result<usize, String> {
        let before = self.data.items.len();
        self.data.items.retain(|i| i.deleted == 0);
        self.save()?;
        Ok(before - self.data.items.len())
    }

    pub fn add_many(&mut self, items: Vec<Item>) -> Result<usize, String> {
        let field = |i: &Item, l: &str| i.fields.iter().find(|f| f.label == l).map(|f| f.value.clone()).unwrap_or_default();
        let mut n = 0;
        for mut it in items {
            let same = |e: &Item| e.deleted == 0 && e.title == it.title && ["Username", "Password", "One-time code"].iter().all(|l| field(e, l) == field(&it, l));
            let dup = self.data.items.iter().any(same);
            if dup { continue; }
            it.id = new_id();
            it.updated = now();
            self.data.items.push(it);
            n += 1;
        }
        if n > 0 { self.save()?; }
        Ok(n)
    }

    pub fn change_password(&mut self, old: &str, new: &str, kdf: Kdf) -> Result<(), String> {
        if *derive(old, &self.salt, self.kdf)? != *self.key { return Err("current password is wrong".into()); }
        self.set_password(new, kdf)
    }

    /// New salt and key; the recovery file (if any) is re-wrapped so the recovery key keeps working.
    fn set_password(&mut self, new: &str, kdf: Kdf) -> Result<(), String> {
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let key = derive(new, &salt, kdf)?;
        let prev = (std::mem::replace(&mut self.key, key), std::mem::replace(&mut self.salt, salt), std::mem::replace(&mut self.kdf, kdf));
        if let Err(e) = self.save() { (self.key, self.salt, self.kdf) = prev; return Err(e); }
        let phrase = self.data.settings.recovery_phrase.clone();
        if !phrase.is_empty() { self.recovery_write(&phrase)?; }
        Ok(())
    }

    fn recovery_write(&self, phrase: &str) -> Result<(), String> {
        let rk = recovery_key(phrase);
        let mut nonce = [0u8; NONCE];
        OsRng.fill_bytes(&mut nonce);
        let ct = XChaCha20Poly1305::new(Key::from_slice(&*rk)).encrypt(XNonce::from_slice(&nonce), Payload { msg: &self.key[..], aad: RMAGIC })
            .map_err(|_| "encryption failed".to_string())?;
        let mut out = RMAGIC.to_vec();
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        write_atomic(&self.path.with_file_name("recovery.bin"), &out)
    }

    /// Creates (or replaces) the recovery key and returns it to show once.
    pub fn enable_recovery(&mut self) -> Result<String, String> {
        let phrase = new_phrase();
        self.recovery_write(&phrase)?;
        self.data.settings.recovery_phrase = phrase.clone();
        self.save()?;
        Ok(phrase)
    }

    /// Forgot the master password: the recovery key opens the vault and a new master password is set.
    pub fn recover(path: &Path, phrase: &str, new_pw: &str, kdf: Kdf) -> Result<Self, String> {
        let b = fs::read(path.with_file_name("recovery.bin")).map_err(|_| "no recovery key was set up for this vault".to_string())?;
        if b.len() < 4 + NONCE + 16 || &b[..4] != RMAGIC { return Err("the recovery file is damaged".into()); }
        let rk = recovery_key(phrase);
        let key = XChaCha20Poly1305::new(Key::from_slice(&*rk)).decrypt(XNonce::from_slice(&b[4..4 + NONCE]), Payload { msg: &b[4 + NONCE..], aad: RMAGIC })
            .map_err(|_| "that recovery key is wrong".to_string())?;
        let key: [u8; 32] = key.try_into().map_err(|_| "the recovery file is damaged".to_string())?;
        let mut s = Self::open_with_key(path, &key)?;
        s.set_password(new_pw, kdf)?;
        Ok(s)
    }

    // ---- attachments: each file is its own XChaCha20-Poly1305 blob under the vault key, id as AAD
    fn att_dir(&self) -> PathBuf { self.path.with_file_name("attachments") }

    pub fn att_add(&mut self, item_id: &str, name: &str, bytes: &[u8]) -> Result<Att, String> {
        if bytes.len() > MAX_ATT { return Err("files can be at most 25 MB".into()); }
        if !self.data.items.iter().any(|i| i.id == item_id) { return Err("item not found".into()); }
        let id = new_id();
        let mut nonce = [0u8; NONCE];
        OsRng.fill_bytes(&mut nonce);
        let ct = XChaCha20Poly1305::new(Key::from_slice(&*self.key)).encrypt(XNonce::from_slice(&nonce), Payload { msg: bytes, aad: id.as_bytes() })
            .map_err(|_| "encryption failed".to_string())?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&ct);
        write_atomic(&self.att_dir().join(format!("{id}.bin")), &out)?;
        let att = Att { id, name: name.rsplit(['\\', '/']).next().unwrap_or(name).to_string(), size: bytes.len() as u64 };
        let it = self.data.items.iter_mut().find(|i| i.id == item_id).unwrap();
        it.attachments.push(att.clone());
        it.updated = now();
        self.save()?;
        Ok(att)
    }

    pub fn att_get(&self, att_id: &str) -> Result<Vec<u8>, String> {
        // only ids that an item references: no path tricks
        if !self.data.items.iter().any(|i| i.attachments.iter().any(|a| a.id == att_id)) { return Err("attachment not found".into()); }
        let b = fs::read(self.att_dir().join(format!("{att_id}.bin"))).map_err(|e| e.to_string())?;
        if b.len() < NONCE + 16 { return Err("attachment is damaged".into()); }
        XChaCha20Poly1305::new(Key::from_slice(&*self.key)).decrypt(XNonce::from_slice(&b[..NONCE]), Payload { msg: &b[NONCE..], aad: att_id.as_bytes() })
            .map_err(|_| "attachment is damaged".to_string())
    }

    pub fn att_remove(&mut self, item_id: &str, att_id: &str) -> Result<(), String> {
        let it = self.data.items.iter_mut().find(|i| i.id == item_id).ok_or("item not found")?;
        it.attachments.retain(|a| a.id != att_id);
        it.updated = now();
        self.save()
    }

    /// Deletes attachment files no item refers to any more (permanent delete, emptied trash). Only `.bin` files: a `.tmp`
    /// may be a download that sync is writing right now.
    fn gc_attachments(&self) {
        let keep: std::collections::HashSet<String> = self.data.items.iter().flat_map(|i| i.attachments.iter().map(|a| format!("{}.bin", a.id))).collect();
        for e in fs::read_dir(self.att_dir()).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.ends_with(".bin") && !keep.contains(&name) { let _ = fs::remove_file(e.path()); }
        }
    }

    // ---- bulk actions and duplicate
    pub fn bulk(&mut self, ids: &[String], op: &str, value: &str) -> Result<usize, String> {
        if !["folder", "favorite", "unfavorite", "trash", "restore", "tag", "untag"].contains(&op) { return Err("unknown action".into()); }
        let t = now();
        let mut n = 0;
        for it in self.data.items.iter_mut().filter(|i| ids.contains(&i.id)) {
            match op {
                "folder" => it.folder = value.trim().to_string(),
                "favorite" => it.favorite = true,
                "unfavorite" => it.favorite = false,
                "trash" => if it.deleted == 0 { it.deleted = t },
                "restore" => it.deleted = 0,
                "tag" => { let v = value.trim(); if !v.is_empty() && !it.tags.iter().any(|x| x == v) { it.tags.push(v.to_string()); } }
                _ => it.tags.retain(|x| x != value.trim()),
            }
            it.updated = t;
            n += 1;
        }
        if n > 0 { self.save()?; }
        Ok(n)
    }

    /// Puts an earlier version back; the current state becomes a version too, so a restore can be undone.
    pub fn restore_version(&mut self, id: &str, at: u64) -> Result<(), String> {
        let it = self.data.items.iter_mut().find(|i| i.id == id).ok_or("item not found")?;
        let v = it.versions.iter().find(|v| v.at == at).cloned().ok_or("that version no longer exists")?;
        if !it.same_content(&Item { title: v.title.clone(), folder: v.folder.clone(), tags: v.tags.clone(), notes: v.notes.clone(), expires: v.expires.clone(), category: v.category.clone(), fields: v.fields.clone(), ..Default::default() }) {
            let cur = it.snapshot();
            it.versions.push(cur);
            it.versions.drain(..it.versions.len().saturating_sub(KEEP_VERSIONS));
        }
        (it.title, it.folder, it.tags, it.notes, it.expires, it.category, it.fields) = (v.title, v.folder, v.tags, v.notes, v.expires, v.category, v.fields);
        it.updated = now().max(it.updated + 1); // a distinct timestamp so the restored state is its own point in time
        self.save()
    }

    pub fn duplicate(&mut self, id: &str) -> Result<String, String> {
        let mut c = self.data.items.iter().find(|i| i.id == id).ok_or("item not found")?.clone();
        c.id = new_id();
        c.title = format!("{} (copy)", c.title);
        c.history.clear();
        c.attachments.clear();
        c.versions.clear();
        c.deleted = 0;
        c.updated = now();
        self.data.items.push(c.clone());
        self.save()?;
        Ok(c.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const FAST: Kdf = Kdf { m: 8, t: 1, p: 1 };

    fn tmp() -> PathBuf {
        std::env::temp_dir().join(format!("vault-test-{}", new_id())).join("vault.bin")
    }
    fn item(t: &str) -> Item { Item { kind: "login".into(), title: t.into(), ..Default::default() } }

    #[test]
    fn roundtrip_and_wrong_password() {
        let p = tmp();
        let mut s = Session::create(&p, "correct horse", FAST).unwrap();
        let id = s.upsert(item("Bank")).unwrap();
        let s2 = Session::open(&p, "correct horse").unwrap();
        assert_eq!(s2.data.items.len(), 1);
        assert_eq!(s2.data.items[0].id, id);
        assert!(Session::open(&p, "wrong").is_err());
        assert!(Session::create(&p, "x", FAST).is_err(), "must not overwrite an existing vault");
    }

    #[test]
    fn open_with_the_derived_key() {
        let p = tmp();
        let s = Session::create(&p, "pw", FAST).unwrap();
        let k = s.key();
        assert!(Session::open_with_key(&p, &k).is_ok());
        assert!(Session::open_with_key(&p, &[7u8; 32]).is_err());
    }

    #[test]
    fn tampering_is_detected() {
        let p = tmp();
        Session::create(&p, "pw", FAST).unwrap();
        let good = fs::read(&p).unwrap();
        for pos in [5, 20, HDR + 3, good.len() - 1] { // KDF cost, salt, nonce, tag
            let mut b = good.clone();
            b[pos] ^= 1;
            fs::write(&p, &b).unwrap();
            assert!(Session::open(&p, "pw").is_err(), "flip at {pos} went unnoticed");
        }
    }

    #[test]
    fn every_save_uses_a_new_nonce_and_plaintext_is_not_stored() {
        let p = tmp();
        let mut s = Session::create(&p, "pw", FAST).unwrap();
        s.upsert(item("SecretTitle123")).unwrap();
        let a = fs::read(&p).unwrap();
        s.save().unwrap();
        let b = fs::read(&p).unwrap();
        assert_ne!(a[HDR..HDR + NONCE], b[HDR..HDR + NONCE]);
        assert!(!b.windows(14).any(|w| w == b"SecretTitle123"));
        assert!(p.parent().unwrap().join("backups").read_dir().unwrap().count() >= 1);
    }

    #[test]
    fn change_password_and_remove() {
        let p = tmp();
        let mut s = Session::create(&p, "old-pass", FAST).unwrap();
        let id = s.upsert(item("A")).unwrap();
        assert!(s.change_password("nope", "new-pass", FAST).is_err());
        s.change_password("old-pass", "new-pass", FAST).unwrap();
        assert!(Session::open(&p, "old-pass").is_err());
        let mut s = Session::open(&p, "new-pass").unwrap();
        s.remove(&id).unwrap(); // to the trash
        assert_eq!(Session::open(&p, "new-pass").unwrap().data.items.len(), 1);
        s.remove(&id).unwrap(); // for good
        assert!(s.remove(&id).is_err());
        assert!(Session::open(&p, "new-pass").unwrap().data.items.is_empty());
    }

    #[test]
    fn trash_restore_purge_and_history() {
        let p = tmp();
        let mut s = Session::create(&p, "pw", FAST).unwrap();
        let mut it = item("Site");
        it.fields = vec![Field { label: "Password".into(), value: "one".into(), kind: "secret".into() }];
        let id = s.upsert(it).unwrap();
        let mut edit = s.data.items[0].clone();
        edit.fields[0].value = "two".into();
        edit.history = vec![Hist { label: "x".into(), value: "forged".into(), at: 1 }]; // client cannot write history
        s.upsert(edit).unwrap();
        let h = &s.data.items[0].history;
        assert_eq!((h.len(), h[0].value.as_str()), (1, "one"));
        s.remove(&id).unwrap();
        assert!(s.data.items[0].deleted > 0);
        s.restore(&id).unwrap();
        assert_eq!(s.data.items[0].deleted, 0);
        s.remove(&id).unwrap();
        s.data.items[0].deleted = now() - 31 * 86400; // past the 30 days
        s.save().unwrap();
        assert!(Session::open(&p, "pw").unwrap().data.items.is_empty(), "old trash is purged on open");
        let mut s = Session::open(&p, "pw").unwrap();
        s.upsert(item("A")).unwrap();
        let a = s.data.items[0].id.clone();
        s.remove(&a).unwrap();
        assert_eq!(s.empty_trash().unwrap(), 1);
    }

    #[test]
    fn trash_and_restore_count_as_changes_for_sync() {
        let p = tmp();
        let mut s = Session::create(&p, "pw", FAST).unwrap();
        let id = s.upsert(item("A")).unwrap();
        s.data.items[0].updated = 1;
        s.remove(&id).unwrap();
        assert!(s.data.items[0].updated > 1, "trashing bumps updated");
        s.data.items[0].updated = 1;
        s.restore(&id).unwrap();
        assert!(s.data.items[0].updated > 1, "restoring bumps updated");
        // the trashed copy wins a merge against an older live copy
        let live = Data { items: vec![Item { updated: 5, ..s.data.items[0].clone() }], ..Default::default() };
        s.remove(&id).unwrap();
        assert!(merge_data(s.data.clone(), live).items[0].deleted > 0);
    }

    #[test]
    fn recovery_key_survives_a_password_change_and_opens_the_vault() {
        let p = tmp();
        let mut s = Session::create(&p, "first password", FAST).unwrap();
        s.upsert(item("Bank")).unwrap();
        let phrase = s.enable_recovery().unwrap();
        assert_eq!(phrase.len(), 39); // 8 groups of 4 + 7 dashes
        s.change_password("first password", "second password", FAST).unwrap(); // re-wraps recovery.bin
        assert!(Session::recover(&p, "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH", "x", FAST).is_err(), "wrong key");
        let r = Session::recover(&p, &phrase.to_lowercase().replace('-', " "), "third password", FAST).unwrap(); // case and separators do not matter
        assert_eq!(r.data.items.len(), 1);
        assert!(Session::open(&p, "second password").is_err());
        assert_eq!(Session::open(&p, "third password").unwrap().data.items[0].title, "Bank");
        let again = Session::open(&p, "third password").unwrap();
        assert!(Session::recover(&p, &phrase, "fourth password", FAST).is_ok() && again.data.settings.recovery_phrase == phrase, "still works after recovering");
    }

    #[test]
    fn attachments_are_encrypted_listed_and_cleaned_up() {
        let p = tmp();
        let mut s = Session::create(&p, "pw", FAST).unwrap();
        let id = s.upsert(item("Passport")).unwrap();
        let att = s.att_add(&id, "C:\\scans\\passport.pdf", b"TOP-SECRET-SCAN").unwrap();
        assert_eq!(att.name, "passport.pdf");
        let s2 = Session::open(&p, "pw").unwrap();
        assert_eq!(s2.att_get(&att.id).unwrap(), b"TOP-SECRET-SCAN");
        let file = p.with_file_name("attachments").join(format!("{}.bin", att.id));
        assert!(!fs::read(&file).unwrap().windows(10).any(|w| w == b"TOP-SECRET"));
        assert!(s2.att_get("../vault").is_err(), "unknown ids are refused");
        let mut edit = s.data.items[0].clone();
        edit.attachments.clear(); // the page cannot drop or forge attachments through save
        s.upsert(edit).unwrap();
        assert_eq!(s.data.items[0].attachments.len(), 1);
        s.att_remove(&id, &att.id).unwrap();
        assert!(!file.exists(), "removed attachment file is deleted");
        let a2 = s.att_add(&id, "x.txt", b"x").unwrap();
        s.remove(&id).unwrap();
        s.remove(&id).unwrap(); // permanent delete
        assert!(!p.with_file_name("attachments").join(format!("{}.bin", a2.id)).exists());
        assert!(s.att_add("nope", "x", b"x").is_err());
    }

    #[test]
    fn bulk_actions_duplicate_and_restore_file() {
        let p = tmp();
        let mut s = Session::create(&p, "pw", FAST).unwrap();
        let a = s.upsert(item("A")).unwrap();
        let b = s.upsert(item("B")).unwrap();
        let ids = vec![a.clone(), b.clone()];
        assert_eq!(s.bulk(&ids, "folder", " Work ").unwrap(), 2);
        s.bulk(&ids, "tag", "urgent").unwrap();
        s.bulk(&ids, "tag", "urgent").unwrap();
        s.bulk(&[a.clone()], "favorite", "").unwrap();
        assert!(s.data.items.iter().all(|i| i.folder == "Work" && i.tags == ["urgent"]));
        assert!(s.data.items[0].favorite && !s.data.items[1].favorite);
        s.bulk(&ids, "untag", "urgent").unwrap();
        assert!(s.data.items.iter().all(|i| i.tags.is_empty()));
        s.bulk(&[b.clone()], "trash", "").unwrap();
        assert!(s.data.items[1].deleted > 0);
        assert!(s.bulk(&ids, "explode", "").is_err());
        let d = s.duplicate(&a).unwrap();
        assert_eq!(s.data.items.iter().find(|i| i.id == d).unwrap().title, "A (copy)");
        // restore from a backup file keeps a safety copy
        let good = fs::read(&p).unwrap();
        let other = p.with_file_name("other.bin");
        let mut o = Session::create(&other, "otherpw", FAST).unwrap();
        o.upsert(item("Only in other")).unwrap();
        restore_file(&p, &other).unwrap();
        assert_eq!(Session::open(&p, "otherpw").unwrap().data.items[0].title, "Only in other");
        let safety = fs::read_dir(p.with_file_name("backups")).unwrap().flatten().find(|e| e.file_name().to_string_lossy().starts_with("pre-restore")).unwrap();
        assert!(fs::read(safety.path()).unwrap().len() > 100 && good.len() > 100);
        fs::write(&other, b"not a vault").unwrap();
        assert!(restore_file(&p, &other).is_err(), "garbage is refused");
    }

    #[test]
    fn versions_record_edits_cap_and_restore() {
        let p = tmp();
        let mut s = Session::create(&p, "pw", FAST).unwrap();
        let mut it = item("Bank");
        it.fields = vec![Field { label: "Username".into(), value: "me".into(), kind: "text".into() }];
        let id = s.upsert(it).unwrap();
        assert!(s.data.items[0].versions.is_empty());
        let same = s.data.items[0].clone();
        s.upsert(same).unwrap(); // a save without changes adds nothing
        assert!(s.data.items[0].versions.is_empty());
        let mut e = s.data.items[0].clone();
        e.title = "Bank 2".into();
        e.versions = vec![ItemVersion::default(); 3]; // the page cannot forge versions
        s.upsert(e).unwrap();
        assert_eq!(s.data.items[0].versions.len(), 1);
        assert_eq!(s.data.items[0].versions[0].title, "Bank");
        let at = s.data.items[0].versions[0].at;
        s.data.items[0].versions[0].at = 1; // make timestamps distinct for the lookup
        s.restore_version(&id, 1).unwrap();
        assert_eq!(s.data.items[0].title, "Bank");
        assert_eq!(s.data.items[0].versions.last().unwrap().title, "Bank 2", "restore can be undone");
        assert!(s.restore_version(&id, 999).is_err() && at > 0);
        for n in 0..40 { let mut e = s.data.items[0].clone(); e.notes = format!("n{n}"); s.upsert(e).unwrap(); }
        assert_eq!(s.data.items[0].versions.len(), 25, "oldest versions are dropped");
    }

    #[test]
    fn merging_two_pcs_keeps_everything_and_the_newer_edit() {
        let mut a = Data::default();
        let mut b = Data::default();
        let it = |id: &str, t: &str, u: u64| Item { id: id.into(), kind: "login".into(), title: t.into(), updated: u, ..Default::default() };
        a.items = vec![it("1", "old title", 10), it("2", "only here", 5), it("4", "tie local", 7)];
        b.items = vec![it("1", "new title", 20), it("3", "only there", 6), it("4", "tie remote", 7)];
        a.settings.accent = "rose".into();
        let m = merge_data(a, b);
        let t: Vec<(&str, &str)> = m.items.iter().map(|i| (i.id.as_str(), i.title.as_str())).collect();
        assert_eq!(t, [("1", "new title"), ("2", "only here"), ("3", "only there"), ("4", "tie local")]);
        assert_eq!(m.settings.accent, "rose");
    }

    #[test]
    fn dates() {
        assert_eq!(parse_date("2026-11-22"), Some(20_779));
        assert_eq!(parse_date(" 2000-02-29 "), Some(11_016));
        for d in [0i64, 11_016, 19_783, 20_779, 30_000] { let (y, m, dd) = ymd(d); assert_eq!(parse_date(&format!("{y}-{m}-{dd}")), Some(d)); }
        for bad in ["", "2026-13-01", "2026-11", "x-y-z", "2026-11-22-1"] { assert_eq!(parse_date(bad), None, "{bad}"); }
    }

    #[test]
    fn date_math() {
        assert_eq!(ymd(0), (1970, 1, 1));
        assert_eq!(ymd(20_779), (2026, 11, 22));
        assert_eq!(ymd(11_016), (2000, 2, 29));
        assert_eq!(ymd(19_783), (2024, 3, 1));
    }
}
