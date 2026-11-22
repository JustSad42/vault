//! Search: words (all must match), "quoted phrases", -exclusions, fuzzy title matches ("gthb" finds GitHub) and operators:
//! kind: tag: folder: cat: domain: user: is:(fav weak reused old expiring nopass notp http dup trash) has:(totp files notes expiry website password history tags).
use crate::{categories, domain, vault::Item};
use std::collections::HashMap;

struct Term { neg: bool, op: Option<String>, val: String }

fn parse(q: &str) -> Vec<Term> {
    let (mut out, mut cur, mut quoted) = (vec![], String::new(), false);
    let mut push = |cur: &mut String, out: &mut Vec<Term>| {
        let mut t = std::mem::take(cur).to_lowercase();
        if t.is_empty() { return; }
        let neg = t.starts_with('-') && t.len() > 1;
        if neg { t.remove(0); }
        let op = t.split_once(':').filter(|(k, v)| !v.is_empty() && ["kind", "tag", "folder", "cat", "domain", "user", "is", "has"].contains(k)).map(|(k, v)| (k.to_string(), v.to_string()));
        out.push(match op { Some((k, v)) => Term { neg, op: Some(k), val: v }, None => Term { neg, op: None, val: t } });
    };
    for c in q.chars() {
        match c { '"' => quoted = !quoted, c if c.is_whitespace() && !quoted => push(&mut cur, &mut out), c => cur.push(c) }
    }
    push(&mut cur, &mut out);
    out
}

fn field<'a>(i: &'a Item, l: &str) -> &'a str { i.fields.iter().find(|f| f.label == l).map(|f| f.value.as_str()).unwrap_or("") }

fn fuzzy(hay: &str, needle: &str) -> bool {
    if needle.chars().count() < 3 { return false; }
    let mut it = hay.chars();
    needle.chars().all(|c| it.any(|h| h == c)) && hay.chars().count() <= needle.chars().count() * 4
}

/// Ids of matching items, best first. `trash` selects the trash instead of live items.
pub fn run(items: &[Item], flags: &HashMap<String, Vec<&'static str>>, q: &str, trash: bool) -> Vec<String> {
    let terms = parse(q);
    let mut hits: Vec<(u32, String, &Item)> = vec![];
    'item: for i in items.iter().filter(|i| (i.deleted > 0) == trash) {
        let fl = flags.get(&i.id).map(|v| v.as_slice()).unwrap_or(&[]);
        let (title, site) = (i.title.to_lowercase(), categories::website(i).to_lowercase());
        let host = domain::host_of(&site).unwrap_or_default();
        let user = ["Username", "Email", "Account holder", "Cardholder", "Full name"].iter().map(|l| field(i, l)).find(|v| !v.is_empty()).unwrap_or("").to_lowercase();
        let cat = categories::of(i).to_lowercase();
        let mut score = 0u32;
        for t in &terms {
            let v = t.val.as_str();
            let (hit, pts) = match t.op.as_deref() {
                Some("kind") => (i.kind == v, 0),
                Some("tag") => (i.tags.iter().any(|x| x.to_lowercase().contains(v)), 0),
                Some("folder") => (i.folder.to_lowercase().contains(v), 0),
                Some("cat") => (cat.contains(v), 0),
                Some("domain") => (host.contains(v), 0),
                Some("user") => (user.contains(v), 0),
                Some("is") => (match v { "fav" | "favorite" => i.favorite, "trash" => i.deleted > 0, f => fl.contains(&f) }, 0),
                Some("has") => (match v {
                    "totp" => fl.contains(&"totp"), "files" => !i.attachments.is_empty(), "notes" => !i.notes.is_empty(), "expiry" => !i.expires.is_empty(),
                    "website" => !site.is_empty(), "password" => !fl.contains(&"nopass") && i.kind == "login", "history" => !i.versions.is_empty() || !i.history.is_empty(), "tags" => !i.tags.is_empty(), _ => false }, 0),
                _ => {
                    let words: Vec<&str> = title.split(|c: char| !c.is_alphanumeric()).collect();
                    if title == v { (true, 100) }
                    else if title.starts_with(v) { (true, 80) }
                    else if words.iter().any(|w| w.starts_with(v)) { (true, 70) }
                    else if title.contains(v) { (true, 60) }
                    else if host.contains(v) || site.contains(v) { (true, 50) }
                    else if user.contains(v) || i.folder.to_lowercase().contains(v) || cat == v || i.tags.iter().any(|x| x.to_lowercase().contains(v)) { (true, 40) }
                    else if fuzzy(&title, v) { (true, 30) }
                    else if i.fields.iter().any(|f| f.kind == "text" && f.value.to_lowercase().contains(v)) { (true, 20) }
                    else if i.notes.to_lowercase().contains(v) { (true, 10) }
                    else { (false, 0) }
                }
            };
            if hit == t.neg { continue 'item; }
            if hit { score += pts; }
        }
        hits.push((score, title, i));
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    hits.into_iter().map(|(_, _, i)| i.id.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Field;

    fn it(id: &str, kind: &str, title: &str, site: &str, user: &str) -> Item {
        let f = |l: &str, v: &str| Field { label: l.into(), value: v.into(), kind: "text".into() };
        Item { id: id.into(), kind: kind.into(), title: title.into(), fields: vec![f("Website", site), f("Username", user)], ..Default::default() }
    }
    fn ids(items: &[Item], q: &str) -> Vec<String> { run(items, &HashMap::new(), q, false) }

    #[test]
    fn words_phrases_fuzzy_operators_and_ranking() {
        let mut gh = it("1", "login", "GitHub", "https://github.com", "octocat");
        gh.tags = vec!["work".into()];
        gh.notes = "recovery codes in the safe".into();
        let gl = it("2", "login", "GitLab", "https://gitlab.com", "octocat");
        let mut visa = it("3", "card", "Visa Platinum", "", "");
        visa.folder = "Money".into();
        let items = vec![gh, gl, visa];
        assert_eq!(ids(&items, "git"), ["1", "2"]);
        assert_eq!(ids(&items, "gthb"), ["1"], "fuzzy");
        assert_eq!(ids(&items, "octocat gitlab"), ["2"], "all words must match");
        assert_eq!(ids(&items, "-gitlab git"), ["1"]);
        assert_eq!(ids(&items, "kind:card"), ["3"]);
        assert_eq!(ids(&items, "tag:work"), ["1"]);
        assert_eq!(ids(&items, "cat:finance"), ["3"]);
        assert_eq!(ids(&items, "domain:gitlab.com"), ["2"]);
        assert_eq!(ids(&items, "user:octo kind:login"), ["1", "2"]);
        assert_eq!(ids(&items, "\"in the safe\""), ["1"], "phrases search notes too");
        assert_eq!(ids(&items, "folder:money visa"), ["3"]);
        assert_eq!(ids(&items, "has:notes"), ["1"]);
        assert_eq!(ids(&items, "nomatchatall"), Vec::<String>::new());
        assert_eq!(ids(&items, "").len(), 3);
        assert_eq!(ids(&items, "unknownop:x"), Vec::<String>::new(), "an unknown operator is plain text");
    }

    #[test]
    fn flags_trash_and_best_match_first() {
        let mut a = it("a", "login", "Mail", "https://mail.example", "me");
        let b = it("b", "login", "Email backup", "", "me");
        let mut c = it("c", "login", "Old", "", "");
        c.deleted = 5;
        a.favorite = true;
        let fl: HashMap<String, Vec<&'static str>> = [("b".to_string(), vec!["weak"])].into();
        let items = vec![a, b, c];
        assert_eq!(run(&items, &fl, "is:weak", false), ["b"]);
        assert_eq!(run(&items, &fl, "is:fav", false), ["a"]);
        assert_eq!(run(&items, &fl, "", true), ["c"], "trash only on request");
        assert_eq!(run(&items, &fl, "mail", false), ["a", "b"], "title starts with beats title contains");
    }
}
