// TheoChat — Background service
// Polls Railway /health to update the extension badge icon with live status.
// Runs as a persistent background script (Firefox/Zen MV3).

const POLL_INTERVAL = 30 * 1000; // 30s — lightweight, just one small fetch
let lastStreaming = false;
let wsUrl = '';
let targetTwitchChannel = 'theo';
let popupOpen = false;

function isTargetTwitchUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'www.twitch.tv' && parsed.hostname !== 'twitch.tv') return false;
    const path = parsed.pathname.toLowerCase();
    return path === `/${targetTwitchChannel}` ||
           path.startsWith(`/${targetTwitchChannel}/`) ||
           path.startsWith(`/popout/${targetTwitchChannel}/`);
  } catch {
    return false;
  }
}

async function hasTargetTabOpen() {
  const tabs = await chrome.tabs.query({});
  return tabs.some((tab) => typeof tab.url === 'string' && isTargetTwitchUrl(tab.url));
}

async function getRuntimeConfig() {
  const stored = await chrome.storage.sync.get({ wsUrl: '' });
  try {
    const res = await fetch('https://t3yt.mikepfunk.com/api/config', { cache: 'no-store' });
    const data = await res.json();
    if (data?.twitchChannel) targetTwitchChannel = String(data.twitchChannel).toLowerCase();
    return {
      wsUrl: data?.wsUrl || stored.wsUrl || '',
      twitchChannel: data?.twitchChannel || targetTwitchChannel,
    };
  } catch {
    return { wsUrl: stored.wsUrl || '', twitchChannel: targetTwitchChannel };
  }
}

async function checkLiveStatus() {
  try {
    if (!popupOpen && !(await hasTargetTabOpen())) {
      setBadge('', '');
      return;
    }

    if (!wsUrl) {
      const config = await getRuntimeConfig();
      wsUrl = config.wsUrl || '';
      if (config.twitchChannel) targetTwitchChannel = String(config.twitchChannel).toLowerCase();
    }
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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'theochat.popupOpen') {
    popupOpen = !!message.value;
    if (popupOpen) checkLiveStatus();
  }
});
