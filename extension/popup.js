// TheoChat — Popup control rig
// Talks to the active Twitch tab's content script + the Railway service /health

const HEALTH_POLL_MS = 4000; // popup-only tick — not server quota burn

const els = {
  svcLed:     document.querySelector('[data-signal="service"] .signal__led'),
  ytLed:      document.querySelector('[data-signal="youtube"] .signal__led'),
  twLed:      document.querySelector('[data-signal="twitch"] .signal__led'),
  svcState:   document.getElementById('svcState'),
  ytState:    document.getElementById('ytState'),
  twState:    document.getElementById('twState'),
  toggle:     document.getElementById('toggle'),
  toggleState:document.getElementById('toggleState'),
  toggleHint: document.getElementById('toggleHint'),
  delaySlider:document.getElementById('delaySlider'),
  delayReadout:document.getElementById('delayReadout'),
  delayExplain:document.getElementById('delayExplain'),
  statPending:document.getElementById('statPending'),
  statCount:  document.getElementById('statCount'),
  statLast:   document.getElementById('statLast'),
  openOptions:document.getElementById('openOptions'),
  version:    document.getElementById('version'),
  endpoint:   document.getElementById('endpoint'),
  alert:      document.getElementById('alert'),
  alertText:  document.getElementById('alertText'),
  reconnect:  document.getElementById('reconnectBtn'),
};

let state = {
  enabled: true,
  delayMs: 0,
  connected: false,
  pending: 0,
  messagesToday: 0,
  lastMessageAt: null,
  wsUrl: '',
  svcOk: false,
  ytLive: false,
  lastError: null,
  lastHeartbeat: null,
};

let healthTimer = null;

// ─── Init ────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  chrome.runtime.sendMessage({ type: 'theochat.popupOpen', value: true });
  els.version.textContent = `v${chrome.runtime.getManifest().version}`;

  const stored = await chrome.storage.sync.get({ enabled: true, delayMs: 0, wsUrl: '' });
  state.enabled = stored.enabled;
  state.delayMs = stored.delayMs;
  state.wsUrl = stored.wsUrl;
  render();

  els.toggle.addEventListener('click', onToggle);
  els.delaySlider.addEventListener('input', onDelayInput);
  els.openOptions.addEventListener('click', onOpenOptions);
  els.reconnect.addEventListener('click', onReconnect);

  pollHealth();
  healthTimer = setInterval(pollHealth, HEALTH_POLL_MS);
  queryActiveTabStatus();
});

window.addEventListener('unload', () => {
  chrome.runtime.sendMessage({ type: 'theochat.popupOpen', value: false });
  if (healthTimer) clearInterval(healthTimer);
});

// ─── Render ──────────────────────────────────────────────────────

function render() {
  els.svcLed.dataset.state = state.svcOk ? 'ok' : 'off';
  els.svcState.textContent = state.svcOk ? 'LIVE' : 'DOWN';

  els.ytLed.dataset.state = state.ytLive ? 'live' : 'idle';
  els.ytState.textContent = state.ytLive ? 'STREAM' : 'IDLE';

  const injecting = state.enabled && state.connected;
  els.twLed.dataset.state = injecting ? 'ok' : (state.enabled ? 'warn' : 'off');
  els.twState.textContent = injecting ? 'ACTIVE' : (state.enabled ? 'STANDBY' : 'PAUSED');

  els.toggle.setAttribute('aria-pressed', String(state.enabled));
  els.toggleState.textContent = state.enabled ? 'BRIDGE ON' : 'BRIDGE OFF';
  els.toggleHint.textContent = state.enabled
    ? 'Injecting YouTube into Twitch chat'
    : 'YouTube messages are hidden';

  els.delaySlider.value = String(Math.round(state.delayMs / 1000));
  const seconds = Math.round(state.delayMs / 1000);
  els.delayReadout.textContent = seconds === 0 ? '0s' : `${seconds}s`;
  els.delaySlider.style.setProperty('--fill', `${(seconds / 30) * 100}%`);

  // Build delay explanation with safe DOM methods (no innerHTML)
  els.delayExplain.textContent = '';
  if (seconds === 0) {
    els.delayExplain.appendChild(document.createTextNode(
      'No delay — messages appear the instant YouTube sends them.'
    ));
  } else {
    els.delayExplain.appendChild(document.createTextNode('Messages are held '));
    const strong = document.createElement('strong');
    strong.textContent = `${seconds}s`;
    els.delayExplain.appendChild(strong);
    els.delayExplain.appendChild(document.createTextNode(
      ' before appearing. Mods get that window to delete on YouTube — deleted messages never show.'
    ));
  }

  els.statPending.textContent = String(state.pending);
  els.statCount.textContent = formatCount(state.messagesToday);
  els.statLast.textContent = formatRelative(state.lastMessageAt);

  els.endpoint.textContent = state.wsUrl || 'not configured';

  // Alert logic — only show when something's actionable
  const showAlert = state.enabled && (!state.connected || state.lastError);
  els.alert.hidden = !showAlert;
  if (showAlert) {
    if (state.lastError && Date.now() - (state.lastError.at || 0) < 120000) {
      // Recent error (<2 min old)
      els.alert.dataset.state = 'err';
      els.alertText.textContent = state.lastError.message;
    } else if (!state.connected) {
      els.alert.dataset.state = 'idle';
      els.alertText.textContent = 'Disconnected from service';
    } else {
      els.alert.dataset.state = 'ok';
      els.alertText.textContent = 'All systems nominal';
    }
  }
}

// ─── Event handlers ──────────────────────────────────────────────

async function onToggle() {
  state.enabled = !state.enabled;
  await chrome.storage.sync.set({ enabled: state.enabled });
  sendToActiveTab({ type: 'theochat.setEnabled', value: state.enabled });
  render();
}

async function onDelayInput(e) {
  const seconds = parseInt(e.target.value, 10) || 0;
  state.delayMs = seconds * 1000;
  await chrome.storage.sync.set({ delayMs: state.delayMs });
  sendToActiveTab({ type: 'theochat.setDelay', value: state.delayMs });
  render();
}

function onOpenOptions(e) {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
}

async function onReconnect() {
  els.reconnect.textContent = 'RECONNECTING';
  els.reconnect.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('twitch.tv')) {
      await chrome.tabs.sendMessage(tab.id, { type: 'theochat.reconnect' });
    }
    // Clear last error optimistically
    state.lastError = null;
    setTimeout(queryActiveTabStatus, 500);
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    els.reconnect.textContent = 'RECONNECT';
    els.reconnect.disabled = false;
  }, 1200);
}

// ─── Data fetchers ───────────────────────────────────────────────

async function pollHealth() {
  if (!state.wsUrl) {
    state.svcOk = false;
    state.ytLive = false;
    render();
    return;
  }
  try {
    const httpUrl = state.wsUrl
      .replace(/^ws(s)?:/, 'http$1:')
      .replace(/\?.*$/, '')
      .replace(/\/$/, '') + '/health';
    const res = await fetch(httpUrl, { cache: 'no-store' });
    const data = await res.json();
    state.svcOk = data.status === 'ok';
    state.ytLive = !!data.streaming;
    render();
  } catch {
    state.svcOk = false;
    state.ytLive = false;
    render();
  }
}

async function queryActiveTabStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('twitch.tv')) {
      state.connected = false;
      render();
      return;
    }
    const reply = await chrome.tabs.sendMessage(tab.id, { type: 'theochat.getStatus' });
    if (reply) {
      state.connected = !!reply.connected;
      state.pending = reply.pending ?? 0;
      state.messagesToday = reply.messagesToday ?? 0;
      state.lastMessageAt = reply.lastMessageAt ?? null;
      state.lastError = reply.lastError ?? null;
      state.lastHeartbeat = reply.lastHeartbeat ?? null;
    }
    render();
  } catch {
    state.connected = false;
    render();
  }
}

async function sendToActiveTab(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('twitch.tv')) {
      await chrome.tabs.sendMessage(tab.id, message);
    }
  } catch { /* settings still saved in storage */ }
}

// ─── Formatters ──────────────────────────────────────────────────

function formatCount(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n / 1000)}K`;
}

function formatRelative(ts) {
  if (!ts) return '—';
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 5) return 'now';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h`;
}
