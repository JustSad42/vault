//! The browser extension's link to the app. A loopback-only server (port in bridge.json) speaks one JSON object per line.
//! Nothing but `ping`, `show` and `pair` works without a pairing token; after that every request is limited to what the page
//! it comes from may see: logins are only returned or filled for the same site, and a look-alike site gets a warning, never a login.
use crate::{domain, gen, passkey, totp, vault::{self, Field, Item, Paired}, App};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::{BufRead, BufReader, Read, Write}, net::{TcpListener, TcpStream}, sync::Mutex, time::{Duration, Instant}};
use tauri::{AppHandle, Manager};

/// The native host relays messages of at most 4 MiB; a longer line drops the connection instead of growing without bound.
const MAX_LINE: usize = 4 * 1024 * 1024 + 1024;

static PAIRING: Mutex<Option<(String, Instant, u8)>> = Mutex::new(None);

/// A six-digit code the user types into the extension within two minutes.
pub fn start_pairing() -> String {
    let n = OsRng.next_u32() % 1_000_000;
    let code = format!("{n:06}");
    *PAIRING.lock().unwrap() = Some((code.clone(), Instant::now() + Duration::from_secs(120), 0));
    code
}

fn hex(b: &[u8]) -> String { data_encoding::HEXLOWER.encode(b) }
fn token_hash(t: &str) -> String { hex(&Sha256::digest(t.as_bytes())) }
fn field<'a>(i: &'a Item, l: &str) -> &'a str { i.fields.iter().find(|f| f.label == l).map(|f| f.value.as_str()).unwrap_or("") }

fn sites_of(i: &Item) -> Vec<&str> {
    i.fields.iter().filter(|f| (f.label == "Website" || f.label.starts_with("Website ") || f.label == "URL" || f.label.starts_with("Extra site")) && !f.value.is_empty()).map(|f| f.value.as_str()).collect()
}

fn alive<'a>(items: &'a [Item], kind: &'a str) -> impl Iterator<Item = &'a Item> { items.iter().filter(move |i| i.deleted == 0 && i.kind == kind) }

pub fn serve(app: AppHandle) {
    let Ok(l) = TcpListener::bind("127.0.0.1:0") else { return };
    let port = l.local_addr().map(|a| a.port()).unwrap_or(0);
    let _ = std::fs::create_dir_all(crate::vault_dir());
    let _ = std::fs::write(crate::vault_dir().join("bridge.json"), json!({ "port": port }).to_string());
    for c in l.incoming().flatten() {
        let app = app.clone();
        std::thread::spawn(move || handle(app, c));
    }
}

fn handle(app: AppHandle, stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(600)));
    let Ok(mut w) = stream.try_clone() else { return };
    let mut r = BufReader::new(stream);
    loop {
        let mut line = Vec::new();
        match (&mut r).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line) { Ok(0) | Err(_) => break, Ok(_) => {} }
        if line.len() > MAX_LINE { break; }
        let Ok(req) = serde_json::from_slice::<Value>(&line) else { continue };
        let mut resp = dispatch(&app, &req).unwrap_or_else(|e| json!({ "error": e }));
        resp["rid"] = req["rid"].clone(); // `id` is the item id in many requests, so the message id has its own name
        if writeln!(w, "{resp}").is_err() { break; }
    }
}

fn s<'a>(r: &'a Value, k: &str) -> Result<&'a str, String> { r[k].as_str().ok_or_else(|| format!("missing {k}")) }

fn dispatch(app: &AppHandle, r: &Value) -> Result<Value, String> {
    let cmd = s(r, "cmd")?;
    let st = app.state::<App>();
    if let (Some(u), Some(t)) = (r["url"].as_str(), r["top"].as_str()) {
        if !domain::same_site(u, t) && cmd != "ping" && cmd != "show" { return Err("this frame belongs to a different site than the page".into()); }
    }
    match cmd {
        "ping" => return Ok(json!({ "ok": true, "locked": st.0.lock().unwrap().is_none(), "version": env!("CARGO_PKG_VERSION") })),
        "show" => { crate::show(app); return Ok(json!({ "ok": true })); }
        "pair" => return pair(&st, r),
        _ => {}
    }
    let mut g = st.0.lock().unwrap();
    let Some(sess) = g.as_mut() else { return Ok(json!({ "locked": true })) };
    let h = token_hash(r["token"].as_str().unwrap_or(""));
    if !sess.data.settings.paired.iter().any(|p| p.hash == h) { return Ok(json!({ "unpaired": true })); }
    let items = &sess.data.items;
    match cmd {
        "match" => {
            let url = s(r, "url")?;
            let host = domain::host_of(url).ok_or("bad url")?;
            let mut logins: Vec<&Item> = alive(items, "login").filter(|i| sites_of(i).iter().any(|w| domain::same_site(w, url))).collect();
            logins.sort_by_key(|i| (!sites_of(i).iter().any(|w| domain::host_of(w).as_deref() == Some(&host)), i.title.to_lowercase()));
            let look = if logins.is_empty() {
                alive(items, "login").find_map(|i| sites_of(i).into_iter().find(|w| domain::host_of(w).is_some_and(|sh| domain::lookalike(&host, &sh))).map(|w| json!({ "title": i.title, "site": domain::host_of(w) })))
            } else { None };
            Ok(json!({ "logins": logins.iter().map(|i| json!({ "id": i.id, "title": i.title, "username": field(i, "Username"), "totp": i.fields.iter().any(|f| f.kind == "totp" && !f.value.is_empty()) })).collect::<Vec<_>>(),
                "lookalike": look, "https": url.starts_with("https://") || host == "localhost", "passkeys": alive(items, "passkey").filter(|i| field(i, "Website") == host || host.ends_with(&format!(".{}", field(i, "Website")))).count() }))
        }
        "fill" => {
            let url = s(r, "url")?;
            let i = items.iter().find(|i| i.id == s(r, "id").unwrap_or("") && i.deleted == 0 && i.kind == "login").ok_or("login not found")?;
            if !sites_of(i).iter().any(|w| domain::same_site(w, url)) { return Err("this login belongs to a different site".into()); }
            let code = i.fields.iter().find(|f| f.kind == "totp" && !f.value.is_empty()).and_then(|f| totp::code(&f.value, vault::now()).ok()).map(|o| o.code);
            Ok(json!({ "username": field(i, "Username"), "password": field(i, "Password"), "totp": code }))
        }
        "check_save" | "save" => {
            let (url, user, pass) = (s(r, "url")?, s(r, "username").unwrap_or(""), s(r, "password")?);
            if pass.is_empty() { return Ok(json!({ "action": "none" })); }
            let existing = alive(items, "login").find(|i| sites_of(i).iter().any(|w| domain::same_site(w, url)) && field(i, "Username").eq_ignore_ascii_case(user));
            let action = match existing { None => "new", Some(i) if field(i, "Password") != pass => "update", _ => "none" };
            if cmd == "check_save" || action == "none" { return Ok(json!({ "action": action })); }
            let item = match existing {
                Some(i) => { let mut c = i.clone(); if let Some(f) = c.fields.iter_mut().find(|f| f.label == "Password") { f.value = pass.into(); } else { c.fields.push(Field { label: "Password".into(), value: pass.into(), kind: "secret".into() }); } c }
                None => {
                    let host = domain::host_of(url).ok_or("bad url")?;
                    let f = |l: &str, v: &str, k: &str| Field { label: l.into(), value: v.into(), kind: k.into() };
                    Item { kind: "login".into(), title: host.trim_start_matches("www.").to_string(), fields: vec![f("Username", user, "text"), f("Password", pass, "secret"), f("Website", url.split(['?', '#']).next().unwrap_or(url), "text")], ..Default::default() }
                }
            };
            let id = sess.upsert(item)?;
            Ok(json!({ "action": action, "id": id }))
        }
        "cards" => Ok(json!({ "cards": alive(items, "card").map(|i| { let n: String = field(i, "Card number").chars().filter(|c| c.is_ascii_digit()).collect();
            json!({ "id": i.id, "title": i.title, "last4": n.get(n.len().saturating_sub(4)..).unwrap_or(""), "holder": field(i, "Cardholder") }) }).collect::<Vec<_>>() })),
        "fill_card" => {
            let i = items.iter().find(|i| i.id == s(r, "id").unwrap_or("") && i.deleted == 0 && i.kind == "card").ok_or("card not found")?;
            let (mm, yy) = parse_expiry(field(i, "Expiry"));
            Ok(json!({ "holder": field(i, "Cardholder"), "number": field(i, "Card number").split_whitespace().collect::<String>(), "expiry": field(i, "Expiry"), "month": mm, "year": yy, "cvv": field(i, "CVV"), "zip": field(i, "Billing zip / postcode") }))
        }
        "identities" => Ok(json!({ "identities": alive(items, "identity").map(|i| json!({ "id": i.id, "title": i.title, "name": field(i, "Full name"), "email": field(i, "Email") })).collect::<Vec<_>>() })),
        "fill_identity" => {
            let i = items.iter().find(|i| i.id == s(r, "id").unwrap_or("") && i.deleted == 0 && i.kind == "identity").ok_or("identity not found")?;
            let mut m = serde_json::Map::new();
            for f in &i.fields { m.insert(f.label.clone(), json!(f.value)); }
            Ok(Value::Object(m))
        }
        "generate" => Ok(json!({ "password": gen::password(r["len"].as_u64().unwrap_or(20) as usize, true, true, true, true)? })),
        "pk_list" => {
            let rp = s(r, "rpId")?;
            Ok(json!({ "passkeys": alive(items, "passkey").filter(|i| field(i, "Website") == rp).map(|i| json!({ "id": i.id, "credentialId": field(i, "Credential ID"), "userName": field(i, "Username"), "displayName": field(i, "Display name"), "userHandle": field(i, "User handle") })).collect::<Vec<_>>() }))
        }
        "pk_create" => {
            let (rp, origin, cd) = (s(r, "rpId")?, s(r, "origin")?, s(r, "clientDataJSON")?);
            if !passkey::rp_allowed(origin, rp) { return Err("this page may not use that relying party".into()); }
            passkey::check_client_data(cd, "webauthn.create", origin)?;
            let (user, handle) = (r["userName"].as_str().unwrap_or(""), r["userHandle"].as_str().unwrap_or(""));
            let existing: Vec<&Item> = alive(items, "passkey").filter(|i| field(i, "Website") == rp).collect();
            if r["excludeIds"].as_array().is_some_and(|ex| existing.iter().any(|i| ex.iter().any(|e| e.as_str() == Some(field(i, "Credential ID"))))) { return Ok(json!({ "excluded": true })); }
            let c = passkey::create(rp)?;
            let f = |l: &str, v: String, k: &str| Field { label: l.into(), value: v, kind: k.into() };
            let fields = vec![f("Website", rp.into(), "text"), f("Username", user.into(), "text"), f("Display name", r["displayName"].as_str().unwrap_or("").into(), "text"), f("Credential ID", passkey::b64(&c.credential_id), "secret"),
                f("Private key", passkey::b64(&c.private_pkcs8), "multiline"), f("User handle", handle.into(), "secret")];
            let same = existing.iter().find(|i| !handle.is_empty() && field(i, "User handle") == handle).map(|i| (*i).clone());
            let item = match same { Some(mut i) => { i.fields = fields; i } None => Item { kind: "passkey".into(), title: format!("{} ({})", r["rpName"].as_str().filter(|n| !n.is_empty()).unwrap_or(rp), if user.is_empty() { "passkey" } else { user }), fields, ..Default::default() } };
            sess.upsert(item)?;
            Ok(json!({ "credentialId": passkey::b64(&c.credential_id), "attestationObject": passkey::b64(&c.attestation_object), "authData": passkey::b64(&c.auth_data), "publicKey": passkey::b64(&c.public_spki) }))
        }
        "pk_get" => {
            let (rp, origin, cd) = (s(r, "rpId")?, s(r, "origin")?, s(r, "clientDataJSON")?);
            if !passkey::rp_allowed(origin, rp) { return Err("this page may not use that relying party".into()); }
            passkey::check_client_data(cd, "webauthn.get", origin)?;
            let i = alive(items, "passkey").find(|i| i.id == r["id"].as_str().unwrap_or("") && field(i, "Website") == rp).ok_or("passkey not found")?;
            let (auth, sig) = passkey::assert(&passkey::unb64(field(i, "Private key"))?, rp, cd.as_bytes())?;
            Ok(json!({ "credentialId": field(i, "Credential ID"), "authenticatorData": passkey::b64(&auth), "signature": passkey::b64(&sig), "userHandle": field(i, "User handle") }))
        }
        _ => Err(format!("unknown command {cmd}")),
    }
}

fn pair(st: &tauri::State<App>, r: &Value) -> Result<Value, String> {
    {
        let mut p = PAIRING.lock().unwrap();
        let Some((code, until, tries)) = p.as_mut() else { return Err("no pairing in progress: in Vault open Settings > Browser extension and click Pair".into()) };
        if Instant::now() > *until { *p = None; return Err("the pairing code expired: start again in Vault".into()); }
        *tries += 1;
        if *tries > 5 { *p = None; return Err("too many wrong codes: start again in Vault".into()); }
        if r["code"].as_str() != Some(code.as_str()) { return Err("wrong code".into()); }
        *p = None;
    }
    let mut g = st.0.lock().unwrap();
    let sess = g.as_mut().ok_or("unlock Vault first")?;
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    let token = hex(&raw);
    let name = r["name"].as_str().unwrap_or("Browser").chars().take(40).collect::<String>();
    sess.data.settings.paired.push(Paired { name, hash: token_hash(&token), created: vault::now() });
    sess.save()?;
    Ok(json!({ "token": token }))
}

fn parse_expiry(e: &str) -> (String, String) {
    let d: Vec<&str> = e.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).collect();
    match d.as_slice() {
        [m, y] => (format!("{:0>2}", m), if y.len() == 2 { format!("20{y}") } else { (*y).into() }),
        [one] if one.len() == 4 => (one[..2].into(), format!("20{}", &one[2..])),
        _ => (String::new(), String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiry_formats() {
        assert_eq!(parse_expiry("09/27"), ("09".into(), "2027".into()));
        assert_eq!(parse_expiry("9 / 2027"), ("09".into(), "2027".into()));
        assert_eq!(parse_expiry("0927"), ("09".into(), "2027".into()));
        assert_eq!(parse_expiry("nonsense"), (String::new(), String::new()));
    }

    #[test]
    fn pairing_codes_expire_and_are_six_digits() {
        let c = start_pairing();
        assert!(c.len() == 6 && c.chars().all(|x| x.is_ascii_digit()));
        assert_ne!(token_hash("a"), token_hash("b"));
    }

    #[test]
    fn sites_include_extra_website_fields() {
        let f = |l: &str, v: &str| Field { label: l.into(), value: v.into(), kind: "text".into() };
        let i = Item { fields: vec![f("Website", "https://a.com"), f("Website 2", "https://b.com"), f("Username", "x")], ..Default::default() };
        assert_eq!(sites_of(&i), ["https://a.com", "https://b.com"]);
    }
}
