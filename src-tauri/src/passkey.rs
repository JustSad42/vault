//! Passkeys (WebAuthn, ES256, "none" attestation): create a credential, then sign assertions with it.
//! Flags mark the credential as multi-device and backed up (BE/BS) because it lives in the vault, not in a chip.
use data_encoding::BASE64URL_NOPAD as B64;
use p256::{ecdsa::{signature::Signer, Signature, SigningKey}, pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey}};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};

fn head(major: u8, n: u64, out: &mut Vec<u8>) {
    let m = major << 5;
    match n {
        0..=23 => out.push(m | n as u8),
        24..=0xff => out.extend_from_slice(&[m | 24, n as u8]),
        0x100..=0xffff => { out.push(m | 25); out.extend_from_slice(&(n as u16).to_be_bytes()); }
        _ => { out.push(m | 26); out.extend_from_slice(&(n as u32).to_be_bytes()); }
    }
}
fn bytes(b: &[u8], out: &mut Vec<u8>) { head(2, b.len() as u64, out); out.extend_from_slice(b); }
fn text(s: &str, out: &mut Vec<u8>) { head(3, s.len() as u64, out); out.extend_from_slice(s.as_bytes()); }
fn int(n: i64, out: &mut Vec<u8>) { if n >= 0 { head(0, n as u64, out) } else { head(1, (-1 - n) as u64, out) } }

pub struct Created { pub credential_id: Vec<u8>, pub private_pkcs8: Vec<u8>, pub public_spki: Vec<u8>, pub auth_data: Vec<u8>, pub attestation_object: Vec<u8> }

fn rp_hash(rp_id: &str) -> [u8; 32] { Sha256::digest(rp_id.as_bytes()).into() }

fn cose_key(sk: &SigningKey) -> Vec<u8> {
    let pt = sk.verifying_key().to_encoded_point(false);
    let (x, y) = (pt.x().unwrap(), pt.y().unwrap());
    let mut o = vec![];
    head(5, 5, &mut o);
    int(1, &mut o); int(2, &mut o);   // kty: EC2
    int(3, &mut o); int(-7, &mut o);  // alg: ES256
    int(-1, &mut o); int(1, &mut o);  // crv: P-256
    int(-2, &mut o); bytes(x, &mut o);
    int(-3, &mut o); bytes(y, &mut o);
    o
}

pub fn create(rp_id: &str) -> Result<Created, String> {
    let sk = SigningKey::random(&mut OsRng);
    let mut id = vec![0u8; 32];
    OsRng.fill_bytes(&mut id);
    let mut auth = rp_hash(rp_id).to_vec();
    auth.push(0x5D);                         // UP | UV | BE | BS | AT
    auth.extend_from_slice(&[0, 0, 0, 0]);   // signCount: synced credentials report 0
    auth.extend_from_slice(&[0u8; 16]);      // AAGUID
    auth.extend_from_slice(&(id.len() as u16).to_be_bytes());
    auth.extend_from_slice(&id);
    auth.extend_from_slice(&cose_key(&sk));
    let mut att = vec![];
    head(5, 3, &mut att);
    text("fmt", &mut att); text("none", &mut att);
    text("attStmt", &mut att); head(5, 0, &mut att);
    text("authData", &mut att); bytes(&auth, &mut att);
    Ok(Created {
        credential_id: id, private_pkcs8: sk.to_pkcs8_der().map_err(|e| e.to_string())?.as_bytes().to_vec(),
        public_spki: sk.verifying_key().to_public_key_der().map_err(|e| e.to_string())?.as_bytes().to_vec(), auth_data: auth, attestation_object: att,
    })
}

/// (authenticatorData, DER signature) over authData || SHA-256(clientDataJSON).
pub fn assert(private_pkcs8: &[u8], rp_id: &str, client_data_json: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let sk = SigningKey::from_pkcs8_der(private_pkcs8).map_err(|e| e.to_string())?;
    let mut auth = rp_hash(rp_id).to_vec();
    auth.push(0x1D);                         // UP | UV | BE | BS
    auth.extend_from_slice(&[0, 0, 0, 0]);
    let mut msg = auth.clone();
    msg.extend_from_slice(&Sha256::digest(client_data_json));
    let sig: Signature = sk.sign(&msg);
    Ok((auth, sig.to_der().as_bytes().to_vec()))
}

/// WebAuthn only lets a page use rpId when it is the page's host or a parent domain of it; https (or localhost) only.
pub fn rp_allowed(origin: &str, rp_id: &str) -> bool {
    let Some(host) = crate::domain::host_of(origin) else { return false };
    let secure = origin.starts_with("https://") || host == "localhost";
    let rp = rp_id.to_lowercase();
    secure && (rp.contains('.') || rp == "localhost") && (host == rp || host.ends_with(&format!(".{rp}")))
}

/// clientDataJSON must say what we are about to do, for the origin the page claimed.
pub fn check_client_data(json: &str, kind: &str, origin: &str) -> Result<(), String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|_| "bad clientDataJSON".to_string())?;
    if v["type"] != kind || v["origin"] != origin || v["challenge"].as_str().is_none_or(str::is_empty) { return Err("clientDataJSON does not match the request".into()); }
    Ok(())
}

pub fn b64(b: &[u8]) -> String { B64.encode(b) }
pub fn unb64(s: &str) -> Result<Vec<u8>, String> { B64.decode(s.trim_end_matches('=').as_bytes()).map_err(|_| "bad base64url".to_string()) }

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Verifier, VerifyingKey};
    use p256::EncodedPoint;

    /// Reads the COSE key out of authData (after the 55-byte header and the credential id) with a tiny CBOR scan.
    fn cose_xy(auth: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let idlen = u16::from_be_bytes([auth[53], auth[54]]) as usize;
        let k = &auth[55 + idlen..];
        assert_eq!(k[0], 0xA5, "map of 5");
        let find = |tag: &[u8]| { let i = k.windows(tag.len()).position(|w| w == tag).unwrap() + tag.len(); k[i..i + 32].to_vec() };
        (find(&[0x21, 0x58, 0x20]), find(&[0x22, 0x58, 0x20])) // -2: bytes(32), -3: bytes(32)
    }

    #[test]
    fn create_then_assert_verifies_like_a_server_would() {
        let c = create("example.com").unwrap();
        assert_eq!(&c.auth_data[..32], &rp_hash("example.com"));
        assert_eq!(c.auth_data[32], 0x5D);
        assert_eq!(c.credential_id.len(), 32);
        assert!(c.attestation_object.starts_with(&[0xA3, 0x63, b'f', b'm', b't', 0x64, b'n', b'o', b'n', b'e']));
        let (x, y) = cose_xy(&c.auth_data);
        let vk = VerifyingKey::from_encoded_point(&EncodedPoint::from_affine_coordinates(x.as_slice().into(), y.as_slice().into(), false)).unwrap();
        let cd = br#"{"type":"webauthn.get","challenge":"abc","origin":"https://example.com"}"#;
        let (auth, sig) = assert(&c.private_pkcs8, "example.com", cd).unwrap();
        assert_eq!(auth[32], 0x1D);
        let mut msg = auth.clone();
        msg.extend_from_slice(&Sha256::digest(cd));
        vk.verify(&msg, &Signature::from_der(&sig).unwrap()).expect("signature verifies with the public key from the attestation");
        let mut tampered = msg.clone();
        tampered[0] ^= 1;
        assert!(vk.verify(&tampered, &Signature::from_der(&sig).unwrap()).is_err());
    }

    #[test]
    fn relying_party_and_client_data_rules() {
        assert!(rp_allowed("https://login.example.com", "example.com"));
        assert!(rp_allowed("https://example.com", "example.com"));
        assert!(rp_allowed("http://localhost:8080", "localhost"));
        for (o, r) in [("https://evil.com", "example.com"), ("https://notexample.com", "example.com"), ("http://example.com", "example.com"), ("https://example.com", "com"), ("https://a.com", "")] {
            assert!(!rp_allowed(o, r), "{o} must not use rpId {r}");
        }
        let ok = r#"{"type":"webauthn.create","challenge":"xyz","origin":"https://example.com"}"#;
        assert!(check_client_data(ok, "webauthn.create", "https://example.com").is_ok());
        assert!(check_client_data(ok, "webauthn.get", "https://example.com").is_err());
        assert!(check_client_data(ok, "webauthn.create", "https://evil.com").is_err());
        assert!(check_client_data("{}", "webauthn.create", "x").is_err() && check_client_data("nope", "x", "x").is_err());
        assert_eq!(unb64(&b64(&[1, 2, 3, 250])).unwrap(), [1, 2, 3, 250]);
    }
}
