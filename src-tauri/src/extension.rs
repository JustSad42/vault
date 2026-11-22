//! The browser extension travels inside the app: Vault writes it to a folder for "Load unpacked" and registers the
//! native-messaging host so Chrome and Edge can start `vault.exe --native-host`.
use std::{path::Path, process::Command};

/// Fixed by the public key in extension/manifest.json, so the host manifest can name exactly this extension.
pub const EXTENSION_ID: &str = "minkodnoaeoogpdmiijfmcggndakbjhf";

const FILES: &[(&str, &[u8])] = &[
    ("manifest.json", include_bytes!("../../extension/manifest.json")), ("host.js", include_bytes!("../../extension/host.js")), ("background.js", include_bytes!("../../extension/background.js")),
    ("content.js", include_bytes!("../../extension/content.js")), ("passkey.js", include_bytes!("../../extension/passkey.js")), ("popup.html", include_bytes!("../../extension/popup.html")),
    ("popup.js", include_bytes!("../../extension/popup.js")), ("popup.css", include_bytes!("../../extension/popup.css")), ("icon48.png", include_bytes!("../../extension/icon48.png")),
    ("icon128.png", include_bytes!("../../extension/icon128.png")),
];

pub fn install(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for (name, bytes) in FILES { std::fs::write(dir.join(name), bytes).map_err(|e| e.to_string())?; }
    Ok(())
}

/// Writes the host manifest and points Chrome's and Edge's registry entries (current user only) at it.
pub fn register_native_host(vault_dir: &Path, name: &str) {
    let Ok(exe) = std::env::current_exe() else { return };
    let dir = vault_dir.join("native-host");
    let _ = std::fs::create_dir_all(&dir);
    let manifest = dir.join(format!("{name}.json"));
    let json = serde_json::json!({ "name": name, "description": "Vault password manager", "path": exe, "type": "stdio", "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")] });
    if std::fs::write(&manifest, json.to_string()).is_err() { return; }
    for browser in [r"Software\Google\Chrome", r"Software\Microsoft\Edge"] {
        let key = format!(r"HKCU\{browser}\NativeMessagingHosts\{name}");
        let mut c = Command::new("reg");
        c.args(["add", &key, "/ve", "/t", "REG_SZ", "/d"]).arg(&manifest).arg("/f").stdin(std::process::Stdio::null());
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
        let _ = c.output();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn extension_files_are_embedded_and_the_id_matches_the_manifest_key() {
        let m: serde_json::Value = serde_json::from_slice(super::FILES.iter().find(|f| f.0 == "manifest.json").unwrap().1).unwrap();
        let der = data_encoding::BASE64.decode(m["key"].as_str().unwrap().as_bytes()).unwrap();
        use sha2::{Digest, Sha256};
        let id: String = Sha256::digest(&der)[..16].iter().flat_map(|b| [b >> 4, b & 15]).map(|n| (b'a' + n) as char).collect();
        assert_eq!(id, super::EXTENSION_ID);
        let dir = std::env::temp_dir().join(format!("vault-ext-{}", id));
        super::install(&dir).unwrap();
        assert!(dir.join("content.js").exists() && dir.join("icon128.png").exists());
    }
}
