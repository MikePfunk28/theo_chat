// TheoChat — Content script for Twitch
// Connects to the TheoChat service and injects YouTube messages into Twitch chat.
// Only activates on Theo's configured Twitch page — any other page is ignored entirely.

(function () {
  'use strict';

  // ─── Hard channel gate — extension only works on Theo's channel ─
  let TARGET_TWITCH_CHANNEL = 'theo';

  function isTargetChannelPage() {
    if (location.hostname !== 'www.twitch.tv' && location.hostname !== 'twitch.tv') {
      return false;
    }
    // Path should be /theo or /theo/... (about, videos, clips sub-pages on his channel are OK)
    const path = location.pathname.toLowerCase();
    return path === `/${TARGET_TWITCH_CHANNEL}` ||
           path.startsWith(`/${TARGET_TWITCH_CHANNEL}/`) ||
           path.startsWith(`/popout/${TARGET_TWITCH_CHANNEL}/`); // popout chat
  }

  // ─── Configuration ────────────────────────────────────────────
  const DEFAULT_WS_URL = 'ws://localhost:9300';
  const RECONNECT_DELAY = 3000;
  let WS_URL = DEFAULT_WS_URL;
  let WS_TOKEN = '';

  // ─── Settings (synced with popup) ─────────────────────────────
  let ENABLED = true;       // master on/off
  let messagesToday = 0;    // counter for popup stats
  let lastMessageAt = null; // timestamp for popup stats
  let lastError = null;     // { message, at } — visible in popup
  let lastHeartbeat = null; // last time we got anything from the service

  // ─── Custom YouTube emoji library (shortcut → image URL) ──────
  // Populated when service sends yt.emoji.library event.
  let emojiLibrary = {};

  // ─── Defensive: catch-all so nothing we do can break Twitch chat ─
  function safe(fn, label) {
    try { return fn(); }
    catch (err) {
      console.error(`[TheoChat] ${label} failed:`, err);
      lastError = { message: `${label}: ${err.message || 'unknown'}`, at: Date.now() };
    }
  }

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
      reconnectAttempts = 0; // reset backoff on successful connect
      console.log('[TheoChat] Connected to TheoChat service');
      // Status is visible in the popup's signal LEDs — don't pollute Twitch chat
    };

    ws.onmessage = (event) => {
      lastHeartbeat = Date.now(); // any message counts as life
      try {
        const data = JSON.parse(event.data);
        safe(() => handleEvent(data), 'handleEvent');
      } catch (err) {
        console.error('[TheoChat] Failed to parse message:', err);
        lastError = { message: `parse: ${err.message || 'invalid JSON'}`, at: Date.now() };
      }
    };

    ws.onclose = (e) => {
      isConnected = false;
      console.log(`[TheoChat] Disconnected (code ${e.code})`);
      if (e.code !== 1000 && e.code !== 1001) {
        lastError = { message: `ws closed: ${e.code}${e.reason ? ' ' + e.reason : ''}`, at: Date.now() };
      }
      scheduleReconnect();
    };

    ws.onerror = () => {
      console.error('[TheoChat] WebSocket error');
      lastError = { message: 'ws error (check service)', at: Date.now() };
      if (ws) ws.close();
    };
  }

  let reconnectAttempts = 0;
  function scheduleReconnect() {
    if (reconnectTimer) return;
    // Exponential backoff: 3s, 6s, 12s, 24s, max 30s
    const delay = Math.min(RECONNECT_DELAY * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isConnected) {
        connectWebSocket();
      }
    }, delay);
  }

  function forceReconnect() {
    reconnectAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.close(); } catch {} }
    ws = null;
    connectWebSocket();
  }

  // Heartbeat watchdog: if nothing from service for 90s, assume stale and reconnect.
  // Gated on isTargetChannelPage() so the timer is a no-op on non-Theo twitch tabs
  // (content script matches *://*.twitch.tv/* but must be fully inert elsewhere).
  setInterval(() => {
    if (!isTargetChannelPage()) return;
    if (isConnected && lastHeartbeat && Date.now() - lastHeartbeat > 90000) {
      console.warn('[TheoChat] No heartbeat for 90s — forcing reconnect');
      lastError = { message: 'stale connection, reconnecting', at: Date.now() };
      forceReconnect();
    }
  }, 30000);

  // ─── Event Handling ──────────────────────────────────────────

  function handleEvent(event) {
    if (!chatContainer) return;
    if (!ENABLED) return;  // master toggle

    switch (event.type) {
      case 'yt.message.created':
        injectChatMessage(event);
        messagesToday++;
        lastMessageAt = Date.now();
        break;

      case 'yt.message.deleted':
        deleteMessage(event.messageId);
        break;

      case 'yt.user.banned':
        banUser(event.userId, event.bannedMessageIds || []);
        break;

      case 'yt.chat.ended':
        break;

      case 'system.connected':
        break;

      case 'yt.emoji.library':
        if (event.emojis && typeof event.emojis === 'object') {
          emojiLibrary = event.emojis;
          console.log(`[TheoChat] Received ${Object.keys(emojiLibrary).length} custom emojis`);
        }
        break;

      case 'system.heartbeat':
        break;

      case 'system.reconciled':
        break;
    }
  }

  // ─── DOM Injection ───────────────────────────────────────────

  function injectChatMessage(event) {
    if (!chatContainer) return;
    const existing = chatContainer.querySelector(`[data-theochat-msg-id="${CSS.escape(event.messageId)}"]`);
    if (existing) return;

    const el = document.createElement('div');
    el.className = 'theochat-msg';
    el.setAttribute('data-theochat-msg-id', event.messageId);
    el.setAttribute('data-theochat-user-id', event.userId);

    // Build message via DOM methods (AMO-safe — no innerHTML)
    const mkBadge = (text, className, title) => {
      const span = document.createElement('span');
      span.className = className;
      if (title) span.title = title;
      span.textContent = text;
      return span;
    };

    // YouTube badge
    el.appendChild(mkBadge('YT', 'theochat-badge', 'YouTube'));

    // Role badges (order: owner > moderator > verified > member)
    for (const badge of event.badges) {
      if (badge === 'owner') {
        el.appendChild(mkBadge('Owner', 'theochat-badge theochat-badge-owner', 'Channel Owner'));
      } else if (badge === 'moderator') {
        el.appendChild(mkBadge('Mod', 'theochat-badge theochat-badge-moderator', 'Moderator'));
      } else if (badge === 'verified') {
        el.appendChild(mkBadge('✓', 'theochat-badge theochat-badge-verified', 'Verified'));
      } else if (badge === 'member') {
        el.appendChild(mkBadge('Member', 'theochat-badge theochat-badge-member', 'Member'));
      }
    }

    // Super chat badge
    if (event.isSuperChat && event.superChatAmount) {
      el.appendChild(mkBadge(event.superChatAmount, 'theochat-badge theochat-badge-superchat', 'Super Chat'));
    }

    // Avatar
    if (event.profileImageUrl) {
      const img = document.createElement('img');
      img.className = 'theochat-avatar';
      img.src = event.profileImageUrl;
      img.alt = '';
      img.loading = 'lazy';
      el.appendChild(img);
    }

    // Author name (colored)
    const author = document.createElement('span');
    author.className = 'theochat-author';
    author.style.color = getNameColor(event.displayName);
    author.textContent = event.displayName;
    el.appendChild(author);

    // Separator
    const sep = document.createElement('span');
    sep.textContent = ': ';
    el.appendChild(sep);

    // Message text — render custom YouTube emoji shortcuts as <img>
    const body = document.createElement('span');
    body.className = 'theochat-text';
    renderMessageBody(body, event.text);
    el.appendChild(body);

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

  // ─── Utilities ───────────────────────────────────────────────

  // Render a message body — scan for :shortcut: patterns and replace with
  // <img> when we have a matching custom emoji. Plain text otherwise.
  // Uses only textContent / appendChild — no innerHTML — so AMO-safe.
  function renderMessageBody(parent, text) {
    if (!text) return;
    // Split text around :shortcut: patterns. Matches 1..50 chars, no spaces.
    const parts = text.split(/(:[A-Za-z0-9_\-+]{1,50}:)/g);
    for (const part of parts) {
      if (!part) continue;
      const isShortcut = /^:[A-Za-z0-9_\-+]{1,50}:$/.test(part);
      if (isShortcut && emojiLibrary[part]) {
        const img = document.createElement('img');
        img.className = 'theochat-emoji';
        img.src = emojiLibrary[part];
        img.alt = part;
        img.title = part;
        img.loading = 'lazy';
        parent.appendChild(img);
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    }
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
  // Disconnect the WS and clear DOM when Theo navigates away from his channel.
  // Reactivate when he returns. Keeps extension inert on other pages.

  function teardown() {
    if (ws) { try { ws.close(1000, 'nav away'); } catch {} }
    ws = null;
    isConnected = false;
    reconnectAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (chatContainer) {
      try { chatContainer.querySelectorAll('.theochat-msg').forEach((el) => el.remove()); } catch {}
    }
    chatContainer = null;
  }

  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (isTargetChannelPage()) {
        console.log('[TheoChat] On target channel — (re)initializing');
        chatContainer = null;
        waitForChatContainer();
      } else {
        console.log('[TheoChat] Navigated away from target channel — tearing down');
        teardown();
      }
    }
  });
  urlObserver.observe(document.body, { childList: true, subtree: true });

  // ─── Initialize ──────────────────────────────────────────────

  console.log('[TheoChat] Extension loaded');

  // Note: storage settings are always loaded so that when the user NAVIGATES
  // to twitch.tv/theo from elsewhere (SPA nav), activation is instant.
  // But waitForChatContainer() is only called when we're on the target page.

  // Load WebSocket URL from extension storage, then start
  const CONFIG_URL = 'https://t3yt.mikepfunk.com/api/config';

  async function resolveWsUrl(storedUrl) {
    // Try live config first — if CF Worker knows the Railway URL, use it
    try {
      const res = await fetch(CONFIG_URL, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.twitchChannel === 'string' && data.twitchChannel) {
          TARGET_TWITCH_CHANNEL = data.twitchChannel.toLowerCase();
        }
        if (data && typeof data.wsUrl === 'string' && data.wsUrl) {
          chrome.storage.sync.set({ wsUrl: data.wsUrl });
          console.log(`[TheoChat] Fetched WS URL from config: ${data.wsUrl} (channel=${TARGET_TWITCH_CHANNEL})`);
          return data.wsUrl;
        }
      }
    } catch (e) {
      console.log('[TheoChat] Config fetch failed, using stored URL');
    }
    return storedUrl || DEFAULT_WS_URL;
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(
      { wsUrl: DEFAULT_WS_URL, wsToken: '', enabled: true },
      async (result) => {
        WS_URL = await resolveWsUrl(result.wsUrl);
        WS_TOKEN = result.wsToken || '';
        ENABLED = result.enabled !== false;
        console.log(`[TheoChat] WS URL loaded: ${WS_URL} | enabled=${ENABLED} | delivery=realtime`);
        if (isTargetChannelPage()) {
          waitForChatContainer();
        } else {
          console.log(`[TheoChat] Not on twitch.tv/${TARGET_TWITCH_CHANNEL} — extension inert (will activate on navigation)`);
        }
      }
    );

    // Listen for live settings changes from the popup
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'theochat.setEnabled') {
        ENABLED = !!msg.value;
        if (!ENABLED) {
          if (chatContainer) {
            chatContainer.querySelectorAll('.theochat-msg').forEach((el) => el.remove());
          }
        }
      } else if (msg.type === 'theochat.getStatus') {
        sendResponse({
          enabled: ENABLED,
          delayMs: 0,
          connected: isConnected,
          pending: 0,
          messagesToday,
          lastMessageAt,
          wsUrl: WS_URL,
          lastError,
          lastHeartbeat,
          readyState: ws ? ws.readyState : -1,
        });
        return true;
      } else if (msg.type === 'theochat.reconnect') {
        forceReconnect();
        sendResponse({ ok: true });
      } else if (msg.type === 'theochat.flushQueue') {
        sendResponse({ ok: true });
      }
    });
  } else if (isTargetChannelPage()) {
    waitForChatContainer();
  }

})();
