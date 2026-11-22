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

const launch = () => spawn(EXE, [], { env: { ...process.env, VAULT_DIR: DATA, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333' }, stdio: 'ignore' });
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
  let it = await inv('get_item', { id: gh.id });
  it.fields.find(f => f.label === 'Password').value = 'NewPass!2345xyz'; await inv('save_item', { item: it });
  it = await inv('get_item', { id: gh.id });
  ok(it.history.length === 1 && it.history[0].value === generated, 'changing a password keeps the old one in history');

  // csv import + dedupe, card, wifi + QR
  const n = await inv('import_csv', { text: 'name,url,username,password,note\nBank,https://bank.example,me,pw-1,\nBank,https://bank.example,me,pw-1,\n' });
  ok(n === 1, 'CSV import added 1 and skipped the duplicate row (got ' + n + ')');
  await nav('Cards'); await click('New'); await click('Credit', 'dialog button');
  await setv('form.edit > input:nth-of-type(1)', 'Visa');
  await ev(`(()=>{const e=document.querySelectorAll('.erow')[1].querySelectorAll('input')[1];e.value='4111 1111 1111 1234';e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await click('Save', 'form.edit button'); await wait(`document.querySelector('.list').innerText.includes('•••• 1234')`, 'card masked in list');
  await wait(`!!document.querySelector('.wallet')`, 'wallet card'); ok(true, 'card saved, masked in list, wallet graphic shown'); await sleep(500); await shot('08-card');
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
  const ts = await inv('get_item', { id: all.find(x => x.title === 'TestSite').id });
  ok(ts.fields.some(f => f.kind === 'totp' && f.value.startsWith('otpauth://')), 'one-time code attached to the existing login');
  await sleep(1500); await shot('13-authenticator');
  ok((await ev(`document.querySelectorAll('.acard').length`)) >= 3, 'Authenticator view lists all codes');

  // scan the real screen: show a QR in an Edge window of its own, then scan
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
  const p3 = await inv('scan_image', { data: fs.readFileSync(BUILD + 'otp.png').toString('base64') });
  ok(p3.accounts[0]?.title === 'ScreenSite', 'scan_image reads a site setup QR');

  // trash, security center, quick find, settings, light theme
  await nav('All items'); await clickRow('Bank'); await wait(`document.querySelector('.detail .head h2')?.textContent==='Bank'`, 'Bank open');
  await click('Edit', '.detail button'); await wait(`!!document.querySelector('form.edit')`, 'edit'); await click('Delete', 'form.edit button');
  await wait(`!document.querySelector('.list').innerText.includes('Bank')`, 'Bank left the list'); ok(true, 'delete moves the item to the trash');
  await nav('Trash'); await wait(`document.querySelector('.list').innerText.includes('Bank')`, 'Bank in trash'); await clickRow('Bank'); await sleep(500); await shot('15-trash');
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

  // stay signed in: the vault was created with the option on, so a restart opens straight into it
  ok(fs.existsSync(DATA + '\\quick.bin'), 'quick.bin written when the option is on');
  app.kill(); await sleep(2500); app = launch(); await connect(); await send('Runtime.enable');
  await wait(`!!document.querySelector('.layout')`, 'auto sign-in after restart', 20000); ok(true, 'restart opens straight into the vault, no typing');
  await wait(`document.body.innerText.includes('GitHub')`, 'items visible after auto sign-in');
  await click('Lock', 'aside button'); await wait(`!!document.querySelector('form.lock')`, 'lock screen');
  ok((await text()).includes('Stay signed in') === false && (await ev(`document.querySelector('form.lock button.primary').textContent`)) === 'Unlock', 'lock screen offers a one-click Unlock'); await sleep(500); await shot('21-quick-lock');
  await click('Unlock', 'form.lock button'); await wait(`!!document.querySelector('.layout')`, 'one-click unlock'); ok(true, 'one click unlocks');
  const hello = await inv('change_password', { oldPassword: MP, newPassword: 'another long passphrase' }); // quick unlock must survive a master password change
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
