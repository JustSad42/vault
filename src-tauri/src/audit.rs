//! Security center: weak, reused, old and insecure-site logins, plus an opt-in Have I Been Pwned check
//! (k-anonymity: only the first 5 characters of each password's SHA-1 leave this PC).
use crate::{domain, gen, vault::Item};
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};

#[derive(Serialize, Clone)]
pub struct Ref { pub id: String, pub title: String, pub note: String }

#[derive(Serialize, Default)]
pub struct Audit { pub total: usize, pub score: u32, pub weak: Vec<Ref>, pub reused: Vec<Ref>, pub old: Vec<Ref>, pub insecure: Vec<Ref>, pub expiring: Vec<Ref> }

fn field<'a>(i: &'a Item, label: &str) -> Option<&'a str> {
    i.fields.iter().find(|f| f.label == label && !f.value.is_empty()).map(|f| f.value.as_str())
}

/// When the current password was set, as well as the item knows: the latest password change in its history, else the
/// oldest version that already had this password, else the last edit. Tagging or moving an item does not make it "new".
fn password_since(i: &Item, pw: &str) -> u64 {
    if let Some(at) = i.history.iter().filter(|h| h.label == "Password").map(|h| h.at).max() { return at; }
    let mut since = i.updated;
    for v in i.versions.iter().rev() {
        if v.fields.iter().any(|f| f.label == "Password" && f.value == pw) { since = since.min(v.at); } else { break; }
    }
    since
}

pub fn run(items: &[Item], now: u64) -> Audit {
    let logins: Vec<&Item> = items.iter().filter(|i| i.deleted == 0 && i.kind == "login").collect();
    let mut a = Audit { total: logins.len(), ..Default::default() };
    let mut by_pw: HashMap<&str, Vec<&Item>> = HashMap::new();
    for i in &logins { if let Some(p) = field(i, "Password") { by_pw.entry(p).or_default().push(i); } }
    let r = |i: &Item, note: String| Ref { id: i.id.clone(), title: i.title.clone(), note };
    let mut bad = HashSet::new();
    for i in &logins {
        if let Some(p) = field(i, "Password") {
            let b = gen::bits(p);
            if b < 60.0 { a.weak.push(r(i, format!("{} password", gen::level(b)))); bad.insert(i.id.clone()); }
            let n = by_pw[p].len();
            if n > 1 { a.reused.push(r(i, format!("same password on {} other item{}", n - 1, if n == 2 { "" } else { "s" }))); bad.insert(i.id.clone()); }
            let days = now.saturating_sub(password_since(i, p)) / 86400;
            if days > 365 { a.old.push(r(i, format!("unchanged for {} months", days / 30))); bad.insert(i.id.clone()); }
        }
        if field(i, "Website").is_some_and(|w| w.trim().to_lowercase().starts_with("http://")) {
            a.insecure.push(r(i, "site does not use HTTPS".into())); bad.insert(i.id.clone());
        }
    }
    for i in items.iter().filter(|i| i.deleted == 0 && !i.expires.is_empty()) {
        let Some(day) = crate::vault::parse_date(&i.expires) else { continue };
        let left = day - (now / 86400) as i64;
        if left <= 14 {
            a.expiring.push(r(i, if left < 0 { format!("expired {} day{} ago", -left, if left == -1 { "" } else { "s" }) } else if left == 0 { "expires today".into() } else { format!("expires in {left} day{}", if left == 1 { "" } else { "s" }) }));
            bad.insert(i.id.clone());
        }
    }
    a.score = if logins.is_empty() { 100 } else { (100 - 100 * bad.len() / logins.len()) as u32 };
    a
}

fn sha1_hex(pw: &str) -> String { data_encoding::HEXUPPER.encode(&Sha1::digest(pw.as_bytes())) }

/// Count for `suffix` in an HIBP range response ("SUFFIX:COUNT" lines; padded lines have count 0).
fn count_in(body: &str, suffix: &str) -> u64 {
    body.lines().filter_map(|l| l.trim().split_once(':')).find(|(s, _)| s.eq_ignore_ascii_case(suffix)).and_then(|(_, c)| c.trim().parse().ok()).unwrap_or(0)
}

/// Parallel requests to the range API: one shared agent keeps its TLS connections open between requests.
const BREACH_THREADS: usize = 6;

/// `list` = (id, title, password). One request per distinct 5-character prefix.
pub fn breaches(list: Vec<(String, String, String)>) -> Result<Vec<Ref>, String> {
    let mut by_prefix: HashMap<String, Vec<(usize, String)>> = HashMap::new();
    for (n, (_, _, pw)) in list.iter().enumerate() {
        let h = sha1_hex(pw);
        by_prefix.entry(h[..5].to_string()).or_default().push((n, h[5..].to_string()));
    }
    let work: Vec<(String, Vec<(usize, String)>)> = by_prefix.into_iter().collect();
    if work.is_empty() { return Ok(vec![]); }
    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(10)).build();
    let chunk = work.len().div_ceil(BREACH_THREADS);
    let found: Vec<Result<Vec<(usize, u64)>, String>> = std::thread::scope(|sc| {
        let jobs: Vec<_> = work.chunks(chunk).map(|part| { let agent = agent.clone(); sc.spawn(move || {
            let mut hits = vec![];
            for (prefix, entries) in part {
                let body = agent.get(&format!("https://api.pwnedpasswords.com/range/{prefix}")).set("Add-Padding", "true").call()
                    .map_err(|e| format!("could not reach api.pwnedpasswords.com: {e}"))?.into_string().map_err(|e| e.to_string())?;
                for (n, suffix) in entries { let c = count_in(&body, suffix); if c > 0 { hits.push((*n, c)); } }
            }
            Ok(hits)
        }) }).collect();
        jobs.into_iter().map(|j| j.join().unwrap_or_else(|_| Err("breach check failed".into()))).collect()
    });
    let mut out = vec![];
    for r in found { for (n, c) in r? { out.push(Ref { id: list[n].0.clone(), title: list[n].1.clone(), note: format!("seen {c} times in known breaches") }); } }
    out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Field;

    fn login(id: &str, pw: &str, site: &str, updated: u64) -> Item {
        let f = |l: &str, v: &str, k: &str| Field { label: l.into(), value: v.into(), kind: k.into() };
        Item { id: id.into(), kind: "login".into(), title: id.into(), updated, fields: vec![f("Password", pw, "secret"), f("Website", site, "text")], ..Default::default() }
    }

    #[test]
    fn finds_each_problem_and_scores() {
        let now = 1_000_000_000;
        let items = vec![login("a", "hunter2", "https://a.x", now), login("b", "Xk9#mQ2$vL7&pR4!", "http://b.x", now),
            login("c", "Zt5@nW8*yB3%kD6^", "https://c.x", now), login("d", "Zt5@nW8*yB3%kD6^", "https://d.x", now - 400 * 86400)];
        let a = run(&items, now);
        fn ids(v: &[Ref]) -> Vec<&str> { v.iter().map(|r| r.id.as_str()).collect() }
        assert_eq!(ids(&a.weak), ["a"]);
        assert_eq!(ids(&a.reused), ["c", "d"]);
        assert_eq!(ids(&a.old), ["d"]);
        assert_eq!(ids(&a.insecure), ["b"]);
        assert_eq!(a.score, 0); // all four have a problem
        assert_eq!(run(&[], now).score, 100);
    }

    #[test]
    fn password_age_ignores_edits_that_keep_the_password() {
        let now = 1_000_000_000;
        let year = 400 * 86400;
        // tagged yesterday, but the password has been the same since a version from 400 days ago
        let mut a = login("a", "Zt5@nW8*yB3%kD6^", "https://a.x", now - 86400);
        a.versions = vec![crate::vault::ItemVersion { at: now - year, fields: a.fields.clone(), ..Default::default() }];
        // changed 10 days ago according to history, though an old version had another password
        let mut b = login("b", "Xk9#mQ2$vL7&pR4!", "https://b.x", now - 86400);
        b.history = vec![crate::vault::Hist { label: "Password".into(), value: "older".into(), at: now - 10 * 86400 }];
        let r = run(&[a, b], now);
        assert_eq!(r.old.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["a"]);
    }

    #[test]
    fn expiring_items_are_flagged() {
        let now = 20_779 * 86400; // 2026-11-22
        let mut a = login("a", "Zt5@nW8*yB3%kD6^", "https://a.x", now);
        a.expires = "2026-11-30".into();
        let mut b = login("b", "Xk9#mQ2$vL7&pR4!", "https://b.x", now);
        b.expires = "2026-11-20".into();
        let mut c = login("c", "Qw3!rT6&yU9#iO2$", "https://c.x", now);
        c.expires = "2027-06-01".into();
        let r = run(&[a, b, c], now);
        assert_eq!(r.expiring.iter().map(|x| (x.id.as_str(), x.note.as_str())).collect::<Vec<_>>(), [("a", "expires in 8 days"), ("b", "expired 2 days ago")]);
    }

    #[test]
    fn flags_for_smart_filters() {
        let now = 20_779 * 86400;
        let mut a = login("a", "hunter2", "https://www.site.com", now);
        a.fields.push(crate::vault::Field { label: "Username".into(), value: "Me".into(), kind: "text".into() });
        let mut b = login("b", "Xk9#mQ2$vL7&pR4!", "https://site.com/login", now);
        b.fields.push(crate::vault::Field { label: "Username".into(), value: "me".into(), kind: "text".into() });
        b.fields.push(crate::vault::Field { label: "One-time code".into(), value: "GEZDGNBV".into(), kind: "totp".into() });
        let mut c = login("c", "", "", now);
        c.fields.retain(|f| f.label != "Password" || !f.value.is_empty());
        let f = flags(&[a, b, c], now);
        assert!(f["a"].contains(&"weak") && f["a"].contains(&"notp") && f["a"].contains(&"dup"));
        assert!(f["b"].contains(&"totp") && f["b"].contains(&"dup") && !f["b"].contains(&"weak"));
        assert!(f["c"].contains(&"nopass"));
    }

    #[test]
    fn trashed_items_are_ignored() {
        let mut i = login("a", "x", "http://a", 0);
        i.deleted = 5;
        assert_eq!(run(&[i], 10).total, 0);
    }

    #[test]
    fn hibp_helpers() {
        assert_eq!(sha1_hex("password"), "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
        let body = "0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:3861493\r\nFFFF0000000000000000000000000000000:0\r\n";
        assert_eq!(count_in(body, "1E4C9B93F3F0682250B6CF8331B7EE68FD8"), 3861493);
        assert_eq!(count_in(body, "FFFF0000000000000000000000000000000"), 0);
        assert_eq!(count_in(body, "NOTTHERE"), 0);
    }
}

/// Per-item markers used by smart filters and search: weak reused old http expiring nopass notp totp files dup.
pub fn flags(items: &[Item], now: u64) -> HashMap<String, Vec<&'static str>> {
    let a = run(items, now);
    let mut m: HashMap<String, Vec<&'static str>> = HashMap::new();
    for (name, list) in [("weak", &a.weak), ("reused", &a.reused), ("old", &a.old), ("http", &a.insecure), ("expiring", &a.expiring)] {
        for r in list { m.entry(r.id.clone()).or_default().push(name); }
    }
    let mut by_user: HashMap<(String, String), Vec<&Item>> = HashMap::new();
    for i in items.iter().filter(|i| i.deleted == 0) {
        let f = m.entry(i.id.clone()).or_default();
        if i.kind == "login" {
            if field(i, "Password").is_none() { f.push("nopass"); }
            else if !i.fields.iter().any(|x| x.kind == "totp" && !x.value.is_empty()) { f.push("notp"); }
            if let (Some(h), Some(u)) = (field(i, "Website").and_then(domain::host_of), field(i, "Username")) { by_user.entry((domain::etld1(&h), u.to_lowercase())).or_default().push(i); }
        }
        if i.fields.iter().any(|x| x.kind == "totp" && !x.value.is_empty()) { f.push("totp"); }
        if !i.attachments.is_empty() { f.push("files"); }
    }
    for group in by_user.values().filter(|g| g.len() > 1) { for i in group { m.entry(i.id.clone()).or_default().push("dup"); } }
    m
}
