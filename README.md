# Vault

A local-first password manager for Windows (Tauri 2, Rust and TypeScript). No account, no cloud: one encrypted file on your PC, with optional encrypted sync to a server you run yourself.

**Install:** download `Vault_x.y.z_x64-setup.exe` from [Releases](../../releases/latest) and run it (per-user, no admin). The app updates itself from here: Settings > Updates, or automatically on start. Every update is checked against a signature key built into the app.

## What it does
- **Items:** logins, cards, bank accounts, identities and addresses, documents (passport, ID: photos and PDFs), secure notes (Markdown with checklists), API keys, SSH keys, Wi-Fi (with QR code), passkeys.
- **Find things:** a search language (`kind:card tag:work is:weak has:totp -old`), typo-tolerant, smart filters (weak, reused, old, no 2FA, no HTTPS, duplicates, expiring), automatic categories, folders, tags, favorites, bulk actions, Ctrl+K quick find (and Ctrl+Alt+K from anywhere).
- **Generator:** random passwords, or passphrases of random words from the EFF list (easy to type, about 13 bits per word).
- **Import:** KeePass `.kdbx` databases (groups, custom fields, codes, tags, expiry, attachments), Bitwarden JSON exports (cards, identities, notes, SSH keys), and CSV from Chrome, Edge, Brave, 1Password, Bitwarden or KeePass.
- **Auto-type (Ctrl+Alt+A):** for desktop apps and games: types the username, Tab and the password into the window in front. A login's "Auto-type window" field (part of the window title) picks it straight away; otherwise Vault guesses from the title and lets you choose.
- **Authenticator:** live one-time codes. Import from **Google Authenticator** (Transfer accounts > Export) by camera, from the screen, from an image or pasted text; scan a site's 2FA QR code from your screen.
- **Browser extension (Chrome and Edge):** autofills logins, cards and addresses (including split card numbers and dropdowns), offers to save new logins, warns about look-alike sites and keeps **passkeys** in Vault. It talks to the app over Chrome native messaging and a loopback-only bridge; the browser must be paired with a code you approve in Vault.
- **Safety net:** version history of every item (including bulk folder and tag changes, and the other PC's edit when sync merges two changes), trash (30 days), password history, daily encrypted backups with in-app restore, recovery key (printable kit), encrypted export, share one item as an encrypted file, security center with an optional breach check (Have I Been Pwned, k-anonymity).
- **Sign-in:** master password (Argon2id, re-encrypted automatically if an older Vault used cheaper settings), optional "stay signed in on this PC" (Windows DPAPI) with an optional Windows Hello check, lock on idle, when Windows locks or when the PC sleeps, clipboard auto-clear (kept out of Windows clipboard history), tray icon, start with Windows.
- **Sync (optional):** push and pull with merge to your own server, see [server/](server/README.md).

## Browser extension
Settings > Browser extension > Install: Vault writes the extension to a folder. In `chrome://extensions` turn on Developer mode, choose **Load unpacked** and select that folder, then click the Vault icon in the toolbar and enter the pairing code from Settings > Pair a browser.

## Security design
- File: `VLT1` header (KDF cost and salt, authenticated as AAD) + XChaCha20-Poly1305 over a JSON document; key from Argon2id (64 MiB, 3 passes). Fresh nonce on every save; atomic writes. Attachments are separate XChaCha20-Poly1305 blobs.
- Secrets stay in Rust: the page gets an item with every password, key, code and earlier password replaced by a marker, and asks for one value when you click show or copy (copies go straight from Rust to the clipboard). One-time codes are computed in Rust. Secrets are overwritten in memory when the vault locks.
- Site matching uses the full public suffix list, so `alice.github.io` and `mallory.github.io` are different sites.
- Items deleted for good are remembered for a year, so a sync merge with an older copy does not bring them back.
- Windows Hello is a consent check by the app before it uses the DPAPI-protected key, not extra encryption. The extension only receives a login for the exact site (registrable domain) of the page asking, never for a look-alike, and never in a frame from another site.
- Data folder: `%APPDATA%\Vault` (`VAULT_DIR` overrides it): `vault.bin`, `backups\`, `attachments\`, `recovery.bin`, `quick.bin` (only with "stay signed in").
- **Not independently audited.** Keep an exported backup somewhere else.

## Build
Windows with Rust, Node and the MSVC Build Tools:
```
npm install
npx tauri icon app-icon.png          # once, makes the icons
npm test                             # front-end unit tests
cd src-tauri && cargo test --lib     # 62 Rust tests, plus the end-to-end scripts in pc-tools
npx tauri build                      # installer in src-tauri\target\release\bundle\nsis
```
To publish a release (maintainer): set `TAURI_SIGNING_PRIVATE_KEY_PATH` to the update-signing key, bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`, run `npx tauri build`, then `node scripts/release.mjs "notes"` (needs the GitHub CLI). `pc-tools/drive.mjs` and `pc-tools/drive-ext.mjs` are end-to-end tests that run the real app and a real browser (fake data only). They start the app with `VAULT_TEST_COPY=1`, so it can run next to an installed Vault (no single-instance hand-off, no global hotkeys, no native-host registration). GitHub Actions runs the unit tests on every push.
