//! Encrypted vault file: Argon2id -> XChaCha20-Poly1305. The header (magic, KDF cost, salt) is
//! authenticated as AAD, so a tampered cost or salt fails to open instead of being trusted.
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{aead::{Aead, Payload}, Key, KeyInit, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use zeroize::Zeroizing;

const MAGIC: &[u8; 4] = b"VLT1";
const HDR: usize = 32; // magic 4 + m,t,p 12 + salt 16
const NONCE: usize = 24;
const KEEP_BACKUPS: usize = 14;
const TRASH_DAYS: u64 = 30;
const KEEP_HISTORY: usize = 20;

#[derive(Clone, Copy)]
pub struct Kdf { pub m: u32, pub t: u32, pub p: u32 }
/// 64 MiB, 3 passes: about 0.3 s per unlock on a desktop.
pub const KDF: Kdf = Kdf { m: 65536, t: 3, p: 1 };

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Field { pub label: String, pub value: String, pub kind: String } // kind: text | secret | totp

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Hist { pub label: String, pub value: String, pub at: u64 }

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
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    #[serde(default = "d_auto")] pub autolock_min: u32, // 0 = never
    #[serde(default = "d_clip")] pub clip_secs: u64,    // 0 = never clear
}
fn d_auto() -> u32 { 5 }
fn d_clip() -> u64 { 20 }
impl Default for Settings { fn default() -> Self { Settings { autolock_min: d_auto(), clip_secs: d_clip() } } }

#[derive(Serialize, Deserialize, Default)]
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
        let mut all: Vec<PathBuf> = fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.path()).collect();
        all.sort();
        while all.len() > KEEP_BACKUPS { let _ = fs::remove_file(all.remove(0)); }
    }

    pub fn save(&self) -> Result<(), String> {
        let bytes = seal(&self.key, &self.salt, self.kdf, &self.data)?;
        if let Some(dir) = self.path.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
        if self.path.exists() { self.backup(); }
        let tmp = self.path.with_extension("tmp");
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&bytes).and_then(|_| f.sync_all()).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }

    pub fn upsert(&mut self, mut item: Item) -> Result<String, String> {
        if item.title.trim().is_empty() { return Err("title is required".into()); }
        item.updated = now();
        if item.id.is_empty() {
            item.id = new_id();
            item.history.clear();
            item.deleted = 0;
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
            *slot = item.clone();
        }
        self.save()?;
        Ok(item.id)
    }

    /// First call moves the item to the trash, a second call (from the trash) deletes it for good.
    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        let it = self.data.items.iter_mut().find(|i| i.id == id).ok_or("item not found")?;
        if it.deleted == 0 { it.deleted = now(); } else { self.data.items.retain(|i| i.id != id); }
        self.save()
    }

    pub fn restore(&mut self, id: &str) -> Result<(), String> {
        self.data.items.iter_mut().find(|i| i.id == id).ok_or("item not found")?.deleted = 0;
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
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let key = derive(new, &salt, kdf)?;
        let prev = (std::mem::replace(&mut self.key, key), std::mem::replace(&mut self.salt, salt), std::mem::replace(&mut self.kdf, kdf));
        if let Err(e) = self.save() { (self.key, self.salt, self.kdf) = prev; return Err(e); }
        Ok(())
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
    fn date_math() {
        assert_eq!(ymd(0), (1970, 1, 1));
        assert_eq!(ymd(20_779), (2026, 11, 22));
        assert_eq!(ymd(11_016), (2000, 2, 29));
        assert_eq!(ymd(19_783), (2024, 3, 1));
    }
}
