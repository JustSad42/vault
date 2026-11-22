//! Password generator: OS randomness, no modulo bias, at least one character of every chosen class.
use rand::{rngs::OsRng, RngCore};

fn below(n: usize) -> usize {
    let n = n as u32;
    let lim = u32::MAX - u32::MAX % n;
    loop {
        let x = OsRng.next_u32();
        if x < lim { return (x % n) as usize; }
    }
}

const COMMON: &[&str] = &["password", "123456", "12345678", "123456789", "1234567890", "qwerty", "qwertyuiop", "letmein", "admin", "welcome", "iloveyou", "monkey", "dragon", "abc123", "111111", "passw0rd", "football", "login", "master", "123123"];

/// Rough guessing-entropy estimate: length times character-pool size, discounted for repeated characters.
/// Passphrases of random words score high; it cannot tell a famous quote from random words.
pub fn bits(pw: &str) -> f64 {
    if pw.is_empty() || COMMON.contains(&pw.to_lowercase().as_str()) { return 0.0; }
    let pool = [pw.chars().any(|c| c.is_ascii_lowercase()) as u32 * 26, pw.chars().any(|c| c.is_ascii_uppercase()) as u32 * 26,
        pw.chars().any(|c| c.is_ascii_digit()) as u32 * 10, pw.chars().any(|c| !c.is_ascii_alphanumeric()) as u32 * 33].iter().sum::<u32>();
    let uniq = pw.chars().collect::<std::collections::HashSet<_>>().len();
    pw.chars().count().min(uniq * 2) as f64 * (pool as f64).log2()
}

pub fn level(bits: f64) -> &'static str { if bits < 40.0 { "weak" } else if bits < 60.0 { "fair" } else if bits < 80.0 { "good" } else { "strong" } }

pub fn password(len: usize, lower: bool, upper: bool, digits: bool, symbols: bool) -> Result<String, String> {
    let mut sets: Vec<&[u8]> = vec![];
    if lower { sets.push(b"abcdefghijklmnopqrstuvwxyz"); }
    if upper { sets.push(b"ABCDEFGHIJKLMNOPQRSTUVWXYZ"); }
    if digits { sets.push(b"0123456789"); }
    if symbols { sets.push(b"!@#$%^&*()-_=+[]{};:,.?/"); }
    if sets.is_empty() { return Err("choose at least one character type".into()); }
    if !(8..=128).contains(&len) { return Err("length must be 8 to 128".into()); }
    let all: Vec<u8> = sets.concat();
    let mut out: Vec<u8> = sets.iter().map(|s| s[below(s.len())]).collect();
    while out.len() < len { out.push(all[below(all.len())]); }
    for i in (1..out.len()).rev() { out.swap(i, below(i + 1)); } // Fisher-Yates
    Ok(String::from_utf8(out).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_and_every_class_present() {
        for _ in 0..200 {
            let p = password(12, true, true, true, true).unwrap();
            assert_eq!(p.len(), 12);
            assert!(p.chars().any(|c| c.is_ascii_lowercase()) && p.chars().any(|c| c.is_ascii_uppercase())
                && p.chars().any(|c| c.is_ascii_digit()) && p.chars().any(|c| !c.is_ascii_alphanumeric()));
        }
        assert!(password(20, false, false, true, false).unwrap().chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn strength_estimate() {
        assert_eq!(bits("Password"), 0.0);
        assert_eq!(level(bits("aaaaaaaaaaaa")), "weak");
        assert!(bits("abcdefgh") < bits("aB3$eF6&hJ9("));
        assert_eq!(level(bits(&password(20, true, true, true, true).unwrap())), "strong");
    }

    #[test]
    fn rejects_bad_options() {
        assert!(password(20, false, false, false, false).is_err());
        assert!(password(4, true, true, true, true).is_err());
        assert!(password(500, true, true, true, true).is_err());
    }
}
