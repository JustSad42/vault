//! Imports. CSV by header name (Chrome/Edge/Brave, Bitwarden, 1Password and KeePass CSV exports all map onto the same
//! columns), plus two full-fidelity formats: Bitwarden's unencrypted JSON export (cards, identities, notes, SSH keys,
//! custom fields, folders) and KeePass .kdbx databases (groups, custom fields, TOTP, tags, expiry, attachments).
use crate::vault::{Field, Item};
use serde_json::Value;

fn fld(label: &str, value: &str, kind: &str) -> Field { Field { label: label.into(), value: value.trim_end().into(), kind: kind.into() } }
/// Keeps only the fields that have a value.
fn some(fields: Vec<Field>) -> Vec<Field> { fields.into_iter().filter(|f| !f.value.is_empty()).collect() }

pub fn parse(text: &str) -> Result<Vec<Item>, String> {
    let text = text.trim_start_matches('\u{feff}');
    let mut rd = csv::ReaderBuilder::new().flexible(true).from_reader(text.as_bytes());
    let hdr: Vec<String> = rd.headers().map_err(|e| e.to_string())?.iter().map(|h| h.trim().to_lowercase()).collect();
    if !hdr.iter().any(|h| matches!(h.as_str(), "password" | "login_password" | "note" | "notes")) {
        return Err("this does not look like a password export (no password column)".into());
    }
    let mut out = vec![];
    for rec in rd.records() {
        let rec = rec.map_err(|e| e.to_string())?;
        let col = |names: &[&str]| -> String {
            names.iter().find_map(|n| hdr.iter().position(|h| h == n)).and_then(|i| rec.get(i)).unwrap_or("").trim().to_string()
        };
        let (mut title, url, user, pass) = (col(&["name", "title"]), col(&["url", "login_uri", "website"]), col(&["username", "login_username"]), col(&["password", "login_password"]));
        let (notes, totp, folder) = (col(&["note", "notes"]), col(&["totp", "login_totp", "otpauth"]), col(&["folder", "group"]));
        if [&title, &url, &user, &pass, &notes].iter().all(|s| s.is_empty()) { continue; }
        if title.is_empty() { title = if url.is_empty() { user.clone() } else { url.clone() }; }
        if title.is_empty() { title = "Untitled".into(); }
        let kind = if user.is_empty() && pass.is_empty() && url.is_empty() { "note" } else { "login" };
        let mut fields = vec![];
        for (label, value, k) in [("Username", user, "text"), ("Password", pass, "secret"), ("Website", url, "text"), ("One-time code", totp, "totp")] {
            if !value.is_empty() { fields.push(Field { label: label.into(), value, kind: k.into() }); }
        }
        out.push(Item { kind: kind.into(), title, folder, fields, notes, ..Default::default() });
    }
    Ok(out)
}

/// Bitwarden "Export vault" as .json (not the password-protected variant).
pub fn bitwarden_json(text: &str) -> Result<Vec<Item>, String> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| "this is not a Bitwarden JSON export".to_string())?;
    if v["encrypted"].as_bool() == Some(true) { return Err("this export is encrypted: in Bitwarden choose the plain .json format".into()); }
    let items = v["items"].as_array().ok_or("this is not a Bitwarden JSON export (no items)")?;
    let folders: std::collections::HashMap<&str, &str> = v["folders"].as_array().into_iter().flatten().filter_map(|f| Some((f["id"].as_str()?, f["name"].as_str()?))).collect();
    let s = |x: &Value| x.as_str().unwrap_or("").to_string();
    let mut out = vec![];
    for it in items {
        let mut fields;
        let kind = match it["type"].as_u64() {
            Some(1) => {
                let l = &it["login"];
                fields = vec![fld("Username", &s(&l["username"]), "text"), fld("Password", &s(&l["password"]), "secret")];
                for (n, u) in l["uris"].as_array().into_iter().flatten().filter_map(|u| u["uri"].as_str()).enumerate() {
                    fields.push(fld(&if n == 0 { "Website".to_string() } else { format!("Website {}", n + 1) }, u, "text"));
                }
                fields.push(fld("One-time code", &s(&l["totp"]), "totp"));
                "login"
            }
            Some(3) => {
                let c = &it["card"];
                let (m, y) = (s(&c["expMonth"]), s(&c["expYear"]));
                let exp = if m.is_empty() && y.is_empty() { String::new() } else { format!("{:0>2}/{}", m, y.get(y.len().saturating_sub(2)..).unwrap_or(&y)) };
                fields = vec![fld("Cardholder", &s(&c["cardholderName"]), "text"), fld("Card number", &s(&c["number"]), "secret"), fld("Expiry", &exp, "text"), fld("CVV", &s(&c["code"]), "secret"), fld("Brand", &s(&c["brand"]), "text")];
                "card"
            }
            Some(4) => {
                let d = &it["identity"];
                let name = ["firstName", "middleName", "lastName"].iter().map(|k| s(&d[*k])).filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ");
                fields = vec![fld("Full name", &name, "text"), fld("First name", &s(&d["firstName"]), "text"), fld("Last name", &s(&d["lastName"]), "text"), fld("Email", &s(&d["email"]), "text"),
                    fld("Phone", &s(&d["phone"]), "text"), fld("Address line 1", &s(&d["address1"]), "text"), fld("Address line 2", &[s(&d["address2"]), s(&d["address3"])].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(", "), "text"),
                    fld("City", &s(&d["city"]), "text"), fld("State / region", &s(&d["state"]), "text"), fld("Postal code", &s(&d["postalCode"]), "text"), fld("Country", &s(&d["country"]), "text"),
                    fld("Company", &s(&d["company"]), "text"), fld("Username", &s(&d["username"]), "text"), fld("Social security number", &s(&d["ssn"]), "secret"),
                    fld("Passport number", &s(&d["passportNumber"]), "secret"), fld("License number", &s(&d["licenseNumber"]), "secret")];
                "identity"
            }
            Some(5) => {
                let k = &it["sshKey"];
                fields = vec![fld("Public key", &s(&k["publicKey"]), "text"), fld("Private key", &s(&k["privateKey"]), "multiline"), fld("Fingerprint", &s(&k["keyFingerprint"]), "text")];
                "ssh"
            }
            _ => { fields = vec![]; "note" }
        };
        for c in it["fields"].as_array().into_iter().flatten() {
            fields.push(fld(&s(&c["name"]), &s(&c["value"]), if c["type"].as_u64() == Some(1) { "secret" } else { "text" }));
        }
        let title = Some(s(&it["name"])).filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "Untitled".into());
        let folder = it["folderId"].as_str().and_then(|id| folders.get(id)).map(|f| f.to_string()).unwrap_or_default();
        out.push(Item { kind: kind.into(), title, folder, fields: some(fields), notes: s(&it["notes"]), favorite: it["favorite"].as_bool().unwrap_or(false), ..Default::default() });
    }
    Ok(out)
}

/// A KeePass database (.kdbx, KDBX 3.1 or 4) opened with its master password. Each entry comes with its attachments.
pub fn keepass(bytes: &[u8], password: &str) -> Result<Vec<(Item, Vec<(String, Vec<u8>)>)>, String> {
    use keepass::{db::fields, Database, DatabaseKey};
    let db = Database::open(&mut &bytes[..], DatabaseKey::new().with_password(password)).map_err(|e| {
        let m = e.to_string();
        if m.to_lowercase().contains("key") || m.to_lowercase().contains("hmac") { "wrong KeePass password (or the database also needs a key file)".to_string() } else { format!("could not open the KeePass file: {m}") }
    })?;
    let bin = db.meta.recyclebin_uuid;
    let mut out = vec![];
    // depth-first over groups, remembering the folder path; the recycle bin is skipped
    let mut stack = vec![(db.root().id(), String::new(), true)];
    while let Some((gid, path, is_root)) = stack.pop() {
        let Some(g) = db.group(gid) else { continue };
        if Some(g.id().uuid()) == bin { continue; }
        let here = if is_root { String::new() } else if path.is_empty() { g.name.clone() } else { format!("{path} / {}", g.name) };
        for e in g.entries() {
            let get = |k: &str| e.get(k).unwrap_or("").to_string();
            let (user, pass, url) = (get(fields::USERNAME), get(fields::PASSWORD), get(fields::URL));
            let otp = Some(get(fields::OTP)).filter(|o| !o.is_empty()).unwrap_or_else(|| get("TOTP Seed"));
            let mut fl = vec![fld("Username", &user, "text"), fld("Password", &pass, "secret"), fld("Website", &url, "text"), fld("One-time code", &otp, "totp")];
            let mut extra: Vec<(&String, &keepass::db::Value<String>)> = e.fields.iter().filter(|(k, _)| !fields::KNOWN_FIELDS.contains(&k.as_str()) && !["otp", "TOTP Seed", "TOTP Settings"].contains(&k.as_str())).collect();
            extra.sort_by(|a, b| a.0.cmp(b.0));
            for (k, v) in extra { fl.push(fld(k, v.get(), if v.is_protected() { "secret" } else { "text" })); }
            let fl = some(fl);
            let notes = get(fields::NOTES);
            let kind = if user.is_empty() && pass.is_empty() && url.is_empty() && otp.is_empty() && !notes.is_empty() { "note" } else { "login" };
            let title = Some(get(fields::TITLE)).filter(|t| !t.trim().is_empty()).unwrap_or_else(|| if url.is_empty() { "Untitled".into() } else { url.clone() });
            let expires = if e.times.expires == Some(true) { e.times.expiry.format("%Y-%m-%d").to_string() } else { String::new() };
            let files = e.attachments_named().map(|(n, a)| (n.to_string(), a.data.get().clone())).collect();
            out.push((Item { kind: kind.into(), title, folder: here.clone(), fields: fl, notes, tags: e.tags.clone(), expires, ..Default::default() }, files));
        }
        for sub in g.groups() { stack.push((sub.id(), here.clone(), false)); }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitwarden_json_export_keeps_every_kind() {
        let j = r#"{"encrypted":false,"folders":[{"id":"f1","name":"Work"}],"items":[
          {"type":1,"name":"Mail","folderId":"f1","favorite":true,"notes":"n","login":{"username":"me","password":"pw","totp":"GEZDGNBV","uris":[{"uri":"https://mail.x"},{"uri":"https://webmail.x"}]},
           "fields":[{"name":"PIN","value":"1234","type":1},{"name":"Plan","value":"pro","type":0}]},
          {"type":3,"name":"Visa","card":{"cardholderName":"Me","number":"4111111111111111","expMonth":"9","expYear":"2027","code":"123","brand":"Visa"}},
          {"type":4,"name":"Me","identity":{"firstName":"Ada","lastName":"Lovelace","email":"a@x","city":"London","passportNumber":"P1"}},
          {"type":2,"name":"Note","notes":"secret text","secureNote":{"type":0}},
          {"type":5,"name":"Server","sshKey":{"privateKey":"-----BEGIN","publicKey":"ssh-ed25519 AAA","keyFingerprint":"SHA256:x"}}]}"#;
        let v = bitwarden_json(j).unwrap();
        assert_eq!(v.iter().map(|i| i.kind.as_str()).collect::<Vec<_>>(), ["login", "card", "identity", "note", "ssh"]);
        let l = &v[0];
        assert!(l.favorite && l.folder == "Work" && l.notes == "n");
        let get = |i: &Item, lab: &str| i.fields.iter().find(|f| f.label == lab).map(|f| (f.value.clone(), f.kind.clone()));
        assert_eq!(get(l, "Website 2").unwrap().0, "https://webmail.x");
        assert_eq!(get(l, "One-time code").unwrap().1, "totp");
        assert_eq!(get(l, "PIN").unwrap(), ("1234".into(), "secret".into()));
        assert_eq!(get(&v[1], "Expiry").unwrap().0, "09/27");
        assert_eq!(get(&v[2], "Full name").unwrap().0, "Ada Lovelace");
        assert_eq!(get(&v[2], "Passport number").unwrap().1, "secret");
        assert_eq!(get(&v[4], "Private key").unwrap().1, "multiline");
        assert!(bitwarden_json(r#"{"encrypted":true,"data":"x"}"#).is_err());
        assert!(bitwarden_json("name,url\n").is_err());
    }

    #[test]
    fn keepass_database_with_groups_fields_and_files() {
        use keepass::{db::{fields, Value}, Database, DatabaseKey};
        let mut db = Database::new();
        {
            let mut root = db.root_mut();
            let mut work = root.add_group();
            work.name = "Work".into();
            let mut e = work.add_entry();
            e.set_unprotected(fields::TITLE, "GitLab");
            e.set_unprotected(fields::USERNAME, "me");
            e.set_protected(fields::PASSWORD, "pw");
            e.set_unprotected(fields::URL, "https://gitlab.com");
            e.set_unprotected(fields::OTP, "otpauth://totp/x?secret=GEZDGNBV");
            e.set_protected("Recovery code", "abc");
            e.tags = vec!["dev".into()];
            e.add_attachment("key.txt", Value::protected(b"FILE".to_vec()));
            let mut n = root.add_entry();
            n.set_unprotected(fields::TITLE, "Alarm");
            n.set_unprotected(fields::NOTES, "1234");
        }
        let mut buf = vec![];
        db.save(&mut buf, DatabaseKey::new().with_password("kp-pass")).unwrap();
        assert!(keepass(&buf, "nope").is_err());
        let mut v = keepass(&buf, "kp-pass").unwrap();
        v.sort_by(|a, b| a.0.title.cmp(&b.0.title));
        let (note, _) = &v[0];
        assert_eq!((note.kind.as_str(), note.notes.as_str(), note.folder.as_str()), ("note", "1234", ""));
        let (gl, files) = &v[1];
        assert_eq!((gl.folder.as_str(), gl.tags.clone()), ("Work", vec!["dev".to_string()]));
        let get = |lab: &str| gl.fields.iter().find(|f| f.label == lab).map(|f| (f.value.clone(), f.kind.clone())).unwrap();
        assert_eq!(get("Password"), ("pw".into(), "secret".into()));
        assert_eq!(get("One-time code").1, "totp");
        assert_eq!(get("Recovery code"), ("abc".into(), "secret".into()));
        assert_eq!(files, &vec![("key.txt".to_string(), b"FILE".to_vec())]);
    }

    #[test]
    fn chrome_export() {
        let v = parse("name,url,username,password,note\nGitHub,https://github.com,me,pw1,\"two\nlines\"\n,,,,\n").unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].title, "GitHub");
        assert_eq!(v[0].notes, "two\nlines");
        assert_eq!(v[0].fields.iter().map(|f| f.label.as_str()).collect::<Vec<_>>(), ["Username", "Password", "Website"]);
    }

    #[test]
    fn bitwarden_export_with_totp_and_secure_note() {
        let csv = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n\
                   Work,1,login,Mail,,,0,https://mail.x,me,pw,GEZDGNBV\n,,note,Wifi code,1234,,0,,,,\n";
        let v = parse(csv).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].folder, "Work");
        assert!(v[0].fields.iter().any(|f| f.kind == "totp" && f.value == "GEZDGNBV"));
        assert_eq!(v[1].kind, "note");
    }

    #[test]
    fn non_password_csv_is_refused() {
        assert!(parse("a,b\n1,2\n").is_err());
    }
}
