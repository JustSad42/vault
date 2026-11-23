#!/usr/bin/env python3
"""Vault sync: stores encrypted blobs for the Vault app and nothing else. The server never sees a password or plaintext:
the vault file, the recovery file and attachments arrive already encrypted. One slot per sync key (the slot is a hash of the key).
Listens on the Tailscale address only (see vault-sync.service)."""
import hashlib, json, os, re, shutil, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA = os.environ.get('VAULT_SYNC_DIR', '/var/lib/vault-sync')
BIND = os.environ.get('VAULT_SYNC_BIND', '127.0.0.1')
PORT = int(os.environ.get('VAULT_SYNC_PORT', '8803'))
MAX_VAULT, MAX_SMALL, MAX_ATT, KEEP = 64 << 20, 1 << 20, 40 << 20, 30
LOCK = threading.Lock()
TOKEN_RE, ATT_RE = re.compile(r'^[0-9a-f]{32,128}$'), re.compile(r'^[0-9a-f]{24}$')


def slot_dir(token):
    return os.path.join(DATA, hashlib.sha256(token.encode()).hexdigest()[:40])


def read_rev(d):
    try:
        return int(open(os.path.join(d, 'rev')).read().strip())
    except (OSError, ValueError):
        return 0


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class H(BaseHTTPRequestHandler):
    server_version = 'VaultSync'

    def log_message(self, fmt, *args):  # no client addresses or tokens in the journal
        sys.stderr.write('%s %s\n' % (self.command, self.path.split('?')[0]))

    def reply(self, code, body=b'', ctype='application/json', **headers):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in headers.items():
            self.send_header(k.replace('_', '-'), str(v))
        self.end_headers()
        self.wfile.write(body)

    def token(self):
        t = self.headers.get('Authorization', '').removeprefix('Bearer ').strip()
        return t if TOKEN_RE.match(t) else None

    def body(self, limit):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = -1
        if n < 0 or n > limit:  # a negative length would make rfile.read() read without limit
            self.reply(413, {'error': 'too large'})
            return None
        return self.rfile.read(n)

    def route(self):
        tok = self.token()
        if not tok:
            return self.reply(401, {'error': 'missing or malformed sync key'})
        d, p, m = slot_dir(tok), self.path.split('?')[0], self.command
        if p == '/v1/info' and m == 'GET':
            rev = read_rev(d)
            vp = os.path.join(d, 'versions', f'vault-{rev}.bin')
            atts = os.listdir(os.path.join(d, 'att')) if os.path.isdir(os.path.join(d, 'att')) else []
            return self.reply(200, {'rev': rev, 'size': os.path.getsize(vp) if rev and os.path.exists(vp) else 0, 'atts': len(atts), 'recovery': os.path.exists(os.path.join(d, 'recovery.bin'))})
        if p == '/v1/vault':
            if m == 'GET':
                rev = read_rev(d)
                vp = os.path.join(d, 'versions', f'vault-{rev}.bin')
                if not rev or not os.path.exists(vp):
                    return self.reply(404, {'error': 'nothing stored yet'})
                return self.reply(200, open(vp, 'rb').read(), 'application/octet-stream', X_Rev=rev)
            if m == 'PUT':
                data = self.body(MAX_VAULT)
                if data is None:
                    return
                if not data.startswith(b'VLT1'):
                    return self.reply(400, {'error': 'not a Vault file'})
                with LOCK:  # compare-and-swap: a second device cannot silently overwrite the first
                    cur = read_rev(d)
                    if str(cur) != (self.headers.get('If-Match') or '').strip():
                        return self.reply(409, {'error': 'changed elsewhere', 'rev': cur})
                    new = cur + 1
                    write_atomic(os.path.join(d, 'versions', f'vault-{new}.bin'), data)
                    write_atomic(os.path.join(d, 'rev'), str(new).encode())
                    vers = sorted((int(re.search(r'(\d+)', f).group(1)), f) for f in os.listdir(os.path.join(d, 'versions')) if f.endswith('.bin'))
                    for _, f in vers[:-KEEP]:
                        os.remove(os.path.join(d, 'versions', f))
                return self.reply(200, {'rev': new})
        if p == '/v1/recovery':
            if m == 'GET':
                rp = os.path.join(d, 'recovery.bin')
                return self.reply(200, open(rp, 'rb').read(), 'application/octet-stream') if os.path.exists(rp) else self.reply(404, {'error': 'none'})
            if m == 'PUT':
                data = self.body(MAX_SMALL)
                if data is None:
                    return
                if not data.startswith(b'VRC1'):
                    return self.reply(400, {'error': 'not a recovery file'})
                write_atomic(os.path.join(d, 'recovery.bin'), data)
                return self.reply(200, {'ok': True})
        if p == '/v1/att' and m == 'GET':
            ad = os.path.join(d, 'att')
            return self.reply(200, [{'id': f[:-4], 'size': os.path.getsize(os.path.join(ad, f))} for f in sorted(os.listdir(ad)) if f.endswith('.bin')] if os.path.isdir(ad) else [])
        mm = re.match(r'^/v1/att/([0-9a-f]{24})$', p)
        if mm:
            ap = os.path.join(d, 'att', mm.group(1) + '.bin')
            if m == 'GET':
                return self.reply(200, open(ap, 'rb').read(), 'application/octet-stream') if os.path.exists(ap) else self.reply(404, {'error': 'none'})
            if m == 'PUT':
                data = self.body(MAX_ATT)
                if data is None:
                    return
                write_atomic(ap, data)
                return self.reply(200, {'ok': True})
            if m == 'DELETE':
                if os.path.exists(ap):
                    os.remove(ap)
                return self.reply(200, {'ok': True})
        if p == '/v1/all' and m == 'DELETE':
            shutil.rmtree(d, ignore_errors=True)
            return self.reply(200, {'ok': True})
        return self.reply(404, {'error': 'unknown request'})

    do_GET = do_PUT = do_DELETE = route

    def do_POST(self):
        self.reply(405, {'error': 'method not allowed'})


def main():
    os.makedirs(DATA, exist_ok=True)
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()


if __name__ == '__main__':
    main()
