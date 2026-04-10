// TheoChat — Options page script

const DEFAULT_WS_URL = 'ws://localhost:9300';

document.addEventListener('DOMContentLoaded', () => {
  const wsUrlInput = document.getElementById('wsUrl');
  const saveBtn = document.getElementById('save');
  const statusEl = document.getElementById('status');

  // Load saved settings
  chrome.storage.sync.get({ wsUrl: DEFAULT_WS_URL }, (result) => {
    wsUrlInput.value = result.wsUrl;
  });

  // Save settings
  saveBtn.addEventListener('click', () => {
    const wsUrl = wsUrlInput.value.trim() || DEFAULT_WS_URL;
    chrome.storage.sync.set({ wsUrl }, () => {
      statusEl.style.display = 'block';
      setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    });
  });
});
