import { listen } from '@tauri-apps/api/event';
import './style.css';
import './updater';
import {
  Audit, CATEGORY_COLORS, DOC_TYPES, F, Field, FKind, Item, KIND_ORDER, KINDS, Kind, Live, Ref, Settings, Sum, TEMPLATES, Template, ago, applyTheme, avatar, call, chip, copyBtn, copyText, dialog,
  err, flashIcon, fromHtml, h, hooks, hue, icon, iconBtn, isImage, meter, put, pwField, S, toast,
} from './kit';
import {
  ask, attachFiles, attachmentTile, confirmDialog, forgotDialog, genDialog, restoreDialog, masterDialog, newDialog, photoDialog, saveSettings, searchHelp, settingsDialog, shareDialog, twofaDialog, versionsDialog,
} from './dialogs';
import { Block, Inl, parse as parseMd, toggleLine } from './md';

void masterDialog;
const app = document.getElementById('app')!;
let ticks: number[] = [];
let idleTimer = 0;
let searchTimer = 0;
let layoutEl: HTMLElement, listEl: HTMLElement, detailEl: HTMLElement, navEl: HTMLElement, searchEl: HTMLInputElement, bulkEl: HTMLElement;
let sortBy = 'name';
const navOpen = (k: string, d = true) => { try { const v = localStorage.getItem('nav-' + k); return v === null ? d : v === '1'; } catch { return d; } };
const setNavOpen = (k: string, v: boolean) => { try { localStorage.setItem('nav-' + k, v ? '1' : '0'); } catch { /* storage unavailable */ } };

const SMART: [string, string, string][] = [['flag:weak', 'Weak passwords', 'alert'], ['flag:reused', 'Reused passwords', 'copy'], ['flag:old', 'Old passwords', 'clock'], ['flag:http', 'No HTTPS', 'globe'], ['flag:nopass', 'No password', 'key'],
  ['flag:notp', 'No 2FA code', 'timer'], ['flag:expiring', 'Expiring or expired', 'clock'], ['flag:dup', 'Duplicates', 'copy'], ['flag:files', 'With photos or files', 'clip']];

// ---------- lock screen ----------
async function showLock(auto = false) {
  S.mainActive = false;
  clearTimeout(idleTimer);
  ticks.forEach(clearInterval); ticks = [];
  S.sums = []; S.vis = []; S.sel = null; S.editing = null; S.filter = 'all'; S.query = ''; S.qids = null; S.bulk = false; S.picked.clear(); S.pending = [];
  document.querySelectorAll('dialog').forEach(d => d.remove());
  const { exists, quick, recovery } = await call<{ exists: boolean; quick: boolean; recovery: boolean }>('status');
  if (auto && exists && quick) { // startup with "stay signed in": straight into the vault
    try { await call('quick_unlock'); return await showMain(); } catch { /* fall back to the password screen */ }
  }
  const pw = pwField('pw1', exists ? (quick ? 'or type your master password' : 'Master password') : 'Choose a master password (10+ characters)');
  const pw2 = exists ? null : pwField('pw2', 'Repeat master password');
  const m = exists ? null : meter();
  pw.input.addEventListener('input', () => m?.update(pw.input.value));
  const msg = h('p', { class: 'hint', id: 'msg' }, exists ? '' : 'There is no way to recover this password unless you create a recovery key later. Write it down somewhere safe.');
  const btn = h('button', { type: 'submit', class: 'primary big' }, exists ? 'Unlock' : 'Create vault');
  const stay = quick ? null : h('input', { type: 'checkbox', id: 'stay', checked: !exists });
  const stayRow = stay && h('label', { class: 'chk stay' }, stay, h('span', {}, exists ? 'Stay signed in on this PC' : 'Unlock automatically on this PC', h('small', {}, 'Uses your Windows sign-in to protect the key, so anyone using this Windows account can open the vault. You can turn it off in Settings.')));
  const form = h('form', { class: 'card lock' },
    h('div', { class: 'logo' }, icon('shield')), h('h1', {}, 'Vault'),
    h('p', { class: 'sub' }, exists ? 'Enter your master password to unlock.' : 'Create your vault. Everything stays encrypted on this PC.'),
    quick ? btn : pw.wrap, pw2?.wrap, m?.el, stayRow, quick ? pw.wrap : btn, msg,
    exists && recovery ? h('button', { type: 'button', class: 'linkbtn', onclick: () => forgotDialog(() => showMain()) }, 'Forgot your master password?') : null,
    exists ? null : h('button', { type: 'button', class: 'linkbtn', onclick: () => restoreDialog(() => showLock(false)) }, 'Already use Vault? Restore from my server'));
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
    } catch (e) {
      msg.textContent = String(e); btn.disabled = false; btn.classList.remove('busy');
      form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
    }
  });
  put(app, h('div', { class: 'center' }, h('i', { class: 'orb a' }), h('i', { class: 'orb b' }), h('i', { class: 'orb c' }), form));
  (quick ? btn : pw.input).focus();
}

// ---------- main screen ----------
function resetIdle() {
  clearTimeout(idleTimer);
  if (S.settings.autolock_min > 0) idleTimer = window.setTimeout(lockNow, S.settings.autolock_min * 60000);
}
async function lockNow() { await call('lock'); await showLock(false); }

async function showMain() {
  S.settings = await call<Settings>('get_settings');
  applyTheme();
  searchEl = h('input', { type: 'search', placeholder: 'Search   ( / )', 'aria-label': 'Search', oninput: () => { S.query = searchEl.value; clearTimeout(searchTimer); searchTimer = window.setTimeout(runSearch, 70); } });
  navEl = h('nav');
  listEl = h('div', { class: 'list' });
  bulkEl = h('div', { class: 'bulkbar', hidden: true });
  detailEl = h('main', { class: 'detail' });
  const importInput = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, onchange: async () => {
    const f = importInput.files?.[0]; if (!f) return;
    try { const n = await call<number>('import_csv', { text: await f.text() }); toast(`Imported ${n} item${n === 1 ? '' : 's'}. Delete the CSV file now: it holds your passwords in plain text.`); await reload(); }
    catch (e) { err(e); }
    importInput.value = '';
  } });
  const sort = h('select', { 'aria-label': 'Sort', title: 'Sort', onchange: () => { sortBy = sort.value; renderList(true); } },
    h('option', { value: 'name' }, 'A–Z'), h('option', { value: 'recent' }, 'Recent'), h('option', { value: 'category' }, 'Category'), h('option', { value: 'kind' }, 'Type'));
  const side = (name: string, label: string, fn: () => void) => h('button', { class: 'side', onclick: fn }, icon(name), h('span', {}, label));
  layoutEl = h('div', { class: 'layout' },
    h('aside', {}, h('div', { class: 'brand' }, h('div', { class: 'logo sm' }, icon('shield')), h('b', {}, 'Vault')), navEl, h('div', { class: 'grow' }),
      side('cmd', 'Quick find', palette), side('dice', 'Generator', () => genDialog()), side('upload', 'Import CSV', () => importInput.click()),
      side('settings', 'Settings', settingsDialog), side('lock', 'Lock', lockNow), importInput),
    h('section', { class: 'col' },
      h('div', { class: 'bar' }, h('div', { class: 'search' }, icon('search'), searchEl, iconBtn('hash', 'Search tips', searchHelp, 'tipbtn')), h('button', { class: 'primary', onclick: () => newDialog(newItem) }, icon('plus'), h('span', {}, 'New'))),
      h('div', { class: 'bar sub' }, sort, h('button', { class: 'ghost sm', id: 'selbtn', onclick: () => { S.bulk = !S.bulk; S.picked.clear(); renderList(); } }, icon('checksq'), h('span', {}, 'Select'))),
      listEl, bulkEl),
    detailEl);
  put(app, layoutEl);
  S.mainActive = true;
  resetIdle();
  await reload();
  try {
    const a = await call<Audit>('security_audit');
    if (a.expiring.length) toast(`${a.expiring.length} item${a.expiring.length === 1 ? ' is' : 's are'} expiring or expired: ${a.expiring.slice(0, 2).map(r => r.title).join(', ')}${a.expiring.length > 2 ? '…' : ''}`, true);
  } catch { /* nothing to warn about */ }
  if (S.settings.check_updates) hooks.checkUpdate(false);
}

async function reload() {
  try { S.sums = await call<Sum[]>('list'); } catch (e) { err(e); return; }
  await runSearch(false);
  renderNav(); renderList(); renderDetail();
}

async function runSearch(redraw = true) {
  if (S.query.trim()) { try { S.qids = await call<string[]>('search', { query: S.query, trash: S.filter === 'trash' }); } catch { S.qids = null; } } else S.qids = null;
  if (redraw) { renderList(true); renderNav(); }
}

function matches(s: Sum, f: string) {
  if (f === 'all') return true;
  if (f === 'fav') return s.favorite;
  if (f.startsWith('kind:')) return s.kind === f.slice(5);
  if (f.startsWith('folder:')) return s.folder === f.slice(7);
  if (f.startsWith('tag:')) return s.tags.includes(f.slice(4));
  if (f.startsWith('cat:')) return s.category === f.slice(4);
  if (f.startsWith('flag:')) return s.flags.includes(f.slice(5));
  return false;
}

function go(key: string) {
  S.filter = key; S.sel = null; S.editing = null; S.pending = [];
  layoutEl.classList.toggle('wide', key === 'security' || key === 'auth');
  runSearch(false).then(() => { renderNav(); renderList(true); renderDetail(); });
}
hooks.go = go; hooks.reload = reload; hooks.renderDetail = () => renderDetail(); hooks.renderList = a => renderList(a); hooks.renderNav = () => renderNav(); hooks.lockNow = lockNow; hooks.resetIdle = resetIdle;

function renderNav() {
  const alive = S.sums.filter(s => !s.deleted);
  const n = (f: string) => alive.filter(s => matches(s, f)).length;
  const entry = (key: string, label: string, ic: string, count: number | string = '', badge = false, color?: string) => {
    const b = h('button', { class: key === S.filter ? 'nav on' : 'nav', onclick: () => go(key) }, icon(ic), h('span', { class: 'lbl' }, label), count !== '' && h('span', { class: badge ? 'n badge' : 'n' }, String(count)));
    if (color) b.style.setProperty('--kc', color);
    return b;
  };
  const group = (id: string, title: string, items: Node[], def = true) => items.length ? h('details', { class: 'ngroup', open: navOpen(id, def), ontoggle: (e: Event) => setNavOpen(id, (e.target as HTMLDetailsElement).open) }, h('summary', {}, title), ...items) : null;
  const folders = [...new Set(alive.map(s => s.folder).filter(Boolean))].sort();
  const tags = [...new Set(alive.flatMap(s => s.tags))].sort();
  const cats = [...new Set(alive.map(s => s.category))].sort();
  const smart = SMART.filter(([k]) => n(k) > 0 || k === S.filter);
  put(navEl,
    entry('all', 'All items', 'grid', alive.length), entry('fav', 'Favorites', 'star', n('fav')),
    group('types', 'Types', KIND_ORDER.filter(k => n('kind:' + k) > 0 || ['login', 'card', 'note'].includes(k)).map(k => entry('kind:' + k, KINDS[k].plural, KINDS[k].icon, n('kind:' + k), false, KINDS[k].color))),
    group('smart', 'Smart filters', smart.map(([k, l, i]) => entry(k, l, i, n(k), ['flag:weak', 'flag:reused', 'flag:expiring'].includes(k)))),
    group('cats', 'Categories', cats.map(c => entry('cat:' + c, c, 'hash', n('cat:' + c), false, CATEGORY_COLORS[c])), false),
    group('folders', 'Folders', folders.map(f => entry('folder:' + f, f, 'folder', n('folder:' + f))), false),
    group('tags', 'Tags', tags.map(t => entry('tag:' + t, t, 'tag', n('tag:' + t))), false),
    group('tools', 'Tools', [entry('auth', 'Authenticator', 'timer'), entry('security', 'Security center', 'shieldcheck'), entry('trash', 'Trash', 'trash', S.sums.filter(s => s.deleted).length || '')]));
}

const SORTS: Record<string, (a: Sum, b: Sum) => number> = {
  name: (a, b) => a.title.localeCompare(b.title),
  recent: (a, b) => b.updated - a.updated || a.title.localeCompare(b.title),
  category: (a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title),
  kind: (a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title),
};

function renderList(animate = false) {
  if (S.filter === 'security' || S.filter === 'auth') return;
  const inTrash = S.filter === 'trash';
  let rows = S.sums.filter(s => inTrash ? s.deleted : !s.deleted && matches(s, S.filter));
  if (S.qids) { const order = new Map(S.qids.map((id, i) => [id, i])); rows = rows.filter(s => order.has(s.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!); }
  else rows.sort(SORTS[sortBy]);
  S.vis = rows;
  listEl.className = 'list' + (animate ? ' enter' : '');
  document.getElementById('selbtn')?.classList.toggle('on', S.bulk);
  renderBulk();
  if (!rows.length) {
    const none = S.sums.length === 0;
    return put(listEl, h('div', { class: 'empty small' }, icon(inTrash ? 'trash' : 'shield', 'big'),
      h('p', {}, inTrash ? 'The trash is empty.' : none ? 'Your vault is empty.' : S.query ? 'Nothing matches that search.' : 'Nothing here.'),
      none && !inTrash ? h('button', { class: 'primary', onclick: () => newDialog(newItem) }, 'Add your first item') : null));
  }
  put(listEl, inTrash ? h('div', { class: 'trashbar' }, h('small', {}, 'Items are deleted for good after 30 days.'), h('button', { class: 'danger', onclick: emptyTrash }, 'Empty trash')) : null,
    ...rows.map((s, i) => {
      const warn = s.flags.includes('weak') || s.flags.includes('reused') ? icon('alert', 'warn') : null;
      const r = h('button', { class: 'row' + (s.id === S.sel && !S.bulk ? ' on' : '') + (S.picked.has(s.id) ? ' picked' : ''), 'data-id': s.id, onclick: () => {
        if (S.bulk) { S.picked.has(s.id) ? S.picked.delete(s.id) : S.picked.add(s.id); renderList(); return; }
        S.sel = s.id; S.editing = null; markSel(); renderDetail();
      } },
        S.bulk ? h('span', { class: 'cb' + (S.picked.has(s.id) ? ' on' : '') }, S.picked.has(s.id) ? icon('check') : null) : null,
        avatar(s.kind, s.title), h('div', { class: 't' }, h('b', {}, s.title), h('small', {}, s.sub || s.domain || KINDS[s.kind]?.label || '')),
        warn, s.files ? icon('clip', 'dim') : null, s.favorite ? icon('star', 'fav') : null);
      r.style.setProperty('--i', String(Math.min(i, 12)));
      r.style.setProperty('--kc', KINDS[s.kind]?.color ?? '#9aa4b8');
      return r;
    }));
}

function renderBulk() {
  bulkEl.hidden = !S.bulk;
  if (!S.bulk) return;
  const ids = [...S.picked], inTrash = S.filter === 'trash';
  const act = async (op: string, value = '', msg = 'Done') => { if (!ids.length) return; try { const n = await call<number>('bulk', { ids, op, value }); S.picked.clear(); await reload(); toast(`${msg} (${n})`); } catch (e) { err(e); } };
  put(bulkEl, h('b', {}, `${ids.length} selected`),
    h('button', { class: 'ghost sm', onclick: () => { S.vis.forEach(s => S.picked.add(s.id)); renderList(); } }, 'All'),
    inTrash ? h('button', { class: 'sm', disabled: !ids.length, onclick: () => act('restore', '', 'Restored') }, icon('restore'), h('span', {}, 'Restore')) : h('button', { class: 'sm', disabled: !ids.length, title: 'Add to favorites', onclick: () => act('favorite', '', 'Favorited') }, icon('star')),
    !inTrash ? h('button', { class: 'sm', disabled: !ids.length, title: 'Move to a folder', onclick: async () => { const f = await ask('Move to folder', 'Folder name', '', 'Move', 'Leave empty to take them out of any folder.'); if (f !== null) act('folder', f, 'Moved'); } }, icon('folder')) : null,
    !inTrash ? h('button', { class: 'sm', disabled: !ids.length, title: 'Add a tag', onclick: async () => { const t = await ask('Add a tag', 'Tag', '', 'Add'); if (t) act('tag', t, 'Tagged'); } }, icon('tag')) : null,
    !inTrash ? h('button', { class: 'sm danger', disabled: !ids.length, title: 'Move to the trash', onclick: () => act('trash', '', 'Moved to the trash') }, icon('trash')) : null,
    h('button', { class: 'sm', onclick: () => { S.bulk = false; S.picked.clear(); renderList(); } }, 'Done'));
}

function markSel() {
  listEl.querySelectorAll<HTMLElement>('.row').forEach(r => r.classList.toggle('on', r.dataset.id === S.sel));
  listEl.querySelector('.row.on')?.scrollIntoView({ block: 'nearest' });
}

function moveSel(d: number) {
  if (!S.vis.length || S.editing || S.bulk) return;
  const i = S.vis.findIndex(s => s.id === S.sel);
  S.sel = S.vis[Math.max(0, Math.min(S.vis.length - 1, i < 0 ? (d > 0 ? 0 : S.vis.length - 1) : i + d))].id;
  markSel(); renderDetail();
}

async function emptyTrash() {
  if (!await confirmDialog('Empty the trash?', 'These items and their files will be deleted for good.', 'Delete forever', true)) return;
  try { await call('empty_trash'); S.sel = null; await reload(); toast('Trash emptied'); } catch (e) { err(e); }
}

function openItem(id: string) {
  S.filter = 'all'; S.query = ''; searchEl.value = ''; S.qids = null; S.sel = id; S.editing = null; S.bulk = false;
  layoutEl.classList.remove('wide'); renderNav(); renderList(true); renderDetail(); markSel();
}
hooks.openItem = openItem;

function newItem(k: Kind, tpl?: Template) {
  S.sel = null; S.pending = [];
  if (['security', 'trash', 'auth'].includes(S.filter)) go('all');
  const fields = tpl ? tpl.fields.map(f => F(f.label, f.kind as FKind)) : TEMPLATES[k]();
  S.editing = { id: '', kind: k, title: '', folder: S.filter.startsWith('folder:') ? S.filter.slice(7) : '', fields, notes: '', favorite: false, updated: 0, history: [], deleted: 0,
    tags: S.filter.startsWith('tag:') ? [S.filter.slice(4)] : [], expires: '', attachments: [], category: '', versions: [] };
  renderList(); renderDetail();
}

// ---------- detail ----------
const emptyDetail = () => h('div', { class: 'empty' }, icon('shieldcheck', 'big'), h('p', {}, 'Select an item to see it here.'),
  h('p', { class: 'hint' }, 'Ctrl+K quick find · Ctrl+N new · Ctrl+L lock · ↑ ↓ to browse'));

async function renderDetail() {
  ticks.forEach(clearInterval); ticks = [];
  if (S.filter === 'security') return renderSecurity();
  if (S.filter === 'auth') return renderAuth();
  if (S.editing) return renderEdit(S.editing);
  if (!S.sel) return put(detailEl, emptyDetail());
  let it: Item;
  try { it = await call<Item>('get_item', { id: S.sel }); } catch { S.sel = null; return renderDetail(); }
  if (S.sel !== it.id || S.editing) return; // user moved on while we waited
  ticks.forEach(clearInterval); ticks = [];
  const k = KINDS[it.kind] ?? KINDS.other;
  const auto = S.sums.find(s => s.id === it.id)?.category ?? '';
  const act = (fn: () => Promise<void>) => async () => { try { await fn(); } catch (e) { err(e); } };
  const acts = it.deleted
    ? [h('button', { onclick: act(async () => { await call('restore_item', { id: it.id }); await reload(); toast('Restored'); }) }, icon('restore'), h('span', {}, 'Restore')), delForever(it)]
    : [iconBtn('star', it.favorite ? 'Remove from favorites' : 'Add to favorites', act(async () => { await call('save_item', { item: { ...it, favorite: !it.favorite } }); await reload(); }), it.favorite ? 'on' : ''),
       iconBtn('history', `Version history (${it.versions.length})`, () => versionsDialog(it)), iconBtn('copy', 'Duplicate', act(async () => { const id = await call<string>('duplicate_item', { id: it.id }); await reload(); openItem(id); toast('Duplicated'); })),
       it.kind !== 'passkey' ? iconBtn('share', 'Share as an encrypted file', () => shareDialog(it)) : null,
       h('button', { onclick: () => { S.editing = structuredClone(it); S.pending = []; renderDetail(); } }, icon('edit'), h('span', {}, 'Edit'))];
  const shown = it.fields.filter(f => f.value);
  const dueIn = it.expires ? Math.floor((Date.parse(it.expires + 'T00:00:00') - Date.now()) / 86400000) + 1 : null;
  const chips = [chip(k.label, k.color, k.icon), auto && chip(auto, CATEGORY_COLORS[auto]), it.folder && chip(it.folder, undefined, 'folder'), ...it.tags.map(t => chip(t, undefined, 'tag')),
    dueIn !== null && chip(dueIn < 0 ? `Expired ${-dueIn} d ago` : dueIn === 0 ? 'Expires today' : `Expires in ${dueIn} d`, dueIn <= 14 ? '#ff6b6b' : '#9aa4b8', 'clock'),
    it.kind === 'login' && !it.fields.some(f => f.label === 'Password' && f.value) && chip('No password: passkey or single sign-on', '#9aa4b8')];
  const photos = it.attachments.length ? h('div', { class: 'photos' }, ...it.attachments.map(a => attachmentTile(it, a, false, () => renderDetail()))) : null;
  const head = h('div', { class: 'head' }, avatar(it.kind, it.title, true), h('div', { class: 'ttl' }, h('h2', {}, it.title), h('div', { class: 'chips' }, ...chips)), h('div', { class: 'acts' }, ...acts));
  head.style.setProperty('--kc', k.color);
  put(detailEl, head,
    ['card', 'bank'].includes(it.kind) ? walletCard(it) : null,
    it.kind === 'wifi' ? await wifiQr(it) : null,
    it.kind === 'document' ? photos : null,
    shown.length ? h('div', { class: 'group' }, ...shown.map(viewField)) : null,
    it.kind === 'identity' ? addressBlock(it) : null,
    it.kind === 'api' ? apiBlock(it) : null,
    it.kind !== 'document' && photos ? h('div', { class: 'sect' }, h('h3', {}, icon('image'), ' Photos and files'), photos) : null,
    it.notes ? h('div', { class: 'group' }, h('div', { class: 'f static' }, h('div', { class: 'l' }, 'Notes'), h('div', { class: 'md' }, ...renderMd(it.notes, async line => { await call('save_item', { item: { ...it, notes: toggleLine(it.notes, line) } }); renderDetail(); })))) : null,
    it.history.length ? h('details', { class: 'group hist' }, h('summary', {}, icon('clock'), ` Earlier passwords and secrets (${it.history.length})`),
      ...it.history.slice().reverse().map(x => viewField({ label: `Previous ${x.label} · ${ago(x.at)}`, value: x.value, kind: 'secret' }))) : null,
    h('small', { class: 'hint foot', title: new Date(it.updated * 1000).toLocaleString() }, 'Changed ' + ago(it.updated)));
}

function renderMd(text: string, toggle: (line: number) => void): Node[] {
  const inl = (xs: Inl[]): Node[] => xs.map(x => x.t === 'b' ? h('strong', {}, x.v) : x.t === 'i' ? h('em', {}, x.v) : x.t === 'code' ? h('code', {}, x.v) : x.t === 'link' ? h('a', { class: 'mdlink', title: 'Click to copy the link', onclick: (e: Event) => { e.preventDefault(); copyText(x.v); } }, x.v) : document.createTextNode(x.v));
  const blk = (b: Block): Node => {
    switch (b.t) {
      case 'h': return h(('h' + (b.n + 2)) as 'h3', {}, ...inl(b.inl));
      case 'p': return h('p', {}, ...inl(b.inl));
      case 'quote': return h('blockquote', {}, ...inl(b.inl));
      case 'code': return h('pre', { class: 'mdcode' }, b.text);
      case 'hr': return h('hr');
      default: return h(b.t, {}, ...b.items.map(i => h('li', { class: i.check === undefined ? '' : 'task' + (i.check ? ' done' : '') },
        i.check === undefined ? null : h('input', { type: 'checkbox', checked: i.check, onchange: () => toggle(i.line) }), h('span', {}, ...inl(i.inl)))));
    }
  };
  return parseMd(text).map(blk);
}

function delForever(it: Item) {
  let armed = false;
  const b = h('button', { class: 'danger', onclick: async () => {
    if (!armed) { armed = true; put(b, icon('trash'), h('span', {}, 'Click again to delete')); return; }
    try { await call('delete_item', { id: it.id }); S.sel = null; await reload(); toast('Deleted for good'); } catch (e) { err(e); }
  } }, icon('trash'), h('span', {}, 'Delete forever'));
  return b;
}

async function wifiQr(it: Item) {
  const g = (l: string) => it.fields.find(f => f.label === l)?.value || '';
  if (!g('Network name')) return null;
  try { return h('div', { class: 'qr' }, fromHtml(await call<string>('wifi_qr', { ssid: g('Network name'), password: g('Password'), security: g('Security') })), h('small', { class: 'hint' }, 'Scan with a phone camera to join')); }
  catch { return null; }
}

function walletCard(it: Item) {
  const g = (l: string) => it.fields.find(f => f.label === l)?.value || '';
  if (it.kind === 'bank') {
    const acc = g('Account number').replace(/\s/g, ''), iban = g('IBAN').replace(/\s/g, '');
    const w = h('div', { class: 'wallet bank' }, h('div', { class: 'top' }, h('b', {}, g('Bank name') || it.title), icon('bank')),
      h('div', { class: 'num' }, iban ? iban.slice(0, 4) + ' •••• •••• ' + iban.slice(-4) : '•••• ' + (acc.slice(-4) || '••••')), h('div', { class: 'bot' }, h('span', {}, g('Account holder')), h('span', {}, g('SWIFT / BIC'))));
    w.style.setProperty('--h', String(hue(it.title)));
    return w;
  }
  const num = g('Card number').replace(/\D/g, '');
  const brand = /^4/.test(num) ? 'VISA' : /^(5[1-5]|2[2-7])/.test(num) ? 'Mastercard' : /^3[47]/.test(num) ? 'AMEX' : /^6/.test(num) ? 'Discover' : '';
  const w = h('div', { class: 'wallet' }, h('div', { class: 'top' }, h('i', { class: 'chip' }), h('b', {}, brand)),
    h('div', { class: 'num' }, '•••• •••• •••• ' + (num.slice(-4) || '••••')), h('div', { class: 'bot' }, h('span', {}, g('Cardholder') || it.title), h('span', {}, g('Expiry'))));
  w.style.setProperty('--h', String(hue(it.title)));
  return w;
}

function addressBlock(it: Item) {
  const g = (l: string) => it.fields.find(f => f.label === l)?.value.trim() || '';
  const lines = [g('Full name') || [g('First name'), g('Last name')].filter(Boolean).join(' '), g('Company'), g('Address line 1'), g('Address line 2'), [g('Postal code'), g('City')].filter(Boolean).join(' '), g('State / region'), g('Country')].filter(Boolean);
  if (lines.length < 2) return null;
  return h('div', { class: 'sect' }, h('div', { class: 'addr' }, h('pre', {}, lines.join('\n')), h('button', { onclick: () => copyText(lines.join('\n')) }, icon('copy'), h('span', {}, 'Copy full address'))));
}

function apiBlock(it: Item) {
  const g = (l: string) => it.fields.find(f => f.label === l)?.value || '';
  const key = g('Secret key') || g('Key');
  if (!key) return null;
  const name = ((g('Service') || it.title).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'API') + '_API_KEY';
  return h('div', { class: 'sect' }, h('div', { class: 'btns' },
    h('button', { onclick: () => copyText(`${name}=${key}`) }, icon('terminal'), h('span', {}, `Copy as ${name}=…`)),
    h('button', { onclick: () => copyText(`export ${name}=${key}`) }, icon('terminal'), h('span', {}, 'Copy as export …')),
    h('button', { onclick: () => copyText(`$env:${name}="${key}"`) }, icon('terminal'), h('span', {}, 'Copy for PowerShell'))));
}

function ringEl() {
  const el = fromHtml('<svg class="ring" viewBox="0 0 36 36"><circle class="bg" cx="18" cy="18" r="15"/><circle class="fg" cx="18" cy="18" r="15"/><text x="18" y="22" text-anchor="middle"></text></svg>');
  const fg = el.querySelector('.fg') as SVGElement, txt = el.querySelector('text')!;
  return { el, set(left: number, period: number) { txt.textContent = String(left); fg.style.strokeDashoffset = String(94.25 * (1 - left / period)); } };
}

function jwt(v: string): any | null {
  const p = v.split('.');
  if (p.length !== 3 || !p.every(x => /^[A-Za-z0-9_-]+$/.test(x))) return null;
  try { return JSON.parse(atob(p[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(p[1].length / 4) * 4, '='))); } catch { return null; }
}

const groupDigits = (v: string) => v.replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();

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
    const grouped = ['IBAN', 'Card number', 'Account number'].includes(f.label);
    let shown = false;
    const paint = () => { val.textContent = masked && !shown ? '••••••••••' : grouped ? groupDigits(f.value) : f.value; val.classList.toggle('pre', f.kind === 'multiline' && shown); };
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
async function renderEdit(it: Item) {
  const isNew = !it.id;
  const cats = await call<string[]>('categories_list');
  const title = h('input', { value: it.title, placeholder: 'Title', class: 'big', oninput: () => it.title = title.value });
  const folder = h('input', { value: it.folder, placeholder: 'Folder (optional)', list: 'folders', oninput: () => it.folder = folder.value });
  const dl = h('datalist', { id: 'folders' }, ...[...new Set(S.sums.map(s => s.folder).filter(Boolean))].map(f => h('option', { value: f })));
  const fav = h('input', { type: 'checkbox', checked: it.favorite, onchange: () => it.favorite = fav.checked });
  const cat = h('select', { 'aria-label': 'Category', onchange: () => it.category = cat.value }, h('option', { value: '', selected: !it.category }, 'Category: automatic'), ...cats.map(c => h('option', { value: c, selected: c === it.category }, c)));
  const exp = h('input', { type: 'date', value: it.expires, title: 'Expiry or rotation date: Vault warns you before it', oninput: () => it.expires = exp.value });
  const tagBox = h('div', { class: 'tagbox' });
  const tagIn = h('input', { placeholder: 'Add tag…', list: 'taglist', onkeydown: (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ',') && tagIn.value.trim()) { e.preventDefault(); addTag(tagIn.value.trim().replace(/,$/, '')); tagIn.value = ''; }
    else if (e.key === 'Backspace' && !tagIn.value && it.tags.length) { it.tags.pop(); paintTags(); }
  } });
  const addTag = (t: string) => { if (t && !it.tags.includes(t)) it.tags.push(t); paintTags(); };
  const paintTags = () => put(tagBox, icon('tag'), ...it.tags.map(t => h('span', { class: 'chip rm', onclick: () => { it.tags = it.tags.filter(x => x !== t); paintTags(); } }, t, icon('x'))), tagIn);
  const tl = h('datalist', { id: 'taglist' }, ...[...new Set(S.sums.flatMap(s => s.tags))].map(t => h('option', { value: t })));
  paintTags();
  const notes = h('textarea', { value: it.notes, rows: 4, placeholder: 'Notes (Markdown: # headings, **bold**, - [ ] checklists)', oninput: () => it.notes = notes.value });
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
          const p = await call<{ accounts: { title: string; account: string; uri: string }[] }>('scan_screen'); const a = p.accounts[0];
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
  const files = h('div', { class: 'group attgroup' });
  const refreshAtts = async () => { if (!isNew) { const fresh = await call<Item>('get_item', { id: it.id }); it.attachments = fresh.attachments; } paintFiles(); };
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true, onchange: async () => { await attachFiles([...(fileIn.files ?? [])], isNew ? null : it.id); fileIn.value = ''; await refreshAtts(); } });
  const paintFiles = () => put(files,
    h('div', { class: 'photos' }, ...it.attachments.map(a => attachmentTile(it, a, true, refreshAtts)), ...S.pending.map((p, i) =>
      h('div', { class: 'att' }, isImage(p.name) ? h('button', { type: 'button', class: 'thumb' }, h('img', { alt: p.name, src: `data:image/jpeg;base64,${p.data}` })) : h('button', { type: 'button', class: 'thumb file' }, icon('doc')),
        h('div', { class: 'cap' }, h('span', {}, p.name), h('small', {}, 'saved with the item')), iconBtn('x', 'Remove', () => { S.pending.splice(i, 1); paintFiles(); }, 'rm')))),
    h('div', { class: 'btns pad' }, h('button', { type: 'button', onclick: () => fileIn.click() }, icon('clip'), h('span', {}, 'Add photos or files…')),
      h('button', { type: 'button', onclick: () => photoDialog(async (name, data) => { await attachFiles([{ name, data }], isNew ? null : it.id); await refreshAtts(); }) }, icon('camera'), h('span', {}, 'Take a photo')),
      h('small', { class: 'hint' }, 'Photos, PDFs and documents are encrypted. You can also paste a copied image with Ctrl+V.')));
  void refreshAtts();
  const docChips = it.kind === 'document' ? h('div', { class: 'chips pickers' }, ...DOC_TYPES.map(t => h('button', { type: 'button', class: 'chipbtn pick', onclick: () => {
    let f = it.fields.find(x => x.label === 'Document type'); if (!f) { f = F('Document type'); it.fields.unshift(f); }
    f.value = t; if (!it.title.trim()) { it.title = t; title.value = t; } paintRows();
  } }, t))) : null;
  const del = !isNew && h('button', { type: 'button', class: 'danger', onclick: async () => {
    try { await call('delete_item', { id: it.id }); S.sel = null; S.editing = null; await reload(); toast('Moved to the trash'); } catch (e) { err(e); }
  } }, icon('trash'), h('span', {}, 'Delete'));
  const form = h('form', { class: 'edit', onsubmit: async (ev: Event) => {
    ev.preventDefault();
    try {
      const id = await call<string>('save_item', { item: { ...it, fields: it.fields.filter(f => f.label.trim() || f.value) } });
      if (S.pending.length) await attachFiles(S.pending.splice(0), id);
      S.sel = id; S.editing = null; await reload(); toast('Saved');
    } catch (e) { err(e); }
  } },
    h('h2', {}, isNew ? `New ${KINDS[it.kind].label.toLowerCase()}` : 'Edit item'), title, docChips, h('div', { class: 'two' }, folder, cat), dl, tl, tagBox,
    h('div', { class: 'two' }, h('label', { class: 'dlabel' }, h('span', {}, 'Expires or rotate by'), exp), h('label', { class: 'chk' }, fav, ' Favorite')), rows,
    h('button', { type: 'button', class: 'ghost', onclick: () => { it.fields.push(F('')); paintRows(); } }, icon('plus'), h('span', {}, 'Add field')),
    h('h4', { class: 'edh' }, icon('image'), ' Photos and files'), files, fileIn,
    h('h4', { class: 'edh' }, icon('note'), ' Notes'), notes,
    h('div', { class: 'btns' }, h('button', { class: 'primary', type: 'submit' }, 'Save'), h('button', { type: 'button', onclick: () => { S.editing = null; S.pending = []; renderDetail(); } }, 'Cancel'),
      h('button', { type: 'button', class: 'ghost', onclick: async () => {
        const name = await ask('Save as template', 'Template name', it.title, 'Save', "Keeps this item's field layout (labels and types, no values) so you can start new items from it.");
        if (!name) return;
        S.settings.templates.push({ name, kind: it.kind, fields: it.fields.map(f => ({ label: f.label, kind: f.kind })) });
        await saveSettings(); toast('Template saved');
      } }, icon('sparkle'), h('span', {}, 'Save as template')), del));
  form.addEventListener('paste', async e => {
    const f = [...(e.clipboardData?.files ?? [])].find(x => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); await attachFiles([f], isNew ? null : it.id); await refreshAtts(); toast('Image added'); }
  });
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
    if (S.filter !== 'auth' || !grid.isConnected) return;
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

// ---------- security center ----------
async function renderSecurity() {
  put(detailEl, h('p', { class: 'hint pad' }, 'Checking your passwords…'));
  let a: Audit;
  try { a = await call<Audit>('security_audit'); } catch (e) { return err(e); }
  if (S.filter !== 'security') return;
  const section = (title: string, ic: string, refs: Ref[], tip: string, flag: string) => h('section', { class: 'sect' },
    h('h3', {}, icon(ic), ` ${title} `, h('span', { class: 'n' }, String(refs.length)), refs.length ? h('button', { class: 'linkbtn', onclick: () => go('flag:' + flag) }, 'View in list') : null),
    refs.length ? h('div', { class: 'group' }, ...refs.map(r => h('button', { class: 'row flat', onclick: () => openItem(r.id) }, h('div', { class: 't' }, h('b', {}, r.title), h('small', {}, r.note)), icon('edit')))) : h('p', { class: 'hint ok' }, icon('check'), ' ' + tip));
  const ring = fromHtml(`<svg class="score" viewBox="0 0 120 120"><circle class="bg" cx="60" cy="60" r="52"/><circle class="fg ${a.score >= 80 ? 'strong' : a.score >= 50 ? 'fair' : 'weak'}" cx="60" cy="60" r="52"/><text x="60" y="68" text-anchor="middle">${a.score}</text></svg>`);
  (ring.querySelector('.fg') as SVGElement).style.strokeDashoffset = String(326.7 * (1 - a.score / 100));
  const breaches = h('div', { class: 'sect' });
  const runBreach = h('button', { class: 'primary' }, icon('globe'), h('span', {}, 'Check for breached passwords'));
  runBreach.addEventListener('click', async () => {
    runBreach.disabled = true; runBreach.classList.add('busy');
    try {
      const found = await call<Ref[]>('breach_check');
      put(breaches, h('h3', {}, icon('alert'), ' Found in known breaches ', h('span', { class: 'n' }, String(found.length))),
        found.length ? h('div', { class: 'group' }, ...found.map(r => h('button', { class: 'row flat', onclick: () => openItem(r.id) }, h('div', { class: 't' }, h('b', {}, r.title), h('small', {}, r.note)), icon('edit')))) : h('p', { class: 'hint ok' }, icon('check'), ' None of your passwords were found.'));
    } catch (e) { err(e); runBreach.disabled = false; runBreach.classList.remove('busy'); }
  });
  put(breaches, h('h3', {}, icon('globe'), ' Breach check'), h('p', { class: 'hint' }, 'Optional and online. Only the first 5 characters of a hash of each password are sent to haveibeenpwned.com; your passwords never leave this PC.'), runBreach);
  put(detailEl, h('div', { class: 'secwrap' },
    h('div', { class: 'sechead' }, ring, h('div', {}, h('h2', {}, 'Security center'), h('p', { class: 'hint' }, a.total ? `${a.total} login${a.total === 1 ? '' : 's'} checked on this PC.` : 'Add logins to see how healthy your passwords are.'))),
    section('Expiring or expired', 'clock', a.expiring, 'Nothing is due soon.', 'expiring'), section('Weak passwords', 'alert', a.weak, 'No weak passwords.', 'weak'), section('Reused passwords', 'copy', a.reused, 'No reused passwords.', 'reused'),
    section('Old passwords', 'clock', a.old, 'Nothing older than a year.', 'old'), section('Sites without HTTPS', 'globe', a.insecure, 'Every saved site uses HTTPS.', 'http'), breaches));
}

// ---------- quick find ----------
function palette() {
  if (!S.mainActive || document.querySelector('dialog.pal')) return;
  type Entry = { label: string; sub: string; ic: string; run: () => void; pw?: () => void };
  const actions: Entry[] = [
    { label: 'New login', sub: 'Action', ic: 'plus', run: () => newItem('login') }, { label: 'New item…', sub: 'Action', ic: 'plus', run: () => newDialog(newItem) }, { label: 'Password generator', sub: 'Action', ic: 'dice', run: () => genDialog() },
    { label: 'Authenticator codes', sub: 'Action', ic: 'timer', run: () => go('auth') }, { label: 'Import 2FA codes', sub: 'Action', ic: 'scan', run: twofaDialog },
    { label: 'Security center', sub: 'Action', ic: 'shieldcheck', run: () => go('security') }, { label: 'Settings', sub: 'Action', ic: 'settings', run: settingsDialog }, { label: 'Lock vault', sub: 'Action', ic: 'lock', run: lockNow }];
  const q = h('input', { placeholder: 'Search items or type a command…', autocomplete: 'off', spellcheck: false });
  const res = h('div', { class: 'pres' });
  let list: Entry[] = [], cur = 0, seq = 0;
  const draw = async () => {
    const t = q.value, n = ++seq;
    let ids: string[] | null = null;
    if (t.trim()) { try { ids = await call<string[]>('search', { query: t, trash: false }); } catch { ids = []; } }
    if (n !== seq) return;
    const byId = new Map(S.sums.map(s => [s.id, s]));
    const hits = (ids ?? S.sums.filter(s => !s.deleted).sort(SORTS.name).map(s => s.id)).map(id => byId.get(id)).filter((s): s is Sum => !!s).slice(0, 7);
    const items: Entry[] = hits.map(s => ({
      label: s.title, sub: s.sub || s.domain || KINDS[s.kind].label, ic: KINDS[s.kind].icon, run: () => openItem(s.id),
      pw: async () => { const it = await call<Item>('get_item', { id: s.id }); const p = it.fields.find(f => f.label === 'Password')?.value; if (p) copyText(p); else toast('This item has no password', true); } }));
    list = [...items, ...actions.filter(a => !t.trim() || a.label.toLowerCase().includes(t.toLowerCase()))];
    cur = Math.min(cur, Math.max(0, list.length - 1));
    put(res, ...(list.length ? list.map((e, i) => h('button', { class: 'pr' + (i === cur ? ' on' : ''), onclick: () => { d.remove(); e.run(); }, onmousemove: () => { if (cur !== i) { cur = i; res.querySelectorAll('.pr').forEach((x, j) => x.classList.toggle('on', j === cur)); } } },
      icon(e.ic), h('b', {}, e.label), h('small', {}, e.sub))) : [h('p', { class: 'hint pad' }, 'Nothing found.')]));
  };
  const d = dialog(() => [q, res, h('small', { class: 'hint pfoot' }, 'Enter opens · Ctrl+Enter copies the password · Esc closes')], 'pal');
  q.addEventListener('input', () => { cur = 0; draw(); });
  q.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(0, Math.min(list.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1))); res.querySelectorAll('.pr').forEach((x, j) => x.classList.toggle('on', j === cur)); res.querySelector('.pr.on')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter' && list[cur]) { e.preventDefault(); const en = list[cur]; d.remove(); if (e.ctrlKey && en.pw) en.pw(); else en.run(); }
  });
  draw(); q.focus();
}

async function copyField(label: string) {
  if (!S.sel || S.editing) return;
  try { const it = await call<Item>('get_item', { id: S.sel }); const v = it.fields.find(f => f.label === label)?.value; if (v) copyText(v); else toast(`This item has no ${label.toLowerCase()}`, true); } catch (e) { err(e); }
}

async function copyCode() {
  if (!S.sel || S.editing) return;
  try {
    const t = (await call<Item>('get_item', { id: S.sel })).fields.find(f => f.kind === 'totp' && f.value);
    if (!t) return toast('This item has no one-time code', true);
    await copyText((await call<{ code: string }>('totp', { secret: t.value })).code);
  } catch (e) { err(e); }
}

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  if (!S.mainActive) return;
  const k = e.key.toLowerCase();
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName);
  const modal = !!document.querySelector('dialog[open]');
  if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'k') { e.preventDefault(); palette(); }
  else if (modal) return;
  else if (e.ctrlKey && !e.shiftKey && k === 'n') { e.preventDefault(); newDialog(newItem); }
  else if (e.ctrlKey && !e.shiftKey && k === 'l') { e.preventDefault(); lockNow(); }
  else if (e.ctrlKey && e.shiftKey && k === 'c') { e.preventDefault(); copyField('Password'); }
  else if (e.ctrlKey && e.shiftKey && k === 'u') { e.preventDefault(); copyField('Username'); }
  else if (e.ctrlKey && e.shiftKey && k === 't') { e.preventDefault(); copyCode(); }
  else if (e.key === '/' && !typing) { e.preventDefault(); searchEl.focus(); searchEl.select(); }
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (!typing || e.target === searchEl)) { e.preventDefault(); moveSel(e.key === 'ArrowDown' ? 1 : -1); }
  else if (e.key === 'Escape') {
    if (S.bulk) { S.bulk = false; S.picked.clear(); renderList(); }
    else if (S.editing) { S.editing = null; S.pending = []; renderDetail(); }
    else if (S.query) { S.query = ''; searchEl.value = ''; runSearch(); }
  }
});
for (const ev of ['mousemove', 'keydown', 'click']) document.addEventListener(ev, () => { if (S.mainActive) resetIdle(); }, { passive: true });
listen('quick-search', () => palette());
listen('vault-locked', () => { if (S.mainActive) showLock(false); });
listen('vault-synced', () => { if (S.mainActive && !S.editing) reload(); });

showLock(true).catch(e => { app.textContent = String(e); });
