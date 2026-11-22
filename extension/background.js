importScripts('host.js');

let port = null;
const pending = new Map();
let seq = 0;

function connect() {
  port = chrome.runtime.connectNative(VAULT_HOST);
  port.onMessage.addListener(m => { const p = pending.get(m.rid); if (p) { pending.delete(m.rid); p(m); } });
  port.onDisconnect.addListener(() => {
    const msg = chrome.runtime.lastError?.message || '';
    const err = /not found|forbidden/i.test(msg) ? 'host_missing' : 'app_not_running';
    for (const p of pending.values()) p({ error: err });
    pending.clear();
    port = null;
  });
}

async function send(cmd, data = {}, useToken = true) {
  if (!port) connect();
  const id = ++seq;
  const { token } = await chrome.storage.local.get('token');
  return new Promise(res => {
    const timer = setTimeout(() => { pending.delete(id); res({ error: 'timeout' }); }, 20000);
    pending.set(id, m => { clearTimeout(timer); res(m); });
    try { port.postMessage({ ...data, rid: id, cmd, token: useToken ? token : undefined }); }
    catch (e) { pending.delete(id); clearTimeout(timer); res({ error: 'app_not_running' }); }
  });
}

const candidates = new Map(); // tabId -> { url, username, password, ts }

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const tabId = sender.tab?.id;
    if (msg.type === 'req') {
      const data = { ...msg.data };
      data.top = sender.tab?.url ?? data.url;            // the app refuses frames from a different site than the tab
      if (!data.url) data.url = data.top;
      const r = await send(msg.cmd, data, msg.cmd !== 'pair' && msg.cmd !== 'ping' && msg.cmd !== 'show');
      if (msg.cmd === 'pair' && r.token) await chrome.storage.local.set({ token: r.token });
      reply(r);
    } else if (msg.type === 'badge' && tabId != null) {
      chrome.action.setBadgeText({ tabId, text: msg.n ? String(msg.n) : '' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#7b8cff' });
      reply({});
    } else if (msg.type === 'save-candidate' && tabId != null) {
      candidates.set(tabId, { ...msg.data, ts: Date.now() });
      reply({});
    } else if (msg.type === 'pending-save' && tabId != null) {
      const c = candidates.get(tabId);
      if (c && Date.now() - c.ts < 90000) { candidates.delete(tabId); reply({ candidate: c }); } else reply({});
    } else if (msg.type === 'settings') {
      reply(await chrome.storage.local.get({ autofill: false, offerSave: true, never: [] }));
    } else reply({});
  })();
  return true;
});

chrome.tabs.onRemoved.addListener(id => candidates.delete(id));
