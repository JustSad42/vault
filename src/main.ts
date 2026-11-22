import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import './style.css';

type Kind = 'login' | 'card' | 'note' | 'ssh' | 'api' | 'wifi' | 'other';
type FKind = 'text' | 'secret' | 'multiline' | 'totp';
interface Field { label: string; value: string; kind: FKind }
interface Hist { label: string; value: string; at: number }
interface Item { id: string; kind: Kind; title: string; folder: string; fields: Field[]; notes: string; favorite: boolean; updated: number; history: Hist[]; deleted: number }
interface Sum { id: string; kind: Kind; title: string; sub: string; folder: string; favorite: boolean; deleted: boolean }
interface Settings { autolock_min: number; clip_secs: number }
interface Ref { id: string; title: string; note: string }
interface Acct { title: string; account: string; uri: string }
interface Parsed { accounts: Acct[]; skipped: number }
interface Live { id: string; title: string; sub: string; label: string; code: string; left: number; period: number }
interface Audit { total: number; score: number; weak: Ref[]; reused: Ref[]; old: Ref[]; insecure: Ref[] }

const KINDS: Record<Kind, { label: string; plural: string; icon: string; desc: string }> = {
  login: { label: 'Login', plural: 'Logins', icon: 'key', desc: 'Website or app account' },
  card: { label: 'Credit / debit card', plural: 'Cards', icon: 'card', desc: 'Payment card' },
  note: { label: 'Secure note', plural: 'Notes', icon: 'note', desc: 'Private text' },
  ssh: { label: 'SSH key', plural: 'SSH keys', icon: 'terminal', desc: 'Server access key' },
  api: { label: 'API key', plural: 'API keys', icon: 'braces', desc: 'Token or secret' },
  wifi: { label: 'Wi-Fi network', plural: 'Wi-Fi', icon: 'wifi', desc: 'Password with QR code' },
  other: { label: 'Other card or ID', plural: 'Other', icon: 'id', desc: 'Membership, ID, licence' },
};
const KIND_ORDER = Object.keys(KINDS) as Kind[];
const F = (label: string, kind: FKind = 'text', value = ''): Field => ({ label, value, kind });
const TEMPLATES: Record<Kind, () => Field[]> = {
  login: () => [F('Username'), F('Password', 'secret'), F('Website'), F('One-time code', 'totp')],
  card: () => [F('Cardholder'), F('Card number', 'secret'), F('Expiry'), F('CVV', 'secret'), F('PIN', 'secret')],
  note: () => [],
  ssh: () => [F('Public key'), F('Private key', 'multiline'), F('Passphrase', 'secret')],
  api: () => [F('Key', 'secret'), F('Endpoint'), F('Expires')],
  wifi: () => [F('Network name'), F('Password', 'secret'), F('Security', 'text', 'WPA2')],
  other: () => [F('Name'), F('Number')],
};

const ICONS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7"/>',
  terminal: '<path d="m4 17 6-5-6-5M12 19h8"/>',
  braces: '<path d="M8 4c-2 0-3 1-3 3v2c0 1-1 2-2 3 1 1 2 2 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1 1 2 2 3-1 1-2 2-2 3v2c0 2-1 3-3 3"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/>',
  id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16c.5-2 5.5-2 6 0M14 10h4M14 14h3"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.7A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.4-1"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z"/>',
  shieldcheck: '<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  restore: '<path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 3h6"/>',
  cmd: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
};

// Builds DOM without innerHTML: imported data is untrusted.
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'list' || k.startsWith('data-') || k.startsWith('aria-')) e.setAttribute(k, v);
    else if (v !== undefined) (e as any)[k] = v;
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}
const put = (el: Element, ...kids: (Node | null | false | undefined)[]) => el.replaceChildren(...(kids.filter(Boolean) as Node[]));

// Icons and the QR code are static strings or generated by our own Rust, never user text.
function fromHtml(html: string): Element {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as Element;
}
const icon = (name: string, cls = '') => fromHtml(`<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`);

const app = document.getElementById('app')!;
let sums: Sum[] = [];
let vis: Sum[] = [];
let sel: string | null = null;
let editing: Item | null = null;
let filter = 'all';
let query = '';
let settings: Settings = { autolock_min: 5, clip_secs: 20 };
let ticks: number[] = [];
let idleTimer = 0;
let toastTimer = 0;
let mainActive = false;
let layoutEl: HTMLElement, listEl: HTMLElement, detailEl: HTMLElement, navEl: HTMLElement, searchEl: HTMLInputElement;

const call = <T = void>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args);
const err = (e: unknown) => toast(String(e), true);

function toast(msg: string, bad = false) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast' }); document.body.append(t); }
  put(t, icon(bad ? 'alert' : 'check'), h('span', {}, msg));
  t.className = bad ? 'bad show' : 'show';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), bad ? 6000 : 2600);
}

async function copyText(text: string) {
  try { await call('copy', { text }); toast(settings.clip_secs ? `Copied. The clipboard clears in ${settings.clip_secs} s.` : 'Copied.'); } catch (e) { err(e); }
}

const hue = (s: string) => { let n = 0; for (const c of s) n = (n * 31 + c.codePointAt(0)!) % 360; return n; };
function avatar(kind: Kind, title: string, big = false) {
  const a = h('div', { class: 'av' + (big ? ' big' : '') }, kind === 'login' ? h('span', {}, (title.trim()[0] || '?').toUpperCase()) : icon(KINDS[kind].icon));
  a.style.setProperty('--h', String(hue(title)));
  return a;
}

function ago(ts: number) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} days ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

function iconBtn(name: string, title: string, onclick: (e: Event) => void, cls = '') {
  return h('button', { type: 'button', class: 'icon ' + cls, title, 'aria-label': title, onclick }, icon(name));
}

/** Copy button that turns into a check mark for a moment. */
function copyBtn(get: () => string) {
  const b = iconBtn('copy', 'Copy', () => { copyText(get()); flashIcon(b); });
  return b;
}
function flashIcon(b: HTMLElement) { b.replaceChildren(icon('check')); b.classList.add('done'); setTimeout(() => { b.replaceChildren(icon('copy')); b.classList.remove('done'); }, 1200); }

// ---------- password strength ----------
function meter() {
  const bar = h('i'), lab = h('small');
  const el = h('div', { class: 'meter' }, h('div', { class: 'track' }, bar), lab);
  let seq = 0;
  const update = async (pw: string) => {
    const n = ++seq;
    if (!pw) { bar.style.width = '0'; lab.textContent = ''; return; }
    const s = await call<{ bits: number; level: string }>('strength', { password: pw });
    if (n !== seq) return;
    bar.style.width = Math.min(100, Math.round(s.bits)) + '%';
    bar.className = s.level;
    lab.textContent = s.level[0].toUpperCase() + s.level.slice(1);
  };
  return { el, update };
}

function pwField(id: string, placeholder: string) {
  const input = h('input', { type: 'password', id, placeholder, autocomplete: 'off', spellcheck: false });
  const eye = iconBtn('eye', 'Show', () => { const show = input.type === 'password'; input.type = show ? 'text' : 'password'; put(eye, icon(show ? 'eyeoff' : 'eye')); });
  return { wrap: h('div', { class: 'pwf' }, input, eye), input };
}

// ---------- lock screen ----------
async function showLock(auto = false) {
  mainActive = false;
  clearTimeout(idleTimer);
  ticks.forEach(clearInterval); ticks = [];
  sums = []; vis = []; sel = null; editing = null; filter = 'all'; query = '';
  document.querySelectorAll('dialog').forEach(d => d.remove());
  const { exists, quick } = await call<{ exists: boolean; quick: boolean }>('status');
  if (auto && exists && quick) { // startup with "stay signed in": straight into the vault
    try { await call('quick_unlock'); return await showMain(); } catch { /* fall back to the password screen */ }
  }
  const pw = pwField('pw1', exists ? (quick ? 'or type your master password' : 'Master password') : 'Choose a master password (10+ characters)');
  const pw2 = exists ? null : pwField('pw2', 'Repeat master password');
  const m = exists ? null : meter();
  pw.input.addEventListener('input', () => m?.update(pw.input.value));
  const msg = h('p', { class: 'hint', id: 'msg' }, exists ? '' : 'There is no way to recover this password. Write it down somewhere safe.');
  const btn = h('button', { type: 'submit', class: 'primary big' }, exists ? 'Unlock' : 'Create vault');
  const stay = quick ? null : h('input', { type: 'checkbox', id: 'stay', checked: !exists });
  const stayRow = stay && h('label', { class: 'chk stay' }, stay, h('span', {}, exists ? 'Stay signed in on this PC' : 'Unlock automatically on this PC', h('small', {}, 'Uses your Windows sign-in to protect the key, so anyone using this Windows account can open the vault. You can turn it off in Settings.')));
  const form = h('form', { class: 'card lock' },
    h('div', { class: 'logo' }, icon('shield')), h('h1', {}, 'Vault'),
    h('p', { class: 'sub' }, exists ? 'Enter your master password to unlock.' : 'Create your vault. Everything stays encrypted on this PC.'),
    quick ? btn : pw.wrap, pw2?.wrap, m?.el, stayRow, quick ? pw.wrap : btn, msg);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const viaQuick = quick && !pw.input.value;
    if (pw2 && pw.input.value !== pw2.input.value) { msg.textContent = 'The two passwords differ.'; return; }
    btn.disabled = true; btn.classList.add('busy'); msg.textContent = exists ? 'Unlocking…' : 'Creating…';
    try {
      if (viaQuick) await call('quick_unlock'); else await call(exists ? 'unlock' : 'create_vault', { password: pw.input.value });
      pw.input.value = ''; if (pw2) pw2.input.value = '';
      if (stay?.checked) await call('quick_enable').catch(err);
      await showMain();
    }
    catch (e) {
      msg.textContent = String(e); btn.disabled = false; btn.classList.remove('busy');
      form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
    }
  });
  put(app, h('div', { class: 'center' }, h('i', { class: 'orb a' }), h('i', { class: 'orb b' }), form));
  (quick ? btn : pw.input).focus();
}

// ---------- main screen ----------
function resetIdle() {
  clearTimeout(idleTimer);
  if (settings.autolock_min > 0) idleTimer = window.setTimeout(lockNow, settings.autolock_min * 60000);
}
async function lockNow() { await call('lock'); await showLock(false); }

async function showMain() {
  settings = await call<Settings>('get_settings');
  searchEl = h('input', { type: 'search', placeholder: 'Search   ( / )', 'aria-label': 'Search', oninput: () => { query = searchEl.value.toLowerCase(); renderList(true); } });
  navEl = h('nav');
  listEl = h('div', { class: 'list' });
  detailEl = h('main', { class: 'detail' });
  const importInput = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, onchange: async () => {
    const f = importInput.files?.[0]; if (!f) return;
    try { const n = await call<number>('import_csv', { text: await f.text() }); toast(`Imported ${n} item${n === 1 ? '' : 's'}. Delete the CSV file now: it holds your passwords in plain text.`); await reload(); }
    catch (e) { err(e); }
    importInput.value = '';
  } });
  const side = (name: string, label: string, fn: () => void) => h('button', { class: 'side', onclick: fn }, icon(name), h('span', {}, label));
  layoutEl = h('div', { class: 'layout' },
    h('aside', {}, h('div', { class: 'brand' }, h('div', { class: 'logo sm' }, icon('shield')), h('b', {}, 'Vault')), navEl, h('div', { class: 'grow' }),
      side('cmd', 'Quick find', palette), side('dice', 'Generator', () => genDialog()), side('upload', 'Import CSV', () => importInput.click()),
      side('settings', 'Settings', settingsDialog), side('key', 'Master password', masterDialog), side('lock', 'Lock', lockNow), importInput),
    h('section', { class: 'col' }, h('div', { class: 'bar' }, h('div', { class: 'search' }, icon('search'), searchEl), h('button', { class: 'primary', onclick: newDialog }, icon('plus'), h('span', {}, 'New'))), listEl),
    detailEl);
  put(app, layoutEl);
  mainActive = true;
  resetIdle();
  await reload();
}

async function reload() {
  try { sums = await call<Sum[]>('list'); } catch (e) { err(e); return; }
  renderNav(); renderList(); renderDetail();
}

function matches(s: Sum, f: string) {
  if (f === 'all') return true;
  if (f === 'fav') return s.favorite;
  if (f.startsWith('kind:')) return s.kind === f.slice(5);
  if (f.startsWith('folder:')) return s.folder === f.slice(7);
  return false;
}

function go(key: string) {
  filter = key; sel = null; editing = null;
  layoutEl.classList.toggle('wide', key === 'security' || key === 'auth');
  renderNav(); renderList(true); renderDetail();
}

function renderNav() {
  const alive = sums.filter(s => !s.deleted);
  const n = (f: string) => alive.filter(s => matches(s, f)).length;
  const entry = (key: string, label: string, ic: string, count: number | string = '', badge = false) =>
    h('button', { class: key === filter ? 'nav on' : 'nav', onclick: () => go(key) }, icon(ic), h('span', { class: 'lbl' }, label), count !== '' && h('span', { class: badge ? 'n badge' : 'n' }, String(count)));
  const folders = [...new Set(alive.map(s => s.folder).filter(Boolean))].sort();
  put(navEl,
    entry('all', 'All items', 'grid', alive.length), entry('fav', 'Favorites', 'star', n('fav')),
    h('div', { class: 'sec' }, 'Types'),
    ...KIND_ORDER.filter(k => n('kind:' + k) > 0 || ['login', 'card', 'note'].includes(k)).map(k => entry('kind:' + k, KINDS[k].plural, KINDS[k].icon, n('kind:' + k))),
    folders.length ? h('div', { class: 'sec' }, 'Folders') : null,
    ...folders.map(f => entry('folder:' + f, f, 'folder', n('folder:' + f))),
    h('div', { class: 'sec' }, 'Tools'),
    entry('auth', 'Authenticator', 'timer'), entry('security', 'Security center', 'shieldcheck'), entry('trash', 'Trash', 'trash', sums.filter(s => s.deleted).length || ''));
}

function renderList(animate = false) {
  if (filter === 'security' || filter === 'auth') return;
  const rows = sums
    .filter(s => filter === 'trash' ? s.deleted : !s.deleted && matches(s, filter))
    .filter(s => !query || [s.title, s.sub, s.folder].some(x => x.toLowerCase().includes(query)))
    .sort((a, b) => a.title.localeCompare(b.title));
  vis = rows;
  listEl.className = 'list' + (animate ? ' enter' : '');
  if (!rows.length) {
    const none = sums.length === 0;
    return put(listEl, h('div', { class: 'empty small' }, icon(filter === 'trash' ? 'trash' : 'shield', 'big'),
      h('p', {}, filter === 'trash' ? 'The trash is empty.' : none ? 'Your vault is empty.' : 'Nothing matches.'),
      none && filter !== 'trash' ? h('button', { class: 'primary', onclick: newDialog }, 'Add your first item') : null));
  }
  put(listEl, filter === 'trash' ? h('div', { class: 'trashbar' }, h('small', {}, 'Items are deleted for good after 30 days.'), h('button', { class: 'danger', onclick: emptyTrash }, 'Empty trash')) : null,
    ...rows.map((s, i) => {
      const r = h('button', { class: s.id === sel ? 'row on' : 'row', 'data-id': s.id, onclick: () => { sel = s.id; editing = null; markSel(); renderDetail(); } },
        avatar(s.kind, s.title), h('div', { class: 't' }, h('b', {}, s.title), h('small', {}, s.sub || s.folder || KINDS[s.kind].label)), s.favorite ? icon('star', 'fav') : null);
      r.style.setProperty('--i', String(Math.min(i, 12)));
      return r;
    }));
}

function markSel() {
  listEl.querySelectorAll<HTMLElement>('.row').forEach(r => r.classList.toggle('on', r.dataset.id === sel));
  listEl.querySelector('.row.on')?.scrollIntoView({ block: 'nearest' });
}

function moveSel(d: number) {
  if (!vis.length || editing) return;
  const i = vis.findIndex(s => s.id === sel);
  sel = vis[Math.max(0, Math.min(vis.length - 1, i < 0 ? (d > 0 ? 0 : vis.length - 1) : i + d))].id;
  markSel(); renderDetail();
}

function openItem(id: string) {
  filter = 'all'; query = ''; searchEl.value = ''; sel = id; editing = null;
  layoutEl.classList.remove('wide'); renderNav(); renderList(true); renderDetail(); markSel();
}

async function emptyTrash() {
  dialog(close => [h('h3', {}, 'Empty the trash?'), h('p', { class: 'hint' }, 'These items will be deleted for good.'),
    h('div', { class: 'btns' }, h('button', { class: 'danger', onclick: async () => { close(); try { await call('empty_trash'); sel = null; await reload(); toast('Trash emptied'); } catch (e) { err(e); } } }, 'Delete forever'), h('button', { onclick: close }, 'Cancel'))]);
}

// ---------- detail ----------
const emptyDetail = () => h('div', { class: 'empty' }, icon('shieldcheck', 'big'), h('p', {}, 'Select an item to see it here.'),
  h('p', { class: 'hint' }, 'Ctrl+K quick find · Ctrl+N new · Ctrl+L lock · ↑ ↓ to browse'));

async function renderDetail() {
  ticks.forEach(clearInterval); ticks = [];
  if (filter === 'security') return renderSecurity();
  if (filter === 'auth') return renderAuth();
  if (editing) return renderEdit(editing);
  if (!sel) return put(detailEl, emptyDetail());
  let it: Item;
  try { it = await call<Item>('get_item', { id: sel }); } catch { sel = null; return renderDetail(); }
  if (sel !== it.id || editing) return; // user moved on while we waited
  ticks.forEach(clearInterval); ticks = [];
  const k = KINDS[it.kind];
  const acts = it.deleted
    ? [h('button', { onclick: async () => { try { await call('restore_item', { id: it.id }); await reload(); toast('Restored'); } catch (e) { err(e); } } }, icon('restore'), h('span', {}, 'Restore')), delForever(it)]
    : [iconBtn('star', it.favorite ? 'Remove from favorites' : 'Add to favorites', async () => { try { await call('save_item', { item: { ...it, favorite: !it.favorite } }); await reload(); } catch (e) { err(e); } }, it.favorite ? 'on' : ''),
       h('button', { onclick: () => { editing = structuredClone(it); renderDetail(); } }, icon('edit'), h('span', {}, 'Edit'))];
  const shown = it.fields.filter(f => f.value);
  put(detailEl,
    h('div', { class: 'head' }, avatar(it.kind, it.title, true), h('div', { class: 'ttl' }, h('h2', {}, it.title), h('small', { class: 'hint' }, [k.label, it.folder].filter(Boolean).join(' · '))), h('div', { class: 'acts' }, ...acts)),
    it.kind === 'card' ? wallet(it) : null,
    it.kind === 'wifi' ? await wifiQr(it) : null,
    shown.length ? h('div', { class: 'group' }, ...shown.map(viewField)) : null,
    it.notes ? h('div', { class: 'group' }, h('div', { class: 'f' }, h('div', { class: 'l' }, 'Notes'), h('pre', { class: 'notes' }, it.notes))) : null,
    it.history.length ? h('details', { class: 'group hist' }, h('summary', {}, icon('clock'), ` History (${it.history.length})`),
      ...it.history.slice().reverse().map(x => viewField({ label: `Previous ${x.label} · ${ago(x.at)}`, value: x.value, kind: 'secret' }))) : null,
    h('small', { class: 'hint foot', title: new Date(it.updated * 1000).toLocaleString() }, 'Changed ' + ago(it.updated)));
}

function delForever(it: Item) {
  let armed = false;
  const b = h('button', { class: 'danger', onclick: async () => {
    if (!armed) { armed = true; put(b, icon('trash'), h('span', {}, 'Click again to delete')); return; }
    try { await call('delete_item', { id: it.id }); sel = null; await reload(); toast('Deleted for good'); } catch (e) { err(e); }
  } }, icon('trash'), h('span', {}, 'Delete forever'));
  return b;
}

async function wifiQr(it: Item) {
  const g = (l: string) => it.fields.find(f => f.label === l)?.value || '';
  if (!g('Network name')) return null;
  try { return h('div', { class: 'qr' }, fromHtml(await call<string>('wifi_qr', { ssid: g('Network name'), password: g('Password'), security: g('Security') })), h('small', { class: 'hint' }, 'Scan with a phone camera to join')); }
  catch { return null; }
}

function wallet(it: Item) {
  const g = (l: string) => it.fields.find(f => f.label === l)?.value || '';
  const num = g('Card number').replace(/\D/g, '');
  const brand = /^4/.test(num) ? 'VISA' : /^(5[1-5]|2[2-7])/.test(num) ? 'Mastercard' : /^3[47]/.test(num) ? 'AMEX' : /^6/.test(num) ? 'Discover' : '';
  const w = h('div', { class: 'wallet' }, h('div', { class: 'top' }, h('i', { class: 'chip' }), h('b', {}, brand)),
    h('div', { class: 'num' }, '•••• •••• •••• ' + (num.slice(-4) || '••••')),
    h('div', { class: 'bot' }, h('span', {}, g('Cardholder') || it.title), h('span', {}, g('Expiry'))));
  w.style.setProperty('--h', String(hue(it.title)));
  return w;
}

function jwt(v: string): any | null {
  const p = v.split('.');
  if (p.length !== 3 || !p.every(x => /^[A-Za-z0-9_-]+$/.test(x))) return null;
  try { return JSON.parse(atob(p[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(p[1].length / 4) * 4, '='))); } catch { return null; }
}

function ringEl() {
  const el = fromHtml('<svg class="ring" viewBox="0 0 36 36"><circle class="bg" cx="18" cy="18" r="15"/><circle class="fg" cx="18" cy="18" r="15"/><text x="18" y="22" text-anchor="middle"></text></svg>');
  const fg = el.querySelector('.fg') as SVGElement, txt = el.querySelector('text')!;
  return { el, set(left: number, period: number) { txt.textContent = String(left); fg.style.strokeDashoffset = String(94.25 * (1 - left / period)); } };
}

function viewField(f: Field): HTMLElement {
  const val = h('div', { class: 'val' });
  const acts = h('div', { class: 'acts' });
  const row = h('div', { class: 'f' }, h('div', { class: 'l' }, f.label), val, acts);
  let get = () => f.value;
  if (f.kind === 'totp') {
    const ring = ringEl();
    const code = h('span', { class: 'code' });
    val.append(code, ring.el);
    let cur = '';
    get = () => cur;
    const tick = async () => {
      try {
        const o = await call<{ code: string; left: number; period: number }>('totp', { secret: f.value });
        cur = o.code; code.textContent = `${o.code.slice(0, o.code.length / 2)} ${o.code.slice(o.code.length / 2)}`;
        ring.set(o.left, o.period); row.classList.toggle('low', o.left <= 5);
      } catch (e) { cur = ''; code.textContent = String(e); }
    };
    tick(); ticks.push(window.setInterval(tick, 1000));
  } else {
    const masked = f.kind === 'secret' || f.kind === 'multiline';
    let shown = false;
    const paint = () => { val.textContent = masked && !shown ? '••••••••••' : f.value; val.classList.toggle('pre', f.kind === 'multiline' && shown); };
    paint();
    if (masked) { const eye = iconBtn('eye', 'Show or hide', () => { shown = !shown; paint(); put(eye, icon(shown ? 'eyeoff' : 'eye')); }); acts.append(eye); }
    const claims = jwt(f.value);
    if (claims) {
      const box = h('pre', { class: 'jwt', hidden: true }, JSON.stringify(claims, null, 2) + (typeof claims.exp === 'number' ? `\nexpires ${new Date(claims.exp * 1000).toLocaleString()}` : ''));
      acts.append(h('button', { type: 'button', class: 'chipbtn', onclick: () => { box.hidden = !box.hidden; } }, 'JWT'));
      row.append(box);
    }
  }
  const cb = copyBtn(() => get());
  acts.append(cb);
  row.addEventListener('click', e => {
    if ((e.target as HTMLElement).closest('.acts, .jwt')) return;
    if (get()) { copyText(get()); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 500); flashIcon(cb); }
  });
  return row;
}

// ---------- edit ----------
function renderEdit(it: Item) {
  const isNew = !it.id;
  const title = h('input', { value: it.title, placeholder: 'Title', class: 'big', oninput: () => it.title = title.value });
  const folder = h('input', { value: it.folder, placeholder: 'Folder (optional)', list: 'folders', oninput: () => it.folder = folder.value });
  const dl = h('datalist', { id: 'folders' }, ...[...new Set(sums.map(s => s.folder).filter(Boolean))].map(f => h('option', { value: f })));
  const fav = h('input', { type: 'checkbox', checked: it.favorite, onchange: () => it.favorite = fav.checked });
  const notes = h('textarea', { value: it.notes, rows: 4, placeholder: 'Notes', oninput: () => it.notes = notes.value });
  const rows = h('div', { class: 'group edit-fields' });
  const paintRows = () => put(rows, ...it.fields.map((f, i) => {
    const multi = f.kind === 'multiline';
    const val: HTMLInputElement | HTMLTextAreaElement = multi
      ? h('textarea', { value: f.value, rows: 4, class: 'mask', placeholder: 'Value', spellcheck: false, oninput: () => f.value = val.value })
      : h('input', { value: f.value, type: f.kind === 'text' ? 'text' : 'password', placeholder: f.kind === 'totp' ? 'Secret key or otpauth:// link' : 'Value', autocomplete: 'off', spellcheck: false, oninput: () => f.value = val.value });
    const label = h('input', { value: f.label, placeholder: 'Label', oninput: () => f.label = label.value });
    const kind = h('select', { 'aria-label': 'Field type', onchange: () => { f.kind = kind.value as FKind; paintRows(); } },
      ...([['text', 'text'], ['secret', 'secret'], ['multiline', 'long text'], ['totp', 'one-time code']] as [FKind, string][]).map(([k, n]) => h('option', { value: k, selected: k === f.kind }, n)));
    return h('div', { class: 'erow' }, label, val, kind,
      f.kind === 'secret' ? iconBtn('dice', 'Generate a password', () => genDialog(pw => { f.value = pw; paintRows(); })) : null,
      f.kind === 'totp' ? iconBtn('scan', 'Scan a QR code on the screen', async () => {
        try {
          const p = await call<Parsed>('scan_screen'); const a = p.accounts[0];
          if (!a) return toast('No 2FA code found', true);
          f.value = a.uri;
          if (!it.title.trim()) { it.title = a.title; title.value = a.title; }
          const u = it.fields.find(x => x.label === 'Username'); if (u && !u.value) u.value = a.account;
          paintRows(); toast(p.accounts.length > 1 ? `Found ${p.accounts.length} codes and used the first. Use Authenticator > Add or import for several.` : 'Code added. Save to keep it.');
        } catch (e) { err(e); }
      }) : null,
      f.kind !== 'text' ? iconBtn('eye', 'Show or hide', () => { if (val instanceof HTMLInputElement) val.type = val.type === 'password' ? 'text' : 'password'; else val.classList.toggle('mask'); }) : null,
      iconBtn('x', 'Remove field', () => { it.fields.splice(i, 1); paintRows(); }));
  }));
  paintRows();
  const del = !isNew && h('button', { type: 'button', class: 'danger', onclick: async () => {
    try { await call('delete_item', { id: it.id }); sel = null; editing = null; await reload(); toast('Moved to the trash'); } catch (e) { err(e); }
  } }, icon('trash'), h('span', {}, 'Delete'));
  const form = h('form', { class: 'edit', onsubmit: async (ev: Event) => {
    ev.preventDefault();
    try { const id = await call<string>('save_item', { item: { ...it, fields: it.fields.filter(f => f.label.trim() || f.value) } }); sel = id; editing = null; await reload(); toast('Saved'); }
    catch (e) { err(e); }
  } },
    h('h2', {}, isNew ? `New ${KINDS[it.kind].label.toLowerCase()}` : 'Edit item'), title, folder, dl, h('label', { class: 'chk' }, fav, ' Favorite'), rows,
    h('button', { type: 'button', class: 'ghost', onclick: () => { it.fields.push(F('')); paintRows(); } }, icon('plus'), h('span', {}, 'Add field')), notes,
    h('div', { class: 'btns' }, h('button', { class: 'primary', type: 'submit' }, 'Save'), h('button', { type: 'button', onclick: () => { editing = null; renderDetail(); } }, 'Cancel'), del));
  put(detailEl, form);
  title.focus();
}

// ---------- authenticator ----------
async function renderAuth() {
  const search = h('input', { type: 'search', placeholder: 'Filter codes', oninput: () => apply() });
  const grid = h('div', { class: 'authgrid' });
  put(detailEl, h('div', { class: 'secwrap' },
    h('div', { class: 'head' }, h('div', { class: 'ttl' }, h('h2', {}, 'Authenticator'), h('small', { class: 'hint' }, 'Click a code to copy it')),
      h('div', { class: 'acts' }, h('button', { class: 'primary', onclick: twofaDialog }, icon('scan'), h('span', {}, 'Add or import')))),
    h('div', { class: 'search auth' }, icon('search'), search), grid));
  const cards = new Map<string, { el: HTMLElement; code: HTMLElement; ring: ReturnType<typeof ringEl>; cur: string }>();
  let sig = '#';
  const apply = () => { const q = search.value.toLowerCase(); cards.forEach(c => { c.el.hidden = !!q && !c.el.dataset.q!.includes(q); }); };
  const fmt = (c: string) => `${c.slice(0, c.length / 2)} ${c.slice(c.length / 2)}`;
  const tick = async () => {
    let live: Live[];
    try { live = await call<Live[]>('totp_all'); } catch { return; }
    if (filter !== 'auth' || !grid.isConnected) return;
    const keys = live.map((l, i) => `${l.id}:${i}`);
    if (keys.join('|') !== sig) {
      sig = keys.join('|'); cards.clear();
      put(grid, ...(live.length ? live.map((l, i) => {
        const code = h('span', { class: 'code' }), ring = ringEl(), c = { el: null as unknown as HTMLElement, code, ring, cur: '' };
        c.el = h('button', { class: 'acard', 'data-q': `${l.title} ${l.sub}`.toLowerCase(), onclick: () => { if (c.cur) { copyText(c.cur); c.el.classList.add('flash'); setTimeout(() => c.el.classList.remove('flash'), 500); } } },
          avatar('login', l.title), h('div', { class: 't' }, h('b', {}, l.title), h('small', {}, l.sub || l.label)), code, ring.el,
          h('span', { class: 'go', title: 'Open item', onclick: (e: Event) => { e.stopPropagation(); openItem(l.id); } }, icon('edit')));
        cards.set(keys[i], c);
        return c.el;
      }) : [h('div', { class: 'empty' }, icon('timer', 'big'), h('p', {}, 'No one-time codes yet.'), h('button', { class: 'primary', onclick: twofaDialog }, 'Add or import codes'))]));
      apply();
    }
    live.forEach((l, i) => { const c = cards.get(keys[i]); if (!c) return; c.cur = l.code; c.code.textContent = fmt(l.code); c.ring.set(l.left, l.period); c.el.classList.toggle('low', l.left <= 5); });
  };
  tick(); ticks.push(window.setInterval(tick, 1000));
}

const b64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej('could not read the file'); r.readAsDataURL(f); });

function twofaDialog() {
  const out = h('div', { class: 'found' });
  const run = async (fn: () => Promise<Parsed>, btn?: HTMLElement) => {
    btn?.classList.add('busy'); (btn as HTMLButtonElement | undefined)?.setAttribute('disabled', '');
    try { found(await fn()); } catch (e) { err(e); }
    btn?.classList.remove('busy'); btn?.removeAttribute('disabled');
  };
  const fromFile = (f: File) => run(async () => call<Parsed>('scan_image', { data: await b64(f) }));
  const found = (p: Parsed) => {
    const logins = sums.filter(s => !s.deleted && s.kind === 'login');
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
          } else fresh.push({ id: '', kind: 'login', title: r.a.title, folder: '', fields: [F('Username', 'text', r.a.account), F('One-time code', 'totp', r.a.uri)], notes: '', favorite: false, updated: 0, history: [], deleted: 0 });
        }
        const added = fresh.length ? await call<number>('import_items', { items: fresh }) : 0;
        await reload();
        toast([added && `${added} added`, merged && `${merged} updated`, (same + fresh.length - added) && `${same + fresh.length - added} already there`].filter(Boolean).join(', ') || 'Nothing to add');
        document.querySelector('dialog.twofa')?.remove();
      } catch (e) { err(e); add.removeAttribute('disabled'); }
    });
    put(out, h('div', { class: 'group' }, ...rows.map(r => r.el)), p.skipped ? h('p', { class: 'hint' }, `${p.skipped} entr${p.skipped === 1 ? 'y was' : 'ies were'} skipped (counter-based codes are not supported, or the data was unreadable).`) : null,
      h('p', { class: 'hint' }, 'Delete any screenshot of an export QR code afterwards: it contains every secret.'), add);
    refresh();
  };
  const imgIn = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => { const f = imgIn.files?.[0]; if (f) fromFile(f); imgIn.value = ''; } });
  const txt = h('textarea', { rows: 3, placeholder: '…or paste otpauth:// or otpauth-migration:// links here', spellcheck: false });
  const screen = h('button', { class: 'primary', onclick: () => run(() => call<Parsed>('scan_screen'), screen) }, icon('scan'), h('span', {}, 'Scan my screen'));
  const d = dialog(close => [h('h3', {}, 'Import 2FA codes'),
    h('p', { class: 'hint' }, 'Works with Google Authenticator (menu > Transfer accounts > Export), the QR code a site shows when you turn on 2FA, and text links.'),
    h('div', { class: 'btns' }, screen, h('button', { onclick: () => imgIn.click() }, icon('upload'), h('span', {}, 'Open QR image…')), imgIn),
    h('p', { class: 'hint' }, 'Vault hides itself while scanning, so show the QR code first. A screenshot from your phone works too: open the image here or press Ctrl+V to paste it.'),
    txt, h('button', { onclick: () => txt.value.trim() && run(async () => { const p = await call<Parsed>('parse_2fa', { text: txt.value }); if (!p.accounts.length && !p.skipped) throw 'No 2FA links found in that text.'; return p; }) }, 'Read pasted text'),
    out, h('button', { onclick: close }, 'Close')], 'twofa');
  d.addEventListener('paste', e => {
    const f = [...(e.clipboardData?.files ?? [])].find(x => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); fromFile(f); }
  });
}

// ---------- security center ----------
async function renderSecurity() {
  put(detailEl, h('p', { class: 'hint pad' }, 'Checking your passwords…'));
  let a: Audit;
  try { a = await call<Audit>('security_audit'); } catch (e) { return err(e); }
  if (filter !== 'security') return;
  const open = openItem;
  const section = (title: string, ic: string, refs: Ref[], tip: string) => h('section', { class: 'sect' },
    h('h3', {}, icon(ic), ` ${title} `, h('span', { class: 'n' }, String(refs.length))),
    refs.length ? h('div', { class: 'group' }, ...refs.map(r => h('button', { class: 'row flat', onclick: () => open(r.id) }, h('div', { class: 't' }, h('b', {}, r.title), h('small', {}, r.note)), icon('edit')))) : h('p', { class: 'hint ok' }, icon('check'), ' ' + tip));
  const ring = fromHtml(`<svg class="score" viewBox="0 0 120 120"><circle class="bg" cx="60" cy="60" r="52"/><circle class="fg ${a.score >= 80 ? 'strong' : a.score >= 50 ? 'fair' : 'weak'}" cx="60" cy="60" r="52"/><text x="60" y="68" text-anchor="middle">${a.score}</text></svg>`);
  (ring.querySelector('.fg') as SVGElement).style.strokeDashoffset = String(326.7 * (1 - a.score / 100));
  const breaches = h('div', { class: 'sect' });
  const runBreach = h('button', { class: 'primary' }, icon('globe'), h('span', {}, 'Check for breached passwords'));
  runBreach.addEventListener('click', async () => {
    runBreach.disabled = true; runBreach.classList.add('busy');
    try {
      const found = await call<Ref[]>('breach_check');
      put(breaches, h('h3', {}, icon('alert'), ' Found in known breaches ', h('span', { class: 'n' }, String(found.length))),
        found.length ? h('div', { class: 'group' }, ...found.map(r => h('button', { class: 'row flat', onclick: () => open(r.id) }, h('div', { class: 't' }, h('b', {}, r.title), h('small', {}, r.note)), icon('edit')))) : h('p', { class: 'hint ok' }, icon('check'), ' None of your passwords were found.'));
    } catch (e) { err(e); runBreach.disabled = false; runBreach.classList.remove('busy'); }
  });
  put(breaches, h('h3', {}, icon('globe'), ' Breach check'), h('p', { class: 'hint' }, 'Optional and online. Only the first 5 characters of a hash of each password are sent to haveibeenpwned.com; your passwords never leave this PC.'), runBreach);
  put(detailEl, h('div', { class: 'secwrap' },
    h('div', { class: 'sechead' }, ring, h('div', {}, h('h2', {}, 'Security center'), h('p', { class: 'hint' }, a.total ? `${a.total} login${a.total === 1 ? '' : 's'} checked on this PC.` : 'Add logins to see how healthy your passwords are.'))),
    section('Weak passwords', 'alert', a.weak, 'No weak passwords.'), section('Reused passwords', 'copy', a.reused, 'No reused passwords.'),
    section('Old passwords', 'clock', a.old, 'Nothing older than a year.'), section('Sites without HTTPS', 'globe', a.insecure, 'Every saved site uses HTTPS.'), breaches));
}

// ---------- dialogs ----------
function dialog(content: (close: () => void) => (Node | null | false)[], cls = '') {
  const d = h('dialog', { class: cls });
  const close = () => { d.close(); d.remove(); };
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', e => { if (e.target === d) close(); });
  d.append(h('div', { class: 'dlg' }, ...(content(close).filter(Boolean) as Node[])));
  document.body.append(d);
  d.showModal();
  return d;
}

function newItem(k: Kind) {
  sel = null;
  if (['security', 'trash', 'auth'].includes(filter)) go('all');
  editing = { id: '', kind: k, title: '', folder: filter.startsWith('folder:') ? filter.slice(7) : '', fields: TEMPLATES[k](), notes: '', favorite: false, updated: 0, history: [], deleted: 0 };
  renderList(); renderDetail();
}

function newDialog() {
  dialog(close => [h('h3', {}, 'New item'), h('div', { class: 'tiles' },
    ...KIND_ORDER.map(k => h('button', { class: 'tile', onclick: () => { close(); newItem(k); } }, icon(KINDS[k].icon), h('span', {}, h('b', {}, KINDS[k].label), h('small', {}, KINDS[k].desc))))),
    h('button', { onclick: close }, 'Cancel')]);
}

let genOpts = { len: 20, lower: true, upper: true, digits: true, symbols: true };
function genDialog(use?: (pw: string) => void) {
  const m = meter();
  const out = h('input', { readOnly: true, class: 'mono' });
  const run = async () => { try { out.value = await call<string>('generate', genOpts); m.update(out.value); } catch (e) { out.value = ''; err(e); } };
  const lab = h('label', {}, `Length ${genOpts.len}`);
  const len = h('input', { type: 'range', min: 8, max: 64, value: genOpts.len, oninput: () => { genOpts.len = +len.value; lab.textContent = `Length ${genOpts.len}`; run(); } });
  const box = (k: 'lower' | 'upper' | 'digits' | 'symbols', text: string) => {
    const c = h('input', { type: 'checkbox', checked: genOpts[k], onchange: () => { genOpts[k] = c.checked; run(); } });
    return h('label', { class: 'chk' }, c, ' ' + text);
  };
  dialog(close => [h('h3', {}, 'Password generator'), out, m.el, lab, len, h('div', { class: 'opts' }, box('lower', 'a-z'), box('upper', 'A-Z'), box('digits', '0-9'), box('symbols', 'Symbols')),
    h('div', { class: 'btns' }, h('button', { onclick: run }, icon('restore'), h('span', {}, 'Regenerate')), h('button', { onclick: () => out.value && copyText(out.value) }, icon('copy'), h('span', {}, 'Copy')),
      use ? h('button', { class: 'primary', onclick: () => { if (out.value) { use(out.value); close(); } } }, 'Use') : null, h('button', { onclick: close }, 'Close'))]);
  run();
}

function masterDialog() {
  const a = pwField('m0', 'Current master password'), b = pwField('m1', 'New master password (10+ characters)'), c = pwField('m2', 'Repeat new password');
  const m = meter();
  b.input.addEventListener('input', () => m.update(b.input.value));
  const msg = h('p', { class: 'hint' }, 'Older backups in the Vault folder still open with the old password.');
  dialog(close => [h('h3', {}, 'Change master password'), a.wrap, b.wrap, m.el, c.wrap, msg,
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: async () => {
      if (b.input.value !== c.input.value) { msg.textContent = 'The new passwords differ.'; return; }
      try { await call('change_password', { oldPassword: a.input.value, newPassword: b.input.value }); close(); toast('Master password changed'); } catch (e) { msg.textContent = String(e); }
    } }, 'Change'), h('button', { onclick: close }, 'Cancel'))]);
}

async function settingsDialog() {
  const dir = await call<string>('backup_dir');
  const { quick } = await call<{ quick: boolean }>('status');
  const choose = (label: string, opts: [number, string][], cur: number, set: (v: number) => void) => {
    const s = h('select', { onchange: async () => { set(+s.value); try { await call('set_settings', { settings }); resetIdle(); toast('Saved'); } catch (e) { err(e); } } },
      ...opts.map(([v, n]) => h('option', { value: String(v), selected: v === cur }, n)));
    return h('label', { class: 'setrow' }, h('span', {}, label), s);
  };
  dialog(close => [h('h3', {}, 'Settings'),
    choose('Lock after being idle', [[1, '1 minute'], [2, '2 minutes'], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [0, 'Never']], settings.autolock_min, v => settings.autolock_min = v),
    choose('Clear the clipboard after', [[10, '10 seconds'], [20, '20 seconds'], [30, '30 seconds'], [60, '1 minute'], [0, 'Never']], settings.clip_secs, v => settings.clip_secs = v),
    (() => {
      const c = h('input', { type: 'checkbox', checked: quick, id: 'quickbox', onchange: async () => {
        try { await call(c.checked ? 'quick_enable' : 'quick_disable'); toast(c.checked ? 'Vault will open automatically on this PC' : 'Vault will ask for the master password'); } catch (e) { c.checked = !c.checked; err(e); }
      } });
      return h('label', { class: 'chk stay' }, c, h('span', {}, 'Unlock automatically on this PC', h('small', {}, 'Opens straight into the vault when you start the app, and the lock screen needs one click. Anyone using this Windows account can open it.')));
    })(),
    h('div', { class: 'setrow col2' }, h('span', {}, 'Automatic backups (one per day, newest 14)'), h('code', {}, dir), h('button', { onclick: () => call('open_backups').catch(err) }, icon('folder'), h('span', {}, 'Open backup folder'))),
    h('button', { onclick: async () => {
      const path = await save({ defaultPath: 'vault-backup.bin', filters: [{ name: 'Vault backup', extensions: ['bin'] }] });
      if (path) { try { await call('export_backup', { path }); toast('Encrypted backup saved'); } catch (e) { err(e); } }
    } }, icon('upload'), h('span', {}, 'Export encrypted backup…')),
    h('div', { class: 'keys' }, h('b', {}, 'Shortcuts'), ...([['Ctrl+Alt+K', 'Quick find from anywhere'], ['Ctrl+K', 'Quick find'], ['Ctrl+N', 'New item'], ['Ctrl+Shift+C', 'Copy password'], ['Ctrl+Shift+U', 'Copy username'], ['Ctrl+Shift+T', 'Copy one-time code'], ['Ctrl+L', 'Lock'], ['/', 'Search'], ['↑ ↓', 'Browse the list']] as [string, string][]).map(([k, d]) => h('div', {}, h('kbd', {}, k), h('span', {}, d)))),
    h('button', { onclick: close }, 'Close')]);
}

// ---------- quick find ----------
function palette() {
  if (!mainActive || document.querySelector('dialog.pal')) return;
  type Entry = { label: string; sub: string; ic: string; run: () => void; pw?: () => void };
  const open = openItem;
  const actions: Entry[] = [
    { label: 'New login', sub: 'Action', ic: 'plus', run: () => newItem('login') }, { label: 'Password generator', sub: 'Action', ic: 'dice', run: () => genDialog() },
    { label: 'Authenticator codes', sub: 'Action', ic: 'timer', run: () => go('auth') }, { label: 'Import 2FA codes', sub: 'Action', ic: 'scan', run: twofaDialog },
    { label: 'Security center', sub: 'Action', ic: 'shieldcheck', run: () => go('security') }, { label: 'Settings', sub: 'Action', ic: 'settings', run: settingsDialog }, { label: 'Lock vault', sub: 'Action', ic: 'lock', run: lockNow }];
  const q = h('input', { placeholder: 'Search items or type a command…', autocomplete: 'off', spellcheck: false });
  const res = h('div', { class: 'pres' });
  let list: Entry[] = [], cur = 0;
  const draw = () => {
    const t = q.value.toLowerCase();
    const items: Entry[] = sums.filter(s => !s.deleted && (!t || [s.title, s.sub, s.folder].some(x => x.toLowerCase().includes(t)))).sort((a, b) => a.title.localeCompare(b.title)).slice(0, 7).map(s => ({
      label: s.title, sub: s.sub || KINDS[s.kind].label, ic: KINDS[s.kind].icon, run: () => open(s.id),
      pw: async () => { const it = await call<Item>('get_item', { id: s.id }); const p = it.fields.find(f => f.label === 'Password')?.value; if (p) copyText(p); else toast('This item has no password', true); } }));
    list = [...items, ...actions.filter(a => !t || a.label.toLowerCase().includes(t))];
    cur = Math.min(cur, Math.max(0, list.length - 1));
    put(res, ...(list.length ? list.map((e, i) => h('button', { class: 'pr' + (i === cur ? ' on' : ''), onclick: () => { d.remove(); e.run(); }, onmousemove: () => { if (cur !== i) { cur = i; res.querySelectorAll('.pr').forEach((x, j) => x.classList.toggle('on', j === cur)); } } },
      icon(e.ic), h('b', {}, e.label), h('small', {}, e.sub))) : [h('p', { class: 'hint pad' }, 'Nothing found.')]));
  };
  const d = dialog(() => [q, res, h('small', { class: 'hint pfoot' }, 'Enter opens · Ctrl+Enter copies the password · Esc closes')], 'pal');
  q.addEventListener('input', () => { cur = 0; draw(); });
  q.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(0, Math.min(list.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1))); draw(); res.querySelector('.pr.on')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter' && list[cur]) { e.preventDefault(); const en = list[cur]; d.remove(); if (e.ctrlKey && en.pw) en.pw(); else en.run(); }
  });
  draw(); q.focus();
}

async function copyField(label: string) {
  if (!sel || editing) return;
  try { const it = await call<Item>('get_item', { id: sel }); const v = it.fields.find(f => f.label === label)?.value; if (v) copyText(v); else toast(`This item has no ${label.toLowerCase()}`, true); } catch (e) { err(e); }
}

async function copyCode() {
  if (!sel || editing) return;
  try {
    const t = (await call<Item>('get_item', { id: sel })).fields.find(f => f.kind === 'totp' && f.value);
    if (!t) return toast('This item has no one-time code', true);
    await copyText((await call<{ code: string }>('totp', { secret: t.value })).code);
  } catch (e) { err(e); }
}

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  if (!mainActive) return;
  const k = e.key.toLowerCase();
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName);
  const modal = !!document.querySelector('dialog[open]');
  if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'k') { e.preventDefault(); palette(); }
  else if (modal) return;
  else if (e.ctrlKey && !e.shiftKey && k === 'n') { e.preventDefault(); newDialog(); }
  else if (e.ctrlKey && !e.shiftKey && k === 'l') { e.preventDefault(); lockNow(); }
  else if (e.ctrlKey && e.shiftKey && k === 'c') { e.preventDefault(); copyField('Password'); }
  else if (e.ctrlKey && e.shiftKey && k === 'u') { e.preventDefault(); copyField('Username'); }
  else if (e.ctrlKey && e.shiftKey && k === 't') { e.preventDefault(); copyCode(); }
  else if (e.key === '/' && !typing) { e.preventDefault(); searchEl.focus(); searchEl.select(); }
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (!typing || e.target === searchEl)) { e.preventDefault(); moveSel(e.key === 'ArrowDown' ? 1 : -1); }
  else if (e.key === 'Escape') {
    if (editing) { editing = null; renderDetail(); }
    else if (query) { query = ''; searchEl.value = ''; renderList(true); }
  }
});
for (const ev of ['mousemove', 'keydown', 'click']) document.addEventListener(ev, () => { if (mainActive) resetIdle(); }, { passive: true });
listen('quick-search', () => palette());

showLock(true).catch(e => { app.textContent = String(e); });
