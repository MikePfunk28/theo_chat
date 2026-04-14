// TheoChat — Options page script

const DEFAULT_WS_URL = 'ws://localhost:9300';

document.addEventListener('DOMContentLoaded', () => {
  const wsUrlInput = document.getElementById('wsUrl');
  const wsTokenInput = document.getElementById('wsToken');
  const saveBtn = document.getElementById('save');
  const testBtn = document.getElementById('test');
  const statusEl = document.getElementById('status');

  // Load saved settings
  chrome.storage.sync.get({ wsUrl: DEFAULT_WS_URL, wsToken: '' }, (result) => {
    wsUrlInput.value = result.wsUrl;
    wsTokenInput.value = result.wsToken;
  });

  // Save settings
  saveBtn.addEventListener('click', () => {
    const wsUrl = wsUrlInput.value.trim() || DEFAULT_WS_URL;
    const wsToken = wsTokenInput.value.trim();
    chrome.storage.sync.set({ wsUrl, wsToken }, () => {
      statusEl.textContent = 'Settings saved!';
      statusEl.style.color = '#00ad03';
      statusEl.style.display = 'block';
      setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    });
  });

  // Test connection
  testBtn.addEventListener('click', () => {
    const wsUrl = wsUrlInput.value.trim() || DEFAULT_WS_URL;
    const wsToken = wsTokenInput.value.trim();
    const url = wsToken ? `${wsUrl}?token=${encodeURIComponent(wsToken)}` : wsUrl;

    statusEl.textContent = 'Connecting...';
    statusEl.style.color = '#adadb8';
    statusEl.style.display = 'block';

    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      statusEl.textContent = 'Connection timed out';
      statusEl.style.color = '#ff4444';
    }, 5000);

    ws.onopen = () => {
      clearTimeout(timeout);
      statusEl.textContent = 'Connected!';
      statusEl.style.color = '#00ad03';
      ws.close();
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      statusEl.textContent = 'Connection failed';
      statusEl.style.color = '#ff4444';
    };
  });
});
