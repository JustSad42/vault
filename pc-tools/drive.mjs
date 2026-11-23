// End-to-end check of the real Vault window through WebView2's debug port. Runs inside the desktop session (session.cmd).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const BUILD = fileURLToPath(new URL('./qr/', import.meta.url));
const ROOT = process.env.USERPROFILE + '\\vault-test', DATA = ROOT + '\\data', EXE = process.env.VAULT_EXE;
fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(DATA, { recursive: true });
const log = (s) => { console.log(s); fs.appendFileSync(ROOT + '\\drive.log', s + '\n'); };
let fails = 0;
const ok = (c, m) => { log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const WV = process.env.USERPROFILE + '\\vault-test-wv-' + Date.now(); // own WebView2 profile per run: flags must match for a shared one
fs.readdirSync(process.env.USERPROFILE).filter(n => n.startsWith('vault-test-wv-')).forEach(n => { try { fs.rmSync(process.env.USERPROFILE + '\\' + n, { recursive: true, force: true }); } catch {} });
const launch = () => spawn(EXE, [], { env: { ...process.env, VAULT_DIR: DATA, VAULT_TEST_COPY: '1', WEBVIEW2_USER_DATA_FOLDER: WV, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333 --use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-video-capture=' + BUILD + 'cam.mjpeg' }, stdio: 'ignore' });
let app = launch();
let ws, id = 0; const pend = new Map();
async function connect() {
  ws = null; pend.clear();
  for (let i = 0; i < 60; i++) {
    try { const t = (await (await fetch('http://127.0.0.1:9333/json')).json()).find(x => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); break; } } catch {}
    await sleep(500);
  }
  if (!ws) throw new Error('no debug target');
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
}
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) { const x = r.result.exceptionDetails; throw new Error(typeof x.exception?.value === 'string' ? x.exception.value : (x.exception?.description || x.text || 'eval error')); }
  return r.result.result.value;
}
async function wait(expr, what, ms = 10000) { for (let t = 0; t < ms; t += 200) { try { if (await ev(expr)) return true; } catch {} await sleep(200); } ok(false, 'timeout: ' + what); return false; }
const click = (text, sel = 'button') => ev(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.trim().startsWith(${JSON.stringify(text)}));if(!b)throw new Error('no button '+${JSON.stringify(text)});b.click();return true})()`);
const setv = (sel, v) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
const text = () => ev('document.body.innerText');
const inv = (cmd, args = {}) => ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)},${JSON.stringify(args)})`);
const clickRow = (t) => ev(`(()=>{const r=[...document.querySelectorAll('.list .row')].find(r=>r.textContent.includes(${JSON.stringify(t)}));if(!r)throw new Error('no row '+${JSON.stringify(t)});r.click();return true})()`);
const nav = (t) => click(t, 'nav button');
const key = (target, init) => ev(`${target}.dispatchEvent(new KeyboardEvent('keydown',Object.assign({bubbles:true},${JSON.stringify(init)})))`);
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${ROOT}\\${name}.png`, Buffer.from(r.result.data, 'base64')); }

try {
  await connect(); await send('Runtime.enable');
  await wait(`!!document.querySelector('form.lock')`, 'lock screen'); await sleep(600); await shot('01-create');
  ok((await text()).includes('Create vault'), 'first run offers Create vault');
  await setv('#pw1', 'short'); await setv('#pw2', 'short'); await click('Create vault');
  await wait(`document.querySelector('#msg').textContent.includes('at least 10')`, 'short password refused'); ok(true, 'short master password refused');
  const MP = 'correct horse battery';
  let CUR = MP; // the master password changes later in the run
  await setv('#pw1', MP); await sleep(300); await shot('02-strength'); await setv('#pw2', MP); await click('Create vault');
  await wait(`!!document.querySelector('.layout')`, 'main screen'); ok(true, 'vault created, main screen shown');
  ok(fs.existsSync(DATA + '\\vault.bin'), 'vault.bin written');
  await sleep(400); await shot('03-empty');

  // login through the UI, with generator
  await click('New'); await click('Login', 'dialog button'); await sleep(300); await shot('04-newdialog-gone');
  await wait(`!!document.querySelector('form.edit')`, 'edit form');
  await setv('form.edit > input:nth-of-type(1)', 'GitHub');
  const row = (i, v) => ev(`(()=>{const e=document.querySelectorAll('.erow')[${i}].querySelectorAll('input')[1];e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await row(0, 'octocat'); await row(2, 'http://github.com'); await row(3, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  await ev(`document.querySelectorAll('.erow')[1].querySelectorAll('button')[0].click()`);
  await wait(`!!document.querySelector('dialog')`, 'generator dialog'); await sleep(600); await shot('05-generator');
  const generated = await ev(`document.querySelector('dialog input.mono').value`);
  ok(generated.length === 20, 'generator gave a 20-char password');
  await click('Use', 'dialog button'); await wait(`!document.querySelector('dialog')`, 'dialog closed');
  ok((await ev(`document.querySelectorAll('.erow')[1].querySelectorAll('input')[1].value`)) === generated, 'generated password filled into the field');
  await shot('06-edit'); await click('Save', 'form.edit button');
  await wait(`!!document.querySelector('.detail .head h2')`, 'detail after save');
  ok((await text()).includes('GitHub') && (await text()).includes('octocat'), 'item saved and listed');
  await wait(`/\\d{3} \\d{3}/.test(document.querySelector('.detail').innerText)`, 'live one-time code'); ok(true, 'one-time code shown with ring');
  await sleep(700); await shot('07-detail');

  // history
  const gh = (await inv('list')).find(x => x.title === 'GitHub');
  let it = await inv('get_item_full', { id: gh.id });
  it.fields.find(f => f.label === 'Password').value = 'NewPass!2345xyz'; await inv('save_item', { item: it });
  it = await inv('get_item_full', { id: gh.id });
  ok(it.history.length === 1 && it.history[0].value === generated, 'changing a password keeps the old one in history');
  // the page only gets markers for secrets, and asks Rust for one value at a time
  const view = await inv('get_item', { id: gh.id });
  const pwIdx = view.fields.findIndex(f => f.label === 'Password');
  ok(view.fields[pwIdx].value.startsWith('\u0001hidden:') && view.fields.find(f => f.kind === 'totp').value.startsWith('\u0001hidden:') && view.history[0].value.startsWith('\u0001hidden:')
    && !JSON.stringify(view).includes('NewPass') && !JSON.stringify(view).includes(generated), 'get_item hides passwords, codes and earlier passwords from the page');
  ok(await inv('reveal', { id: gh.id, src: 'field', at: 0, idx: pwIdx }) === 'NewPass!2345xyz' && await inv('reveal', { id: gh.id, src: 'hist', at: 0, idx: 0 }) === generated, 'reveal gives one value on request');
  ok((view.fields.find(f => f.label === 'Username').value) === 'octocat', 'plain text fields stay visible');

  // csv import + dedupe, card, wifi + QR
  const n = await inv('import_csv', { text: 'name,url,username,password,note\nBank,https://bank.example,me,pw-1,\nBank,https://bank.example,me,pw-1,\n' });
  ok(n === 1, 'CSV import added 1 and skipped the duplicate row (got ' + n + ')');
  await nav('Cards'); await click('New'); await click('Credit', 'dialog button'); await wait(`!!document.querySelector('form.edit')`, 'card edit form');
  await setv('form.edit > input:nth-of-type(1)', 'Visa');
  await ev(`(()=>{const e=document.querySelectorAll('.erow')[1].querySelectorAll('input')[1];e.value='4111 1111 1111 1234';e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await click('Save', 'form.edit button'); await wait(`document.querySelector('.list').innerText.includes('•••• 1234')`, 'card masked in list');
  await wait(`!!document.querySelector('.wallet')`, 'wallet card'); ok(true, 'card saved, masked in list, wallet graphic shown'); await sleep(500); await shot('08-card');
  ok((await ev(`document.querySelector('.wallet .num').textContent`)).endsWith('1234'), 'wallet card shows the last four digits without the page holding the number');
  const F = (label, kind, value) => ({ label, kind, value });
  await inv('save_item', { item: { id: '', kind: 'wifi', title: 'Home Wi-Fi', folder: 'Home', fields: [F('Network name', 'text', 'HomeNet'), F('Password', 'secret', 'sup3r secret;pass'), F('Security', 'text', 'WPA2')], notes: '', favorite: true, updated: 0, history: [], deleted: 0 } });
  await inv('save_item', { item: { id: '', kind: 'login', title: 'TestSite', folder: '', fields: [F('Username', 'text', 'bob@test.org'), F('Password', 'secret', 'Zt5@nW8*yB3%kD6^')], notes: '', favorite: false, updated: 0, history: [], deleted: 0 } });
  await nav('All items'); await click('Lock', 'aside button'); await wait(`!!document.querySelector('form.lock')`, 'locked');
  await setv('#pw1', 'wrong password!!'); await click('Unlock');
  await wait(`document.querySelector('#msg').textContent.includes('wrong password')`, 'wrong password message'); ok(true, 'wrong password refused'); await shot('09-wrong');
  await setv('#pw1', MP); await click('Unlock'); await wait(`!!document.querySelector('.layout')`, 'unlocked again');
  await wait(`document.body.innerText.includes('Home Wi-Fi')`, 'items after unlock');
  ok((await text()).includes('Bank') && (await text()).includes('GitHub') && (await text()).includes('Visa'), 'items survived lock/unlock and filter was reset');
  await clickRow('Home Wi-Fi'); await wait(`!!document.querySelector('.qr svg')`, 'wifi QR'); ok(true, 'Wi-Fi item shows a QR code'); await sleep(500); await shot('10-wifi');

  // 2FA import: image file (Google Authenticator export QR), pasted text, merge into existing login
  const migImg = fs.readFileSync(BUILD + 'migration.png').toString('base64');
  const p1 = await inv('scan_image', { data: migImg });
  ok(p1.accounts.length === 2 && p1.accounts[0].title === 'Example' && p1.accounts[1].title === 'TestSite', 'Google Authenticator export QR image decoded to 2 accounts');
  await nav('Authenticator'); await wait(`!!document.querySelector('.acard')`, 'authenticator cards');
  await wait(`/\\d{3} \\d{3}/.test(document.querySelector('.authgrid').innerText)`, 'live codes in authenticator view'); ok(true, 'Authenticator view shows live codes');
  await click('Add or import'); await wait(`!!document.querySelector('dialog.twofa')`, '2FA dialog'); await sleep(400); await shot('11-twofa');
  const link = fs.readFileSync(BUILD + 'migration.txt', 'utf8').trim();
  await setv('dialog.twofa textarea', link); await click('Read pasted text', 'dialog button');
  await wait(`document.querySelectorAll('.frow').length===2`, 'two found rows'); await sleep(400); await shot('12-twofa-found');
  ok((await ev(`document.querySelector('.frow select')?.value`)) === 'merge', 'existing TestSite login is offered for merging');
  await click('Add 2 accounts', 'dialog button'); await wait(`!document.querySelector('dialog.twofa')`, 'dialog closed after add');
  const all = await inv('list');
  ok(all.filter(x => x.title === 'TestSite').length === 1 && all.filter(x => x.title === 'Example').length === 1, 'merge added no duplicate login, new login created');
  const ts = await inv('get_item_full', { id: all.find(x => x.title === 'TestSite').id });
  ok(ts.fields.some(f => f.kind === 'totp' && f.value.startsWith('otpauth://')), 'one-time code attached to the existing login');
  await sleep(1500); await shot('13-authenticator');
  ok((await ev(`document.querySelectorAll('.acard').length`)) >= 3, 'Authenticator view lists all codes');

  // camera: a simulated webcam shows a phone with two Google-style QR codes (13 accounts), blurred and noisy
  await click('Add or import'); await wait(`!!document.querySelector('dialog.twofa')`, '2FA dialog (camera)'); await click('Use camera', 'dialog button');
  await wait(`!!document.querySelector('#camstatus')`, 'camera panel'); await sleep(2500); await shot('13b-camera');
  const camOk = await wait(`document.querySelectorAll('.frow').length===13`, 'all 13 accounts from the camera in both QR codes', 40000);
  ok(camOk, 'camera scanner collected 13 accounts from 2 Google Authenticator QR codes');
  if (camOk) { await sleep(400); await shot('13c-camera-found'); await click('Add 13 accounts', 'dialog button'); await wait(`!document.querySelector('dialog.twofa')`, 'camera import done'); ok((await inv('list')).some(x => x.title === 'Acct7') && (await inv('list')).some(x => x.title === 'Extra3'), 'camera-scanned accounts were added'); }
  else { await ev(`document.querySelector('dialog.twofa')?.remove()`); }

  // scan the real screen: show a QR in an Edge window of its own, then scan (VAULT_SKIP_SCREEN=1 skips it while someone uses the PC)
  if (!process.env.VAULT_SKIP_SCREEN) {
  const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $f=New-Object Windows.Forms.Form; $f.Text='qrtest'; $f.StartPosition='Manual'; $f.Location=New-Object Drawing.Point(120,120); $f.Size=New-Object Drawing.Size(720,760); $f.TopMost=$true; $p=New-Object Windows.Forms.PictureBox; $p.Dock='Fill'; $p.SizeMode='Zoom'; $p.BackColor=[Drawing.Color]::White; $p.Image=[Drawing.Image]::FromFile('${BUILD}otp.png'); $f.Controls.Add($p); $f.ShowDialog() | Out-Null`;
  const edge = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' }); // a small form of our own showing the QR
  await sleep(4000);
  log('qr window: ' + (await new Promise(r => { const c = spawn('powershell', ['-NoProfile', '-Command', "(Get-Process | Where-Object { $_.MainWindowTitle -eq 'qrtest' } | Measure-Object).Count"]); let o = ''; c.stdout.on('data', x => o += x); c.on('close', () => r(o.trim())); })) + ' window(s) titled qrtest');
  try {
    const p2 = await inv('scan_screen');
    ok(p2.accounts.length >= 1 && p2.accounts[0].title === 'ScreenSite' && p2.accounts[0].account === 'carol@example.com', 'scan_screen found the QR code shown on screen: ' + p2.accounts.map(a => a.title));
  } catch (e) { ok(false, 'scan_screen: ' + e.message); }
  spawn('taskkill', ['/pid', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); await sleep(1500);
  await ev('document.hasFocus()'); await shot('14-after-scan');
  try { await inv('scan_screen'); ok(false, 'scan_screen with no QR should fail'); } catch (e) { ok(/No QR code found/.test(e.message), 'scan_screen without a QR gives a clear error'); }
  } else log('SKIP screen scan (VAULT_SKIP_SCREEN)');
  const p3 = await inv('scan_image', { data: fs.readFileSync(BUILD + 'otp.png').toString('base64') });
  ok(p3.accounts[0]?.title === 'ScreenSite', 'scan_image reads a site setup QR');

  // ---- new item types, photos, search, smart filters, tags, bulk, versions, markdown, sharing
  const Fd = (label, kind, value) => ({ label, kind, value });
  const mk = (kind, title, fields, extra = {}) => ({ id: '', kind, title, folder: '', fields, notes: '', favorite: false, updated: 0, history: [], deleted: 0, tags: [], expires: '', attachments: [], category: '', versions: [], ...extra });
  const refresh = async () => { await click('Lock', 'aside button'); await wait(`!!document.querySelector('form.lock')`, 'lock (refresh)'); await click('Unlock', 'form.lock button'); await wait(`!!document.querySelector('.layout')`, 'unlock (refresh)'); await sleep(300); };
  const bankId = await inv('save_item', { item: mk('bank', 'Main Bank', [Fd('Bank name', 'text', 'Acme Bank'), Fd('Account holder', 'text', 'Me Myself'), Fd('Account number', 'secret', '12345678901234'), Fd('IBAN', 'secret', 'DE89370400440532013000'), Fd('SWIFT / BIC', 'text', 'COBADEFF')], { tags: ['money'] }) });
  const docId = await inv('save_item', { item: mk('document', 'Passport', [Fd('Document type', 'text', 'Passport'), Fd('Number', 'secret', 'X1234567'), Fd('Name on document', 'text', 'Me Myself')], { expires: '2026-12-01' }) });
  await inv('save_item', { item: mk('identity', 'Home address', [Fd('Full name', 'text', 'Me Myself'), Fd('Email', 'text', 'me@example.com'), Fd('Address line 1', 'text', '1 Main St'), Fd('City', 'text', 'Cairo'), Fd('Postal code', 'text', '11511'), Fd('Country', 'text', 'Egypt')]) });
  const noteId = await inv('save_item', { item: mk('note', 'Packing list', [], { notes: '# Packing\n- [ ] passport\n- [x] charger' }) });
  await inv('save_item', { item: mk('api', 'Stripe key', [Fd('Service', 'text', 'Stripe'), Fd('Environment', 'text', 'production'), Fd('Secret key', 'secret', 'sk_test_51FAKEFAKEFAKEFAKEFAKE'), Fd('Endpoint', 'text', 'https://api.stripe.com')]) });
  const lst = await inv('list');
  const bank = lst.find(x => x.id === bankId);
  ok(bank.sub.includes('•••• 1234') && bank.category === 'Finance', 'bank account: masked summary and automatic category Finance');
  ok(lst.find(x => x.title === 'Stripe key').category === 'Developer' && lst.find(x => x.title === 'GitHub').category === 'Developer', 'automatic categories for API keys and GitHub');
  ok((await inv('search', { query: 'gthb', trash: false })).includes(gh.id), 'fuzzy search finds GitHub from "gthb"');
  ok(JSON.stringify(await inv('search', { query: 'kind:bank', trash: false })) === JSON.stringify([bankId]), 'kind: search operator');
  ok((await inv('search', { query: 'is:weak', trash: false })).length >= 1 && (await inv('search', { query: 'has:notes -kind:login', trash: false })).includes(noteId), 'smart-filter and has:/negation operators');
  // a photo on the document
  const png = await ev(`(()=>{const c=document.createElement('canvas');c.width=640;c.height=420;const x=c.getContext('2d');const g=x.createLinearGradient(0,0,640,420);g.addColorStop(0,'#1e3a8a');g.addColorStop(1,'#7c3aed');x.fillStyle=g;x.fillRect(0,0,640,420);x.fillStyle='#fff';x.font='bold 64px sans-serif';x.fillText('PASSPORT',120,230);return c.toDataURL('image/png').split(',')[1]})()`);
  const att = await inv('att_add', { itemId: docId, name: 'passport-front.png', data: png });
  ok(att.size > 500, 'photo stored (encrypted) on a document');
  await refresh();
  await nav('Documents'); await clickRow('Passport'); await wait(`document.querySelector('.att img')?.naturalWidth>0`, 'document photo thumbnail'); ok(true, 'document shows its photo'); await sleep(500); await shot('22-document');
  await ev(`document.querySelector('.att .thumb').click()`); await wait(`document.querySelector('dialog .lightbox img')?.naturalWidth>0`, 'lightbox image'); await sleep(400); await shot('23-lightbox'); ok(true, 'photo opens in the viewer'); await ev(`document.querySelector('dialog').remove()`);
  await nav('Bank accounts'); await clickRow('Main Bank'); await wait(`!!document.querySelector('.wallet.bank')`, 'bank card graphic'); await sleep(400); await shot('24-bank');
  await nav('Identities'); await clickRow('Home address'); await wait(`document.querySelector('.addr pre')?.innerText.includes('Cairo')`, 'address block'); ok(true, 'identity shows a copyable address'); await sleep(300);
  await nav('Notes'); await clickRow('Packing list'); await wait(`document.querySelectorAll('.md li.task').length===2`, 'checklist'); await ev(`document.querySelector('.md li.task input').click()`);
  await wait(`true`, 'toggle'); await sleep(700);
  ok((await inv('get_item', { id: noteId })).notes.includes('- [x] passport'), 'clicking a checklist item in a note saves it');
  // versions, bulk, duplicate, share, backups
  let g1 = await inv('get_item', { id: docId }); g1.title = 'Passport (renewed)'; await inv('save_item', { item: g1 });
  g1 = await inv('get_item', { id: docId }); g1.notes = 'new number'; await inv('save_item', { item: g1 });
  ok((await inv('get_item', { id: docId })).versions.length === 2, 'every change keeps a version of the item');
  await inv('restore_version', { id: docId, at: (await inv('get_item', { id: docId })).versions[0].at });
  ok((await inv('get_item', { id: docId })).title === 'Passport', 'restoring a version brings the old state back');
  ok(await inv('bulk', { ids: [bankId, docId], op: 'tag', value: 'important' }) === 2 && (await inv('get_item', { id: docId })).tags.includes('important'), 'bulk tag');
  ok(!!(await inv('duplicate_item', { id: bankId })) && (await inv('list')).some(x => x.title === 'Main Bank (copy)'), 'duplicate item');
  const sh = ROOT + '\\bank.vaultshare';
  await inv('share_save', { id: bankId, passphrase: 'shared secret pass', path: sh });
  let bad = ''; try { await inv('share_load', { path: sh, passphrase: 'wrong passphrase!' }); } catch (e) { bad = e.message; }
  ok(bad.includes('wrong passphrase'), 'shared file refuses a wrong passphrase');
  const recv = await inv('share_load', { path: sh, passphrase: 'shared secret pass' });
  ok((await inv('get_item', { id: recv })).folder === 'Received' && !fs.readFileSync(sh).toString('latin1').includes('Acme'), 'shared item imported (into Received); the file is encrypted');
  ok((await inv('list_backups')).length >= 1, 'daily backups exist');
  await refresh();
  await nav('Security center'); await wait(`!!document.querySelector('.score')`, 'security center (expiry)'); await sleep(500);
  ok((await text()).includes('Expiring or expired') && (await ev(`document.querySelector('.secwrap').innerText`)).includes('Passport'), 'security center lists the passport expiring soon'); await shot('25-security-expiry');
  await nav('Weak passwords'); await wait(`document.querySelector('.list').innerText.includes('Bank')`, 'smart filter list'); ok(true, 'smart filter "Weak passwords" lists the weak logins'); await sleep(300); await shot('26-smart-filter');
  await nav('All items');
  await click('Settings', 'aside button'); await wait(`!!document.querySelector('dialog.settings')`, 'settings'); await sleep(400); await shot('27-settings');
  await ev(`document.querySelector('button.sw[title=emerald]').click()`); await sleep(300);
  ok((await ev(`document.documentElement.dataset.accent`)) === 'emerald', 'accent colour theme changes'); await shot('28-emerald'); await ev(`document.querySelector('button.sw[title=indigo]').click()`); await ev(`document.querySelector('dialog').remove()`);
  // recovery key: forgot the master password
  const phrase = await inv('recovery_enable');
  ok(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/.test(phrase), 'recovery key created');
  await click('Lock', 'aside button'); await wait(`!!document.querySelector('form.lock')`, 'lock for recovery');
  await wait(`[...document.querySelectorAll('.linkbtn')].some(b=>b.textContent.includes('Forgot'))`, 'forgot link shown'); await click('Forgot your master password?', '.linkbtn');
  await wait(`!!document.querySelector('dialog #r1')`, 'recovery dialog');
  await setv('dialog input.mono', phrase.toLowerCase()); await setv('#r1', 'brand new passphrase 123'); await setv('#r2', 'brand new passphrase 123'); await sleep(300); await shot('29-recover');
  await click('Recover', 'dialog button'); await wait(`!!document.querySelector('.layout')`, 'vault after recovery'); ok(true, 'forgotten master password: recovery key opens the vault and sets a new password'); CUR = 'brand new passphrase 123';
  await wait(`document.body.innerText.includes('GitHub')`, 'items after recovery');

  // trash, security center, quick find, settings, light theme
  await nav('All items'); await ev(`(()=>{const r=[...document.querySelectorAll('.list .row b')].find(b=>b.textContent==='Bank');r.closest('.row').click()})()`); await wait(`document.querySelector('.detail .head h2')?.textContent==='Bank'`, 'Bank open');
  await click('Edit', '.detail button'); await wait(`!!document.querySelector('form.edit')`, 'edit'); await click('Delete', 'form.edit button');
  await wait(`![...document.querySelectorAll('.list .row b')].some(b=>b.textContent==='Bank')`, 'Bank left the list'); ok(true, 'delete moves the item to the trash');
  await nav('Trash'); await wait(`document.querySelector('.list').innerText.includes('Bank')`, 'Bank in trash'); await ev(`document.querySelector('.list .row').click()`); await sleep(500); await shot('15-trash');
  await click('Restore', '.detail button'); await wait(`!document.querySelector('.detail .head h2') || true`, 'restore'); await sleep(600);
  ok((await inv('list')).find(x => x.title === 'Bank').deleted === false, 'restore brings the item back');
  await nav('Security center'); await wait(`!!document.querySelector('.score')`, 'security center'); await sleep(1300); await shot('16-security');
  const sec = await text(); ok(sec.includes('Weak passwords') && sec.includes('Bank') && sec.includes('Sites without HTTPS') && sec.includes('GitHub'), 'security center flags weak password and http site');
  await nav('All items'); await sleep(300);
  await key('document', { key: 'k', ctrlKey: true }); await wait(`!!document.querySelector('dialog.pal')`, 'palette');
  await setv('dialog.pal input', 'git'); await sleep(300); await shot('17-palette');
  ok((await ev(`document.querySelector('.pres').innerText`)).includes('GitHub'), 'quick find lists matches');
  await key(`document.querySelector('dialog.pal input')`, { key: 'Enter' }); await wait(`document.querySelector('.detail .head h2')?.textContent==='GitHub'`, 'palette opened item'); ok(true, 'quick find opens the item');
  await click('Settings', 'aside button'); await wait(`!!document.querySelector('dialog')`, 'settings'); await sleep(400); await shot('18-settings');
  await ev(`document.querySelector('dialog').remove()`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }); await sleep(500); await shot('19-light');
  await nav('Authenticator'); await sleep(1500); await shot('20-light-auth');
  await send('Emulation.setEmulatedMedia', { features: [] });

  // sync to the user's own server (the real service over Tailscale, a throwaway slot): only when VAULT_SYNC_URL is set
  if (process.env.VAULT_SYNC_URL) {
    const base = process.env.VAULT_SYNC_URL;
    const syncKey = await inv('sync_enable', { url: base });
    ok(/^[0-9a-f]{64}$/.test(syncKey), 'sync turned on, a sync key was made');
    const get = async (p, m = 'GET') => { const r = await fetch(base + p, { method: m, headers: { Authorization: 'Bearer ' + syncKey } }); return { s: r.status, b: Buffer.from(await r.arrayBuffer()) }; };
    const info = JSON.parse((await get('/v1/info')).b.toString());
    ok(info.rev >= 1, 'the first sync uploaded the vault (server revision ' + info.rev + ')');
    const st1 = await inv('sync_status');
    ok(st1.configured && !st1.pending, 'status says up to date');
    const srvBlob = (await get('/v1/vault')).b;
    ok(srvBlob.subarray(0, 4).toString() === 'VLT1' && !srvBlob.toString('latin1').includes('GitHub') && !srvBlob.toString('latin1').includes('octocat'), 'the server holds only the encrypted vault');
    const gh2 = (await inv('list')).find(x => x.title === 'GitHub'); let gi = await inv('get_item', { id: gh2.id }); gi.notes = 'synced note'; await inv('save_item', { item: gi });
    ok(await wait(`true`, 'bg sync') && (await (async () => { for (let i = 0; i < 20; i++) { await sleep(2000); const i2 = JSON.parse((await get('/v1/info')).b.toString()); if (i2.rev > info.rev) return true; } return false; })()), 'a change is uploaded automatically within seconds');
    const after = (await get('/v1/vault')).b;
    ok(Buffer.compare(after, fs.readFileSync(DATA + '\\vault.bin')) === 0, 'the server copy is byte-identical to this PC\'s vault file');
    ok((await get('/v1/vault')).s === 200 && (await get('/v1/info')).s === 200, 'server answers');
    ok(JSON.parse((await get('/v1/info')).b.toString()).rev >= 2, 'revisions advance');
    await inv('sync_disable'); await get('/v1/all', 'DELETE');
    ok(JSON.parse((await get('/v1/info')).b.toString()).rev === 0, 'test slot removed from the server');
  } else log('SKIP sync (set VAULT_SYNC_URL to test against your server)');

  // ---- review features: hidden secrets in the UI, passphrases, imports, version reveal, auto-type picker, purge records
  await nav('All items'); await clickRow('GitHub'); await wait(`document.querySelector('.detail .head h2')?.textContent==='GitHub'`, 'GitHub open');
  const pwRow = `[...document.querySelectorAll('.detail .f')].find(r=>r.querySelector('.l')?.textContent==='Password')`;
  ok((await ev(`${pwRow}.querySelector('.val').textContent`)) === '••••••••••', 'password row is masked');
  ok(!(await ev(`[...document.querySelectorAll('.detail .chipbtn')].some(b=>b.offsetParent!==null)`)), 'no JWT button on fields that hold no JWT');
  await ev(`${pwRow}.querySelector('button[title="Show or hide"]').click()`);
  await wait(`${pwRow}.querySelector('.val').textContent==='NewPass!2345xyz'`, 'password shown via reveal'); ok(true, 'the eye button fetches the password from Rust'); await shot('30-revealed');
  await ev(`[...document.querySelectorAll('.detail .head button')].find(b=>b.title?.includes('favorites')).click()`); await sleep(800);
  const fav = await inv('get_item_full', { id: gh.id });
  ok(fav.favorite && fav.fields.find(f => f.label === 'Password').value === 'NewPass!2345xyz' && fav.fields.find(f => f.kind === 'totp').value.startsWith('GEZD'), 'a favorite toggle from the view keeps the real secrets');
  await wait(`document.querySelector('.detail .head h2')?.textContent==='GitHub'`, 'GitHub open again');
  await ev(`[...document.querySelectorAll('.detail .head button')].find(b=>b.title?.startsWith('Version history')).click()`); await wait(`!!document.querySelector('dialog .vlist')`, 'version history');
  await ev(`document.querySelector('dialog .vdiff button').click()`); await wait(`document.querySelector('dialog .vlist').innerText.includes('NewPass!2345xyz')`, 'version diff revealed');
  ok((await ev(`document.querySelector('dialog .vlist').innerText`)).includes(generated), 'version history shows both passwords after the eye click'); await shot('31-versions'); await ev(`document.querySelector('dialog').remove()`);
  // passphrase generator
  await click('Generator', 'aside button'); await wait(`!!document.querySelector('dialog .seg')`, 'generator');
  await click('Passphrase', 'dialog .seg button'); await wait(`/^[A-Z][a-z]+\\d?(-[A-Z][a-z]+\\d?){4}$/.test(document.querySelector('dialog input.mono').value)`, 'passphrase of 5 words');
  ok(true, 'passphrase mode: ' + (await ev(`document.querySelector('dialog input.mono').value`)).replace(/[a-z]/g, '·')); await shot('32-passphrase'); await ev(`document.querySelector('dialog').remove()`);
  // import dialog and Bitwarden JSON
  await click('Import', 'aside button'); await wait(`document.querySelectorAll('dialog.importd .tile').length===3`, 'import dialog'); ok(await ev(`getComputedStyle(document.querySelector('dialog.importd .setcol')).display==='none'`), 'import dialog offers KeePass, Bitwarden and CSV; the KeePass password box waits for a file'); await shot('33-import'); await ev(`document.querySelector('dialog').remove()`);
  const bwj = JSON.stringify({ encrypted: false, folders: [{ id: 'f', name: 'Imported' }], items: [{ type: 3, name: 'BW Card', folderId: 'f', card: { cardholderName: 'Me', number: '5555444433331111', expMonth: '1', expYear: '2030', code: '999' } }, { type: 4, name: 'BW Me', identity: { firstName: 'Bo', lastName: 'Wu', email: 'bo@x' } }] });
  ok(await inv('import_bitwarden', { text: bwj }) === 2 && (await inv('list')).find(x => x.title === 'BW Card')?.tail === '1111', 'Bitwarden JSON import brings cards and identities');
  // auto-type picker (the hotkey itself is not registered in a test copy): picking without a target window fails safely
  await inv('plugin:event|emit', { event: 'autotype-pick', payload: { title: 'Sign in - GitHub', items: [{ id: gh.id, title: 'GitHub', username: 'octocat' }], locked: false } });
  await wait(`!!document.querySelector('dialog.autotype')`, 'auto-type picker'); await shot('34-autotype');
  ok((await ev(`document.querySelector('dialog.autotype').innerText`)).includes('Sign in - GitHub'), 'auto-type picker lists the matching login');
  await ev(`document.querySelector('dialog.autotype .row').click()`); await wait(`document.querySelector('#toast')?.innerText.includes('Ctrl+Alt+A')`, 'no target window'); ok(true, 'picking with no target window types nothing and says why');
  // emptying the trash leaves a purge record (so sync merges do not resurrect)
  const tmpId = await inv('save_item', { item: mk('note', 'Throwaway', [], { notes: 'x' }) });
  await inv('delete_item', { id: tmpId }); await inv('empty_trash');
  ok(!(await inv('list')).some(x => x.id === tmpId), 'emptied trash item is gone');

  // stay signed in: the vault was created with the option on, so a restart opens straight into it
  ok(fs.existsSync(DATA + '\\quick.bin'), 'quick.bin written when the option is on');
  app.kill(); await sleep(2500); app = launch(); await connect(); await send('Runtime.enable');
  await wait(`!!document.querySelector('.layout')`, 'auto sign-in after restart', 20000); ok(true, 'restart opens straight into the vault, no typing');
  await wait(`document.body.innerText.includes('GitHub')`, 'items visible after auto sign-in');
  await click('Lock', 'aside button'); await wait(`!!document.querySelector('form.lock')`, 'lock screen');
  ok((await text()).includes('Stay signed in') === false && (await ev(`document.querySelector('form.lock button.primary').textContent`)) === 'Unlock', 'lock screen offers a one-click Unlock'); await sleep(500); await shot('21-quick-lock');
  await click('Unlock', 'form.lock button'); await wait(`!!document.querySelector('.layout')`, 'one-click unlock'); ok(true, 'one click unlocks');
  const hello = await inv('change_password', { oldPassword: CUR, newPassword: 'another long passphrase' }); // quick unlock must survive a master password change
  await click('Lock', 'aside button'); await wait(`!!document.querySelector('form.lock')`, 'lock again'); await click('Unlock', 'form.lock button');
  await wait(`!!document.querySelector('.layout')`, 'quick unlock after password change'); ok(true, 'quick unlock still works after changing the master password');
  await click('Settings', 'aside button'); await wait(`!!document.querySelector('#quickbox')`, 'settings'); await ev(`document.querySelector('#quickbox').click()`); await sleep(500);
  ok(!fs.existsSync(DATA + '\\quick.bin'), 'turning the option off removes quick.bin');
  app.kill(); await sleep(2500); app = launch(); await connect(); await send('Runtime.enable');
  await wait(`!!document.querySelector('form.lock')`, 'password screen after restart'); await sleep(500);
  ok((await ev(`document.querySelector('#pw1').placeholder`)) === 'Master password' && !(await ev(`!!document.querySelector('.layout')`)), 'with the option off, a restart asks for the master password');
  const raw = fs.readFileSync(DATA + '\\vault.bin').toString('latin1');
  ok(!['GitHub', 'octocat', '4111', 'JBSWY3DPEHPK3PXP', 'HomeNet'].some(x => raw.includes(x)), 'vault.bin holds no plaintext');
} catch (e) { log('ERROR ' + e.message); fails++; }
log(fails ? `FAILED ${fails}` : 'ALL PASSED');
app.kill(); fs.writeFileSync(ROOT + '\\done.txt', String(fails)); process.exit(0);
