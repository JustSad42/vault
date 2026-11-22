//! Security center: weak, reused, old and insecure-site logins, plus an opt-in Have I Been Pwned check
//! (k-anonymity: only the first 5 characters of each password's SHA-1 leave this PC).
use crate::{gen, vault::Item};
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};

#[derive(Serialize, Clone)]
pub struct Ref { pub id: String, pub title: String, pub note: String }

#[derive(Serialize, Default)]
pub struct Audit { pub total: usize, pub score: u32, pub weak: Vec<Ref>, pub reused: Vec<Ref>, pub old: Vec<Ref>, pub insecure: Vec<Ref> }

fn field<'a>(i: &'a Item, label: &str) -> Option<&'a str> {
    i.fields.iter().find(|f| f.label == label && !f.value.is_empty()).map(|f| f.value.as_str())
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
            let days = now.saturating_sub(i.updated) / 86400;
            if days > 365 { a.old.push(r(i, format!("unchanged for {} months", days / 30))); bad.insert(i.id.clone()); }
        }
        if field(i, "Website").is_some_and(|w| w.trim().to_lowercase().starts_with("http://")) {
            a.insecure.push(r(i, "site does not use HTTPS".into())); bad.insert(i.id.clone());
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

/// `list` = (id, title, password). One request per distinct 5-character prefix.
pub fn breaches(list: Vec<(String, String, String)>) -> Result<Vec<Ref>, String> {
    let mut by_prefix: HashMap<String, Vec<(usize, String)>> = HashMap::new();
    for (n, (_, _, pw)) in list.iter().enumerate() {
        let h = sha1_hex(pw);
        by_prefix.entry(h[..5].to_string()).or_default().push((n, h[5..].to_string()));
    }
    let mut out = vec![];
    for (prefix, entries) in by_prefix {
        let body = ureq::get(&format!("https://api.pwnedpasswords.com/range/{prefix}")).set("Add-Padding", "true")
            .timeout(std::time::Duration::from_secs(10)).call().map_err(|e| format!("could not reach api.pwnedpasswords.com: {e}"))?
            .into_string().map_err(|e| e.to_string())?;
        for (n, suffix) in entries {
            let c = count_in(&body, &suffix);
            if c > 0 { out.push(Ref { id: list[n].0.clone(), title: list[n].1.clone(), note: format!("seen {c} times in known breaches") }); }
        }
    }
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
