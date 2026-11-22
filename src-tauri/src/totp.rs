//! RFC 6238 one-time codes. Accepts a bare base32 secret or an otpauth:// URI.
use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Sha256, Sha512};

pub struct Otp { pub code: String, pub left: u64, pub period: u64 }

fn mac(alg: &str, key: &[u8], msg: &[u8]) -> Result<Vec<u8>, String> {
    macro_rules! run { ($t:ty) => {{
        let mut m = <Hmac<$t> as Mac>::new_from_slice(key).map_err(|e| e.to_string())?;
        m.update(msg);
        m.finalize().into_bytes().to_vec()
    }}; }
    Ok(match alg { "SHA1" => run!(Sha1), "SHA256" => run!(Sha256), "SHA512" => run!(Sha512), _ => return Err("unsupported algorithm".into()) })
}

fn parse(input: &str) -> Result<(Vec<u8>, u32, u64, String), String> {
    let s = input.trim();
    let (mut secret, mut digits, mut period, mut alg) = (s.to_string(), 6u32, 30u64, "SHA1".to_string());
    if s.to_lowercase().starts_with("otpauth://") {
        secret.clear();
        for kv in s.split_once('?').map(|x| x.1).unwrap_or("").split('&') {
            let Some((k, v)) = kv.split_once('=') else { continue };
            match k.to_lowercase().as_str() {
                "secret" => secret = v.to_string(),
                "digits" => digits = v.parse().map_err(|_| "bad digits")?,
                "period" => period = v.parse().map_err(|_| "bad period")?,
                "algorithm" => alg = v.to_uppercase(),
                _ => {}
            }
        }
    }
    if !(6..=8).contains(&digits) || period == 0 { return Err("unsupported code settings".into()); }
    let clean: String = secret.chars().filter(|c| !c.is_whitespace() && *c != '-' && *c != '=').collect::<String>().to_uppercase();
    let key = BASE32_NOPAD.decode(clean.as_bytes()).map_err(|_| "secret is not valid base32".to_string())?;
    if key.is_empty() { return Err("secret is empty".into()); }
    Ok((key, digits, period, alg))
}

pub fn code(input: &str, now: u64) -> Result<Otp, String> {
    let (key, digits, period, alg) = parse(input)?;
    let h = mac(&alg, &key, &(now / period).to_be_bytes())?;
    let o = (h[h.len() - 1] & 0xf) as usize;
    let bin = u32::from_be_bytes([h[o] & 0x7f, h[o + 1], h[o + 2], h[o + 3]]);
    Ok(Otp { code: format!("{:0w$}", bin % 10u32.pow(digits), w = digits as usize), left: period - now % period, period })
}

#[cfg(test)]
mod tests {
    use super::*;
    const S1: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const S256: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA====";

    #[test]
    fn rfc6238_vectors() {
        let u = |s: &str, extra: &str| format!("otpauth://totp/x?secret={s}&digits=8{extra}");
        assert_eq!(code(&u(S1, ""), 59).unwrap().code, "94287082");
        assert_eq!(code(&u(S1, ""), 1111111109).unwrap().code, "07081804");
        assert_eq!(code(&u(S256, "&algorithm=SHA256"), 59).unwrap().code, "46119246");
    }

    #[test]
    fn bare_secret_defaults_and_countdown() {
        let o = code(&format!("{} ", S1.to_lowercase()), 59).unwrap(); // case and spaces ignored
        assert_eq!(o.code.len(), 6);
        assert_eq!(o.left, 1);
        assert_eq!(code(S1, 60).unwrap().left, 30);
    }

    #[test]
    fn bad_input_is_an_error() {
        assert!(code("not base32 !!", 0).is_err());
        assert!(code("", 0).is_err());
        assert!(code("otpauth://totp/x?secret=GEZDGNBV&digits=3", 0).is_err());
    }
}
