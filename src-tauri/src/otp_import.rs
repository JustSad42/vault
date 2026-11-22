//! Reads 2FA setup data: otpauth:// links, Google Authenticator "Export accounts" links (otpauth-migration://, a protobuf in base64)
//! and whatever QR codes decode to. HOTP (counter) accounts are not supported and are counted as skipped.
use data_encoding::{BASE32_NOPAD, BASE64URL_NOPAD, BASE64_NOPAD};
use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Account { pub title: String, pub account: String, pub uri: String }

/// Google Authenticator splits big exports into several QR codes; each carries its place in the set.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Batch { pub id: i64, pub index: u64, pub size: u64 }

#[derive(Serialize, Default, Debug)]
pub struct Parsed { pub accounts: Vec<Account>, pub skipped: usize, pub batches: Vec<Batch>, pub foreign: bool }

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let (mut out, mut i) = (Vec::with_capacity(b.len()), 0);
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) { out.push(v); i += 3; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn pct_encode(s: &str) -> String {
    s.bytes().map(|c| if c.is_ascii_alphanumeric() || b"-_.~".contains(&c) { (c as char).to_string() } else { format!("%{c:02X}") }).collect()
}

enum V<'a> { Num(u64), Bytes(&'a [u8]) }

fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let (mut r, mut sh) = (0u64, 0u32);
    loop {
        let c = *b.get(*i)?;
        *i += 1;
        r |= ((c & 0x7f) as u64) << sh;
        if c & 0x80 == 0 { return Some(r); }
        sh += 7;
        if sh > 63 { return None; }
    }
}

/// Minimal protobuf reader: varints and length-delimited fields; fixed-width fields are skipped.
fn fields(b: &[u8]) -> Option<Vec<(u64, V<'_>)>> {
    let (mut i, mut out) = (0, vec![]);
    while i < b.len() {
        let key = varint(b, &mut i)?;
        match key & 7 {
            0 => out.push((key >> 3, V::Num(varint(b, &mut i)?))),
            2 => { let n = varint(b, &mut i)? as usize; let s = b.get(i..i.checked_add(n)?)?; i += n; out.push((key >> 3, V::Bytes(s))); }
            1 => { i += 8; if i > b.len() { return None; } }
            5 => { i += 4; if i > b.len() { return None; } }
            _ => return None,
        }
    }
    Some(out)
}

fn make(issuer: &str, name: &str, secret: &str, alg: &str, digits: u32, period: u64) -> Account {
    let name = name.strip_prefix(&format!("{issuer}:")).unwrap_or(name).trim().to_string();
    let label = if issuer.is_empty() { pct_encode(&name) } else { format!("{}:{}", pct_encode(issuer), pct_encode(&name)) };
    let uri = format!("otpauth://totp/{label}?secret={secret}&issuer={}&algorithm={alg}&digits={digits}&period={period}", pct_encode(issuer));
    Account { title: if issuer.is_empty() { name.clone() } else { issuer.to_string() }, account: name, uri }
}

fn from_migration(data: &str) -> Option<(Vec<Account>, usize, Option<Batch>)> {
    let raw = pct_decode(data).replace(' ', "+"); // a '+' in a URL turns into a space
    let clean: String = raw.chars().filter(|c| *c != '=' && !c.is_whitespace()).collect();
    let bytes = if clean.contains('-') || clean.contains('_') { BASE64URL_NOPAD.decode(clean.as_bytes()) } else { BASE64_NOPAD.decode(clean.as_bytes()) }.ok()?;
    let (mut out, mut skipped, mut size, mut index, mut id) = (vec![], 0, 0u64, 0u64, 0i64);
    for (f, v) in fields(&bytes)? {
        if let V::Num(n) = v { match f { 3 => size = n, 4 => index = n, 5 => id = n as i32 as i64, _ => {} } continue; }
        let (1, V::Bytes(m)) = (f, v) else { continue };
        let (mut secret, mut name, mut issuer, mut alg, mut digits, mut kind) = (&[][..], String::new(), String::new(), 1u64, 1u64, 2u64);
        for (f, v) in fields(m)? {
            match (f, v) {
                (1, V::Bytes(b)) => secret = b,
                (2, V::Bytes(b)) => name = String::from_utf8_lossy(b).into_owned(),
                (3, V::Bytes(b)) => issuer = String::from_utf8_lossy(b).into_owned(),
                (4, V::Num(n)) => alg = n,
                (5, V::Num(n)) => digits = n,
                (6, V::Num(n)) => kind = n,
                _ => {}
            }
        }
        let alg = match alg { 0 | 1 => "SHA1", 2 => "SHA256", 3 => "SHA512", _ => "" };
        if kind == 1 || secret.is_empty() || alg.is_empty() { skipped += 1; continue; } // HOTP or MD5
        out.push(make(&issuer, &name, &BASE32_NOPAD.encode(secret), alg, if digits == 2 { 8 } else { 6 }, 30));
    }
    Some((out, skipped, if size > 0 { Some(Batch { id, index, size }) } else { None }))
}

fn from_otpauth(uri: &str) -> Result<Account, bool> { // Err(true) = valid but unsupported (HOTP)
    let rest = uri.get("otpauth://".len()..).ok_or(false)?;
    let (kind, rest) = rest.split_once('/').ok_or(false)?;
    if kind.eq_ignore_ascii_case("hotp") { return Err(true); }
    if !kind.eq_ignore_ascii_case("totp") || crate::totp::code(uri, 0).is_err() { return Err(false); }
    let (label, query) = rest.split_once('?').unwrap_or((rest, ""));
    let label = pct_decode(label);
    let (lissuer, name) = label.split_once(':').map(|(a, b)| (a.trim().to_string(), b.trim().to_string())).unwrap_or((String::new(), label.trim().to_string()));
    let issuer = query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| k.eq_ignore_ascii_case("issuer")).map(|(_, v)| pct_decode(v)).unwrap_or(lissuer);
    Ok(Account { title: if issuer.is_empty() { name.clone() } else { issuer }, account: name, uri: uri.to_string() })
}

/// Finds every otpauth:// and otpauth-migration:// link in `text` (pasted text or decoded QR codes).
pub fn parse_text(text: &str) -> Parsed {
    let mut p = Parsed::default();
    for tok in text.split_whitespace() {
        let low = tok.to_lowercase();
        if low.starts_with("otpauth-migration://") {
            let data = tok.split_once("data=").map(|x| x.1.split('&').next().unwrap_or("")).unwrap_or("");
            match from_migration(data) { Some((a, s, b)) => { p.accounts.extend(a); p.skipped += s; p.batches.extend(b); } None => p.skipped += 1 }
        } else if low.starts_with("otpauth://") {
            match from_otpauth(tok) { Ok(a) => p.accounts.push(a), Err(_) => p.skipped += 1 }
        }
    }
    let mut seen = std::collections::HashSet::new();
    p.accounts.retain(|a| seen.insert(a.uri.clone()));
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ld(f: u8, b: &[u8]) -> Vec<u8> { let mut v = vec![f << 3 | 2, b.len() as u8]; v.extend_from_slice(b); v }
    fn account(secret: &[u8], name: &str, issuer: &str, alg: u8, digits: u8, kind: u8) -> Vec<u8> {
        let mut m = [ld(1, secret), ld(2, name.as_bytes()), ld(3, issuer.as_bytes())].concat();
        m.extend_from_slice(&[4 << 3, alg, 5 << 3, digits, 6 << 3, kind]);
        ld(1, &m)
    }
    fn link(payload: &[u8]) -> String {
        let b64 = data_encoding::BASE64.encode(payload);
        format!("otpauth-migration://offline?data={}", b64.replace('+', "%2B").replace('/', "%2F").replace('=', "%3D"))
    }

    #[test]
    fn google_authenticator_export() {
        let mut payload = account(b"12345678901234567890", "Example:alice@x.com", "Example", 1, 1, 2);
        payload.extend(account(b"abcdefghij", "bob", "", 2, 2, 2));
        payload.extend(account(b"counter-based", "old", "Legacy", 1, 1, 1)); // HOTP
        payload.extend_from_slice(&[2 << 3, 1, 3 << 3, 1, 4 << 3, 0]); // version, batch fields are ignored
        let p = parse_text(&link(&payload));
        assert_eq!(p.skipped, 1);
        assert_eq!(p.batches, vec![Batch { id: 0, index: 0, size: 1 }]);
        assert_eq!(p.accounts.len(), 2);
        assert_eq!((p.accounts[0].title.as_str(), p.accounts[0].account.as_str()), ("Example", "alice@x.com"));
        assert!(p.accounts[0].uri.contains("secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"));
        assert!(p.accounts[1].uri.contains("algorithm=SHA256") && p.accounts[1].uri.contains("digits=8"));
        for a in &p.accounts { assert!(crate::totp::code(&a.uri, 59).is_ok(), "converted link must produce codes"); }
        assert_eq!(crate::totp::code(&p.accounts[0].uri, 59).unwrap().code.len(), 6);
    }

    #[test]
    fn plain_links_text_and_garbage() {
        let t = "junk otpauth://totp/GitHub:octo%40cat?secret=GEZDGNBVGY3TQOJQ&issuer=GitHub\nnext otpauth://totp/GitHub:octo%40cat?secret=GEZDGNBVGY3TQOJQ&issuer=GitHub \
                 otpauth://hotp/x?secret=GEZDGNBV&counter=1 otpauth://totp/bad?secret=!!! otpauth-migration://offline?data=%%%";
        let p = parse_text(t);
        assert_eq!(p.accounts.len(), 1, "duplicates collapse");
        assert_eq!((p.accounts[0].title.as_str(), p.accounts[0].account.as_str()), ("GitHub", "octo@cat"));
        assert_eq!(p.skipped, 3);
        assert!(parse_text("hello world").accounts.is_empty());
    }
}
