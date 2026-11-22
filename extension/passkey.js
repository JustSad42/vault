// Runs in the page's own world so it can stand in for navigator.credentials. Requests go to Vault through content.js;
// anything Vault cannot or should not handle falls back to the browser's own implementation.
(() => {
  if (!navigator.credentials || window.__vaultPk) return;
  Object.defineProperty(window, '__vaultPk', { value: true });
  const origCreate = navigator.credentials.create.bind(navigator.credentials);
  const origGet = navigator.credentials.get.bind(navigator.credentials);

  const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a.buffer; };
  const utf8 = s => new TextEncoder().encode(s).buffer;
  const buf = x => (x instanceof ArrayBuffer ? x : x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength));

  let n = 0;
  const pend = new Map();
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.__vault !== 'pk-res') return;
    const p = pend.get(e.data.id);
    if (p) { pend.delete(e.data.id); p(e.data); }
  });
  const call = (cmd, data) => new Promise(res => { const id = ++n; pend.set(id, res); window.postMessage({ __vault: 'pk-req', id, cmd, data }, '*'); });
  const fail = (msg, name = 'NotAllowedError') => new DOMException(msg, name);

  const make = (proto, own) => { const o = Object.create(proto || Object.prototype); for (const [k, v] of Object.entries(own)) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); return o; };
  function credential(idB64, response, kind) {
    const raw = unb64u(idB64);
    const c = make(window.PublicKeyCredential?.prototype, {
      id: idB64, rawId: raw, type: 'public-key', authenticatorAttachment: 'platform', response,
      getClientExtensionResults: () => ({}),
    });
    c.toJSON = () => ({ id: idB64, rawId: idB64, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: kind === 'create'
        ? { clientDataJSON: b64u(response.clientDataJSON), attestationObject: b64u(response.attestationObject), transports: ['internal'], authenticatorData: b64u(response.getAuthenticatorData()), publicKey: b64u(response.getPublicKey()), publicKeyAlgorithm: -7 }
        : { clientDataJSON: b64u(response.clientDataJSON), authenticatorData: b64u(response.authenticatorData), signature: b64u(response.signature), userHandle: response.userHandle ? b64u(response.userHandle) : undefined } });
    return c;
  }

  navigator.credentials.create = async function (opts) {
    const pk = opts && opts.publicKey;
    if (!pk || !(pk.pubKeyCredParams || []).some(p => p.alg === -7) || (opts.signal && opts.signal.aborted)) return origCreate(opts);
    const rpId = (pk.rp && pk.rp.id) || location.hostname;
    const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge: b64u(pk.challenge), origin: location.origin, crossOrigin: false });
    const r = await call('pk_create', { rpId, rpName: pk.rp && pk.rp.name, userName: pk.user.name, displayName: pk.user.displayName, userHandle: b64u(pk.user.id), clientDataJSON, origin: location.origin,
      excludeIds: (pk.excludeCredentials || []).map(c => b64u(c.id)) });
    if (r.fallback) return origCreate(opts);
    if (r.cancel) throw fail('The operation either timed out or was not allowed.');
    if (r.excluded) throw fail('The authenticator was previously registered.', 'InvalidStateError');
    if (r.error || !r.credentialId) throw fail(r.error || 'Vault could not create the passkey.');
    const AR = window.AuthenticatorAttestationResponse && window.AuthenticatorAttestationResponse.prototype;
    const response = make(AR, { clientDataJSON: utf8(clientDataJSON), attestationObject: unb64u(r.attestationObject),
      getTransports: () => ['internal'], getAuthenticatorData: () => unb64u(r.authData), getPublicKey: () => unb64u(r.publicKey), getPublicKeyAlgorithm: () => -7 });
    return credential(r.credentialId, response, 'create');
  };

  navigator.credentials.get = async function (opts) {
    const pk = opts && opts.publicKey;
    if (!pk || opts.mediation === 'conditional' || (opts.signal && opts.signal.aborted)) return origGet(opts);
    const rpId = pk.rpId || location.hostname;
    const clientDataJSON = JSON.stringify({ type: 'webauthn.get', challenge: b64u(pk.challenge), origin: location.origin, crossOrigin: false });
    const r = await call('pk_get', { rpId, clientDataJSON, origin: location.origin, allow: (pk.allowCredentials || []).map(c => b64u(c.id)) });
    if (r.fallback) return origGet(opts);
    if (r.cancel) throw fail('The operation either timed out or was not allowed.');
    if (r.error || !r.signature) throw fail(r.error || 'Vault could not use the passkey.');
    const AR = window.AuthenticatorAssertionResponse && window.AuthenticatorAssertionResponse.prototype;
    const response = make(AR, { clientDataJSON: utf8(clientDataJSON), authenticatorData: unb64u(r.authenticatorData), signature: unb64u(r.signature), userHandle: r.userHandle ? unb64u(r.userHandle) : null });
    return credential(r.credentialId, response, 'get');
  };
})();
