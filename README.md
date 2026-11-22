# Vault

A local-first password manager for Windows (Tauri 2 + Rust + TypeScript). No account, no server: one encrypted file on your PC.

## What it does
- **Items:** logins, credit/debit cards, secure notes, SSH keys, API keys (JWT decode), Wi-Fi (with QR code), other cards/IDs. Folders, favorites, search, trash (30 days), password history.
- **Authenticator:** live one-time codes (TOTP) for every item. Import from **Google Authenticator** (Transfer accounts > Export QR, any number of batches), scan a site's 2FA QR **from your screen**, from an image file, or from a pasted screenshot; merges into an existing login.
- **Security center:** weak, reused, old and `http://` passwords, plus an optional breach check (Have I Been Pwned, k-anonymity: only 5 hash characters leave the PC).
- **Sign-in:** master password (Argon2id). Optional **stay signed in on this PC**: the key is protected by Windows (DPAPI), so Vault opens straight into the vault and unlocks with one click. Anyone using that Windows account can open it, so it is off unless you choose it.
- **Quick find** (`Ctrl+K`, global `Ctrl+Alt+K`), keyboard shortcuts, clipboard auto-clear (excluded from Windows clipboard history and cloud sync), idle auto-lock, daily encrypted backups, encrypted backup export, CSV import (Chrome/Edge/Bitwarden/1Password/KeePass), light and dark theme.

## Security design
- File: `VLT1` header (KDF cost + salt, authenticated as AAD) + XChaCha20-Poly1305 over a JSON document; key from Argon2id (64 MiB, 3 passes). New random nonce on every save; atomic write (temp file + rename).
- The data folder is `%APPDATA%\Vault` (`VAULT_DIR` overrides it): `vault.bin`, `backups\` (14 daily copies), `quick.bin` (only with "stay signed in").
- Secrets stay in Rust: one-time codes are computed there and the page only receives the codes.
- **Not independently audited.** Keep an exported backup somewhere else.

## Build (Windows, Rust + Node + MSVC Build Tools)
```
npm install
npx tauri build            # installer in src-tauri\target\release\bundle\nsis
cd src-tauri && cargo test --lib
```
`pc.sh` + `pc-tools/` drive builds from a Linux box over ssh (`pc.sh sync|test|build`); `pc-tools/drive.mjs` is an end-to-end test that runs the real window in a desktop session (fake secrets only, `pc-tools/qr/` holds fake QR codes).

## Not done yet
Browser extension (autofill, passkeys), Windows Hello unlock, sync to a server.
