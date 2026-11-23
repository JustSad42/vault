import { open as openFile, save } from '@tauri-apps/plugin-dialog';
import { getVersion } from '@tauri-apps/api/app';
import {
  ACCENTS, Acct, Att, F, Item, ItemVersion, KINDS, NEW_KINDS, Parsed, Settings, Sum, Template, ago, applyTheme, avatar, b64, bytes, call, copyText, dialog, err, h, hooks, icon, iconBtn, invoke,
  isImage, meter, mimeOf, prepareFile, put, pwField, S, toast, chip, Kind, TEMPLATES, SecretRef, fieldRef, isHidden, reveal,
} from './kit';

// ---------- small helpers ----------
export function ask(title: string, label: string, initial = '', okText = 'OK', hint = ''): Promise<string | null> {
  return new Promise(res => {
    let done = false;
    const inp = h('input', { value: initial, placeholder: label, autocomplete: 'off' });
    const d = dialog(close => [h('h3', {}, title), hint ? h('p', { class: 'hint' }, hint) : null, inp,
      h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => { done = true; close(); res(inp.value.trim()); } }, okText), h('button', { onclick: close }, 'Cancel'))]);
    d.addEventListener('close', () => { if (!done) res(null); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done = true; d.close(); res(inp.value.trim()); } });
    inp.focus(); inp.select();
  });
}

export function confirmDialog(title: string, text: string, okText: string, danger = false): Promise<boolean> {
  return new Promise(res => {
    let done = false;
    const d = dialog(close => [h('h3', {}, title), h('p', { class: 'hint' }, text),
      h('div', { class: 'btns' }, h('button', { class: danger ? 'danger' : 'primary', onclick: () => { done = true; close(); res(true); } }, okText), h('button', { onclick: close }, 'Cancel'))]);
    d.addEventListener('close', () => { if (!done) res(false); });
  });
}

export async function saveSettings() {
  try { await call('set_settings', { settings: S.settings }); applyTheme(); hooks.resetIdle(); } catch (e) { err(e); }
}

// ---------- generator ----------
let genOpts = { mode: 'password' as 'password' | 'words', len: 20, lower: true, upper: true, digits: true, symbols: true, words: 5, sep: '-', capitalize: true, number: true };
export function genDialog(use?: (pw: string) => void) {
  const m = meter();
  const out = h('input', { readOnly: true, class: 'mono' });
  const o = genOpts;
  const run = async () => {
    try {
      out.value = o.mode === 'words'
        ? await call<string>('generate_passphrase', { words: o.words, sep: o.sep, capitalize: o.capitalize, number: o.number })
        : await call<string>('generate', { len: o.len, lower: o.lower, upper: o.upper, digits: o.digits, symbols: o.symbols });
      m.update(out.value);
    } catch (e) { out.value = ''; err(e); }
  };
  const lab = h('label', {}, `Length ${o.len}`);
  const len = h('input', { type: 'range', min: 8, max: 64, value: o.len, oninput: () => { o.len = +len.value; lab.textContent = `Length ${o.len}`; run(); } });
  const box = (k: 'lower' | 'upper' | 'digits' | 'symbols' | 'capitalize' | 'number', text: string) => {
    const c = h('input', { type: 'checkbox', checked: o[k], onchange: () => { o[k] = c.checked; run(); } });
    return h('label', { class: 'chk' }, c, ' ' + text);
  };
  const wlab = h('label', {}, `${o.words} words`);
  const words = h('input', { type: 'range', min: 3, max: 10, value: o.words, oninput: () => { o.words = +words.value; wlab.textContent = `${o.words} words`; run(); } });
  const sep = h('select', { 'aria-label': 'Separator', onchange: () => { o.sep = sep.value; run(); } },
    ...([['-', 'Hyphen  -'], [' ', 'Space'], ['.', 'Dot  .'], ['_', 'Underscore  _'], ['', 'None']] as [string, string][]).map(([v, n]) => h('option', { value: v, selected: v === o.sep }, n)));
  const pwBox = h('div', {}, lab, len, h('div', { class: 'opts' }, box('lower', 'a-z'), box('upper', 'A-Z'), box('digits', '0-9'), box('symbols', 'Symbols')));
  const wBox = h('div', {}, wlab, words, h('div', { class: 'opts' }, sep, box('capitalize', 'Capitals'), box('number', 'A digit')),
    h('small', { class: 'hint' }, 'Random words from the EFF list: easy to type and remember, about 13 bits of strength per word.'));
  const showMode = () => { pwBox.hidden = o.mode !== 'password'; wBox.hidden = o.mode !== 'words'; seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === o.mode)); };
  const seg = h('div', { class: 'seg' }, ...([['password', 'Password'], ['words', 'Passphrase']] as const).map(([k, n]) => h('button', { type: 'button', 'data-m': k, onclick: () => { o.mode = k; showMode(); run(); } }, n)));
  showMode();
  dialog(close => [h('h3', {}, 'Password generator'), seg, out, m.el, pwBox, wBox,
    h('div', { class: 'btns' }, h('button', { onclick: run }, icon('restore'), h('span', {}, 'Regenerate')), h('button', { onclick: () => out.value && copyText(out.value) }, icon('copy'), h('span', {}, 'Copy')),
      use ? h('button', { class: 'primary', onclick: () => { if (out.value) { use(out.value); close(); } } }, 'Use') : null, h('button', { onclick: close }, 'Close'))]);
  run();
}

// ---------- master password ----------
export function masterDialog() {
  const a = pwField('m0', 'Current master password'), b = pwField('m1', 'New master password (10+ characters)'), c = pwField('m2', 'Repeat new password');
  const m = meter();
  b.input.addEventListener('input', () => m.update(b.input.value));
  const msg = h('p', { class: 'hint' }, 'Older backups in the Vault folder still open with the old password. Your recovery key keeps working.');
  dialog(close => [h('h3', {}, 'Change master password'), a.wrap, b.wrap, m.el, c.wrap, msg,
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: async () => {
      if (b.input.value !== c.input.value) { msg.textContent = 'The new passwords differ.'; return; }
      try { await call('change_password', { oldPassword: a.input.value, newPassword: b.input.value }); close(); toast('Master password changed'); } catch (e) { msg.textContent = String(e); }
    } }, 'Change'), h('button', { onclick: close }, 'Cancel'))]);
}

// ---------- recovery key ----------
function printKit(phrase: string) {
  const kit = h('div', { id: 'printkit' },
    h('h1', {}, 'Vault recovery kit'), h('p', {}, 'Keep this page somewhere safe, away from your computer: a locked drawer, a safe. Anyone who finds it can open your vault if they also get your vault file.'),
    h('h2', {}, 'Recovery key'), h('p', { class: 'bigkey' }, phrase),
    h('h2', {}, 'If you forget your master password'), h('ol', {}, h('li', {}, 'Open Vault and choose "Forgot your master password?" on the lock screen.'), h('li', {}, 'Type the recovery key above and choose a new master password.')),
    h('h2', {}, 'Where your data is'), h('p', {}, 'The vault file is %APPDATA%\\Vault\\vault.bin, with daily copies in the backups folder next to it. The recovery key is only useful together with that folder (or a copy of it).'),
    h('p', { class: 'small' }, `Printed ${new Date().toLocaleString()}`));
  document.body.append(kit);
  window.print();
  setTimeout(() => kit.remove(), 1500);
}

export async function recoveryDialog() {
  let phrase = await call<string>('recovery_phrase');
  const body = h('div', { class: 'recov' });
  const draw = () => {
    if (!phrase) {
      put(body, h('p', { class: 'hint' }, 'A recovery key lets you open your vault if you ever forget the master password. Vault creates one random key, shows it once and lets you print it.'),
        h('button', { class: 'primary', onclick: async () => { try { phrase = await call<string>('recovery_enable'); draw(); } catch (e) { err(e); } } }, icon('sparkle'), h('span', {}, 'Create a recovery key')));
    } else {
      put(body, h('div', { class: 'bigkey' }, phrase), h('div', { class: 'btns' },
        h('button', { onclick: () => copyText(phrase) }, icon('copy'), h('span', {}, 'Copy')), h('button', { class: 'primary', onclick: () => printKit(phrase) }, icon('doc'), h('span', {}, 'Print the recovery kit'))),
        h('p', { class: 'hint' }, 'Store it away from this PC. It is kept encrypted inside your vault so you can show it again here, and it keeps working when you change the master password.'));
    }
  };
  draw();
  dialog(close => [h('h3', {}, 'Recovery key'), body, h('button', { onclick: close }, 'Close')]);
}

/** Lock screen: forgot the master password, use the recovery key. */
export function forgotDialog(onDone: () => void) {
  const key = h('input', { placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX', autocomplete: 'off', spellcheck: false, class: 'mono' });
  const p1 = pwField('r1', 'New master password (10+ characters)'), p2 = pwField('r2', 'Repeat new password');
  const m = meter();
  p1.input.addEventListener('input', () => m.update(p1.input.value));
  const msg = h('p', { class: 'hint' }, '');
  dialog(close => [h('h3', {}, 'Forgot your master password?'), h('p', { class: 'hint' }, 'Enter the recovery key you saved, then choose a new master password. Your data stays as it is.'), key, p1.wrap, m.el, p2.wrap, msg,
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: async () => {
      if (p1.input.value !== p2.input.value) { msg.textContent = 'The two passwords differ.'; return; }
      try { await call('recover_vault', { phrase: key.value, newPassword: p1.input.value }); close(); toast('Vault opened with the new master password'); onDone(); } catch (e) { msg.textContent = String(e); }
    } }, 'Recover'), h('button', { onclick: close }, 'Cancel'))]);
}

// ---------- backups ----------
export async function backupsDialog() {
  const list = await call<{ name: string; path: string; size: number; modified: number }[]>('list_backups');
  const restore = async (path: string, label: string) => {
    if (!await confirmDialog('Restore this backup?', `${label} will replace your current vault (a safety copy of the current one is kept in the backups folder). Vault locks afterwards, and the backup opens with the master password it had when it was made.`, 'Restore', true)) return;
    try { await call('restore_backup', { path }); document.querySelectorAll('dialog').forEach(d => d.remove()); toast('Backup restored. Unlock with its master password.'); await hooks.lockNow(); } catch (e) { err(e); }
  };
  dialog(close => [h('h3', {}, 'Backups and restore'), h('p', { class: 'hint' }, 'Vault keeps one encrypted copy per day for two weeks.'),
    h('div', { class: 'group blist' }, ...(list.length ? list.map(b => h('div', { class: 'f static' }, h('div', { class: 'l' }, b.name), h('div', { class: 'val' }, `${new Date(b.modified * 1000).toLocaleString()} · ${bytes(b.size)}`),
      h('div', { class: 'acts' }, h('button', { onclick: () => restore(b.path, b.name) }, icon('restore'), h('span', {}, 'Restore'))))) : [h('p', { class: 'hint pad' }, 'No backups yet.')])),
    h('div', { class: 'btns' }, h('button', { onclick: async () => {
      const path = await openFile({ multiple: false, filters: [{ name: 'Vault backup', extensions: ['bin'] }] });
      if (typeof path === 'string') restore(path, 'The chosen file');
    } }, icon('upload'), h('span', {}, 'Restore from a file…')), h('button', { onclick: () => call('open_backups').catch(err) }, icon('folder'), h('span', {}, 'Open folder')), h('button', { onclick: close }, 'Close'))]);
}

// ---------- sharing one item ----------
export function shareDialog(it: Item) {
  const pass = h('input', { placeholder: 'Passphrase (8+ characters)', autocomplete: 'off', spellcheck: false });
  dialog(close => [h('h3', {}, `Share “${it.title}”`), h('p', { class: 'hint' }, 'Saves one encrypted file. Tell the other person the passphrase separately (not in the same message). History, files and favorites are not included.'), pass,
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: async () => {
      const path = await save({ defaultPath: `${it.title.replace(/[^\w .-]/g, '_')}.vaultshare`, filters: [{ name: 'Shared Vault item', extensions: ['vaultshare'] }] });
      if (!path) return;
      try { await call('share_save', { id: it.id, passphrase: pass.value, path }); close(); toast('Shared file saved'); } catch (e) { err(e); }
    } }, icon('share'), h('span', {}, 'Save shared file…')), h('button', { onclick: close }, 'Cancel'))]);
  pass.focus();
}

export async function importShareDialog() {
  const path = await openFile({ multiple: false, filters: [{ name: 'Shared Vault item', extensions: ['vaultshare'] }] });
  if (typeof path !== 'string') return;
  const pass = h('input', { placeholder: 'Passphrase from the sender', autocomplete: 'off', spellcheck: false });
  const msg = h('p', { class: 'hint' }, '');
  dialog(close => [h('h3', {}, 'Import a shared item'), pass, msg, h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: async () => {
    try { const id = await call<string>('share_load', { path, passphrase: pass.value }); close(); await hooks.reload(); hooks.openItem(id); toast('Item imported'); } catch (e) { msg.textContent = String(e); }
  } }, 'Import'), h('button', { onclick: close }, 'Cancel'))]);
  pass.focus();
}

// ---------- version history ----------
export function versionsDialog(it: Item) {
  type St = Pick<ItemVersion, 'title' | 'folder' | 'tags' | 'notes' | 'expires' | 'category' | 'fields'> & { ref: (idx: number) => SecretRef };
  const cur: St = { title: it.title, folder: it.folder, tags: it.tags, notes: it.notes, expires: it.expires, category: it.category, fields: it.fields, ref: i => fieldRef(it.id, i) };
  const states: { at: number; s: St; current: boolean }[] = [...it.versions.map(v => ({ at: v.at, s: { ...v, ref: (i: number) => ({ id: it.id, src: 'version', at: v.at, idx: i }) } as St, current: false })), { at: it.updated, s: cur, current: true }];
  type Change = { what: string; from: string; to: string; secret: boolean; fromRef?: SecretRef; toRef?: SecretRef };
  const diff = (a: St, b: St): Change[] => {
    const out: Change[] = [];
    const plain: [string, string, string][] = [['Title', a.title, b.title], ['Folder', a.folder, b.folder], ['Tags', a.tags.join(', '), b.tags.join(', ')], ['Notes', a.notes, b.notes], ['Expiry', a.expires, b.expires], ['Category', a.category, b.category]];
    for (const [w, x, y] of plain) if (x !== y) out.push({ what: w, from: x, to: y, secret: false });
    for (const l of new Set([...a.fields.map(f => f.label), ...b.fields.map(f => f.label)])) {
      const ia = a.fields.findIndex(f => f.label === l), ib = b.fields.findIndex(f => f.label === l);
      const fa = a.fields[ia], fb = b.fields[ib];
      if ((fa?.value ?? '') !== (fb?.value ?? '')) out.push({ what: l || '(unnamed field)', from: fa?.value ?? '', to: fb?.value ?? '', secret: (fa ?? fb)!.kind !== 'text',
        fromRef: fa && isHidden(fa.value) ? a.ref(ia) : undefined, toRef: fb && isHidden(fb.value) ? b.ref(ib) : undefined });
    }
    return out;
  };
  const rows = states.map((st, i) => ({ st, i, changes: i < states.length - 1 ? diff(st.s, states[i + 1].s) : [] }));
  const shown = rows.slice().reverse();
  const list = h('div', { class: 'group vlist' });
  const vals = (c: Change) => {
    let shown = false, from = c.from, to = c.to;
    const el = h('span', { class: 'vdiff' });
    const toggle = async () => {
      try { if (!shown) { if (c.fromRef) from = await reveal(c.fromRef); if (c.toRef) to = await reveal(c.toRef); } } catch (e) { return err(e); }
      shown = !shown; if (!shown) { from = c.from; to = c.to; } // revealed values are dropped again when hidden
      paint();
    };
    const paint = () => { const m = (v: string) => (c.secret && !shown ? (v ? '••••••' : '(empty)') : v || '(empty)'); put(el, h('s', {}, m(from)), document.createTextNode(' → '), h('b', {}, m(to)), c.secret ? iconBtn('eye', 'Show or hide', toggle) : null); };
    paint();
    return el;
  };
  put(list, ...(shown.length > 1 ? shown.map(({ st, i, changes }) => {
    const restore = st.current ? null : h('button', { onclick: async () => {
      if (!await confirmDialog('Go back to this version?', 'The current state is kept in the history too, so you can undo this.', 'Restore')) return;
      try { await call('restore_version', { id: it.id, at: st.at }); document.querySelectorAll('dialog').forEach(d => d.remove()); await hooks.reload(); toast('Version restored'); } catch (e) { err(e); }
    } }, icon('restore'), h('span', {}, 'Restore'));
    return h('div', { class: 'f static' }, h('div', { class: 'l' }, st.current ? `Now · ${ago(st.at)}` : `${new Date(st.at * 1000).toLocaleString()} · what changed after it`),
      h('div', { class: 'val vlines' }, ...(changes.length ? changes.map(c => h('div', {}, h('em', {}, c.what + ': '), vals(c))) : [h('span', { class: 'hint' }, st.current ? 'This is the current version.' : 'Only formatting changed.')])), h('div', { class: 'acts' }, restore));
  }) : [h('p', { class: 'hint pad' }, 'No earlier versions yet. Every time you change this item, the old state is kept here (the last 25).')]));
  dialog(close => [h('h3', {}, `History of “${it.title}”`), list, h('button', { onclick: close }, 'Close')], 'wide');
}

// ---------- import ----------
export function importDialog() {
  const msg = h('p', { class: 'hint' }, '');
  const finish = async (n: number, warn = '') => { document.querySelector('dialog.importd')?.remove(); toast(`Imported ${n} item${n === 1 ? '' : 's'}.${warn}`); await hooks.reload(); };
  const file = (accept: string, fn: (f: File) => Promise<void>) => {
    const i = h('input', { type: 'file', accept, hidden: true, onchange: async () => { const f = i.files?.[0]; i.value = ''; if (!f) return; msg.textContent = ''; try { await fn(f); } catch (e) { msg.textContent = String(e); } } });
    return i;
  };
  const plainWarn = ' Delete the export file now: it holds your passwords in plain text.';
  const csv = file('.csv,text/csv', async f => finish(await call<number>('import_csv', { text: await f.text() }), plainWarn));
  const bw = file('.json,application/json', async f => finish(await call<number>('import_bitwarden', { text: await f.text() }), plainWarn));
  let kpFile: File | null = null;
  const kpName = h('b', {}, '');
  const kpPass = pwField('kppw', 'KeePass master password');
  const kpGo = h('button', { class: 'primary', onclick: async () => {
    if (!kpFile) return;
    kpGo.classList.add('busy'); kpGo.setAttribute('disabled', ''); msg.textContent = 'Opening the database…';
    try { const n = await call<number>('import_keepass', { data: await b64(kpFile), password: kpPass.input.value }); kpPass.input.value = ''; await finish(n); }
    catch (e) { msg.textContent = String(e); kpGo.classList.remove('busy'); kpGo.removeAttribute('disabled'); }
  } }, 'Import');
  const kpBox = h('div', { class: 'setcol', style: 'display:none' }, h('p', { class: 'hint' }, 'Database: ', kpName), kpPass.wrap, h('div', { class: 'btns' }, kpGo));
  const kp = file('.kdbx', async f => { kpFile = f; kpName.textContent = f.name; kpBox.style.display = ''; kpPass.input.focus(); });
  kpPass.input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); kpGo.click(); } });
  const tile = (ic: string, title: string, sub: string, input: HTMLInputElement) => h('button', { class: 'tile', onclick: () => input.click() }, icon(ic), h('span', {}, h('b', {}, title), h('small', {}, sub)));
  dialog(close => [h('h3', {}, 'Import'),
    h('div', { class: 'tiles' },
      tile('key', 'KeePass database', '.kdbx: groups, custom fields, codes, attachments', kp),
      tile('shield', 'Bitwarden', 'Export vault as .json (not encrypted): cards, identities, notes, SSH keys', bw),
      tile('upload', 'CSV file', 'Chrome, Edge, Brave, 1Password, Bitwarden or KeePass CSV export', csv)),
    kpBox, msg, h('p', { class: 'hint' }, 'Items already in Vault (same title, username, password and code) are skipped.'), csv, bw, kp,
    h('div', { class: 'btns' }, h('button', { onclick: close }, 'Close'))], 'wide importd');
}

// ---------- auto-type ----------
/** Ctrl+Alt+A found several (or no) logins for the window in front: pick one and Vault types it there. */
export function autotypeDialog(p: { title: string; items: { id: string; title: string; username: string }[]; locked: boolean }, active: () => boolean) {
  if (p.locked || !active()) { toast('Unlock Vault, then press Ctrl+Alt+A again in the window to type into.', true); return; }
  document.querySelector('dialog.autotype')?.remove();
  const go = (id: string) => { document.querySelector('dialog.autotype')?.remove(); call('autotype_item', { id }).catch(err); };
  const row = (id: string, title: string, sub: string) => h('button', { class: 'row flat', onclick: () => go(id) }, avatar('login', title), h('div', { class: 't' }, h('b', {}, title), h('small', {}, sub)));
  const q = h('input', { type: 'search', placeholder: 'Or search all logins…', autocomplete: 'off' });
  const all = h('div', { class: 'group' });
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const list = S.sums.filter(s => !s.deleted && s.kind === 'login' && (!t || `${s.title} ${s.sub} ${s.domain}`.toLowerCase().includes(t))).slice(0, 8);
    put(all, ...list.map(s => row(s.id, s.title, s.sub || s.domain)));
  };
  q.addEventListener('input', draw);
  draw();
  dialog(close => [h('h3', {}, 'Type a login'), h('p', { class: 'hint' }, `Into “${p.title}”. Vault types the username, Tab and the password there.`),
    p.items.length ? h('div', { class: 'group' }, ...p.items.map(i => row(i.id, i.title, i.username))) : h('p', { class: 'hint' }, 'No login matched this window. Tip: add a field named “Auto-type window” to a login with part of the window title, and next time it is typed straight away.'),
    q, all, h('div', { class: 'btns' }, h('button', { onclick: close }, 'Cancel'))], 'autotype');
  q.focus();
}

// ---------- camera (shared by the 2FA scanner and photo capture) ----------
export async function cameraView(box: HTMLElement, hint: string, onStopped?: () => void) {
  const video = h('video', { autoplay: true, muted: true, playsInline: true });
  const status = h('p', { class: 'hint', id: 'camstatus' }, 'Starting the camera…');
  const sel = h('select', { hidden: true, 'aria-label': 'Camera', onchange: () => start(sel.value) });
  const extra = h('div', { class: 'btns' }, sel);
  put(box, video, status, extra, h('p', { class: 'hint' }, hint));
  let stream: MediaStream | null = null;
  const stop = () => { stream?.getTracks().forEach(t => t.stop()); stream = null; };
  const start = async (deviceId?: string): Promise<boolean> => {
    stop();
    try { stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : { width: { ideal: 1920 }, height: { ideal: 1080 } } }); }
    catch (e: any) {
      status.textContent = e?.name === 'NotAllowedError' ? 'The camera is blocked. In Windows open Settings > Privacy & security > Camera and allow desktop apps, then try again.' : e?.name === 'NotFoundError' ? 'No camera was found.' : String(e);
      return false;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    if (cams.length > 1) { sel.hidden = false; const cur = stream.getVideoTracks()[0].getSettings().deviceId; put(sel, ...cams.map((c, i) => h('option', { value: c.deviceId, selected: c.deviceId === cur }, c.label || `Camera ${i + 1}`))); }
    status.textContent = '';
    return true;
  };
  const ok = await start();
  return { video, status, extra, ok, stop: () => { stop(); onStopped?.(); } };
}

// ---------- photos ----------
export async function attachFiles(files: (File | { name: string; data: string })[], itemId: string | null) {
  for (const f of files) {
    try {
      const p = f instanceof File ? await prepareFile(f) : f;
      if (itemId) await call('att_add', { itemId, name: p.name, data: p.data }); else S.pending.push(p);
    } catch (e) { err(e); }
  }
}

export function photoDialog(onShot: (name: string, data: string) => Promise<void>) {
  const box = h('div', { class: 'cam' });
  let cam: Awaited<ReturnType<typeof cameraView>> | null = null, count = 0;
  const shots = h('span', { class: 'hint' }, '');
  const d = dialog(close => [h('h3', {}, 'Take a photo'), box, h('div', { class: 'btns' },
    h('button', { class: 'primary', id: 'snap', onclick: async () => {
      const v = cam?.video; if (!v || !v.videoWidth) return;
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d')!.drawImage(v, 0, 0);
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      await onShot(`photo-${stamp}.jpg`, c.toDataURL('image/jpeg', 0.92).split(',')[1]);
      shots.textContent = `${++count} photo${count === 1 ? '' : 's'} added`;
    } }, icon('camera'), h('span', {}, 'Take photo')), shots, h('button', { onclick: close }, 'Done'))], 'twofa');
  d.addEventListener('close', () => cam?.stop());
  cameraView(box, 'Lay the document flat in good light, fill the picture and avoid glare. You can take several photos (front and back).').then(c => { cam = c; });
}

// ---------- photo gallery (view + lightbox) ----------
export function lightbox(it: Item, att: Att, editable: boolean, onChange: () => void) {
  const img = h('img', { alt: att.name });
  call<string>('att_data', { attId: att.id }).then(d => { img.src = `data:${mimeOf(att.name)};base64,${d}`; }).catch(err);
  dialog(close => [h('h3', {}, att.name), h('div', { class: 'lightbox' }, img), h('div', { class: 'btns' },
    h('button', { onclick: async () => { const path = await save({ defaultPath: att.name }); if (path) { try { await call('att_save', { attId: att.id, path }); toast('Saved'); } catch (e) { err(e); } } } }, icon('download'), h('span', {}, 'Save a copy…')),
    editable ? h('button', { class: 'danger', onclick: async () => { try { await call('att_remove', { itemId: it.id, attId: att.id }); close(); onChange(); } catch (e) { err(e); } } }, icon('trash'), h('span', {}, 'Remove')) : null,
    h('button', { onclick: close }, 'Close'))], 'wide light');
}

export function attachmentTile(it: Item, att: Att, editable: boolean, onChange: () => void) {
  const tile = h('div', { class: 'att' });
  if (isImage(att.name)) {
    const img = h('img', { alt: att.name, loading: 'lazy' });
    call<string>('att_data', { attId: att.id }).then(d => { img.src = `data:${mimeOf(att.name)};base64,${d}`; }).catch(() => {});
    tile.append(h('button', { class: 'thumb', title: att.name, onclick: () => lightbox(it, att, editable, onChange) }, img));
  } else {
    tile.append(h('button', { class: 'thumb file', title: 'Open', onclick: () => call('att_open', { attId: att.id, name: att.name }).then(() => toast('Opened a temporary copy. It is deleted when Vault locks.')).catch(err) }, icon('doc'), h('b', {}, att.name.split('.').pop()!.toUpperCase().slice(0, 4))));
  }
  tile.append(h('div', { class: 'cap' }, h('span', {}, att.name), h('small', {}, bytes(att.size))));
  if (editable) tile.append(iconBtn('x', 'Remove', async () => { try { await call('att_remove', { itemId: it.id, attId: att.id }); onChange(); } catch (e) { err(e); } }, 'rm'));
  else tile.append(iconBtn('download', 'Save a copy', async () => { const path = await save({ defaultPath: att.name }); if (path) { try { await call('att_save', { attId: att.id, path }); toast('Saved'); } catch (e) { err(e); } } }, 'rm'));
  return tile;
}

// ---------- new item ----------
export function newDialog(onPick: (k: Kind, tpl?: Template) => void) {
  dialog(close => [h('h3', {}, 'New item'), h('div', { class: 'tiles' },
    ...NEW_KINDS.map(k => { const t = h('button', { class: 'tile', onclick: () => { close(); onPick(k); } }, icon(KINDS[k].icon), h('span', {}, h('b', {}, KINDS[k].label), h('small', {}, KINDS[k].desc))); t.style.setProperty('--kc', KINDS[k].color); return t; })),
    S.settings.templates.length ? h('h4', {}, 'Your templates') : null,
    S.settings.templates.length ? h('div', { class: 'tiles' }, ...S.settings.templates.map(t => h('button', { class: 'tile', onclick: () => { close(); onPick(t.kind as Kind, t); } }, icon('sparkle'), h('span', {}, h('b', {}, t.name), h('small', {}, `${KINDS[t.kind as Kind]?.label ?? 'Item'} · ${t.fields.length} fields`))))) : null,
    h('div', { class: 'btns' }, h('button', { onclick: () => { close(); importShareDialog(); } }, icon('share'), h('span', {}, 'Import a shared item…')), h('button', { onclick: close }, 'Cancel'))], 'wide');
}

// ---------- search help ----------
export function searchHelp() {
  const rows: [string, string][] = [['github', 'words match titles, sites, usernames, folders, tags, notes'], ['gthb', 'typos and abbreviations still find GitHub'], ['"credit card"', 'exact phrase'], ['-work', 'leave out matches'],
    ['kind:card', 'login card bank identity document note api ssh wifi'], ['tag:work  folder:home  cat:finance', 'by tag, folder, category'], ['domain:google.com  user:me@x.com', 'by site or username'],
    ['is:weak  is:reused  is:old  is:http', 'password problems'], ['is:fav  is:expiring  is:dup  is:nopass', 'favorites, due soon, duplicates, no password'], ['has:totp  has:files  has:notes', 'has a one-time code, files, notes']];
  dialog(close => [h('h3', {}, 'Search tips'), h('div', { class: 'keys' }, ...rows.map(([k, d]) => h('div', {}, h('kbd', {}, k), h('span', {}, d)))), h('button', { onclick: close }, 'Close')], 'wide');
}

// ---------- 2FA import (screen, camera, image, text) ----------
export function twofaDialog() {
  const out = h('div', { class: 'found' });
  const camBox = h('div', { class: 'cam' });
  let cam: Awaited<ReturnType<typeof cameraView>> | null = null;
  let timer = 0;
  const stopCam = () => { clearInterval(timer); cam?.stop(); cam = null; put(camBox); };
  const run = async (fn: () => Promise<Parsed>, btn?: HTMLElement) => {
    btn?.classList.add('busy'); btn?.setAttribute('disabled', '');
    try { found(await fn()); } catch (e) { err(e); }
    btn?.classList.remove('busy'); btn?.removeAttribute('disabled');
  };
  const fromFile = (f: File) => run(async () => call<Parsed>('scan_image', { data: await b64(f) }));
  const found = (p: Parsed) => {
    stopCam();
    const logins = S.sums.filter(s => !s.deleted && s.kind === 'login');
    const rows = p.accounts.map(a => {
      const match = logins.find(s => s.title.toLowerCase() === a.title.toLowerCase());
      const on = h('input', { type: 'checkbox', checked: true, onchange: () => refresh() });
      const mode = match ? h('select', {}, h('option', { value: 'merge' }, `Add to existing “${match.title}”`), h('option', { value: 'new' }, 'Create new login')) : null;
      return { a, match, on, mode, el: h('label', { class: 'frow' }, on, avatar('login', a.title), h('div', { class: 't' }, h('b', {}, a.title), h('small', {}, a.account || a.uri.slice(0, 40))), mode) };
    });
    const add = h('button', { class: 'primary' }, '');
    const refresh = () => { const n = rows.filter(r => r.on.checked).length; add.textContent = `Add ${n} account${n === 1 ? '' : 's'}`; add.toggleAttribute('disabled', n === 0); };
    add.addEventListener('click', async () => {
      add.setAttribute('disabled', '');
      try {
        const fresh: Item[] = []; let merged = 0, same = 0;
        for (const r of rows.filter(r => r.on.checked)) {
          if (r.match && r.mode?.value === 'merge') {
            const it = await call<Item>('get_item', { id: r.match.id });
            const t = it.fields.find(f => f.kind === 'totp');
            if (t?.value === r.a.uri) { same++; continue; }
            if (t) t.value = r.a.uri; else it.fields.push(F('One-time code', 'totp', r.a.uri));
            await call('save_item', { item: it }); merged++;
          } else fresh.push({ id: '', kind: 'login', title: r.a.title, folder: '', fields: [F('Username', 'text', r.a.account), F('One-time code', 'totp', r.a.uri)], notes: '', favorite: false, updated: 0, history: [], deleted: 0, tags: [], expires: '', attachments: [], category: '', versions: [] });
        }
        const added = fresh.length ? await call<number>('import_items', { items: fresh }) : 0;
        await hooks.reload();
        toast([added && `${added} added`, merged && `${merged} updated`, (same + fresh.length - added) && `${same + fresh.length - added} already there`].filter(Boolean).join(', ') || 'Nothing to add');
        document.querySelector('dialog.twofa')?.remove();
      } catch (e) { err(e); add.removeAttribute('disabled'); }
    });
    put(out, h('div', { class: 'group' }, ...rows.map(r => r.el)), p.skipped ? h('p', { class: 'hint' }, `${p.skipped} entr${p.skipped === 1 ? 'y was' : 'ies were'} skipped (counter-based codes are not supported, or the data was unreadable).`) : null,
      h('p', { class: 'hint' }, 'Delete any screenshot of an export QR code afterwards: it contains every secret.'), add);
    refresh();
  };
  const startCamera = async () => {
    stopCam();
    cam = await cameraView(camBox, 'Hold the phone 15 to 30 cm from the camera with the screen at full brightness, so the QR code fills about half of the picture. Keep it still and avoid glare. If Google Authenticator shows several QR codes, show them one after another: Vault collects them all.');
    if (!cam.ok) return;
    const { video, status, extra } = cam;
    const useBtn = h('button', { class: 'primary', hidden: true }, 'Use what was found');
    extra.append(useBtn, h('button', { onclick: stopCam }, 'Stop camera'));
    status.textContent = 'Looking for a QR code…';
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const have = new Map<string, Acct>(), sets = new Map<number, { size: number; seen: Set<number> }>();
    let busy = false;
    const finish = () => found({ accounts: [...have.values()], skipped: 0, batches: [], foreign: false });
    useBtn.addEventListener('click', finish);
    timer = window.setInterval(async () => {
      if (busy || !cam || video.readyState < 2 || !video.videoWidth) return;
      busy = true;
      try {
        const w = video.videoWidth, hh = video.videoHeight;
        canvas.width = w; canvas.height = hh; ctx.drawImage(video, 0, 0, w, hh);
        const px = ctx.getImageData(0, 0, w, hh).data, luma = new Uint8Array(w * hh);
        for (let i = 0, j = 0; i < luma.length; i++, j += 4) luma[i] = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
        const r = await invoke<Parsed>('scan_luma', luma, { headers: { 'x-w': String(w), 'x-h': String(hh) } });
        if (!cam) return;
        if (r.foreign) status.textContent = 'That QR code is not a 2FA setup code.';
        for (const a of r.accounts) have.set(a.uri, a);
        for (const b of r.batches) { const e = sets.get(b.id) ?? { size: b.size, seen: new Set<number>() }; e.seen.add(b.index); sets.set(b.id, e); }
        if (r.accounts.length) {
          const all = [...sets.values()], want = all.reduce((n, e) => n + e.size, 0), got = all.reduce((n, e) => n + e.seen.size, 0), more = got < want;
          status.textContent = `Found ${have.size} account${have.size === 1 ? '' : 's'}.` + (more ? ` Google Authenticator split the export: ${got} of ${want} QR codes scanned. Show the next one.` : '');
          useBtn.hidden = false;
          if (!more) finish();
        }
      } catch (e) { status.textContent = String(e); }
      busy = false;
    }, 250);
  };
  const imgIn = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => { const f = imgIn.files?.[0]; if (f) fromFile(f); imgIn.value = ''; } });
  const txt = h('textarea', { rows: 3, placeholder: '…or paste otpauth:// or otpauth-migration:// links here', spellcheck: false });
  const screen = h('button', { onclick: () => run(() => call<Parsed>('scan_screen'), screen) }, icon('scan'), h('span', {}, 'Scan my screen'));
  const d = dialog(close => [h('h3', {}, 'Import 2FA codes'),
    h('p', { class: 'hint' }, 'Works with Google Authenticator (menu > Transfer accounts > Export), the QR code a site shows when you turn on 2FA, and text links.'),
    h('div', { class: 'btns' }, h('button', { class: 'primary', id: 'camBtn', onclick: startCamera }, icon('camera'), h('span', {}, 'Use camera')), screen, h('button', { onclick: () => imgIn.click() }, icon('upload'), h('span', {}, 'Open QR image…')), imgIn),
    camBox,
    h('p', { class: 'hint' }, 'Camera: point it at the QR code on your phone. Scan my screen: Vault hides itself and reads QR codes on your monitors. No camera? Scan the export QR with another phone, copy the text it shows and paste it below, or open or paste (Ctrl+V) a screenshot.'),
    txt, h('button', { onclick: () => txt.value.trim() && run(async () => { const p = await call<Parsed>('parse_2fa', { text: txt.value }); if (!p.accounts.length && !p.skipped) throw 'No 2FA links found in that text.'; return p; }) }, 'Read pasted text'),
    out, h('button', { onclick: close }, 'Close')], 'twofa');
  d.addEventListener('close', stopCam);
  d.addEventListener('paste', e => {
    const f = [...(e.clipboardData?.files ?? [])].find(x => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); fromFile(f); }
  });
}

// ---------- browser extension ----------
export async function extensionDialog() {
  let path = '';
  try { path = await call<string>('extension_install'); } catch (e) { return err(e); }
  const step = (n: number, ...kids: (Node | string)[]) => h('li', {}, h('b', {}, `${n}. `), ...kids);
  dialog(close => [h('h3', {}, 'Install the browser extension'),
    h('p', { class: 'hint' }, 'Works in Google Chrome and Microsoft Edge. Vault just opened the extension folder.'),
    h('ol', { class: 'steps' },
      step(1, 'Open ', h('code', {}, 'chrome://extensions'), ' (or ', h('code', {}, 'edge://extensions'), ') and turn on Developer mode.'),
      step(2, 'Choose “Load unpacked” and select this folder:'),
      h('div', { class: 'btns' }, h('code', { class: 'path' }, path), h('button', { onclick: () => copyText(path) }, icon('copy'), h('span', {}, 'Copy path'))),
      step(3, 'Click the Vault icon in the browser toolbar and enter the six-digit code from “Pair a browser”.')),
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => { close(); pairDialog(); } }, icon('puzzle'), h('span', {}, 'Pair a browser…')), h('button', { onclick: close }, 'Close'))]);
}

export async function pairDialog() {
  let code = '';
  try { code = await call<string>('bridge_pair_start'); } catch (e) { return err(e); }
  const left = h('small', { class: 'hint' }, 'Valid for 2 minutes.');
  let secs = 120;
  const t = window.setInterval(() => { secs--; left.textContent = secs > 0 ? `Valid for ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}.` : 'The code expired. Close this and start again.'; if (secs <= 0) clearInterval(t); }, 1000);
  const d = dialog(close => [h('h3', {}, 'Pair a browser'), h('p', { class: 'hint' }, 'Type this code into the Vault extension (click its icon in the browser toolbar).'), h('div', { class: 'bigkey', id: 'paircode' }, code), left, h('button', { onclick: close }, 'Close')]);
  d.addEventListener('close', () => clearInterval(t));
}

// ---------- sync ----------
export function syncKeyDialog(key: string) {
  dialog(close => [h('h3', {}, 'Your sync key'), h('p', { class: 'hint' }, 'Sync is on. To get your vault on another PC, install Vault there, choose “Restore from my server” on the first screen, and enter your server address and this key. The key only finds your encrypted copy; your master password is still needed to open it.'),
    h('div', { class: 'bigkey', id: 'synckey' }, key), h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => copyText(key) }, icon('copy'), h('span', {}, 'Copy key')), h('button', { onclick: close }, 'Close'))]);
}

export function restoreDialog(onDone: () => void) {
  const url = h('input', { placeholder: 'Server address, for example http://100.1.2.3:8803', autocomplete: 'off', spellcheck: false });
  const key = h('input', { placeholder: 'Sync key', autocomplete: 'off', spellcheck: false, class: 'mono' });
  const msg = h('p', { class: 'hint' }, '');
  const go = h('button', { class: 'primary' }, 'Restore');
  go.addEventListener('click', async () => {
    go.setAttribute('disabled', ''); go.classList.add('busy'); msg.textContent = 'Downloading…';
    try { await call('sync_restore', { url: url.value, key: key.value }); document.querySelectorAll('dialog').forEach(d => d.remove()); toast('Restored. Enter your master password to unlock.'); onDone(); }
    catch (e) { msg.textContent = String(e); go.removeAttribute('disabled'); go.classList.remove('busy'); }
  });
  dialog(close => [h('h3', {}, 'Restore from my server'), h('p', { class: 'hint' }, 'Downloads your encrypted vault from your own sync server. You still need your master password to open it.'), url, key, msg, h('div', { class: 'btns' }, go, h('button', { onclick: close }, 'Cancel'))]);
  url.focus();
}

// ---------- settings ----------
export async function settingsDialog() {
  const dir = await call<string>('backup_dir');
  const st = await call<{ quick: boolean; recovery: boolean; hello: boolean }>('status');
  const helloOk = st.quick && await call<boolean>('hello_available').catch(() => false);
  let autostart = false;
  try { autostart = await call<boolean>('autostart_get'); } catch { /* not available */ }
  const ver = await getVersion().catch(() => '');
  const syncSt = await call<{ configured: boolean; url: string; rev: number; last_ok_at: number; pending: boolean; note_ok: boolean; note: string }>('sync_status').catch(() => null);
  const paired = await call<{ name: string; created: number }[]>('bridge_paired').catch(() => []);
  const sec = (title: string, ic: string, ...kids: (Node | null)[]) => h('section', { class: 'sset' }, h('h4', {}, icon(ic), ' ' + title), ...kids);
  const choose = (label: string, opts: [number, string][], cur: number, set: (v: number) => void) => {
    const s = h('select', { onchange: async () => { set(+s.value); await saveSettings(); toast('Saved'); } }, ...opts.map(([v, n]) => h('option', { value: String(v), selected: v === cur }, n)));
    return h('label', { class: 'setrow' }, h('span', {}, label), s);
  };
  const toggle = (label: string, sub: string, cur: boolean, set: (v: boolean) => Promise<void>, id = '') => {
    const c = h('input', { type: 'checkbox', checked: cur, id, onchange: async () => { try { await set(c.checked); } catch (e) { c.checked = !c.checked; err(e); } } });
    return h('label', { class: 'chk stay' }, c, h('span', {}, label, sub ? h('small', {}, sub) : null));
  };
  const swatches = h('div', { class: 'swatches' }, ...Object.entries(ACCENTS).map(([k, c]) => {
    const b = h('button', { type: 'button', class: 'sw' + (S.settings.accent === k ? ' on' : ''), title: k, 'aria-label': k, onclick: async () => { S.settings.accent = k; applyTheme(); swatches.querySelectorAll('.sw').forEach(x => x.classList.toggle('on', x === b)); await saveSettings(); } });
    b.style.setProperty('--sw', c);
    return b;
  }));
  const themeSel = h('div', { class: 'seg' }, ...(['auto', 'dark', 'light'] as const).map(t => h('button', { type: 'button', class: S.settings.theme === t ? 'on' : '', onclick: async (e: Event) => { S.settings.theme = t; applyTheme(); themeSel.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === e.currentTarget)); await saveSettings(); } }, t[0].toUpperCase() + t.slice(1))));
  const tplList = S.settings.templates.length ? h('div', { class: 'group' }, ...S.settings.templates.map((t, i) => h('div', { class: 'f static' }, h('div', { class: 'l' }, KINDS[t.kind as Kind]?.label ?? t.kind), h('div', { class: 'val' }, t.name),
    h('div', { class: 'acts' }, iconBtn('trash', 'Delete template', async () => { S.settings.templates.splice(i, 1); await saveSettings(); document.querySelector('dialog.settings')?.remove(); settingsDialog(); }))))) : h('p', { class: 'hint' }, 'None yet. In any item, use “Save as template” to keep its field layout.');
  const upd = h('button', { onclick: () => hooks.checkUpdate(true) }, icon('download'), h('span', {}, 'Check for updates'));
  dialog(close => [h('h3', {}, 'Settings'),
    sec('Appearance', 'palette', h('div', { class: 'setrow' }, h('span', {}, 'Theme'), themeSel), h('div', { class: 'setrow' }, h('span', {}, 'Accent colour'), swatches)),
    sec('Locking and sign-in', 'lock',
      choose('Lock after being idle', [[1, '1 minute'], [2, '2 minutes'], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [0, 'Never']], S.settings.autolock_min, v => S.settings.autolock_min = v),
      choose('Clear the clipboard after', [[10, '10 seconds'], [20, '20 seconds'], [30, '30 seconds'], [60, '1 minute'], [0, 'Never']], S.settings.clip_secs, v => S.settings.clip_secs = v),
      toggle('Lock when Windows locks or the PC sleeps', 'Locks the vault when you lock your PC (Win+L), it goes to the lock screen, or it goes to sleep.', S.settings.lock_on_windows_lock, async v => { S.settings.lock_on_windows_lock = v; await saveSettings(); }),
      toggle('Unlock automatically on this PC', 'Opens straight into the vault when you start the app, and the lock screen needs one click. Anyone using this Windows account can open it.', st.quick, async v => { await call(v ? 'quick_enable' : 'quick_disable'); toast(v ? 'Vault will open automatically on this PC' : 'Vault will ask for the master password'); document.querySelector('dialog.settings')?.remove(); settingsDialog(); }, 'quickbox'),
      helloOk ? toggle('Ask for Windows Hello first', 'Face, fingerprint or your Windows PIN before the automatic unlock, so someone at your unlocked PC cannot just open Vault.', st.hello, async v => { await call('quick_hello_set', { on: v }); toast(v ? 'Vault will ask for Windows Hello' : 'Windows Hello turned off for Vault'); }, 'hellobox') : null,
      h('div', { class: 'btns' }, h('button', { onclick: () => { close(); recoveryDialog(); } }, icon('shield'), h('span', {}, st.recovery ? 'Recovery key…' : 'Create a recovery key…')), h('button', { onclick: () => { close(); masterDialog(); } }, icon('key'), h('span', {}, 'Change master password…')))),
    sec('Windows', 'grid',
      toggle('Keep running in the tray when the window is closed', 'Quick find (Ctrl+Alt+K) and the browser extension keep working.', S.settings.tray, async v => { S.settings.tray = v; await saveSettings(); }),
      toggle('Start Vault when I sign in to Windows', 'Starts minimized in the tray.', autostart, async v => { await call('autostart_set', { on: v }); })),
    sec('Backups', 'folder', h('p', { class: 'hint' }, 'One encrypted copy a day, newest 14 kept.'), h('code', { class: 'path' }, dir),
      h('div', { class: 'btns' }, h('button', { onclick: () => { close(); backupsDialog(); } }, icon('restore'), h('span', {}, 'Backups and restore…')),
        h('button', { onclick: async () => { const path = await save({ defaultPath: 'vault-backup.bin', filters: [{ name: 'Vault backup', extensions: ['bin'] }] }); if (path) { try { await call('export_backup', { path }); toast('Encrypted backup saved'); } catch (e) { err(e); } } } }, icon('upload'), h('span', {}, 'Export encrypted backup…')))),
    sec('Browser extension', 'puzzle', h('p', { class: 'hint' }, 'Fills logins, cards and addresses in Chrome and Edge, offers to save new logins, warns about look-alike sites and keeps passkeys in Vault. Everything stays on this PC.'),
      paired.length ? h('div', { class: 'group' }, ...paired.map(p => h('div', { class: 'f static' }, h('div', { class: 'l' }, `Paired ${ago(p.created)}`), h('div', { class: 'val' }, p.name),
        h('div', { class: 'acts' }, iconBtn('trash', 'Remove this browser', async () => { await call('bridge_revoke', { name: p.name, created: p.created }); document.querySelector('dialog.settings')?.remove(); settingsDialog(); }))))) : null,
      h('div', { class: 'btns' }, h('button', { onclick: () => { close(); extensionDialog(); } }, icon('puzzle'), h('span', {}, 'Install the extension…')), h('button', { class: 'primary', onclick: () => { close(); pairDialog(); } }, h('span', {}, 'Pair a browser…')))),
    sec('Sync to your server', 'cloud', syncSt?.configured
      ? h('div', { class: 'setcol' }, h('p', { class: 'hint' }, `${syncSt.url} · ${syncSt.pending ? 'changes waiting to upload' : syncSt.last_ok_at ? 'up to date, last synced ' + ago(syncSt.last_ok_at) : 'not synced yet'}${syncSt.note && !syncSt.note_ok ? ' · ' + syncSt.note : ''}`),
        h('div', { class: 'btns' }, h('button', { onclick: async (e: Event) => { const b = e.currentTarget as HTMLElement; b.classList.add('busy'); try { const o = await call<string>('sync_now'); toast(o === 'UpToDate' ? 'Already up to date' : `Synced (${o.toLowerCase()})`); await hooks.reload(); } catch (x) { err(x); } b.classList.remove('busy'); } }, icon('restore'), h('span', {}, 'Sync now')),
          h('button', { onclick: async () => syncKeyDialog(await call<string>('sync_key')) }, icon('key'), h('span', {}, 'Show sync key')),
          h('button', { class: 'danger', onclick: async () => { if (await confirmDialog('Turn off sync?', 'The encrypted copy stays on your server; this PC just stops syncing.', 'Turn off', true)) { await call('sync_disable'); document.querySelector('dialog.settings')?.remove(); settingsDialog(); } } }, 'Turn off')))
      : h('div', { class: 'setcol' }, h('p', { class: 'hint' }, 'Keeps an encrypted copy of your vault on your own server (for example over Tailscale), so you can restore it on a new PC. The server only ever sees encrypted files, never your password.'),
        (() => { const u = h('input', { id: 'syncurl', placeholder: 'Server address, for example http://100.1.2.3:8803', autocomplete: 'off', spellcheck: false });
          const b = h('button', { class: 'primary', onclick: async () => { b.classList.add('busy'); try { const k = await call<string>('sync_enable', { url: u.value }); document.querySelector('dialog.settings')?.remove(); syncKeyDialog(k); } catch (x) { err(x); b.classList.remove('busy'); } } }, icon('cloud'), h('span', {}, 'Turn on sync'));
          return h('div', { class: 'btns' }, u, b); })())),
    sec('Updates', 'download', h('p', { class: 'hint' }, `Vault ${ver}. Updates come from GitHub and are checked against a signature.`),
      toggle('Check for updates automatically', '', S.settings.check_updates, async v => { S.settings.check_updates = v; await saveSettings(); }), h('div', { class: 'btns' }, upd)),
    sec('Item templates', 'sparkle', tplList),
    sec('Shortcuts', 'cmd', h('div', { class: 'keys' }, ...([['Ctrl+Alt+K', 'Quick find from anywhere'], ['Ctrl+Alt+A', 'Type a login into the window in front'], ['Ctrl+K', 'Quick find'], ['Ctrl+N', 'New item'], ['Ctrl+Shift+C', 'Copy password'], ['Ctrl+Shift+U', 'Copy username'], ['Ctrl+Shift+T', 'Copy one-time code'], ['Ctrl+L', 'Lock'], ['/', 'Search'], ['↑ ↓', 'Browse the list']] as [string, string][]).map(([k, d]) => h('div', {}, h('kbd', {}, k), h('span', {}, d))))),
    h('button', { onclick: close }, 'Close')], 'settings wide');
}
