//! Sharing one item as a file: Argon2id + XChaCha20-Poly1305 under a passphrase the sender tells the receiver separately.
use crate::vault::{Item, Kdf};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{aead::{Aead, Payload}, Key, KeyInit, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use zeroize::Zeroizing;

const MAGIC: &[u8; 4] = b"VSH1";
const HDR: usize = 32; // magic + m,t,p + salt

fn key(pass: &str, salt: &[u8], k: Kdf) -> Result<Zeroizing<[u8; 32]>, String> {
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(k.m, k.t, k.p, Some(32)).map_err(|e| e.to_string())?)
        .hash_password_into(pass.as_bytes(), salt, &mut *out).map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn export(item: &Item, pass: &str, kdf: Kdf) -> Result<Vec<u8>, String> {
    if pass.chars().count() < 8 { return Err("the passphrase needs at least 8 characters".into()); }
    // only what the receiver needs: no history, attachments, trash state or favorite flag
    let mut it = item.clone();
    (it.id, it.history, it.attachments, it.deleted, it.favorite, it.updated) = (String::new(), vec![], vec![], 0, false, 0);
    let plain = Zeroizing::new(serde_json::to_vec(&it).map_err(|e| e.to_string())?);
    let (mut salt, mut nonce) = ([0u8; 16], [0u8; 24]);
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let mut out = MAGIC.to_vec();
    for v in [kdf.m, kdf.t, kdf.p] { out.extend_from_slice(&v.to_le_bytes()); }
    out.extend_from_slice(&salt);
    let ct = XChaCha20Poly1305::new(Key::from_slice(&*key(pass, &salt, kdf)?)).encrypt(XNonce::from_slice(&nonce), Payload { msg: &plain, aad: &out[..HDR] })
        .map_err(|_| "encryption failed".to_string())?;
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn import(b: &[u8], pass: &str) -> Result<Item, String> {
    if b.len() < HDR + 24 + 16 || &b[..4] != MAGIC { return Err("not a shared Vault item".into()); }
    let u = |i: usize| u32::from_le_bytes(b[4 + i * 4..8 + i * 4].try_into().unwrap());
    let k = Kdf { m: u(0), t: u(1), p: u(2) };
    if k.m > 1 << 20 || k.t > 20 || k.p > 16 { return Err("unreasonable settings in the file".into()); }
    let pt = XChaCha20Poly1305::new(Key::from_slice(&*key(pass, &b[16..32], k)?)).decrypt(XNonce::from_slice(&b[HDR..HDR + 24]), Payload { msg: &b[HDR + 24..], aad: &b[..HDR] })
        .map_err(|_| "wrong passphrase or damaged file".to_string())?;
    serde_json::from_slice(&Zeroizing::new(pt)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{Att, Field};
    const FAST: Kdf = Kdf { m: 8, t: 1, p: 1 };

    #[test]
    fn roundtrip_wrong_passphrase_and_stripping() {
        let it = Item { id: "x".into(), kind: "login".into(), title: "Netflix".into(), favorite: true, attachments: vec![Att { id: "a".into(), name: "f".into(), size: 1 }],
            fields: vec![Field { label: "Password".into(), value: "hunter2hunter2".into(), kind: "secret".into() }], ..Default::default() };
        let f = export(&it, "long shared phrase", FAST).unwrap();
        assert!(!f.windows(7).any(|w| w == b"Netflix"));
        let back = import(&f, "long shared phrase").unwrap();
        assert_eq!((back.title.as_str(), back.fields[0].value.as_str()), ("Netflix", "hunter2hunter2"));
        assert!(back.id.is_empty() && back.attachments.is_empty() && !back.favorite);
        assert!(import(&f, "wrong passphrase!").is_err());
        let mut bad = f.clone();
        bad[6] ^= 1;
        assert!(import(&bad, "long shared phrase").is_err(), "tampered cost is detected");
        assert!(export(&it, "short", FAST).is_err());
        assert!(import(b"nope", "long shared phrase").is_err());
    }
}
