//! Website matching: which saved logins belong to a page, and when a page only looks like a saved site.

const TWO_LEVEL: &[&str] = &["co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "or.jp", "co.in", "co.kr", "co.za",
    "com.br", "com.mx", "com.ar", "com.tr", "com.sg", "com.hk", "com.tw", "com.cn", "com.my", "com.ph", "com.eg", "com.sa", "com.pk", "co.id", "co.il", "com.ua", "com.pl"];

/// "https://User@Sub.Example.com:8080/x?y" or "example.com/x" -> "sub.example.com".
pub fn host_of(url: &str) -> Option<String> {
    let u = url.trim();
    let rest = u.split_once("://").map(|x| x.1).unwrap_or(u);
    let auth = rest.split(['/', '?', '#']).next()?;
    let host = auth.rsplit('@').next()?.split(':').next()?.trim_matches('.').to_lowercase();
    if host.is_empty() || !host.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '.') { return None; }
    Some(host)
}

fn is_ip(h: &str) -> bool { h.split('.').count() == 4 && h.split('.').all(|p| p.parse::<u8>().is_ok()) }

/// Registrable domain ("login.paypal.co.uk" -> "paypal.co.uk"). A small built-in suffix list, not the full public suffix list.
pub fn etld1(host: &str) -> String {
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() <= 2 || is_ip(host) { return host.to_string(); }
    let two = labels[labels.len() - 2..].join(".");
    let n = if TWO_LEVEL.contains(&two.as_str()) { 3 } else { 2 };
    labels[labels.len().saturating_sub(n)..].join(".")
}

pub fn same_site(a: &str, b: &str) -> bool {
    match (host_of(a), host_of(b)) { (Some(x), Some(y)) => etld1(&x) == etld1(&y), _ => false }
}

fn confusable(s: &str) -> String {
    s.replace("rn", "m").replace("vv", "w").replace("cl", "d")
        .chars().map(|c| match c { '0' => 'o', '1' | 'i' | '|' => 'l', '5' => 's', '3' => 'e', '$' => 's', '@' => 'a', c => c }).collect()
}

fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i];
        for j in 1..=b.len() { cur.push((prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + (a[i - 1] != b[j - 1]) as usize)); }
        prev = cur;
    }
    prev[b.len()]
}

/// True when `page` is a different site that imitates `saved`: look-alike spelling, a different TLD, the brand tucked into a
/// subdomain or hyphenated name, or non-ASCII / punycode characters.
pub fn lookalike(page: &str, saved: &str) -> bool {
    let (p, s) = (etld1(page), etld1(saved));
    if p == s || is_ip(page) { return false; }
    let name = |d: &str| d.split('.').next().unwrap_or("").to_string();
    let (pn, sn) = (name(&p), name(&s));
    if sn.len() < 4 { return false; } // too short to judge: "x.com", "t.co"
    if !page.is_ascii() || page.split('.').any(|l| l.starts_with("xn--")) { return true; }
    if pn == sn { return true; } // same name, other TLD
    if confusable(&pn) == confusable(&sn) { return true; }
    let limit = if sn.len() >= 9 { 2 } else { 1 };
    if distance(&pn, &sn) <= limit { return true; }
    // the brand inside the host without being the registrable name: paypal.com.evil.io, paypal-secure.com
    page.split('.').rev().skip(p.matches('.').count() + 1).any(|l| l == sn) || pn.split('-').any(|part| part == sn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_and_registrable_domains() {
        assert_eq!(host_of("https://User:pw@Sub.Example.com:8080/x?y#z").as_deref(), Some("sub.example.com"));
        assert_eq!(host_of("example.com/login").as_deref(), Some("example.com"));
        assert_eq!(host_of("http://[::1]/"), None);
        assert_eq!(host_of(""), None);
        assert_eq!(etld1("login.paypal.co.uk"), "paypal.co.uk");
        assert_eq!(etld1("a.b.github.com"), "github.com");
        assert_eq!(etld1("192.168.1.10"), "192.168.1.10");
        assert!(same_site("https://accounts.google.com/x", "http://mail.google.com"));
        assert!(!same_site("https://google.com", "https://google.org"));
    }

    #[test]
    fn spots_lookalikes_and_not_normal_sites() {
        for (page, saved) in [("paypa1.com", "paypal.com"), ("paypal.com.evil.io", "paypal.com"), ("paypal-secure.com", "paypal.com"), ("gooogle.com", "google.com"),
            ("rnicrosoft.com", "microsoft.com"), ("amazon.co", "amazon.com"), ("xn--pypal-4ve.com", "paypal.com"), ("paypaI.com", "paypal.com")] {
            assert!(lookalike(page, saved), "{page} should look like {saved}");
        }
        for (page, saved) in [("login.paypal.com", "paypal.com"), ("github.com", "gitlab.com"), ("example.com", "stackoverflow.com"), ("t.co", "x.com"), ("192.168.0.1", "paypal.com"), ("mail.google.co.uk", "google.co.uk")] {
            assert!(!lookalike(page, saved), "{page} is not a lookalike of {saved}");
        }
    }
}
