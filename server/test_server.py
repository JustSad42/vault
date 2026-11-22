import json, os, tempfile, threading, unittest, urllib.error, urllib.request
os.environ['VAULT_SYNC_DIR'] = tempfile.mkdtemp()
import server
from http.server import ThreadingHTTPServer

TOK = 'ab' * 20


class T(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(('127.0.0.1', 0), server.H)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def req(self, method, path, body=None, tok=TOK, **h):
        r = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', data=body, method=method, headers=({'Authorization': 'Bearer ' + tok} if tok else {}) | h)
        try:
            with urllib.request.urlopen(r) as x:
                return x.status, x.read(), x.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def test_auth_and_slots(self):
        self.assertEqual(self.req('GET', '/v1/info', tok=None)[0], 401)
        self.assertEqual(self.req('GET', '/v1/info', tok='short')[0], 401)
        self.assertEqual(json.loads(self.req('GET', '/v1/info', tok='cd' * 20)[1])['rev'], 0)

    def test_vault_compare_and_swap_and_history(self):
        tok = 'ef' * 20
        blob = b'VLT1' + b'x' * 100
        self.assertEqual(self.req('GET', '/v1/vault', tok=tok)[0], 404)
        self.assertEqual(self.req('PUT', '/v1/vault', b'garbage', tok=tok, **{'If-Match': '0'})[0], 400)
        s, b, _ = self.req('PUT', '/v1/vault', blob, tok=tok, **{'If-Match': '0'})
        self.assertEqual((s, json.loads(b)['rev']), (200, 1))
        s, b, _ = self.req('PUT', '/v1/vault', blob + b'2', tok=tok, **{'If-Match': '0'})  # a second device that has not seen rev 1
        self.assertEqual((s, json.loads(b)['rev']), (409, 1))
        self.assertEqual(self.req('PUT', '/v1/vault', blob + b'2', tok=tok, **{'If-Match': '1'})[0], 200)
        s, b, h = self.req('GET', '/v1/vault', tok=tok)
        self.assertEqual((s, b, h['X-Rev']), (200, blob + b'2', '2'))
        for i in range(2, 40):
            self.assertEqual(self.req('PUT', '/v1/vault', blob + bytes([i]), tok=tok, **{'If-Match': str(i)})[0], 200)
        self.assertLessEqual(len(os.listdir(os.path.join(server.slot_dir(tok), 'versions'))), server.KEEP)

    def test_recovery_attachments_and_delete(self):
        tok = '12' * 20
        self.assertEqual(self.req('PUT', '/v1/recovery', b'nope', tok=tok)[0], 400)
        self.assertEqual(self.req('PUT', '/v1/recovery', b'VRC1abc', tok=tok)[0], 200)
        self.assertEqual(self.req('GET', '/v1/recovery', tok=tok)[1], b'VRC1abc')
        aid = 'a1' * 12
        self.assertEqual(self.req('PUT', f'/v1/att/{aid}', b'enc', tok=tok)[0], 200)
        self.assertEqual(json.loads(self.req('GET', '/v1/att', tok=tok)[1]), [{'id': aid, 'size': 3}])
        self.assertEqual(self.req('GET', '/v1/att/../../etc/passwd', tok=tok)[0], 404)
        self.assertEqual(self.req('DELETE', f'/v1/att/{aid}', tok=tok)[0], 200)
        self.assertEqual(self.req('DELETE', '/v1/all', tok=tok)[0], 200)
        self.assertEqual(json.loads(self.req('GET', '/v1/info', tok=tok)[1])['rev'], 0)


if __name__ == '__main__':
    unittest.main()
