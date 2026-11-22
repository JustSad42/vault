const app = document.getElementById('app');
const E = (t, p = {}, ...k) => { const e = document.createElement(t); for (const [a, v] of Object.entries(p)) { if (a === 'class') e.className = v; else if (a.startsWith('on')) e.addEventListener(a.slice(2), v); else e[a] = v; } for (const c of k) if (c != null) e.append(c); return e; };
const req = (cmd, data = {}) => new Promise(r => chrome.runtime.sendMessage({ type: 'req', cmd, data }, x => r(x || { error: 'no answer' })));
const LOGO = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z"/></svg>';

async function draw() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const head = E('header', {}, E('div', { class: 'logo' }), E('b', {}, 'Vault'));
  head.firstChild.innerHTML = LOGO;
  const main = E('main');
  app.replaceChildren(head, main);
  const note = (t, c = 'hint') => main.append(E('p', { class: c }, t));
  const ping = await req('ping');
  if (ping.error === 'host_missing') { note('Chrome cannot find the Vault app yet. Open Vault once (it registers the connection), then reopen this popup.', 'bad'); return; }
  if (ping.error) { note('Starting Vault… reopen this popup in a moment.'); return; }
  const { token } = await chrome.storage.local.get('token');
  if (ping.locked && token) {
    note('Vault is locked.'); main.append(E('button', { class: 'p', onclick: () => { req('show'); window.close(); } }, 'Unlock Vault')); return;
  }
  const probe = token ? await req('match', { url: url.startsWith('http') ? url : 'https://example.invalid' }) : { unpaired: true };
  if (probe.unpaired || !token) {
    note('Connect this browser to Vault. In Vault open Settings > Browser extension > Pair, then type the six-digit code here.');
    const code = E('input', { maxLength: 6, placeholder: '000000', inputMode: 'numeric' });
    const msg = E('p', { class: 'hint' });
    main.append(code, E('button', { class: 'p', onclick: async () => {
      if (ping.locked) { msg.textContent = 'Unlock Vault first.'; req('show'); return; }
      const r = await req('pair', { code: code.value.trim(), name: /Edg\//.test(navigator.userAgent) ? 'Microsoft Edge' : 'Google Chrome' });
      if (r.token) draw(); else { msg.className = 'bad'; msg.textContent = r.error || 'Could not pair'; }
    } }, 'Connect'), msg);
    return;
  }
  if (probe.locked) { note('Vault is locked.'); main.append(E('button', { class: 'p', onclick: () => { req('show'); window.close(); } }, 'Unlock Vault')); return; }
  if (/^https?:/.test(url)) {
    if (probe.lookalike) note(`This address looks like “${probe.lookalike.title}” (${probe.lookalike.site}) but is a different site. Vault will not fill here.`, 'bad');
    for (const l of probe.logins || []) {
      main.append(E('div', { class: 'login' }, E('div', { class: 't' }, E('b', {}, l.title), E('small', {}, l.username)),
        E('button', { class: 'p', onclick: async () => { const r = await chrome.tabs.sendMessage(tab.id, { type: 'fill-login', id: l.id }).catch(e => ({ error: String(e) })); if (r && r.error) note(r.error, 'bad'); else window.close(); } }, 'Fill')));
    }
    if (!(probe.logins || []).length && !probe.lookalike) note('No saved login for this site.');
    if (probe.passkeys) note(`${probe.passkeys} passkey${probe.passkeys === 1 ? '' : 's'} saved for this site.`, 'ok');
  } else note('Open a website to see its logins.');
  const s = await chrome.storage.local.get({ autofill: false, offerSave: true });
  const box = (key, text) => { const c = E('input', { type: 'checkbox', checked: s[key], onchange: () => chrome.storage.local.set({ [key]: c.checked }) }); return E('label', {}, c, text); };
  main.append(box('offerSave', 'Offer to save new logins'), box('autofill', 'Fill automatically when only one login matches'), E('button', { onclick: () => { req('show'); window.close(); } }, 'Open Vault'));
}
draw();
