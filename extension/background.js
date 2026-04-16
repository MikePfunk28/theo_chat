// TheoChat — Background service
// Polls Railway /health to update the extension badge icon with live status.
// Runs as a persistent background script (Firefox/Zen MV3).

const POLL_INTERVAL = 30 * 1000; // 30s — lightweight, just one small fetch
let lastStreaming = false;
let wsUrl = '';

async function getWsUrl() {
  try {
    const stored = await chrome.storage.sync.get({ wsUrl: '' });
    if (stored.wsUrl) return stored.wsUrl;
    const res = await fetch('https://t3yt.mikepfunk.com/api/config', { cache: 'no-store' });
    const data = await res.json();
    return data.wsUrl || '';
  } catch {
    return '';
  }
}

async function checkLiveStatus() {
  try {
    if (!wsUrl) wsUrl = await getWsUrl();
    if (!wsUrl) {
      setBadge('', '');
      return;
    }

    const healthUrl = wsUrl.replace(/^ws(s)?:/, 'http$1:').replace(/\?.*$/, '').replace(/\/$/, '') + '/health';
    const res = await fetch(healthUrl, { cache: 'no-store' });
    const data = await res.json();

    if (data.streaming) {
      setBadge('LIVE', '#ff0000');
      if (!lastStreaming) {
        // Just went live — notify
        chrome.notifications.create('theochat-live', {
          type: 'basic',
          iconUrl: 'icon128.png',
          title: 'TheoChat',
          message: 'YouTube stream is live — chat bridge active',
        });
      }
    } else if (data.status === 'ok') {
      setBadge('', '');
      if (lastStreaming) {
        // Stream just ended
        chrome.notifications.create('theochat-ended', {
          type: 'basic',
          iconUrl: 'icon128.png',
          title: 'TheoChat',
          message: 'YouTube stream ended — bridge idle',
        });
      }
    } else {
      setBadge('ERR', '#888888');
    }

    lastStreaming = data.streaming;
  } catch {
    setBadge('', '');
  }
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// Poll on interval
setInterval(checkLiveStatus, POLL_INTERVAL);

// Also check immediately on startup
checkLiveStatus();

// Re-check when storage changes (user updated WS URL)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.wsUrl) {
    wsUrl = changes.wsUrl.newValue || '';
    checkLiveStatus();
  }
});
