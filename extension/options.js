// TheoChat — Advanced / options page
// Manual override for the auto-discovered WebSocket URL + optional token.

const els = {
  wsUrl:    document.getElementById('wsUrl'),
  wsToken:  document.getElementById('wsToken'),
  wsHint:   document.getElementById('wsHint'),
  save:     document.getElementById('saveBtn'),
  test:     document.getElementById('testBtn'),
  reset:    document.getElementById('resetBtn'),
  status:   document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  version:  document.getElementById('version'),
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  els.version.textContent = chrome.runtime.getManifest().version;

  const stored = await chrome.storage.sync.get({ wsUrl: '', wsToken: '' });
  els.wsUrl.value   = stored.wsUrl || '';
  els.wsToken.value = stored.wsToken || '';

  els.save.addEventListener('click', save);
  els.test.addEventListener('click', testConnection);
  els.reset.addEventListener('click', resetToAuto);
  els.wsUrl.addEventListener('input', validateUrl);

  validateUrl();
}

function validateUrl() {
  const v = els.wsUrl.value.trim();
  if (!v) {
    els.wsUrl.classList.remove('is-invalid');
    return true;
  }
  const ok = /^wss?:\/\/.+/.test(v);
  els.wsUrl.classList.toggle('is-invalid', !ok);
  return ok;
}

async function save() {
  if (!validateUrl()) {
    return setStatus('err', 'URL must start with ws:// or wss://');
  }
  await chrome.storage.sync.set({
    wsUrl:   els.wsUrl.value.trim(),
    wsToken: els.wsToken.value.trim(),
  });
  setStatus('ok', 'Saved. Reload the Twitch tab to apply.');
}

async function resetToAuto() {
  await chrome.storage.sync.remove(['wsUrl', 'wsToken']);
  els.wsUrl.value = '';
  els.wsToken.value = '';
  setStatus('ok', 'Reset. Extension will auto-fetch the URL on next load.');
}

async function testConnection() {
  const url = els.wsUrl.value.trim();
  const token = els.wsToken.value.trim();
  if (!url) return setStatus('warn', 'Enter a URL to test.');
  if (!validateUrl()) return setStatus('err', 'URL must start with ws:// or wss://');

  setStatus('warn', 'Connecting…');
  const full = token ? `${url}?token=${encodeURIComponent(token)}` : url;

  try {
    const ws = new WebSocket(full);
    const t = setTimeout(() => { ws.close(); setStatus('err', 'Connection timed out.'); }, 5000);

    ws.onopen = () => {
      clearTimeout(t);
      setStatus('ok', 'Connected.');
      ws.close();
    };
    ws.onerror = () => {
      clearTimeout(t);
      setStatus('err', 'Connection failed.');
    };
  } catch (e) {
    setStatus('err', 'Invalid URL.');
  }
}

function setStatus(state, text) {
  els.status.dataset.state = state;
  els.statusText.textContent = text;
}
