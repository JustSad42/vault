//! CSV import by header name: Chrome/Edge/Brave, Bitwarden, 1Password and KeePass exports all map onto the same columns.
use crate::vault::{Field, Item};

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

#[cfg(test)]
mod tests {
    use super::*;

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
