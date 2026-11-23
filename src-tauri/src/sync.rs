//! Sync with the user's own server. Only encrypted files travel: the vault file, the recovery file and attachments.
//! The engine is separate from the network (`Remote`) so two-PC situations can be tested without a server.
//!   plan   (network, reads): compare local, last-synced and server copies and decide what to do
//!   apply  (file write, under the app's session lock): put an adopted or merged vault file in place
//!   finish (network): upload or confirm, then bring attachments and the recovery file level
use crate::vault;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::{Path, PathBuf}, time::{Duration, UNIX_EPOCH}};

pub enum Put { Ok(u64), Conflict(u64) }

pub trait Remote {
    fn rev(&self) -> Result<u64, String>;
    fn get_vault(&self) -> Result<Option<(Vec<u8>, u64)>, String>;
    fn put_vault(&self, data: &[u8], if_match: u64) -> Result<Put, String>;
    fn get_recovery(&self) -> Result<Option<Vec<u8>>, String>;
    fn put_recovery(&self, data: &[u8]) -> Result<(), String>;
    fn list_att(&self) -> Result<Vec<String>, String>;
    fn get_att(&self, id: &str) -> Result<Option<Vec<u8>>, String>;
    fn put_att(&self, id: &str, data: &[u8]) -> Result<(), String>;
    fn del_att(&self, id: &str) -> Result<(), String>;
}

/// `size` and `mtime` (ns) describe vault.bin when its hash was last confirmed equal to `hash`; 0 = unknown.
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct State { pub rev: u64, pub hash: String, pub at: u64, #[serde(default)] pub size: u64, #[serde(default)] pub mtime: u64 }

/// How many pre-sync safety copies of the vault file to keep in backups/.
const KEEP_PRE_SYNC: usize = 10;

fn hash(b: &[u8]) -> String { data_encoding::HEXLOWER.encode(&Sha256::digest(b)) }
fn stamp(p: &Path) -> Option<(u64, u64)> {
    let m = fs::metadata(p).ok()?;
    Some((m.len(), m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos() as u64))
}
pub fn load_state(dir: &Path) -> State { fs::read(dir.join("sync.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default() }
fn save_state(dir: &Path, rev: u64, h: String) {
    // remember the file's size and time only if the file on disk really is the synced one (a save may have slipped in)
    let p = dir.join("vault.bin");
    let before = stamp(&p);
    let (size, mtime) = match (before, fs::read(&p)) { (Some(st), Ok(b)) if hash(&b) == h => st, _ => (0, 0) };
    let state = State { rev, hash: h, at: vault::now(), size, mtime };
    let _ = vault::write_atomic(&dir.join("sync.json"), &serde_json::to_vec(&state).unwrap_or_default());
}
/// True when the vault file differs from what was last synced. Checked every few seconds, so an unchanged size and
/// modification time answer without reading and hashing the whole file.
pub fn pending(dir: &Path) -> bool {
    let (p, st) = (dir.join("vault.bin"), load_state(dir));
    if st.size > 0 && stamp(&p) == Some((st.size, st.mtime)) { return false; }
    fs::read(&p).map(|b| hash(&b) != st.hash).unwrap_or(false)
}

/// A copy of the vault file as it was before sync replaced it, newest few kept.
fn keep_pre_sync(dir: &Path) -> Result<(), String> {
    let b = dir.join("backups");
    fs::create_dir_all(&b).map_err(|e| e.to_string())?;
    fs::copy(dir.join("vault.bin"), b.join(format!("pre-sync-{:012}.bin", vault::now()))).map_err(|e| e.to_string())?;
    let mut all: Vec<PathBuf> = fs::read_dir(&b).into_iter().flatten().flatten().map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("pre-sync-"))).collect();
    all.sort();
    while all.len() > KEEP_PRE_SYNC { let _ = fs::remove_file(all.remove(0)); }
    Ok(())
}

pub enum Plan { Idle, Push { local: Vec<u8>, if_match: u64 }, Adopt { bytes: Vec<u8>, rev: u64, base: String }, Merge { bytes: Vec<u8>, rev: u64, base: String } }
#[derive(Debug, PartialEq)]
pub enum Outcome { UpToDate, Pushed, Pulled, Merged, Retry }

pub fn plan(dir: &Path, remote: &dyn Remote, key: &[u8; 32]) -> Result<Plan, String> {
    let local = fs::read(dir.join("vault.bin")).map_err(|e| e.to_string())?;
    let (lh, st, r) = (hash(&local), load_state(dir), remote.rev()?);
    let changed = lh != st.hash;
    if r == 0 { return Ok(Plan::Push { local, if_match: 0 }); } // the server is empty: first upload
    if r == st.rev { return Ok(if changed { Plan::Push { local, if_match: r } } else { Plan::Idle }); }
    let (blob, rev) = remote.get_vault()?.ok_or("the server lost the vault")?;
    if !changed { return Ok(Plan::Adopt { bytes: blob, rev, base: lh }); }
    let theirs = vault::read_data(&blob, key).map_err(|_| "the server copy belongs to a different master password. Restore from the server on a new PC, or turn sync off here.".to_string())?;
    let mine = vault::read_data(&local, key)?;
    Ok(Plan::Merge { bytes: vault::reseal(&local, key, &vault::merge_data(mine, theirs))?, rev, base: lh })
}

/// Writes the adopted or merged vault in place, but only if the file is still what the plan was made from.
pub fn apply(dir: &Path, plan: &Plan) -> Result<(), String> {
    let (bytes, base) = match plan { Plan::Adopt { bytes, base, .. } | Plan::Merge { bytes, base, .. } => (bytes, base), _ => return Ok(()) };
    let path = dir.join("vault.bin");
    if hash(&fs::read(&path).map_err(|e| e.to_string())?) != *base { return Err("the vault changed while syncing; it will be tried again".into()); }
    keep_pre_sync(dir)?;
    vault::write_atomic(&path, bytes)
}

pub fn finish(dir: &Path, remote: &dyn Remote, plan: &Plan, key: &[u8; 32]) -> Result<Outcome, String> {
    let out = match plan {
        Plan::Idle => return Ok(Outcome::UpToDate),
        Plan::Push { local, if_match } => match remote.put_vault(local, *if_match)? {
            Put::Ok(rev) => { save_state(dir, rev, hash(local)); push_recovery(dir, remote)?; Outcome::Pushed }
            Put::Conflict(_) => return Ok(Outcome::Retry),
        },
        Plan::Adopt { bytes, rev, .. } => {
            save_state(dir, *rev, hash(bytes));
            if let Some(r) = remote.get_recovery()? { let _ = vault::write_atomic(&dir.join("recovery.bin"), &r); }
            Outcome::Pulled
        }
        Plan::Merge { bytes, rev, .. } => match remote.put_vault(bytes, *rev)? {
            Put::Ok(new) => { save_state(dir, new, hash(bytes)); push_recovery(dir, remote)?; Outcome::Merged }
            Put::Conflict(_) => return Ok(Outcome::Retry),
        },
    };
    attachments(dir, remote, key)?;
    Ok(out)
}

fn push_recovery(dir: &Path, remote: &dyn Remote) -> Result<(), String> {
    match fs::read(dir.join("recovery.bin")) { Ok(b) => remote.put_recovery(&b), Err(_) => Ok(()) }
}

/// Uploads attachment files the server lacks, downloads the ones this PC lacks, and deletes server files that the
/// vault no longer refers to. Only called right after this PC's vault became the server's current one (push, merge or
/// adopt), so "not referenced" means deleted everywhere, not "added on another PC that we have not seen yet".
fn attachments(dir: &Path, remote: &dyn Remote, key: &[u8; 32]) -> Result<(), String> {
    let data = vault::read_data(&fs::read(dir.join("vault.bin")).map_err(|e| e.to_string())?, key)?;
    let want: Vec<&str> = data.items.iter().flat_map(|i| i.attachments.iter().map(|a| a.id.as_str())).collect();
    let have = remote.list_att()?;
    for gone in have.iter().filter(|h| !want.contains(&h.as_str())) { remote.del_att(gone)?; }
    let adir = dir.join("attachments");
    for id in want {
        let f = adir.join(format!("{id}.bin"));
        if f.exists() { if !have.iter().any(|h| h == id) { remote.put_att(id, &fs::read(&f).map_err(|e| e.to_string())?)?; } }
        else if have.iter().any(|h| h == id) {
            if let Some(b) = remote.get_att(id)? { vault::write_atomic(&f, &b)?; }
        }
    }
    Ok(())
}

/// A new PC: copy the vault, recovery file and attachments from the server (needs no password; the vault opens with the master password).
pub fn restore(dir: &Path, remote: &dyn Remote) -> Result<(), String> {
    if dir.join("vault.bin").exists() { return Err("this PC already has a vault".into()); }
    let (blob, rev) = remote.get_vault()?.ok_or("nothing is stored on the server for that sync key")?;
    if let Some(r) = remote.get_recovery()? { vault::write_atomic(&dir.join("recovery.bin"), &r)?; }
    let adir = dir.join("attachments");
    for id in remote.list_att()? { if let Some(b) = remote.get_att(&id)? { vault::write_atomic(&adir.join(format!("{id}.bin")), &b)?; } }
    vault::write_atomic(&dir.join("vault.bin"), &blob)?; // last: a restore cut short leaves no vault, so it can simply be run again
    save_state(dir, rev, hash(&blob));
    Ok(())
}

// ---------- HTTP ----------
pub struct HttpRemote { base: String, token: String, agent: ureq::Agent }

impl HttpRemote {
    pub fn new(url: &str, token: &str) -> Result<Self, String> {
        let base = url.trim().trim_end_matches('/').to_string();
        if !(base.starts_with("http://") || base.starts_with("https://")) { return Err("the server address must start with http:// or https://".into()); }
        Ok(HttpRemote { base, token: token.into(), agent: ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(4)).timeout(Duration::from_secs(90)).build() })
    }
    fn call(&self, method: &str, path: &str, body: Option<&[u8]>) -> Result<Option<Vec<u8>>, String> {
        let req = self.agent.request(method, &format!("{}{path}", self.base)).set("Authorization", &format!("Bearer {}", self.token));
        match if let Some(b) = body { req.send_bytes(b) } else { req.call() } {
            Ok(r) => { let mut v = vec![]; r.into_reader().take(70 << 20).read_to_end(&mut v).map_err(|e| e.to_string())?; Ok(Some(v)) }
            Err(ureq::Error::Status(404, _)) => Ok(None),
            Err(ureq::Error::Status(401, _)) => Err("the server refused the sync key".into()),
            Err(ureq::Error::Status(c, r)) => { let mut v = vec![]; let _ = r.into_reader().take(1 << 16).read_to_end(&mut v); Err(format!("HTTP {c}: {}", String::from_utf8_lossy(&v))) }
            Err(e) => Err(format!("cannot reach the sync server: {e}")),
        }
    }
}

/// The `rev` field of a small JSON answer.
fn rev_of(r: ureq::Response) -> Option<u64> {
    let mut v = vec![];
    r.into_reader().take(1 << 16).read_to_end(&mut v).ok()?;
    serde_json::from_slice::<serde_json::Value>(&v).ok()?["rev"].as_u64()
}

impl Remote for HttpRemote {
    fn rev(&self) -> Result<u64, String> {
        let b = self.call("GET", "/v1/info", None)?.ok_or("no answer")?;
        serde_json::from_slice::<serde_json::Value>(&b).ok().and_then(|v| v["rev"].as_u64()).ok_or_else(|| "unexpected answer from the server".into())
    }
    fn get_vault(&self) -> Result<Option<(Vec<u8>, u64)>, String> {
        // the revision comes from /v1/info first, then the blob: ask for info again after to catch a write in between
        let before = self.rev()?;
        let Some(b) = self.call("GET", "/v1/vault", None)? else { return Ok(None) };
        let after = self.rev()?;
        if before != after { return Err("the server changed while downloading; it will be tried again".into()); }
        Ok(Some((b, after)))
    }
    fn put_vault(&self, data: &[u8], if_match: u64) -> Result<Put, String> {
        let req = self.agent.put(&format!("{}/v1/vault", self.base)).set("Authorization", &format!("Bearer {}", self.token)).set("If-Match", &if_match.to_string());
        match req.send_bytes(data) {
            Ok(r) => Ok(Put::Ok(rev_of(r).ok_or("unexpected answer from the server")?)),
            Err(ureq::Error::Status(409, r)) => Ok(Put::Conflict(rev_of(r).unwrap_or(0))),
            Err(ureq::Error::Status(401, _)) => Err("the server refused the sync key".into()),
            Err(ureq::Error::Status(c, _)) => Err(format!("HTTP {c} from the sync server")),
            Err(e) => Err(format!("cannot reach the sync server: {e}")),
        }
    }
    fn get_recovery(&self) -> Result<Option<Vec<u8>>, String> { self.call("GET", "/v1/recovery", None) }
    fn put_recovery(&self, data: &[u8]) -> Result<(), String> { self.call("PUT", "/v1/recovery", Some(data)).map(|_| ()) }
    fn list_att(&self) -> Result<Vec<String>, String> {
        let b = self.call("GET", "/v1/att", None)?.ok_or("no answer")?;
        Ok(serde_json::from_slice::<Vec<serde_json::Value>>(&b).map_err(|e| e.to_string())?.iter().filter_map(|v| v["id"].as_str().map(String::from)).collect())
    }
    fn get_att(&self, id: &str) -> Result<Option<Vec<u8>>, String> { self.call("GET", &format!("/v1/att/{id}"), None) }
    fn put_att(&self, id: &str, data: &[u8]) -> Result<(), String> { self.call("PUT", &format!("/v1/att/{id}"), Some(data)).map(|_| ()) }
    fn del_att(&self, id: &str) -> Result<(), String> { self.call("DELETE", &format!("/v1/att/{id}"), None).map(|_| ()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{Item, Kdf, Session};
    use std::{cell::RefCell, collections::HashMap};

    const FAST: Kdf = Kdf { m: 8, t: 1, p: 1 };

    #[derive(Default)]
    struct Fake { vault: RefCell<Option<(Vec<u8>, u64)>>, rec: RefCell<Option<Vec<u8>>>, atts: RefCell<HashMap<String, Vec<u8>>> }
    impl Remote for Fake {
        fn rev(&self) -> Result<u64, String> { Ok(self.vault.borrow().as_ref().map(|v| v.1).unwrap_or(0)) }
        fn get_vault(&self) -> Result<Option<(Vec<u8>, u64)>, String> { Ok(self.vault.borrow().clone()) }
        fn put_vault(&self, d: &[u8], m: u64) -> Result<Put, String> {
            let cur = self.rev()?;
            if cur != m { return Ok(Put::Conflict(cur)); }
            *self.vault.borrow_mut() = Some((d.to_vec(), cur + 1));
            Ok(Put::Ok(cur + 1))
        }
        fn get_recovery(&self) -> Result<Option<Vec<u8>>, String> { Ok(self.rec.borrow().clone()) }
        fn put_recovery(&self, d: &[u8]) -> Result<(), String> { *self.rec.borrow_mut() = Some(d.to_vec()); Ok(()) }
        fn list_att(&self) -> Result<Vec<String>, String> { Ok(self.atts.borrow().keys().cloned().collect()) }
        fn get_att(&self, id: &str) -> Result<Option<Vec<u8>>, String> { Ok(self.atts.borrow().get(id).cloned()) }
        fn put_att(&self, id: &str, d: &[u8]) -> Result<(), String> { self.atts.borrow_mut().insert(id.into(), d.to_vec()); Ok(()) }
        fn del_att(&self, id: &str) -> Result<(), String> { self.atts.borrow_mut().remove(id); Ok(()) }
    }

    fn dir() -> std::path::PathBuf { std::env::temp_dir().join(format!("vault-sync-{}", vault::now() as u128 * 1000 + rand_id())) }
    fn rand_id() -> u128 { use rand::RngCore; rand::rngs::OsRng.next_u64() as u128 }
    fn item(t: &str) -> Item { Item { kind: "login".into(), title: t.into(), ..Default::default() } }
    /// One sync round the way the app does it: plan, apply, finish. Returns the outcome and reloads the session from disk.
    fn round(d: &Path, r: &Fake, s: &mut Session, pw: &str) -> Outcome {
        let key = s.key();
        let p = plan(d, r, &key).unwrap();
        apply(d, &p).unwrap();
        let o = finish(d, r, &p, &key).unwrap();
        *s = Session::open(&d.join("vault.bin"), pw).unwrap();
        o
    }

    #[test]
    fn two_pcs_push_pull_merge_with_attachments_and_recovery() {
        let (da, db, srv) = (dir(), dir(), Fake::default());
        let mut a = Session::create(&da.join("vault.bin"), "pw-one-two", FAST).unwrap();
        a.upsert(item("one")).unwrap();
        assert_eq!(round(&da, &srv, &mut a, "pw-one-two"), Outcome::Pushed);
        assert_eq!(round(&da, &srv, &mut a, "pw-one-two"), Outcome::UpToDate);
        // a new PC restores from the server and opens it with the master password
        restore(&db, &srv).unwrap();
        let mut b = Session::open(&db.join("vault.bin"), "pw-one-two").unwrap();
        assert_eq!(b.data.items.len(), 1);
        assert!(restore(&db, &srv).is_err(), "never restore over an existing vault");
        // B changes, A picks it up
        b.upsert(item("two")).unwrap();
        assert_eq!(round(&db, &srv, &mut b, "pw-one-two"), Outcome::Pushed);
        assert_eq!(round(&da, &srv, &mut a, "pw-one-two"), Outcome::Pulled);
        assert_eq!(a.data.items.len(), 2);
        // both change at once: B syncs first, A merges, B adopts the merge
        a.upsert(item("three")).unwrap();
        b.upsert(item("four")).unwrap();
        assert_eq!(round(&db, &srv, &mut b, "pw-one-two"), Outcome::Pushed);
        assert_eq!(round(&da, &srv, &mut a, "pw-one-two"), Outcome::Merged);
        assert_eq!(a.data.items.len(), 4);
        assert_eq!(round(&db, &srv, &mut b, "pw-one-two"), Outcome::Pulled);
        let titles = |s: &Session| { let mut t: Vec<String> = s.data.items.iter().map(|i| i.title.clone()).collect(); t.sort(); t };
        assert_eq!(titles(&a), titles(&b));
        assert_eq!(titles(&b), ["four", "one", "three", "two"]);
        // an attachment and the recovery key follow
        let one = a.data.items.iter().find(|i| i.title == "one").unwrap().id.clone();
        a.att_add(&one, "scan.pdf", b"PDF-BYTES").unwrap();
        a.enable_recovery().unwrap();
        assert_eq!(round(&da, &srv, &mut a, "pw-one-two"), Outcome::Pushed);
        assert_eq!(round(&db, &srv, &mut b, "pw-one-two"), Outcome::Pulled);
        let att = b.data.items.iter().find(|i| i.id == one).unwrap().attachments[0].id.clone();
        assert_eq!(b.att_get(&att).unwrap(), b"PDF-BYTES");
        assert!(db.join("recovery.bin").exists());
        assert!(!srv.vault.borrow().as_ref().unwrap().0.windows(9).any(|w| w == b"PDF-BYTES"), "only encrypted data goes to the server");
        // removing the attachment removes it from the server too
        assert_eq!(srv.atts.borrow().len(), 1);
        b.att_remove(&one, &att).unwrap();
        assert_eq!(round(&db, &srv, &mut b, "pw-one-two"), Outcome::Pushed);
        assert!(srv.atts.borrow().is_empty(), "server copy deleted");
        assert_eq!(round(&da, &srv, &mut a, "pw-one-two"), Outcome::Pulled);
        assert!(a.data.items.iter().all(|i| i.attachments.is_empty()));
    }

    #[test]
    fn a_race_is_retried_and_a_foreign_vault_is_not_merged() {
        let (da, db, srv) = (dir(), dir(), Fake::default());
        let mut a = Session::create(&da.join("vault.bin"), "pw-a-pw-a", FAST).unwrap();
        a.upsert(item("x")).unwrap();
        let key = a.key();
        let p = plan(&da, &srv, &key).unwrap();
        *srv.vault.borrow_mut() = Some((b"VLT1-someone-else".to_vec(), 5)); // the server moved on after we planned
        assert_eq!(finish(&da, &srv, &p, &key).unwrap(), Outcome::Retry);
        // another PC's different vault: both changed, different key -> clear error, nothing overwritten
        let mut other = Session::create(&db.join("vault.bin"), "different-pw-1", FAST).unwrap();
        other.upsert(item("y")).unwrap();
        *srv.vault.borrow_mut() = Some((std::fs::read(db.join("vault.bin")).unwrap(), 7));
        let err = plan(&da, &srv, &key).err().unwrap();
        assert!(err.contains("different master password"), "{err}");
        // apply refuses when the local file changed after planning
        let p2 = Plan::Adopt { bytes: b"x".to_vec(), rev: 8, base: "not-the-hash".into() };
        assert!(apply(&da, &p2).is_err());
    }

    #[test]
    fn pending_tracks_local_changes() {
        let (d, srv) = (dir(), Fake::default());
        let mut a = Session::create(&d.join("vault.bin"), "pw-pending-1", FAST).unwrap();
        assert!(pending(&d));
        round(&d, &srv, &mut a, "pw-pending-1");
        assert!(!pending(&d));
        a.upsert(item("z")).unwrap();
        assert!(pending(&d));
        round(&d, &srv, &mut a, "pw-pending-1");
        let st = load_state(&d);
        assert!(st.size > 0 && st.mtime > 0, "a confirmed sync remembers size and time");
        // same size, new time: falls back to the hash, which still matches
        let b = fs::read(d.join("vault.bin")).unwrap();
        fs::write(d.join("vault.bin"), &b).unwrap();
        assert!(!pending(&d));
        let mut changed = b.clone();
        let n = changed.len() - 1;
        changed[n] ^= 1;
        fs::write(d.join("vault.bin"), &changed).unwrap();
        assert!(pending(&d), "same size, different bytes");
    }

    #[test]
    fn adopting_the_server_copy_keeps_a_safety_copy() {
        let (da, db, srv) = (dir(), dir(), Fake::default());
        let mut a = Session::create(&da.join("vault.bin"), "pw-copy-123", FAST).unwrap();
        a.upsert(item("one")).unwrap();
        round(&da, &srv, &mut a, "pw-copy-123");
        restore(&db, &srv).unwrap();
        let mut b = Session::open(&db.join("vault.bin"), "pw-copy-123").unwrap();
        b.upsert(item("two")).unwrap();
        round(&db, &srv, &mut b, "pw-copy-123");
        assert_eq!(round(&da, &srv, &mut a, "pw-copy-123"), Outcome::Pulled);
        let copies: Vec<_> = fs::read_dir(da.join("backups")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("pre-sync-")).collect();
        assert_eq!(copies.len(), 1);
    }
}
