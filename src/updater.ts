import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { bytes, dialog, err, h, hooks, icon, put, toast } from './kit';

// Updates are published as GitHub releases and every one is checked against the signature key built into this app.
let showing = false;

function updateDialog(u: Update, current: string) {
  if (showing) return;
  showing = true;
  const bar = h('i'), status = h('p', { class: 'hint' }, '');
  const prog = h('div', { class: 'meter', hidden: true }, h('div', { class: 'track' }, bar));
  const go = h('button', { class: 'primary' }, icon('download'), h('span', {}, 'Install and restart'));
  const notes = (u.body ?? '').trim();
  const d = dialog(close => [h('h3', {}, `Vault ${u.version} is available`), h('p', { class: 'hint' }, `You have ${current}. The update is downloaded, checked against its signature and installed; Vault restarts by itself. Your vault is not touched.`),
    notes ? h('pre', { class: 'notes box' }, notes) : null, prog, status, h('div', { class: 'btns' }, go, h('button', { onclick: close }, 'Later'))]);
  d.addEventListener('close', () => { showing = false; });
  go.addEventListener('click', async () => {
    go.setAttribute('disabled', ''); go.classList.add('busy'); prog.hidden = false; status.textContent = 'Downloading…';
    let total = 0, got = 0;
    try {
      await u.downloadAndInstall(ev => {
        if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
        else if (ev.event === 'Progress') { got += ev.data.chunkLength; bar.style.width = total ? `${Math.min(100, (got / total) * 100)}%` : '60%'; status.textContent = `Downloading… ${bytes(got)}${total ? ' of ' + bytes(total) : ''}`; }
        else if (ev.event === 'Finished') { bar.style.width = '100%'; status.textContent = 'Installing…'; }
      });
      status.textContent = 'Restarting…';
      await relaunch();
    } catch (e) { go.removeAttribute('disabled'); go.classList.remove('busy'); put(status, document.createTextNode('Update failed: ' + String(e))); err(e); }
  });
}

hooks.checkUpdate = async (manual: boolean) => {
  try {
    const u = await check();
    if (!u) { if (manual) toast('Vault is up to date'); return; }
    updateDialog(u, await getVersion());
  } catch (e) { if (manual) err('Could not check for updates: ' + String(e)); }
};
