// Vault content script: finds login, card and address forms, offers matching items from the app, fills them, offers to save new logins,
// warns about look-alike sites and answers passkey requests. All Vault UI lives in a closed shadow root so the page cannot read or click it.
(() => {
  if (window.__vaultContent) return;
  window.__vaultContent = true;
  const isTop = window.top === window;

  const ask = (cmd, data = {}) => new Promise(res => { try { chrome.runtime.sendMessage({ type: 'req', cmd, data: { ...data, url: location.href } }, r => res(r || { error: 'no answer' })); } catch { res({ error: 'app_not_running' }); } });
  const bg = (type, data) => new Promise(res => { try { chrome.runtime.sendMessage({ type, data }, r => res(r || {})); } catch { res({}); } });

  // ---------- classify fields ----------
  const AUTO = { username: 'username', email: 'email', 'current-password': 'password', 'new-password': 'newpassword', 'one-time-code': 'otp', 'cc-number': 'ccnum', 'cc-name': 'ccname', 'cc-exp': 'ccexp', 'cc-exp-month': 'ccmonth',
    'cc-exp-year': 'ccyear', 'cc-csc': 'cccvv', name: 'fullname', 'given-name': 'first', 'family-name': 'last', tel: 'phone', 'tel-national': 'phone', 'street-address': 'street', 'address-line1': 'addr1', 'address-line2': 'addr2',
    'address-level2': 'city', 'address-level1': 'state', 'postal-code': 'zip', country: 'country', 'country-name': 'country', organization: 'company', bday: 'bday', 'bday-day': 'bdayd', 'bday-month': 'bdaym', 'bday-year': 'bdayy' };
  const RULES = [
    ['ccnum', /card.?(number|no\b|num)|cc.?num|ccnumber|credit.?card|\bpan\b|cardnumber/], ['cccvv', /cvv|cvc|csc|security.?code|verification.?(code|value)|card.?code/], ['ccname', /card.?holder|name.?on.?card|cc.?name/],
    ['ccexp', /mm\s*[\/\-. ]*\s*(yy|yyyy)|\bmmyy/], ['ccmonth', /(exp|valid).*(mm|month)|\b(mm|month)\b.*(exp|valid)|^(mm|month)$|cc.?month/], ['ccyear', /(exp|valid).*(yy|year)|\b(yy|year)\b.*(exp|valid)|^(yy|yyyy|year)$|cc.?year/], ['ccexp', /expir|exp.?date|valid.?(thru|until)|\bexp\b|mm.?\/.?yy/],
    ['otp', /one.?time|otp|2fa|two.?factor|verification.?code|auth(entication)?.?code|totp|mfa/],
    ['first', /first.?name|given.?name|fname|forename/], ['last', /last.?name|family.?name|surname|lname/], ['email', /e-?mail/], ['phone', /phone|mobile|\btel\b|telephone|cell/],
    ['addr2', /address.?(line)?.?2|addr.?2|apt|suite|unit|flat|building/], ['addr1', /address.?(line)?.?1|addr.?1|street|address$|^address/], ['city', /\bcity\b|town|locality/], ['state', /\bstate\b|province|region|county|governorate/],
    ['zip', /\bzip\b|postal|post.?code|postcode/], ['country', /country|nation/], ['company', /company|organi[sz]ation|employer|business/], ['bday', /birth|\bdob\b|bday/],
    ['username', /user.?(name|id)|log.?in|account|identifier|member|handle|\buser\b/], ['fullname', /^name$|full.?name|your.?name|contact.?name|\bname\b/],
  ];
  const labelText = el => {
    let t = '';
    if (el.labels) for (const l of el.labels) t += ' ' + l.textContent;
    const id = el.getAttribute('aria-labelledby');
    if (id) for (const x of id.split(/\s+/)) t += ' ' + (document.getElementById(x)?.textContent || '');
    return t;
  };
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const usable = el => !el.disabled && !el.readOnly && el.type !== 'hidden' && visible(el);

  function classify(el) {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (el.tagName === 'INPUT' && !['text', 'email', 'tel', 'password', 'search', 'number', 'url', 'date', ''].includes(type)) return null;
    if (el.tagName === 'INPUT' && type === 'password') {
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      return ac.includes('new-password') ? 'newpassword' : 'password';
    }
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean).reverse().find(t => AUTO[t]);
    if (ac) return AUTO[ac];
    const hint = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), labelText(el), el.getAttribute('data-testid')].filter(Boolean).join(' ').toLowerCase();
    if (type === 'email') return 'email';
    if (type === 'tel') return 'phone';
    for (const [k, re] of RULES) if (re.test(hint)) return k;
    return null;
  }

  const LOGIN_KEYS = new Set(['username', 'email']);
  const CARD_KEYS = new Set(['ccnum', 'ccname', 'ccexp', 'ccmonth', 'ccyear', 'cccvv']);
  const ID_KEYS = new Set(['first', 'last', 'fullname', 'phone', 'street', 'addr1', 'addr2', 'city', 'state', 'zip', 'country', 'company', 'bday', 'bdayd', 'bdaym', 'bdayy']);

  /** Every usable field on the page with its meaning, grouped by form. */
  function scan() {
    const groups = new Map();
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (el.closest('#vault-ext-root') || !usable(el) && el.tagName !== 'SELECT') continue;
      if (el.tagName === 'SELECT' && !usable(el)) continue;
      const key = classify(el);
      if (!key) continue;
      const form = el.form || el.closest('form') || document.body;
      if (!groups.has(form)) groups.set(form, []);
      groups.get(form).push({ el, key });
    }
    // a card number split over several short, unlabelled boxes: a run of 3+ four-character inputs beside other card fields
    for (const [form, fields] of groups) {
      const k = fields.map(f => f.key);
      if (k.includes('ccnum') || k.filter(x => CARD_KEYS.has(x)).length < 2) continue;
      const known = new Set(fields.map(f => f.el));
      const byParent = new Map();
      for (const el of form.querySelectorAll('input')) {
        if (known.has(el) || !usable(el) || !(el.maxLength > 0 && el.maxLength <= 4) || !['text', 'tel', 'number', ''].includes((el.getAttribute('type') || '').toLowerCase())) continue;
        const p = el.parentElement; if (!byParent.has(p)) byParent.set(p, []); byParent.get(p).push(el);
      }
      const run = [...byParent.values()].find(r => r.length >= 3 && r.length <= 5);
      if (run) for (const el of run) fields.push({ el, key: 'ccnum' });
    }
    const out = [];
    for (const [form, fields] of groups) {
      const keys = fields.map(f => f.key);
      const pw = keys.filter(k => k === 'password' || k === 'newpassword').length;
      const card = keys.filter(k => CARD_KEYS.has(k)).length;
      const ident = keys.filter(k => ID_KEYS.has(k)).length;
      let kind = null;
      if (card >= 2 || keys.includes('ccnum')) kind = 'card';
      else if (pw && keys.includes('newpassword') || pw >= 2) kind = 'signup';
      else if (pw) kind = 'login';
      else if (ident >= 2 || (ident >= 1 && keys.includes('email') && ident + 1 >= 3)) kind = 'identity';
      else if (fields.some(f => LOGIN_KEYS.has(f.key)) && /log.?in|sign.?in|account|auth|session|sso/i.test(location.pathname + ' ' + document.title)) kind = 'login';
      if (kind) out.push({ form, kind, fields });
    }
    return out;
  }

  // ---------- filling ----------
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  function setValue(el, v) {
    if (v == null || v === '') return false;
    if (el.tagName === 'SELECT') return pickOption(el, String(v));
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    el.focus({ preventScroll: true });
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    flash(el);
    return true;
  }
  function pickOption(sel, want) {
    const w = want.trim().toLowerCase(), n = parseInt(w, 10);
    const opts = [...sel.options];
    const score = o => {
      const v = o.value.trim().toLowerCase(), t = o.textContent.trim().toLowerCase();
      if (v === w || t === w) return 5;
      if (!isNaN(n) && (parseInt(v, 10) === n || parseInt(t, 10) === n) && /^\d+$/.test(w)) return 4;
      if (w.length > 2 && (t.startsWith(w) || w.startsWith(t) && t.length > 2)) return 3;
      if (w.length > 2 && (t.includes(w) || w.includes(t) && t.length > 3)) return 2;
      return 0;
    };
    let best = null, bs = 0;
    for (const o of opts) { const s = o.value ? score(o) : 0; if (s > bs) { best = o; bs = s; } }
    if (!best) return false;
    sel.value = best.value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    flash(sel);
    return true;
  }
  function flash(el) { try { const o = el.style.outline, t = el.style.transition; el.style.transition = 'outline-color .6s'; el.style.outline = '2px solid #7b8cff'; setTimeout(() => { el.style.outline = o; el.style.transition = t; }, 700); } catch { /* ignore */ } }

  const first = (fields, ...keys) => fields.find(f => keys.includes(f.key))?.el;
  function fillLogin(group, d) {
    const f = group.fields;
    const user = first(f, 'username', 'email'), pw = f.filter(x => x.key === 'password' || x.key === 'newpassword').map(x => x.el);
    let n = 0;
    if (user && d.username) n += setValue(user, d.username) ? 1 : 0;
    if (pw[0] && d.password) { setValue(pw[0], d.password); n++; }
    return n;
  }
  function fillCard(group, d) {
    const f = group.fields;
    // a number split over several short boxes
    const nums = f.filter(x => x.key === 'ccnum').map(x => x.el);
    if (nums.length === 1) {
      const el = nums[0], parent = el.parentElement, siblings = parent ? [...parent.querySelectorAll('input')].filter(i => usable(i) && +i.maxLength > 0 && +i.maxLength <= 4) : [];
      if (siblings.length >= 3 && siblings.includes(el)) siblings.forEach((i, k) => setValue(i, d.number.slice(k * 4, k * 4 + 4)));
      else setValue(el, d.number);
    } else nums.forEach((el, k) => setValue(el, d.number.slice(k * 4, k * 4 + 4)));
    setValue(first(f, 'ccname') || first(f, 'fullname'), d.holder);
    const exp = first(f, 'ccexp');
    if (exp && exp.tagName !== 'SELECT') {
      const ph = (exp.placeholder || '').toUpperCase(), yy = d.year.slice(-2), yyyy = d.year;
      setValue(exp, +exp.maxLength === 4 ? d.month + yy : ph.includes('YYYY') ? `${d.month}/${yyyy}` : ph.includes(' / ') ? `${d.month} / ${yy}` : `${d.month}/${yy}`);
    } else if (exp) setValue(exp, `${d.month}/${d.year.slice(-2)}`);
    const mo = first(f, 'ccmonth'), yr = first(f, 'ccyear');
    if (mo) { if (!setValue(mo, d.month) && mo.tagName === 'SELECT') setValue(mo, MONTHS[+d.month - 1]); }
    if (yr) { if (!setValue(yr, yr.tagName === 'SELECT' ? d.year : yr.maxLength === 2 ? d.year.slice(-2) : d.year) && yr.tagName === 'SELECT') setValue(yr, d.year.slice(-2)); }
    setValue(first(f, 'cccvv'), d.cvv);
    setValue(first(f, 'zip'), d.zip);
  }
  const COUNTRY = { Egypt: 'EG', 'United States': 'US', USA: 'US', 'United Kingdom': 'GB', UK: 'GB', Canada: 'CA', Germany: 'DE', France: 'FR', Spain: 'ES', Italy: 'IT', Netherlands: 'NL', Australia: 'AU', India: 'IN', 'Saudi Arabia': 'SA', 'United Arab Emirates': 'AE', Turkey: 'TR', Brazil: 'BR', Mexico: 'MX', Japan: 'JP', China: 'CN', Russia: 'RU', Poland: 'PL', Sweden: 'SE', Norway: 'NO', Ireland: 'IE', Switzerland: 'CH' };
  function fillIdentity(group, m) {
    const f = group.fields, g = l => (m[l] || '').trim();
    const full = g('Full name') || [g('First name'), g('Last name')].filter(Boolean).join(' ');
    const put = (keys, v) => { const el = first(f, ...keys); if (el && v) setValue(el, v); };
    put(['fullname'], full); put(['first'], g('First name') || full.split(' ')[0]); put(['last'], g('Last name') || full.split(' ').slice(1).join(' '));
    put(['email'], g('Email')); put(['phone'], g('Phone')); put(['company'], g('Company'));
    put(['street'], [g('Address line 1'), g('Address line 2')].filter(Boolean).join(', ')); put(['addr1'], g('Address line 1')); put(['addr2'], g('Address line 2'));
    put(['city'], g('City')); put(['zip'], g('Postal code'));
    const st = first(f, 'state'); if (st && g('State / region')) setValue(st, g('State / region'));
    const co = first(f, 'country');
    if (co && g('Country')) { if (!setValue(co, g('Country')) && COUNTRY[g('Country')]) setValue(co, COUNTRY[g('Country')]); }
    const b = g('Birthday');
    if (b) {
      const [y, mo, d] = b.split(/[-/.]/);
      const el = first(f, 'bday'); if (el) setValue(el, el.type === 'date' ? b : `${d}/${mo}/${y}`);
      put(['bdayd'], d); put(['bdaym'], mo); put(['bdayy'], y);
    }
  }

  // ---------- Vault UI in a closed shadow root ----------
  let root, ui, groups = [], active = null, matchInfo = null;
  function mount() {
    if (ui) return;
    root = document.createElement('div');
    root.id = 'vault-ext-root';
    root.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    ui = root.attachShadow({ mode: 'closed' });
    ui.innerHTML = `<style>
      *{box-sizing:border-box;font:13px/1.4 "Segoe UI",system-ui,sans-serif}
      .btn{position:fixed;width:24px;height:24px;border-radius:8px;border:0;background:linear-gradient(135deg,#7b8cff,#a06bff);color:#fff;cursor:pointer;pointer-events:auto;display:none;align-items:center;justify-content:center;box-shadow:0 2px 8px #0005;padding:0}
      .btn svg{width:14px;height:14px}.btn .n{position:absolute;top:-6px;right:-6px;background:#ff6b7e;color:#fff;border-radius:99px;font-size:10px;min-width:15px;height:15px;display:grid;place-items:center;padding:0 3px}
      .menu{position:fixed;min-width:250px;max-width:340px;background:#151822;color:#eceff6;border:1px solid #2a3042;border-radius:14px;box-shadow:0 14px 40px #000a;pointer-events:auto;overflow:hidden}
      .menu h4{margin:0;padding:9px 12px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8b93a8;border-bottom:1px solid #2a3042;display:flex;justify-content:space-between}
      .item{display:flex;gap:10px;align-items:center;width:100%;padding:9px 12px;background:none;border:0;color:inherit;text-align:left;cursor:pointer}
      .item:hover{background:#232a3d}.item b{display:block;font-weight:600}.item small{color:#8b93a8;display:block}.item .av{width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,#7b8cff,#a06bff);display:grid;place-items:center;font-weight:700;flex:none}
      .warn{padding:10px 12px;color:#ffb454;background:#ffb4541a}.bad{padding:10px 12px;color:#ff6b7e;background:#ff6b7e1a}.muted{padding:10px 12px;color:#8b93a8}
      .banner{position:fixed;top:12px;right:12px;width:340px;background:#151822;color:#eceff6;border:1px solid #2a3042;border-radius:14px;box-shadow:0 14px 40px #000a;pointer-events:auto;padding:14px;display:grid;gap:10px}
      .banner.red{border-color:#ff6b7e}.banner h5{margin:0;font-size:14px}.row{display:flex;gap:8px;flex-wrap:wrap}
      .b{padding:7px 14px;border-radius:10px;border:1px solid #2a3042;background:#1c2130;color:#eceff6;cursor:pointer}.b.p{background:linear-gradient(135deg,#7b8cff,#a06bff);border:0;color:#fff;font-weight:600}
      .modal{position:fixed;inset:0;background:#0008;display:grid;place-items:center;pointer-events:auto}.box{width:380px;max-width:92vw;background:#151822;color:#eceff6;border:1px solid #2a3042;border-radius:18px;padding:20px;display:grid;gap:12px;box-shadow:0 20px 60px #000}
    </style><div id="layer"></div>`;
    document.documentElement.append(root);
  }
  const E = (tag, props = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e[k] = v; } for (const c of kids) if (c != null) e.append(c); return e; };
  const layer = () => { mount(); return ui.getElementById('layer'); };
  const LOGO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z"/></svg>';

  let iconBtn;
  function showIcon(field) {
    mount();
    if (!iconBtn) { iconBtn = E('button', { class: 'btn', title: 'Vault', onmousedown: e => e.preventDefault(), onclick: e => { if (e.isTrusted && active) openMenu(active); } }); iconBtn.innerHTML = LOGO; layer().append(iconBtn); }
    active = field;
    placeIcon();
  }
  function placeIcon() {
    if (!iconBtn || !active) return;
    const r = active.el.getBoundingClientRect();
    if (!visible(active.el)) { iconBtn.style.display = 'none'; return; }
    iconBtn.style.display = 'flex';
    iconBtn.style.left = Math.max(2, Math.min(innerWidth - 30, r.right - 30)) + 'px';
    iconBtn.style.top = (r.top + (r.height - 24) / 2) + 'px';
    const n = active.group.kind === 'card' || active.group.kind === 'identity' ? 0 : (matchInfo?.logins?.length || 0);
    iconBtn.querySelector('.n')?.remove();
    if (n) iconBtn.append(E('span', { class: 'n' }, String(n)));
  }
  function closeMenu() { ui?.querySelector('.menu')?.remove(); }
  function menuAt(field, ...parts) {
    closeMenu();
    const r = field.el.getBoundingClientRect();
    const m = E('div', { class: 'menu' }, ...parts);
    m.style.left = Math.max(6, Math.min(innerWidth - 350, r.left)) + 'px';
    m.style.top = Math.min(innerHeight - 60, r.bottom + 6) + 'px';
    layer().append(m);
    return m;
  }
  const initial = s => (s || '?').trim()[0]?.toUpperCase() || '?';
  const item = (title, sub, fn, letter) => E('button', { class: 'item', onclick: e => { if (e.isTrusted) { closeMenu(); fn(); } } }, E('span', { class: 'av' }, letter || initial(title)), E('span', {}, E('b', {}, title), sub ? E('small', {}, sub) : null));
  const header = (t, extra) => E('h4', {}, E('span', {}, t), extra || '');
  const statusMenu = (field, r) => {
    if (r.locked) return menuAt(field, header('Vault'), E('div', { class: 'muted' }, 'Vault is locked.'), item('Unlock Vault', 'Opens the app window', () => ask('show'), '🔒'));
    if (r.unpaired || r.error === 'unpaired') return menuAt(field, header('Vault'), E('div', { class: 'muted' }, 'Not connected yet. Click the Vault icon in the browser toolbar and enter the pairing code from Vault > Settings.'));
    if (r.error === 'host_missing') return menuAt(field, header('Vault'), E('div', { class: 'bad' }, 'The browser cannot find the Vault app. Open Vault once, then reload this page.'));
    if (r.error === 'app_not_running' || r.error === 'timeout') return menuAt(field, header('Vault'), E('div', { class: 'muted' }, 'Starting Vault… try again in a moment.'));
    return menuAt(field, header('Vault'), E('div', { class: 'bad' }, r.error || 'Something went wrong'));
  };

  async function openMenu(field) {
    const { group } = field;
    const kind = group.kind;
    if (kind === 'login' || kind === 'signup') {
      const r = await ask('match');
      if (r.logins === undefined) return statusMenu(field, r);
      matchInfo = r; placeIcon();
      const parts = [header('Vault', kind === 'signup' ? 'sign up' : 'sign in')];
      if (r.lookalike) parts.push(E('div', { class: 'bad' }, `This address looks like “${r.lookalike.title}” (${r.lookalike.site}) but is a different site. Vault will not fill here.`));
      if (!r.https) parts.push(E('div', { class: 'warn' }, 'This page is not secure (http). Anyone on the network could read what you type.'));
      for (const l of r.logins) parts.push(item(l.title, l.username, async () => { const d = await ask('fill', { id: l.id }); if (d.error) return toast(d.error); fillLogin(group, d); if (d.totp) offerCode(d.totp); }));
      if (!r.logins.length && !r.lookalike) parts.push(E('div', { class: 'muted' }, 'No saved login for this site.'));
      if (kind === 'signup') parts.push(item('Generate a strong password', 'Fills the new password fields', async () => { const g = await ask('generate'); if (g.password) { group.fields.filter(f => f.key === 'password' || f.key === 'newpassword').forEach(f => setValue(f.el, g.password)); toast('Password filled. Vault offers to save it when you submit.'); } }, '✦'));
      parts.push(item('Open Vault', '', () => ask('show'), '⌂'));
      menuAt(field, ...parts);
    } else if (kind === 'card') {
      if (!/^https:/.test(location.href) && location.hostname !== 'localhost') return menuAt(field, header('Vault'), E('div', { class: 'bad' }, 'Vault will not fill card details on a page that is not secure (http).'));
      const r = await ask('cards');
      if (!r.cards) return statusMenu(field, r);
      const parts = [header('Vault', 'cards')];
      for (const c of r.cards) parts.push(item(c.title, `•••• ${c.last4}${c.holder ? ' · ' + c.holder : ''}`, async () => { const d = await ask('fill_card', { id: c.id }); if (d.error) return toast(d.error); fillCard(group, d); }, '▭'));
      if (!r.cards.length) parts.push(E('div', { class: 'muted' }, 'No saved cards.'));
      menuAt(field, ...parts);
    } else if (kind === 'identity') {
      const r = await ask('identities');
      if (!r.identities) return statusMenu(field, r);
      const parts = [header('Vault', 'addresses')];
      for (const i of r.identities) parts.push(item(i.title, i.name || i.email, async () => { const d = await ask('fill_identity', { id: i.id }); if (d.error) return toast(d.error); fillIdentity(group, d); }, '☺'));
      if (!r.identities.length) parts.push(E('div', { class: 'muted' }, 'No saved addresses.'));
      menuAt(field, ...parts);
    }
  }

  // ---------- small messages ----------
  function toast(text) {
    const b = E('div', { class: 'banner' }, E('div', {}, text));
    layer().append(b);
    setTimeout(() => b.remove(), 4000);
  }
  function offerCode(code) {
    const b = E('div', { class: 'banner' }, E('h5', {}, 'One-time code'), E('div', {}, `${code.slice(0, 3)} ${code.slice(3)}`), E('div', { class: 'row' }, E('button', { class: 'b p', onclick: e => { if (e.isTrusted) { navigator.clipboard?.writeText(code).catch(() => {}); b.remove(); } } }, 'Copy'), E('button', { class: 'b', onclick: () => b.remove() }, 'Close')));
    layer().append(b);
    setTimeout(() => b.remove(), 20000);
  }
  function banner(red, title, text, buttons) {
    ui?.querySelector('.banner.keep')?.remove();
    const b = E('div', { class: 'banner keep' + (red ? ' red' : '') }, E('h5', {}, title), text ? E('div', {}, text) : null, E('div', { class: 'row' }, ...buttons.map(([label, primary, fn]) => E('button', { class: 'b' + (primary ? ' p' : ''), onclick: e => { if (e.isTrusted) { b.remove(); fn?.(); } } }, label))));
    layer().append(b);
    return b;
  }

  // ---------- save prompts ----------
  function captureCandidate() {
    for (const g of groups.filter(g => g.kind === 'login' || g.kind === 'signup')) {
      const pws = g.fields.filter(f => f.key === 'password' || f.key === 'newpassword').map(f => f.el).filter(e => e.value);
      if (!pws.length) continue;
      const user = first(g.fields, 'username', 'email')?.value || '';
      const d = { url: location.href, username: user, password: pws[0].value };
      bg('save-candidate', d);
      if (isTop) setTimeout(() => { if (document.visibilityState === 'visible') offerSave(d); }, 1500); // pages that do not navigate away
      return;
    }
  }
  async function offerSave(c) {
    const s = await bg('settings');
    if (s.offerSave === false || (s.never || []).includes(location.hostname)) return;
    const r = await ask('check_save', { username: c.username, password: c.password });
    if (!r.action || r.action === 'none') return;
    const label = r.action === 'update' ? 'Update the saved password' : 'Save this login';
    banner(false, `${label}?`, `${c.username || 'No username'} on ${location.hostname}`, [
      [r.action === 'update' ? 'Update' : 'Save', true, async () => { const x = await ask('save', { username: c.username, password: c.password }); toast(x.error ? x.error : r.action === 'update' ? 'Password updated in Vault' : 'Saved to Vault'); }],
      ['Not now', false], ['Never for this site', false, async () => { const cur = await bg('settings'); chrome.storage.local.set({ never: [...(cur.never || []), location.hostname] }); }]]);
  }

  // ---------- detection loop ----------
  let timer = 0, lastSig = '';
  function rescan() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      groups = scan();
      const sig = groups.map(g => g.kind + g.fields.length).join('|');
      for (const g of groups) for (const f of g.fields) f.group = g;
      if (!groups.length) { iconBtn && (iconBtn.style.display = 'none'); return; }
      if (sig !== lastSig) {
        lastSig = sig;
        const login = groups.find(g => g.kind === 'login' || g.kind === 'signup');
        if (login) {
          const r = await ask('match');
          if (r.logins) {
            matchInfo = r; bg('badge', { n: r.logins.length }); placeIcon();
            if (r.lookalike && isTop) banner(true, 'Look-alike site', `This address looks like “${r.lookalike.title}” (${r.lookalike.site}) from your Vault but it is a different site. Vault will not fill here. Check the address bar before typing anything.`, [['I understand', false]]);
            const s = await bg('settings');
            if (s.autofill && r.logins.length === 1 && r.https && !r.lookalike && isTop && login.kind === 'login' && !login.fields.some(f => f.el.value)) {
              const d = await ask('fill', { id: r.logins[0].id }); if (!d.error) fillLogin(login, d);
            }
          }
        }
      }
    }, 350);
  }
  document.addEventListener('focusin', e => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    for (const g of groups) { const f = g.fields.find(x => x.el === el); if (f) { showIcon(f); return; } }
    if (!(el.closest && el.closest('#vault-ext-root'))) { closeMenu(); if (iconBtn) iconBtn.style.display = 'none'; active = null; }
  }, true);
  document.addEventListener('mousedown', e => { if (!e.composedPath().includes(root)) closeMenu(); }, true);
  addEventListener('scroll', () => { placeIcon(); closeMenu(); }, true);
  addEventListener('resize', placeIcon);
  document.addEventListener('submit', () => captureCandidate(), true);
  document.addEventListener('click', e => { const b = e.target.closest?.('button, input[type=submit], [role=button]'); if (b && /sign.?in|log.?in|register|sign.?up|create|continue|submit|next/i.test((b.textContent || b.value || '') + ' ' + (b.type || ''))) captureCandidate(); }, true);
  new MutationObserver(rescan).observe(document.documentElement, { childList: true, subtree: true });
  rescan();

  // a login captured just before the page navigated
  if (isTop) bg('pending-save').then(r => { if (r.candidate && matchSite(r.candidate.url)) setTimeout(() => offerSave(r.candidate), 600); });
  const matchSite = u => { try { const a = new URL(u).hostname.split('.').slice(-2).join('.'), b = location.hostname.split('.').slice(-2).join('.'); return a === b; } catch { return false; } };

  // ---------- messages from the popup ----------
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type === 'fill-login') {
      (async () => {
        const g = groups.find(x => x.kind === 'login' || x.kind === 'signup');
        const d = await ask('fill', { id: msg.id });
        if (d.error) return reply({ error: d.error });
        if (!g) return reply({ error: 'No login form on this page' });
        fillLogin(g, d); if (d.totp) offerCode(d.totp); reply({ ok: true });
      })();
      return true;
    }
    return false;
  });

  // ---------- passkeys (requests come from passkey.js in the page world) ----------
  addEventListener('message', async e => {
    if (e.source !== window || !e.data || e.data.__vault !== 'pk-req' || !isTop && false) return;
    const { id, cmd, data } = e.data;
    const done = r => window.postMessage({ __vault: 'pk-res', id, ...r }, '*');
    const modal = (title, text, rows, buttons) => new Promise(res => {
      const m = E('div', { class: 'modal' }, E('div', { class: 'box' }, E('h5', { style: 'margin:0;font-size:16px' }, title), E('div', { style: 'color:#8b93a8' }, text), ...rows,
        E('div', { class: 'row' }, ...buttons.map(([label, primary, v]) => E('button', { class: 'b' + (primary ? ' p' : ''), onclick: ev => { if (ev.isTrusted) { m.remove(); res(v); } } }, label)))));
      layer().append(m);
    });
    try {
      const ping = await ask('ping');
      if (ping.error || ping.locked) return done({ fallback: true });
      if (cmd === 'pk_create') {
        const probe = await ask('pk_list', { rpId: data.rpId });
        if (probe.unpaired || probe.locked || probe.error) return done({ fallback: true });
        const v = await modal('Create a passkey?', `${data.rpName || data.rpId}${data.userName ? ' · ' + data.userName : ''}`, [E('div', {}, 'It will be saved in Vault on this PC.')], [['Create passkey', true, 'ok'], ['Use the browser instead', false, 'fallback'], ['Cancel', false, 'cancel']]);
        if (v !== 'ok') return done(v === 'fallback' ? { fallback: true } : { cancel: true });
        const r = await ask('pk_create', data);
        return done(r);
      }
      if (cmd === 'pk_get') {
        const r = await ask('pk_list', { rpId: data.rpId });
        if (!r.passkeys) return done({ fallback: true });
        let list = r.passkeys.filter(p => !data.allow.length || data.allow.includes(p.credentialId));
        if (!list.length) return done({ fallback: true });
        let pick = list[0].id;
        const rows = list.map(p => E('button', { class: 'item', style: 'border:1px solid #2a3042;border-radius:12px', onclick: ev => { if (ev.isTrusted) { pick = p.id; ev.currentTarget.parentElement.querySelectorAll('.item').forEach(x => x.style.borderColor = '#2a3042'); ev.currentTarget.style.borderColor = '#7b8cff'; } } }, E('span', { class: 'av' }, initial(p.userName || p.displayName)), E('span', {}, E('b', {}, p.userName || p.displayName || 'Passkey'), E('small', {}, data.rpId))));
        const v = await modal('Sign in with a passkey?', data.rpId, rows, [['Sign in', true, 'ok'], ['Use the browser instead', false, 'fallback'], ['Cancel', false, 'cancel']]);
        if (v !== 'ok') return done(v === 'fallback' ? { fallback: true } : { cancel: true });
        return done(await ask('pk_get', { ...data, id: pick }));
      }
      done({ error: 'unknown request' });
    } catch (err) { done({ error: String(err) }); }
  });
})();
