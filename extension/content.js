// TheoChat — Content script for Twitch
// Connects to the local TheoChat service and injects YouTube messages into Twitch chat

(function () {
  'use strict';

  // ─── Configuration ────────────────────────────────────────────
  // Default WS URL — overridden by extension options (stored in chrome.storage)
  const DEFAULT_WS_URL = 'ws://localhost:9300';
  const RECONNECT_DELAY = 3000;
  let WS_URL = DEFAULT_WS_URL;
  let WS_TOKEN = '';

  // Twitch chat selectors — if Twitch changes their DOM, update these
  const SELECTORS = {
    // The scrollable container that holds all chat messages
    chatContainer: '.chat-scrollable-area__message-container',
    // Fallback selectors in case Twitch changes class names
    chatContainerFallbacks: [
      '[data-a-target="chat-scroller"] .simplebar-content',
      '.chat-list .tw-flex-grow-1',
      '.chat-list__lines .scrollable-area .simplebar-content'
    ],
    // Twitch's chat line elements (for reference when styling)
    chatLine: '.chat-line__message'
  };

  let ws = null;
  let chatContainer = null;
  let reconnectTimer = null;
  let isConnected = false;
  let autoScroll = true;

  // ─── Find Twitch Chat Container ──────────────────────────────

  function findChatContainer() {
    // Try primary selector
    let container = document.querySelector(SELECTORS.chatContainer);
    if (container) return container;

    // Try fallbacks
    for (const selector of SELECTORS.chatContainerFallbacks) {
      container = document.querySelector(selector);
      if (container) return container;
    }

    return null;
  }

  // Watch for Twitch chat to appear (it loads dynamically)
  function waitForChatContainer() {
    chatContainer = findChatContainer();
    if (chatContainer) {
      console.log('[TheoChat] Found Twitch chat container');
      observeScroll();
      connectWebSocket();
      return;
    }

    // Use MutationObserver to detect when chat loads
    const observer = new MutationObserver(() => {
      chatContainer = findChatContainer();
      if (chatContainer) {
        console.log('[TheoChat] Twitch chat container appeared');
        observer.disconnect();
        observeScroll();
        connectWebSocket();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[TheoChat] Waiting for Twitch chat container...');
  }

  // ─── Auto-scroll Detection ───────────────────────────────────

  function observeScroll() {
    // Twitch pauses auto-scroll when the user scrolls up
    // We mirror this behavior: only auto-scroll if the user is at the bottom
    const scrollParent = chatContainer.closest('.simplebar-scroll-content') ||
                         chatContainer.parentElement;

    if (scrollParent) {
      scrollParent.addEventListener('scroll', () => {
        const threshold = 50;
        autoScroll = (scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight) < threshold;
      });
    }
  }

  function scrollToBottom() {
    if (!autoScroll || !chatContainer) return;

    const scrollParent = chatContainer.closest('.simplebar-scroll-content') ||
                         chatContainer.parentElement;
    if (scrollParent) {
      scrollParent.scrollTop = scrollParent.scrollHeight;
    }
  }

  // ─── WebSocket Connection ────────────────────────────────────

  function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    console.log('[TheoChat] Connecting to service...');

    const connectUrl = WS_TOKEN ? `${WS_URL}?token=${encodeURIComponent(WS_TOKEN)}` : WS_URL;
    ws = new WebSocket(connectUrl);

    ws.onopen = () => {
      isConnected = true;
      console.log('[TheoChat] Connected to TheoChat service');
      injectSystemMessage('TheoChat connected — YouTube chat will appear here');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleEvent(data);
      } catch (err) {
        console.error('[TheoChat] Failed to parse message:', err);
      }
    };

    ws.onclose = () => {
      isConnected = false;
      console.log('[TheoChat] Disconnected from service');
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('[TheoChat] WebSocket error');
      ws.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isConnected) {
        connectWebSocket();
      }
    }, RECONNECT_DELAY);
  }

  // ─── Event Handling ──────────────────────────────────────────

  function handleEvent(event) {
    if (!chatContainer) return;

    switch (event.type) {
      case 'yt.message.created':
        injectChatMessage(event);
        break;

      case 'yt.message.deleted':
        deleteMessage(event.messageId);
        break;

      case 'yt.user.banned':
        banUser(event.userId, event.bannedMessageIds || []);
        break;

      case 'yt.chat.ended':
        injectSystemMessage('YouTube live chat ended');
        break;

      case 'system.connected':
        // Already handled in onopen
        break;
    }
  }

  // ─── DOM Injection ───────────────────────────────────────────

  function injectChatMessage(event) {
    const el = document.createElement('div');
    el.className = 'theochat-msg';
    el.setAttribute('data-theochat-msg-id', event.messageId);
    el.setAttribute('data-theochat-user-id', event.userId);

    // Build the message HTML
    let html = '';

    // YouTube badge
    html += '<span class="theochat-badge" title="YouTube">YT</span>';

    // Role badges
    for (const badge of event.badges) {
      if (badge === 'owner') {
        html += '<span class="theochat-badge theochat-badge-owner" title="Channel Owner">Owner</span>';
      } else if (badge === 'moderator') {
        html += '<span class="theochat-badge theochat-badge-moderator" title="Moderator">Mod</span>';
      } else if (badge === 'member') {
        html += '<span class="theochat-badge theochat-badge-member" title="Member">Member</span>';
      }
    }

    // Super chat badge
    if (event.isSuperChat && event.superChatAmount) {
      html += `<span class="theochat-badge theochat-badge-superchat" title="Super Chat">${escapeHtml(event.superChatAmount)}</span>`;
    }

    // Avatar
    if (event.profileImageUrl) {
      html += `<img class="theochat-avatar" src="${escapeHtml(event.profileImageUrl)}" alt="" loading="lazy">`;
    }

    // Author name (colored by platform)
    const nameColor = getNameColor(event.displayName);
    html += `<span class="theochat-author" style="color: ${nameColor}">${escapeHtml(event.displayName)}</span>`;

    // Separator
    html += '<span>: </span>';

    // Message text
    html += `<span class="theochat-text">${escapeHtml(event.text)}</span>`;

    el.innerHTML = html;
    chatContainer.appendChild(el);

    // Scroll to bottom if the user hasn't scrolled up
    scrollToBottom();

    // Prune old TheoChat messages to prevent memory growth (keep last 500)
    const allTheoChatMsgs = chatContainer.querySelectorAll('.theochat-msg');
    if (allTheoChatMsgs.length > 500) {
      for (let i = 0; i < allTheoChatMsgs.length - 500; i++) {
        allTheoChatMsgs[i].remove();
      }
    }
  }

  function deleteMessage(messageId) {
    const el = chatContainer.querySelector(`[data-theochat-msg-id="${CSS.escape(messageId)}"]`);
    if (el) {
      el.remove();
    }
  }

  function banUser(userId, bannedMessageIds) {
    // Remove all messages from this user immediately
    const userMsgs = chatContainer.querySelectorAll(`[data-theochat-user-id="${CSS.escape(userId)}"]`);
    for (const el of userMsgs) {
      el.remove();
    }

    // Also remove by specific message IDs if provided
    for (const msgId of bannedMessageIds) {
      const el = chatContainer.querySelector(`[data-theochat-msg-id="${CSS.escape(msgId)}"]`);
      if (el) {
        el.remove();
      }
    }
  }

  function injectSystemMessage(text) {
    if (!chatContainer) return;

    const el = document.createElement('div');
    el.className = 'theochat-system';
    el.textContent = text;
    chatContainer.appendChild(el);
    scrollToBottom();
  }

  // ─── Utilities ───────────────────────────────────────────────

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Generate a consistent color for a username (similar to Twitch's approach)
  function getNameColor(name) {
    const colors = [
      '#ff4444', '#ff7f50', '#ff69b4', '#b8860b', '#5f9ea0',
      '#1e90ff', '#8a2be2', '#00ff7f', '#daa520', '#d2691e',
      '#008000', '#9acd32', '#2e8b57', '#da70d6', '#e0b619'
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }

  // ─── Handle Page Navigation (Twitch is a SPA) ───────────────

  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log('[TheoChat] Page navigated, re-finding chat container...');
      chatContainer = null;
      waitForChatContainer();
    }
  });
  urlObserver.observe(document.body, { childList: true, subtree: true });

  // ─── Initialize ──────────────────────────────────────────────

  console.log('[TheoChat] Extension loaded');

  // Load WebSocket URL from extension storage, then start
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get({ wsUrl: DEFAULT_WS_URL, wsToken: '' }, (result) => {
      WS_URL = result.wsUrl || DEFAULT_WS_URL;
      WS_TOKEN = result.wsToken || '';
      console.log(`[TheoChat] WebSocket URL: ${WS_URL}`);
      waitForChatContainer();
    });
  } else {
    waitForChatContainer();
  }

})();
