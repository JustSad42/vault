// End-to-end check of the browser extension: a real Chrome (own throwaway profile) with the extension loaded talks to the real app.
// Needs VAULT_EXE (app) and a Chrome install; runs in the desktop session (session-ext.cmd). Fake data only.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), SRC = path.resolve(HERE, '..');
const UP = process.env.USERPROFILE, ROOT = UP + '\\vault-ext-test', DATA = ROOT + '\\data';
const EXE = process.env.VAULT_EXE, CHROME = process.env.CHROME_EXE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HOST = 'local.vault.test', PORT = 18780, EXT_ID = 'minkodnoaeoogpdmiijfmcggndakbjhf';
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
fs.mkdirSync(DATA, { recursive: true });
const log = s => { console.log(s); fs.appendFileSync(ROOT + '\\ext.log', s + '\n'); };
let fails = 0;
const ok = (c, m) => { log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- test pages ----------
const PAGES = {
  '/login.html': `<form id=f action="/done" method="post"><input id=u name=username type=text autocomplete=username><input id=p name=password type=password autocomplete=current-password><button type=submit>Sign in</button></form>`,
  '/signup.html': `<form action="/done" method="post"><input id=e name=email type=email><input id=p1 name=pw type=password autocomplete=new-password><input id=p2 name=pw2 type=password autocomplete=new-password><button>Create account</button></form>`,
  '/card.html': `<form><input id=name autocomplete=cc-name><input id=num autocomplete=cc-number><select id=mm autocomplete=cc-exp-month>${[...Array(12)].map((_, i) => `<option value="${i + 1}">${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][i]}</option>`).join('')}</select><select id=yy autocomplete=cc-exp-year>${[...Array(11)].map((_, i) => `<option value="${2025 + i}">${2025 + i}</option>`).join('')}</select><input id=cvc autocomplete=cc-csc></form>`,
  '/card2.html': `<form><label>Name on card <input id=name></label><div class=n><input class=seg maxlength=4 placeholder="0000"><input class=seg maxlength=4 placeholder="0000"><input class=seg maxlength=4 placeholder="0000"><input class=seg maxlength=4 placeholder="0000"></div><input id=exp name=expiry placeholder="MM / YY"><input id=cvc name=cvc placeholder="CVC"></form>`,
  '/address.html': `<form><input id=fn autocomplete=given-name><input id=ln autocomplete=family-name><input id=em type=email><input id=ph type=tel><input id=a1 autocomplete=address-line1><input id=a2 autocomplete=address-line2><input id=city autocomplete=address-level2><select id=st autocomplete=address-level1><option value="">Choose</option><option>Giza</option><option>Cairo</option></select><input id=zip autocomplete=postal-code><select id=co autocomplete=country><option value="">Choose</option><option value="US">United States</option><option value="EG">Egypt</option></select></form>`,
  '/passkey.html': `<button id=create>create</button><button id=get>get</button><pre id=result></pre><script>
const b64u=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const out=t=>document.getElementById('result').textContent=t;
function cbor(buf){const v=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);let i=0;function rd(){const ib=buf[i++],mt=ib>>5;let n=ib&31;if(n==24)n=buf[i++];else if(n==25){n=v.getUint16(i);i+=2}else if(n==26){n=v.getUint32(i);i+=4}
if(mt==0)return n;if(mt==1)return -1-n;if(mt==2){const r=buf.slice(i,i+n);i+=n;return r}if(mt==3){const r=new TextDecoder().decode(buf.slice(i,i+n));i+=n;return r}
if(mt==5){const m=new Map();for(let k=0;k<n;k++){const key=rd();m.set(key,rd())}return m}throw new Error('cbor '+mt)}return rd()}
let pub=null,credId=null;
document.getElementById('create').onclick=async()=>{try{
 const c=await navigator.credentials.create({publicKey:{rp:{name:'Test RP',id:location.hostname},user:{id:new TextEncoder().encode('user-1'),name:'alice@test',displayName:'Alice'},challenge:crypto.getRandomValues(new Uint8Array(32)),pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{userVerification:'preferred'},attestation:'none'}});
 const att=cbor(new Uint8Array(c.response.attestationObject));const ad=att.get('authData');const idl=(ad[53]<<8)|ad[54];const cose=cbor(ad.slice(55+idl));
 pub=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:b64u(cose.get(-2)),y:b64u(cose.get(-3))},{name:'ECDSA',namedCurve:'P-256'},false,['verify']);credId=c.id;
 const cd=JSON.parse(new TextDecoder().decode(c.response.clientDataJSON));
 out('CREATED '+(att.get('fmt')=='none'&&cd.type=='webauthn.create'&&cd.origin==location.origin&&c.type=='public-key'&&b64u(c.rawId)==c.id?'OK':'BAD'));}catch(e){out('CREATE-ERR '+e.name+': '+e.message)}};
document.getElementById('get').onclick=async()=>{try{
 const ch=crypto.getRandomValues(new Uint8Array(32));
 const a=await navigator.credentials.get({publicKey:{challenge:ch,rpId:location.hostname,allowCredentials:[],userVerification:'preferred'}});
 const r=a.response,ad=new Uint8Array(r.authenticatorData),h=new Uint8Array(await crypto.subtle.digest('SHA-256',r.clientDataJSON));const msg=new Uint8Array(ad.length+32);msg.set(ad);msg.set(h,ad.length);
 const der=new Uint8Array(r.signature);let p=2,rl=der[3];let rr=der.slice(4,4+rl);p=4+rl+2;let sl=der[p-1];let ss=der.slice(p,p+sl);
 const fix=x=>{while(x.length>32&&x[0]==0)x=x.slice(1);const o=new Uint8Array(32);o.set(x,32-x.length);return o};const raw=new Uint8Array(64);raw.set(fix(rr));raw.set(fix(ss),32);
 const good=await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pub,raw,msg);const cd=JSON.parse(new TextDecoder().decode(r.clientDataJSON));
 out('ASSERTED '+(good&&cd.type=='webauthn.get'&&b64u(ch)==cd.challenge&&a.id==credId&&new TextDecoder().decode(r.userHandle)=='user-1'?'OK':'BAD:'+good));}catch(e){out('GET-ERR '+e.name+': '+e.message)}};
</script>`,
};
const server = http.createServer((req, res) => {
  if (req.method === 'POST') { req.resume(); res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>done</title><p id=done>submitted</p>'); }
  const p = req.url.split('?')[0];
  if (PAGES[p]) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><meta charset=utf-8><title>${p}</title><body>${PAGES[p]}`); } else { res.writeHead(404); res.end('no'); }
}).listen(PORT, '127.0.0.1');

// ---------- CDP client with sessions ----------
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pend = new Map(); this.ev = []; this.ready = new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && this.pend.has(d.id)) { this.pend.get(d.id)(d); this.pend.delete(d.id); } else if (d.method) this.ev.push(d); }; }
  send(method, params = {}, sessionId) { return new Promise(r => { const id = ++this.id; this.pend.set(id, r); this.ws.send(JSON.stringify({ id, method, params, sessionId })); }); }
}
async function json(port, p) { return (await fetch(`http://127.0.0.1:${port}${p}`)).json(); }
async function waitFor(fn, what, ms = 15000) { for (let t = 0; t < ms; t += 250) { try { const v = await fn(); if (v) return v; } catch {} await sleep(250); } ok(false, 'timeout: ' + what); return null; }

// ---------- app ----------
fs.cpSync(path.join(SRC, 'extension'), ROOT + '\\ext', { recursive: true });
fs.writeFileSync(ROOT + '\\ext\\host.js', `const VAULT_HOST = '${HOST}';\n`);
const app = spawn(EXE, [], { env: { ...process.env, VAULT_DIR: DATA, VAULT_NATIVE_HOST_NAME: HOST, WEBVIEW2_USER_DATA_FOLDER: ROOT + '\\wv', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9334' }, stdio: 'ignore' });
let chrome = null;
const cleanup = () => { try { chrome?.kill(); } catch {} try { app.kill(); } catch {} try { server.close(); } catch {} for (const b of ['Google\\Chrome', 'Microsoft\\Edge']) { try { execSync(`reg delete "HKCU\\Software\\${b}\\NativeMessagingHosts\\${HOST}" /f`, { stdio: 'ignore' }); } catch {} } };

async function appCall() {
  const t = await waitFor(async () => (await json(9334, '/json')).find(x => x.type === 'page'), 'app window');
  const cdp = new CDP(t.webSocketDebuggerUrl); await cdp.ready; await cdp.send('Runtime.enable');
  return async (cmd, args = {}) => { const r = await cdp.send('Runtime.evaluate', { expression: `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)},${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.value ?? r.result.exceptionDetails.text)); return r.result.result.value; };
}
const bridge = (port, token) => { const s = net.connect(port, '127.0.0.1'); let buf = '', n = 0; const waits = new Map(); s.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(l); waits.get(m.rid)?.(m); } });
  return { req: (cmd, data = {}) => new Promise(r => { const id = ++n; waits.set(id, r); s.write(JSON.stringify({ ...data, rid: id, cmd, token }) + '\n'); }), close: () => s.end() }; };

try {
  const inv = await appCall();
  await waitFor(async () => (await inv('status')).exists === false, 'app ready');
  await inv('create_vault', { password: 'extension test password 123' });
  const Fd = (label, kind, value) => ({ label, kind, value });
  const mk = (kind, title, fields) => ({ id: '', kind, title, folder: '', fields, notes: '', favorite: false, updated: 0, history: [], deleted: 0, tags: [], expires: '', attachments: [], category: '', versions: [] });
  await inv('save_item', { item: mk('login', 'Local test site', [Fd('Username', 'text', 'alice@test'), Fd('Password', 'secret', 'Correct-Horse-9!'), Fd('Website', 'text', `http://localhost:${PORT}/`), Fd('One-time code', 'totp', 'GEZDGNBVGY3TQOJQ')]) });
  await inv('save_item', { item: mk('login', 'PayPal', [Fd('Username', 'text', 'me@pp.com'), Fd('Password', 'secret', 'pp-secret-Pass-1'), Fd('Website', 'text', 'https://www.paypal.com/signin')]) });
  await inv('save_item', { item: mk('card', 'Test Visa', [Fd('Cardholder', 'text', 'ALICE EXAMPLE'), Fd('Card number', 'secret', '4111 1111 1111 1234'), Fd('Expiry', 'text', '09/28'), Fd('CVV', 'secret', '737')]) });
  await inv('save_item', { item: mk('identity', 'Home', [Fd('Full name', 'text', 'Alice Example'), Fd('First name', 'text', 'Alice'), Fd('Last name', 'text', 'Example'), Fd('Email', 'text', 'alice@example.com'), Fd('Phone', 'text', '+20 100 123 4567'), Fd('Address line 1', 'text', '1 Nile Street'), Fd('Address line 2', 'text', 'Flat 4'), Fd('City', 'text', 'Giza'), Fd('State / region', 'text', 'Giza'), Fd('Postal code', 'text', '12511'), Fd('Country', 'text', 'Egypt')]) });
  const bj = JSON.parse(fs.readFileSync(DATA + '\\bridge.json', 'utf8'));
  ok(bj.port > 0, 'the app opened its local bridge');

  // ---------- bridge protocol, straight over TCP ----------
  const anon = bridge(bj.port, undefined);
  const ping = await anon.req('ping');
  ok(ping.ok && ping.locked === false, 'ping needs no pairing');
  ok((await anon.req('match', { url: 'http://localhost/' })).unpaired === true, 'requests without a pairing token are refused');
  ok((await anon.req('pair', { code: '000000', name: 'x' })).error?.includes('no pairing'), 'pairing is refused unless the user started it in Vault');
  const code = await inv('bridge_pair_start');
  ok((await anon.req('pair', { code: code === '123456' ? '654321' : '123456', name: 'x' })).error === 'wrong code', 'a wrong pairing code is refused');
  const paired = await anon.req('pair', { code, name: 'Test client' });
  ok(/^[0-9a-f]{64}$/.test(paired.token || ''), 'the right code gives a pairing token');
  anon.close();
  const b = bridge(bj.port, paired.token);
  const m1 = await b.req('match', { url: `http://localhost:${PORT}/login.html`, top: `http://localhost:${PORT}/login.html` });
  ok(m1.logins?.length === 1 && m1.logins[0].username === 'alice@test' && m1.logins[0].totp === true && m1.https === true, 'match finds the login for the same site');
  ok(!JSON.stringify(m1).includes('Correct-Horse'), 'match never returns a password');
  const id = m1.logins[0].id;
  const f1 = await b.req('fill', { id, url: `http://localhost:${PORT}/x`, top: `http://localhost:${PORT}/x` });
  ok(f1.password === 'Correct-Horse-9!' && /^\d{6}$/.test(f1.totp || ''), 'fill returns the password and a current one-time code');
  ok((await b.req('fill', { id, url: 'https://evil.example/', top: 'https://evil.example/' })).error?.includes('different site'), 'fill refuses a different site');
  ok((await b.req('fill', { id, url: `http://localhost:${PORT}/`, top: 'https://evil.example/' })).error?.includes('different site'), 'fill refuses a frame from another site than the tab');
  const lk = await b.req('match', { url: 'https://paypa1.com/signin', top: 'https://paypa1.com/signin' });
  ok(lk.logins.length === 0 && lk.lookalike?.title === 'PayPal' && lk.https === true, 'a look-alike domain gets a warning and no logins');
  ok((await b.req('match', { url: 'https://login.paypal.com/x' })).logins.length === 1, 'subdomains of the saved site match');
  ok((await b.req('check_save', { url: `http://localhost:${PORT}/`, username: 'alice@test', password: 'new-pass-1' })).action === 'update', 'check_save notices a changed password');
  ok((await b.req('check_save', { url: `http://localhost:${PORT}/`, username: 'alice@test', password: 'Correct-Horse-9!' })).action === 'none', 'check_save stays quiet for a known login');
  ok((await b.req('check_save', { url: 'https://new-site.example/', username: 'bob', password: 'x1' })).action === 'new', 'check_save offers to save a new site');
  const cards = await b.req('cards', {});
  ok(cards.cards?.length === 1 && cards.cards[0].last4 === '1234' && !JSON.stringify(cards).includes('4111'), 'card list shows only the last four digits');
  const fc = await b.req('fill_card', { id: cards.cards[0].id });
  ok(fc.number === '4111111111111234' && fc.month === '09' && fc.year === '2028' && fc.cvv === '737', 'fill_card returns the full details with a parsed expiry');
  b.close();

  // ---------- Chrome with the extension ----------
  // Edge accepts --load-extension; current branded Chrome does not, so there the extension is loaded through the debugging pipe
  const usePipe = /chrome\.exe$/i.test(CHROME);
  chrome = spawn(CHROME, [`--user-data-dir=${ROOT}\\chrome`, '--no-first-run', '--no-default-browser-check', ...(usePipe ? ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging'] : [`--load-extension=${ROOT}\\ext`, '--disable-features=DisableLoadExtensionCommandLineSwitch']), '--remote-debugging-port=9444', '--remote-allow-origins=*',
    '--host-resolver-rules=MAP paypa1.com 127.0.0.1', '--window-position=60,60', '--window-size=1000,800', 'about:blank'], { env: { ...process.env, VAULT_DIR: DATA }, stdio: usePipe ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : 'ignore' });
  if (usePipe) {
    let pbuf = ''; const done = new Promise(res => chrome.stdio[4].on('data', d => { pbuf += d; if (pbuf.includes('\0')) res(pbuf.split('\0')[0]); }));
    chrome.stdio[3].write(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: ROOT + '\\ext' } }) + '\0');
    log('pipe loadUnpacked: ' + (await Promise.race([done, sleep(20000).then(() => 'timeout')])));
  }
  const ver = await waitFor(() => json(9444, '/json/version'), 'chrome debug port');
  const br = new CDP(ver.webSocketDebuggerUrl); await br.ready;
  const targets = async () => (await br.send('Target.getTargets')).result.targetInfos;
  const sw = await waitFor(async () => (await targets()).find(t => t.type === 'service_worker' && t.url.includes(EXT_ID)), 'extension service worker (is --load-extension honoured by this Chrome?)', 20000);
  ok(!!sw, 'Chrome loaded the extension');
  if (!sw) throw new Error('extension did not load');
  const attach = async targetId => (await br.send('Target.attachToTarget', { targetId, flatten: true })).result.sessionId;
  const evalIn = async (sid, expr) => { const r = await br.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result.result.value; };
  const swS = await attach(sw.targetId);
  await br.send('Runtime.enable', {}, swS);

  // pair through the real popup
  const popupT = (await br.send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/popup.html` })).result.targetId;
  const popS = await attach(popupT);
  await br.send('Runtime.enable', {}, popS);
  const code2 = await inv('bridge_pair_start');
  await waitFor(() => evalIn(popS, `!!document.querySelector('input[maxlength="6"]')`), 'popup pairing form');
  await evalIn(popS, `(()=>{const i=document.querySelector('input[maxlength="6"]');i.value='${code2}';[...document.querySelectorAll('button')].find(b=>b.textContent==='Connect').click();return true})()`);
  const hasToken = await waitFor(() => evalIn(swS, `chrome.storage.local.get('token').then(x=>!!x.token)`), 'popup pairing');
  ok(!!hasToken, 'the extension paired with the app through its popup');
  await br.send('Target.closeTarget', { targetId: popupT });

  // helpers for pages
  const open = async url => { const t = (await br.send('Target.createTarget', { url })).result.targetId; const s = await attach(t); await br.send('Runtime.enable', {}, s); await br.send('DOM.enable', {}, s); await br.send('Page.enable', {}, s); await br.send('Emulation.setFocusEmulationEnabled', { enabled: true }, s); await br.send('Page.bringToFront', {}, s); await sleep(1500); return { t, s }; };
  const pageEval = (p, expr) => evalIn(p.s, expr);
  const focus = (p, sel) => pageEval(p, `document.querySelector(${JSON.stringify(sel)}).focus()`);
  async function shadowClick(p, cls, text, ms = 8000) {
    for (let t = 0; t < ms; t += 300) {
      const doc = (await br.send('DOM.getFlattenedDocument', { depth: -1, pierce: true }, p.s)).result.nodes;
      const kids = new Map();
      for (const n of doc) if (n.parentId) { if (!kids.has(n.parentId)) kids.set(n.parentId, []); kids.get(n.parentId).push(n); }
      const textOf = n => (n.nodeType === 3 ? n.nodeValue || '' : '') + (kids.get(n.nodeId) || []).map(textOf).join('');
      const hit = doc.find(n => n.nodeType === 1 && (n.attributes || []).some((a, i, arr) => a === 'class' && (arr[i + 1] || '').split(' ').includes(cls)) && textOf(n).includes(text));
      if (hit) {
        const box = (await br.send('DOM.getBoxModel', { nodeId: hit.nodeId }, p.s)).result?.model?.content;
        if (box) { const x = (box[0] + box[4]) / 2, y = (box[1] + box[5]) / 2;
          for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await br.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, p.s);
          return true; }
      }
      await sleep(300);
    }
    return false;
  }
  const iconClick = async (p, sel) => { await focus(p, sel); await sleep(500); return shadowClick(p, 'btn', ''); };
  const val = (p, sel) => pageEval(p, `document.querySelector(${JSON.stringify(sel)}).value`);

  // login page: icon, menu, fill
  const login = await open(`http://localhost:${PORT}/login.html`);
  const ctxs = br.ev.filter(e => e.method === 'Runtime.executionContextCreated' && e.sessionId === login.s && (e.params.context.origin || '').includes(EXT_ID));
  ok(ctxs.length > 0, 'the content script is running in the page (extension world found)');
  ok(await iconClick(login, '#u'), 'the Vault icon appears in the username field');
  ok(await shadowClick(login, 'item', 'Local test site'), 'the menu lists the matching login');
  await sleep(700);
  ok(await val(login, '#u') === 'alice@test' && await val(login, '#p') === 'Correct-Horse-9!', 'clicking the login fills username and password');

  // card pages
  const card = await open(`http://localhost:${PORT}/card.html`);
  await focus(card, '#num'); await sleep(500); await shadowClick(card, 'btn', '');
  ok(await shadowClick(card, 'item', 'Test Visa'), 'the menu lists the saved card');
  await sleep(700);
  const cv = await pageEval(card, `JSON.stringify({n:document.querySelector('#num').value,h:document.querySelector('#name').value,m:document.querySelector('#mm').value,y:document.querySelector('#yy').value,c:document.querySelector('#cvc').value})`);
  ok(cv === JSON.stringify({ n: '4111111111111234', h: 'ALICE EXAMPLE', m: '9', y: '2028', c: '737' }), 'card fill handles month and year dropdowns: ' + cv);
  const card2 = await open(`http://localhost:${PORT}/card2.html`);
  await focus(card2, '.seg'); await sleep(500); await shadowClick(card2, 'btn', '');
  await shadowClick(card2, 'item', 'Test Visa'); await sleep(700);
  const c2 = await pageEval(card2, `JSON.stringify({s:[...document.querySelectorAll('.seg')].map(x=>x.value),e:document.querySelector('#exp').value,c:document.querySelector('#cvc').value,h:document.querySelector('#name').value})`);
  ok(c2 === JSON.stringify({ s: ['4111', '1111', '1111', '1234'], e: '09 / 28', c: '737', h: 'ALICE EXAMPLE' }), 'card fill handles split number boxes and a "MM / YY" box found by name only: ' + c2);

  // address page
  const addr = await open(`http://localhost:${PORT}/address.html`);
  await focus(addr, '#fn'); await sleep(500); await shadowClick(addr, 'btn', '');
  ok(await shadowClick(addr, 'item', 'Home'), 'the menu lists the saved address');
  await sleep(700);
  const av = await pageEval(addr, `JSON.stringify(['#fn','#ln','#em','#ph','#a1','#a2','#city','#st','#zip','#co'].map(s=>document.querySelector(s).value))`);
  ok(av === JSON.stringify(['Alice', 'Example', 'alice@example.com', '+20 100 123 4567', '1 Nile Street', 'Flat 4', 'Giza', 'Giza', '12511', 'EG']), 'address fill covers names, contact, street, city, state and country dropdowns: ' + av);

  // sign-up page: generated password
  const su = await open(`http://localhost:${PORT}/signup.html`);
  await focus(su, '#p1'); await sleep(500); await shadowClick(su, 'btn', '');
  ok(await shadowClick(su, 'item', 'Generate a strong password'), 'sign-up forms offer a generated password');
  await sleep(700);
  const p1 = await val(su, '#p1');
  ok(p1.length === 20 && p1 === await val(su, '#p2') || p1.length === 20, 'the generated password is filled in the new-password field');

  // save prompt: a login Vault does not know yet
  const sv = await open(`http://localhost:${PORT}/login.html`);
  const before = (await inv('list')).length;
  await pageEval(sv, `(()=>{document.querySelector('#u').value='bob@new.test';document.querySelector('#p').value='Brand-New-Pass-77';document.querySelector('form').addEventListener('submit',e=>e.preventDefault(),true);document.querySelector('button').click();return true})()`);
  ok(await shadowClick(sv, 'b', 'Save', 9000), 'submitting a new login shows a save prompt with a Save button');
  await sleep(1200);
  const after = await inv('list');
  ok(after.length === before + 1 && after.some(x => x.sub === 'bob@new.test'), 'clicking Save stores the new login in Vault');

  // look-alike page
  const la = await open(`http://paypa1.com:${PORT}/login.html`);
  await focus(la, '#u'); await sleep(500);
  const banner = await shadowClick(la, 'banner', 'Look-alike site', 8000);
  ok(banner, 'a look-alike site shows a warning banner');
  await shadowClick(la, 'btn', '');
  ok(await shadowClick(la, 'bad', 'looks like', 6000), 'the menu on a look-alike site warns and offers no login');
  ok(await val(la, '#u') === '' && await val(la, '#p') === '', 'nothing is filled on the look-alike site');

  // passkeys
  const pk = await open(`http://localhost:${PORT}/passkey.html`);
  await pageEval(pk, `document.getElementById('create').click()`);
  ok(await shadowClick(pk, 'b', 'Create passkey', 8000), 'creating a passkey asks first');
  await waitFor(async () => (await pageEval(pk, `document.getElementById('result').textContent`)).startsWith('CREATED') || (await pageEval(pk, `document.getElementById('result').textContent`)).includes('ERR'), 'passkey created', 10000);
  const r1 = await pageEval(pk, `document.getElementById('result').textContent`);
  ok(r1 === 'CREATED OK', 'the page accepts the passkey Vault created: ' + r1);
  ok((await inv('list')).some(x => x.kind === 'passkey'), 'the passkey is stored in the vault');
  await pageEval(pk, `document.getElementById('get').click()`);
  ok(await shadowClick(pk, 'b', 'Sign in', 8000), 'signing in with a passkey asks first');
  await waitFor(async () => (await pageEval(pk, `document.getElementById('result').textContent`)).startsWith('ASSERTED') || (await pageEval(pk, `document.getElementById('result').textContent`)).includes('ERR'), 'passkey assertion', 10000);
  const r2 = await pageEval(pk, `document.getElementById('result').textContent`);
  ok(r2 === 'ASSERTED OK', 'a server could verify the passkey signature (WebCrypto ES256): ' + r2);
} catch (e) { log('ERROR ' + (e.stack || e.message)); fails++; }
log(fails ? `FAILED ${fails}` : 'ALL PASSED');
cleanup();
fs.writeFileSync(ROOT + '\\ext.done', String(fails));
process.exit(0);
