//! Quick unlock: the vault key, protected by Windows (DPAPI) for this Windows user. Whoever is signed in to this
//! Windows account (or runs as it) can unlock the vault without the master password: that is the point of the option.
#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

    const ENTROPY: &[u8] = b"local.vault quick unlock v1";
    fn blob(b: &[u8]) -> CRYPT_INTEGER_BLOB { CRYPT_INTEGER_BLOB { cbData: b.len() as u32, pbData: b.as_ptr() as *mut u8 } }

    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: Windows allocated `pbData` with `cbData` bytes; we copy then free it once.
        unsafe { let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec(); LocalFree(out.pbData as _); v }
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ent = blob(ENTROPY);
        // SAFETY: all pointers are valid for the call; `out` is filled by Windows.
        let ok = unsafe { CryptProtectData(&blob(data), std::ptr::null(), &ent, std::ptr::null(), std::ptr::null(), 0, &mut out) };
        if ok == 0 { return Err("Windows could not protect the key".into()); }
        Ok(take(out))
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ent = blob(ENTROPY);
        // SAFETY: as above.
        let ok = unsafe { CryptUnprotectData(&blob(data), std::ptr::null_mut(), &ent, std::ptr::null(), std::ptr::null(), 0, &mut out) };
        if ok == 0 { return Err("Windows could not unlock the saved key (different Windows account?)".into()); }
        Ok(take(out))
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn protect(_: &[u8]) -> Result<Vec<u8>, String> { Err("quick unlock needs Windows".into()) }
    pub fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> { Err("quick unlock needs Windows".into()) }
}

pub use imp::{protect, unprotect};

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn roundtrip_and_tamper() {
        let key = [42u8; 32];
        let blob = super::protect(&key).unwrap();
        assert_ne!(&blob[..], &key[..]);
        assert_eq!(super::unprotect(&blob).unwrap(), key);
        let mut bad = blob.clone();
        let n = bad.len() - 3;
        bad[n] ^= 1;
        assert!(super::unprotect(&bad).is_err());
    }
}
