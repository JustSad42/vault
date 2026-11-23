import { invoke } from '@tauri-apps/api/core';

export type Kind = 'login' | 'card' | 'bank' | 'identity' | 'document' | 'note' | 'api' | 'ssh' | 'wifi' | 'passkey' | 'other';
export type FKind = 'text' | 'secret' | 'multiline' | 'totp';
export interface Field { label: string; value: string; kind: FKind }
export interface Hist { label: string; value: string; at: number }
export interface Att { id: string; name: string; size: number }
export interface ItemVersion { at: number; title: string; folder: string; tags: string[]; notes: string; expires: string; category: string; fields: Field[] }
export interface Item {
  id: string; kind: Kind; title: string; folder: string; fields: Field[]; notes: string; favorite: boolean; updated: number; history: Hist[]; deleted: number;
  tags: string[]; expires: string; attachments: Att[]; category: string; versions: ItemVersion[];
}
export interface Sum {
  updated: number; id: string; kind: Kind; title: string; sub: string; folder: string; favorite: boolean; deleted: boolean; tags: string[]; expires: string; files: number;
  category: string; domain: string; flags: string[]; versions: number; tail: string;
}
export interface Template { name: string; kind: string; fields: { label: string; kind: string }[] }
export interface Settings {
  autolock_min: number; clip_secs: number; accent: string; theme: string; templates: Template[]; lock_on_windows_lock: boolean; tray: boolean; check_updates: boolean; sync_url: string;
}
export interface Ref { id: string; title: string; note: string }
export interface Audit { total: number; score: number; weak: Ref[]; reused: Ref[]; old: Ref[]; insecure: Ref[]; expiring: Ref[] }
export interface Acct { title: string; account: string; uri: string }
export interface Batch { id: number; index: number; size: number }
export interface Parsed { accounts: Acct[]; skipped: number; batches: Batch[]; foreign: boolean }
export interface Live { id: string; title: string; sub: string; label: string; code: string; left: number; period: number }

/** `get_item` hands the page markers instead of secret values; Rust gives out one value at a time (`reveal`). */
export const HIDDEN = '\u0001hidden:';
export const isHidden = (v: string) => v.startsWith(HIDDEN);
/** Where Rust finds one secret: a field, an earlier password (`hist`), or a field of an old version (`at`). */
export interface SecretRef { id: string; src: 'field' | 'hist' | 'version'; at: number; idx: number }
export const fieldRef = (id: string, idx: number): SecretRef => ({ id, src: 'field', at: 0, idx });

export const KINDS: Record<Kind, { label: string; plural: string; icon: string; desc: string; color: string }> = {
  login: { label: 'Login', plural: 'Logins', icon: 'key', desc: 'Website or app account', color: '#6c8cff' },
  card: { label: 'Credit / debit card', plural: 'Cards', icon: 'card', desc: 'Payment card, with photos', color: '#ff9f43' },
  bank: { label: 'Bank account', plural: 'Bank accounts', icon: 'bank', desc: 'IBAN, account and routing numbers', color: '#2ed3a0' },
  identity: { label: 'Identity & address', plural: 'Identities', icon: 'user', desc: 'Name, address, phone for autofill', color: '#f368a8' },
  document: { label: 'Document', plural: 'Documents', icon: 'doc', desc: 'Passport, ID, licence: photos and PDFs', color: '#b57bff' },
  note: { label: 'Secure note', plural: 'Notes', icon: 'note', desc: 'Private text with checklists', color: '#ffd166' },
  api: { label: 'API key', plural: 'API keys', icon: 'braces', desc: 'Keys, tokens, rotation reminders', color: '#ff6b6b' },
  ssh: { label: 'SSH key', plural: 'SSH keys', icon: 'terminal', desc: 'Server access key', color: '#4cd964' },
  wifi: { label: 'Wi-Fi network', plural: 'Wi-Fi', icon: 'wifi', desc: 'Password with QR code', color: '#38c8ff' },
  passkey: { label: 'Passkey', plural: 'Passkeys', icon: 'passkey', desc: 'Saved from your browser', color: '#8e7dff' },
  other: { label: 'Other card or ID', plural: 'Other', icon: 'id', desc: 'Membership, licence, anything', color: '#9aa4b8' },
};
export const KIND_ORDER = Object.keys(KINDS) as Kind[];
export const NEW_KINDS = KIND_ORDER.filter(k => k !== 'passkey');
export const CATEGORY_COLORS: Record<string, string> = { Email: '#5aa9ff', Social: '#f368a8', Finance: '#2ed3a0', Shopping: '#ff9f43', Developer: '#4cd964', Gaming: '#8e7dff', Entertainment: '#ff6b6b', Work: '#38c8ff', Cloud: '#7aa2ff', Travel: '#ffd166', Education: '#b57bff', News: '#c0c8d8', Health: '#ff7a90', Government: '#9aa4b8', Identity: '#f368a8', Network: '#38c8ff', Notes: '#ffd166', Other: '#9aa4b8' };
export const DOC_TYPES = ['Passport', 'National ID card', "Driver's licence", 'Residence permit', 'Visa', 'Insurance card', 'Birth certificate', 'Other'];
export const ACCENTS: Record<string, string> = { indigo: '#7b8cff', violet: '#a06bff', blue: '#3b9cff', cyan: '#22c3e6', emerald: '#2ed3a0', amber: '#ffb03b', rose: '#ff6b8a', pink: '#f368d8' };

export const F = (label: string, kind: FKind = 'text', value = ''): Field => ({ label, value, kind });
export const TEMPLATES: Record<Kind, () => Field[]> = {
  login: () => [F('Username'), F('Password', 'secret'), F('Website'), F('One-time code', 'totp')],
  card: () => [F('Cardholder'), F('Card number', 'secret'), F('Expiry'), F('CVV', 'secret'), F('PIN', 'secret'), F('Billing zip / postcode')],
  bank: () => [F('Bank name'), F('Account holder'), F('Account number', 'secret'), F('IBAN', 'secret'), F('SWIFT / BIC'), F('Routing number'), F('Branch'), F('PIN', 'secret'), F('Online banking'), F('Bank phone')],
  identity: () => [F('Full name'), F('First name'), F('Last name'), F('Email'), F('Phone'), F('Address line 1'), F('Address line 2'), F('City'), F('State / region'), F('Postal code'), F('Country'), F('Birthday'), F('Company')],
  document: () => [F('Document type', 'text', 'Passport'), F('Number', 'secret'), F('Name on document'), F('Issued by'), F('Issue date'), F('Country')],
  note: () => [],
  api: () => [F('Service'), F('Environment', 'text', 'production'), F('Key ID'), F('Secret key', 'secret'), F('Endpoint'), F('Scopes')],
  ssh: () => [F('Public key'), F('Private key', 'multiline'), F('Passphrase', 'secret')],
  wifi: () => [F('Network name'), F('Password', 'secret'), F('Security', 'text', 'WPA2')],
  passkey: () => [F('Website'), F('Username')],
  other: () => [F('Name'), F('Number')],
};

export const ICONS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>', note: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7"/>',
  terminal: '<path d="m4 17 6-5-6-5M12 19h8"/>', braces: '<path d="M8 4c-2 0-3 1-3 3v2c0 1-1 2-2 3 1 1 2 2 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1 1 2 2 3-1 1-2 2-2 3v2c0 2-1 3-3 3"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/>', id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16c.5-2 5.5-2 6 0M14 10h4M14 14h3"/>',
  bank: '<path d="M3 10 12 4l9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>', passkey: '<circle cx="9" cy="9" r="4"/><path d="M11.5 12.5 20 21M17 18l2-2M14.5 15.5l2-2"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>', copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.7A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.4-1"/>',
  check: '<path d="m5 12 5 5L20 7"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>', edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>', download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>', shield: '<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z"/>',
  shieldcheck: '<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>', grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  restore: '<path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4"/>', alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>', globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  cmd: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>', scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 3h6"/>', camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  clip: '<path d="M20 11 12 19a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7"/>', share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 11 7.6-4M8.2 13l7.6 4"/>',
  history: '<path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4M12 8v4l3 2"/>', tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/>', sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M6 15v4"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>', palette: '<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2-.6-1.3.2-2.5 1.6-2.5H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  puzzle: '<path d="M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4H6v-4h2a2 2 0 1 0 0-4H6V6h4z"/>', cloud: '<path d="M7 18a5 5 0 0 1 0-10 6 6 0 0 1 11.5 1.5A4 4 0 0 1 18 18z"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>', hash: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>', list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  checksq: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>', bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
};

// Builds DOM without innerHTML: imported data is untrusted.
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
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
export const put = (el: Element, ...kids: (Node | null | false | undefined)[]) => el.replaceChildren(...(kids.filter(Boolean) as Node[]));

// Icons and the QR code are static strings or generated by our own Rust, never user text.
export function fromHtml(html: string): Element {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as Element;
}
export const icon = (name: string, cls = '') => fromHtml(`<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`);

/** Shared UI state. The screens read and write it; `hooks` lets dialogs ask the main screen to redraw. */
export const S = {
  sums: [] as Sum[], vis: [] as Sum[], sel: null as string | null, editing: null as Item | null, filter: 'all', query: '', qids: null as string[] | null,
  settings: { autolock_min: 5, clip_secs: 20, accent: 'indigo', theme: 'auto', templates: [], lock_on_windows_lock: true, tray: false, check_updates: true, sync_url: '' } as Settings,
  bulk: false, picked: new Set<string>(), mainActive: false, pending: [] as { name: string; data: string }[],
};
export const hooks = {
  reload: async () => {}, go: (_k: string) => {}, openItem: (_id: string) => {}, renderDetail: () => {}, renderList: (_animate?: boolean) => {}, renderNav: () => {}, lockNow: async () => {},
  resetIdle: () => {}, checkUpdate: (_manual: boolean) => {},
};

export const call = <T = void>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args);
export { invoke };
export const err = (e: unknown) => toast(String(e), true);

let toastTimer = 0;
export function toast(msg: string, bad = false) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast' }); document.body.append(t); }
  put(t, icon(bad ? 'alert' : 'check'), h('span', {}, msg));
  t.className = bad ? 'bad show' : 'show';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), bad ? 6000 : 2600);
}

const copied = () => toast(S.settings.clip_secs ? `Copied. The clipboard clears in ${S.settings.clip_secs} s.` : 'Copied.');
export async function copyText(text: string) {
  try { await call('copy', { text }); copied(); } catch (e) { err(e); }
}
export const reveal = (r: SecretRef) => call<string>('reveal', { ...r });
/** Copies a secret straight from Rust; `fmt` wraps it, `{v}` standing for the value. */
export async function revealCopy(r: SecretRef, fmt?: string) {
  try { await call('reveal_copy', { ...r, fmt: fmt ?? null }); copied(); } catch (e) { err(e); }
}

export const hue = (s: string) => { let n = 0; for (const c of s) n = (n * 31 + c.codePointAt(0)!) % 360; return n; };
export function avatar(kind: Kind, title: string, big = false) {
  const k = KINDS[kind] ?? KINDS.other;
  const a = h('div', { class: 'av' + (big ? ' big' : '') + (kind === 'login' ? '' : ' kind') }, kind === 'login' ? h('span', {}, (title.trim()[0] || '?').toUpperCase()) : icon(k.icon));
  a.style.setProperty('--h', String(hue(title)));
  a.style.setProperty('--kc', k.color);
  return a;
}
export const chip = (text: string, color?: string, ic?: string) => { const c = h('span', { class: 'chip' }, ic ? icon(ic) : null, text); if (color) c.style.setProperty('--cc', color); return c; };

export function ago(ts: number) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} days ago`;
  return new Date(ts * 1000).toLocaleDateString();
}
export const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export function iconBtn(name: string, title: string, onclick: (e: Event) => void, cls = '') {
  return h('button', { type: 'button', class: 'icon ' + cls, title, 'aria-label': title, onclick }, icon(name));
}
export function flashIcon(b: HTMLElement, back = 'copy') { b.replaceChildren(icon('check')); b.classList.add('done'); setTimeout(() => { b.replaceChildren(icon(back)); b.classList.remove('done'); }, 1200); }
export function copyBtn(get: () => string | void, copy?: () => void) {
  const b = iconBtn('copy', 'Copy', () => { if (copy) copy(); else { const v = get(); if (v) copyText(v); } flashIcon(b); });
  return b;
}

export function meter() {
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

export function pwField(id: string, placeholder: string) {
  const input = h('input', { type: 'password', id, placeholder, autocomplete: 'off', spellcheck: false });
  const eye = iconBtn('eye', 'Show', () => { const show = input.type === 'password'; input.type = show ? 'text' : 'password'; put(eye, icon(show ? 'eyeoff' : 'eye')); });
  return { wrap: h('div', { class: 'pwf' }, input, eye), input };
}

export function dialog(content: (close: () => void) => (Node | null | false)[], cls = '') {
  const d = h('dialog', { class: cls });
  const close = () => { d.close(); d.remove(); };
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', e => { if (e.target === d) close(); });
  d.append(h('div', { class: 'dlg' }, ...(content(close).filter(Boolean) as Node[])));
  document.body.append(d);
  d.showModal();
  return d;
}

/** Applies accent colour and light/dark choice to the whole window. */
export function applyTheme() {
  const r = document.documentElement;
  r.dataset.accent = S.settings.accent || 'indigo';
  if (S.settings.theme === 'light' || S.settings.theme === 'dark') r.dataset.theme = S.settings.theme; else delete r.dataset.theme;
}

export const b64 = (f: File | Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej('could not read the file'); r.readAsDataURL(f); });
export const isImage = (name: string) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
export const mimeOf = (name: string) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' } as Record<string, string>)[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';

/** Photos from a phone or camera are huge: shrink to at most 2400 px on the long side (JPEG) before storing. Other files are kept as they are. */
export async function prepareFile(f: File): Promise<{ name: string; data: string }> {
  if (!f.type.startsWith('image/') || (f.size < 1_500_000 && f.type !== 'image/heic')) return { name: f.name, data: await b64(f) };
  const img = new Image();
  img.src = `data:${f.type};base64,${await b64(f)}`;
  await img.decode();
  const k = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return { name: f.name.replace(/\.[^.]+$/, '') + '.jpg', data: c.toDataURL('image/jpeg', 0.9).split(',')[1] };
}
