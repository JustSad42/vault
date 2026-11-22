# Vault sync server (optional)

A tiny Python service (standard library only) that keeps an encrypted copy of your vault so you can restore it on a new PC and keep two PCs in step.
It stores **encrypted files only**: the vault file, the recovery file and attachments arrive already encrypted by the app. It never sees a password or plaintext.

- Run it on a machine you control, bound to a private address (Tailscale or LAN): `VAULT_SYNC_BIND=100.x.y.z python3 server.py` (port 8803 by default, data in `VAULT_SYNC_DIR`).
- `vault-sync.service` is an example systemd unit (dedicated no-login user, hardened).
- In Vault: Settings > Sync to your server > enter `http://<address>:8803`. Vault makes a random sync key; it is the only login. Keep it: a new PC needs it ("Restore from my server").
- Plain HTTP is fine over Tailscale (WireGuard encrypts it). Use HTTPS if you expose it any other way.
- API: `GET /v1/info`, `GET|PUT /v1/vault` (PUT needs `If-Match: <rev>`; 409 when another PC wrote first), `GET|PUT /v1/recovery`, `GET /v1/att`, `GET|PUT|DELETE /v1/att/<id>`, `DELETE /v1/all`. Last 30 vault versions are kept.
- Tests: `python3 -B test_server.py`.
