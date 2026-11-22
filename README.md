# Vault

A local-first password manager for Windows (Tauri 2, Rust and TypeScript). No account, no cloud: one encrypted file on your PC, with optional encrypted sync to a server you run yourself.

**Install:** download `Vault_x.y.z_x64-setup.exe` from [Releases](../../releases/latest) and run it (per-user, no admin). The app updates itself from here: Settings > Updates, or automatically on start. Every update is checked against a signature key built into the app.

## What it does
- **Items:** logins, cards, bank accounts, identities and addresses, documents (passport, ID: photos and PDFs), secure notes (Markdown with checklists), API keys, SSH keys, Wi-Fi (with QR code), passkeys.
- **Find things:** a search language (`kind:card tag:work is:weak has:totp -old`), typo-tolerant, smart filters (weak, reused, old, no 2FA, no HTTPS, duplicates, expiring), automatic categories, folders, tags, favorites, bulk actions, Ctrl+K quick find (and Ctrl+Alt+K from anywhere).
- **Authenticator:** live one-time codes. Import from **Google Authenticator** (Transfer accounts > Export) by camera, from the screen, from an image or pasted text; scan a site's 2FA QR code from your screen.
- **Browser extension (Chrome and Edge):** autofills logins, cards and addresses (including split card numbers and dropdowns), offers to save new logins, warns about look-alike sites and keeps **passkeys** in Vault. It talks to the app over Chrome native messaging and a loopback-only bridge; the browser must be paired with a code you approve in Vault.
- **Safety net:** version history of every item, trash (30 days), password history, daily encrypted backups with in-app restore, recovery key (printable kit), encrypted export, share one item as an encrypted file, security center with an optional breach check (Have I Been Pwned, k-anonymity).
- **Sign-in:** master password (Argon2id), optional "stay signed in on this PC" (Windows DPAPI), lock on idle or when Windows locks, clipboard auto-clear (kept out of Windows clipboard history), tray icon, start with Windows.
- **Sync (optional):** push and pull with merge to your own server, see [server/](server/README.md).

## Browser extension
Settings > Browser extension > Install: Vault writes the extension to a folder. In `chrome://extensions` turn on Developer mode, choose **Load unpacked** and select that folder, then click the Vault icon in the toolbar and enter the pairing code from Settings > Pair a browser.

## Security design
- File: `VLT1` header (KDF cost and salt, authenticated as AAD) + XChaCha20-Poly1305 over a JSON document; key from Argon2id (64 MiB, 3 passes). Fresh nonce on every save; atomic writes. Attachments are separate XChaCha20-Poly1305 blobs.
- Secrets stay in Rust: one-time codes are computed there and the page only receives the codes. The extension only receives a login for the exact site (registrable domain) of the page asking, never for a look-alike, and never in a frame from another site.
- Data folder: `%APPDATA%\Vault` (`VAULT_DIR` overrides it): `vault.bin`, `backups\`, `attachments\`, `recovery.bin`, `quick.bin` (only with "stay signed in").
- **Not independently audited.** Keep an exported backup somewhere else.

## Build
Windows with Rust, Node and the MSVC Build Tools:
```
npm install
npx tauri icon app-icon.png          # once, makes the icons
npm test                             # front-end unit tests
cd src-tauri && cargo test --lib     # 48 Rust tests, plus the end-to-end scripts in pc-tools
npx tauri build                      # installer in src-tauri\target\release\bundle\nsis
```
To publish a release (maintainer): set `TAURI_SIGNING_PRIVATE_KEY_PATH` to the update-signing key, bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`, run `npx tauri build`, then `node scripts/release.mjs "notes"` (needs the GitHub CLI). `pc-tools/drive.mjs` and `pc-tools/drive-ext.mjs` are end-to-end tests that run the real app and a real browser (fake data only).
