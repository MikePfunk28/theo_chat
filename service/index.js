const grpc = require('@grpc/grpc-js');
const { google } = require('googleapis');
const WebSocket = require('ws');
const http = require('http');
const { V3DataLiveChatMessageServiceClient } = require('./grpc/stream_list_grpc_pb.js');
const { LiveChatMessageListRequest } = require('./grpc/stream_list_pb.js');

// ─── Config from environment variables ─────────────────────────
const API_KEY = process.env.GOOGLE_API_KEY || process.env.YOUTUBE_API_KEY;
const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || '';
const VIDEO_ID = process.env.YOUTUBE_VIDEO_ID || '';
const PORT = parseInt(process.env.PORT || '9300', 10);
const WS_TOKEN = process.env.WS_TOKEN || '';
// Auto-derive public URL from Railway env vars if not explicitly set.
// Railway exposes RAILWAY_PUBLIC_DOMAIN (hostname only) and RAILWAY_STATIC_URL.
function derivePublicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.RAILWAY_STATIC_URL) {
    const u = process.env.RAILWAY_STATIC_URL;
    return u.startsWith('http') ? u : `https://${u}`;
  }
  return '';
}
const PUBLIC_URL = derivePublicUrl();
const HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';

if (!API_KEY) {
  console.error('\n  YOUTUBE_API_KEY environment variable is required.\n');
  process.exit(1);
}

if (!CHANNEL_ID && !VIDEO_ID) {
  console.error('\n  Either YOUTUBE_CHANNEL_ID or YOUTUBE_VIDEO_ID is required.\n');
  process.exit(1);
}

// ─── Message type enum from protobuf ───────────────────────────
// Reference: https://github.com/yt-livechat-grpc (and YouTube Data API v3)
const MessageType = {
  TEXT_MESSAGE_EVENT: 1,
  TOMBSTONE: 2,                 // placeholder after deletion
  NEW_SPONSOR_EVENT: 4,
  MESSAGE_DELETED_EVENT: 8,     // mod clicked Remove
  MESSAGE_RETRACTED_EVENT: 11,  // user deleted their own message
  USER_BANNED_EVENT: 10,        // mod banned/hid user
  CHAT_ENDED_EVENT: 12,
  SPONSOR_ONLY_MODE_STARTED_EVENT: 13,
  SPONSOR_ONLY_MODE_ENDED_EVENT: 14,
  SUPER_CHAT_EVENT: 15,
  SUPER_STICKER_EVENT: 16,
  MEMBERSHIP_GIFTING_EVENT: 17,
  GIFT_MEMBERSHIP_RECEIVED_EVENT: 18
};

const TYPE_NAMES = Object.fromEntries(Object.entries(MessageType).map(([k, v]) => [v, k]));

// ─── State ─────────────────────────────────────────────────────
let liveChatId = null;
let videoId = VIDEO_ID || null;
let nextPageToken = '';
const processedIds = new Set();
const activeMessages = new Map(); // messageId -> { userId, displayName }
let running = true;
let isStreaming = false; // true while connected to an active gRPC stream

// ─── Metrics & safety ──────────────────────────────────────────
const QUOTA_DAILY_BUDGET = parseInt(process.env.QUOTA_DAILY_BUDGET || '9000', 10); // cap at 90% of 10K default
const QUOTA_RECONCILE_CEILING = parseInt(process.env.QUOTA_RECONCILE_CEILING || '7500', 10); // stop reconcile at this point
const MAX_WS_PER_IP = parseInt(process.env.MAX_WS_PER_IP || '5', 10);

const metrics = {
  startedAt: Date.now(),
  quotaUsedToday: 0,
  quotaResetAt: nextMidnightPT(),
  messagesRelayed: 0,
  messagesDeleted: 0,
  reconcileRuns: 0,
  reconcileSkippedQuota: 0,
  apiErrors: 0,
  lastApiError: null,
  wsConnectsLifetime: 0,
  wsRejectedForIp: 0,
  wsRejectedForToken: 0,
  pubsubNotifications: 0,
};
const connByIp = new Map();

function nextMidnightPT() {
  // PT is UTC-8 or UTC-7 depending on DST; use a simple UTC boundary offset
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 8, 0, 0)); // 00:00 PT ≈ 08:00 UTC
  return d.getTime();
}

// Quota reset timer
setInterval(() => {
  if (Date.now() >= metrics.quotaResetAt) {
    console.log(`  [Metrics] Midnight PT reached — resetting quota counter (was ${metrics.quotaUsedToday})`);
    metrics.quotaUsedToday = 0;
    metrics.quotaResetAt = nextMidnightPT();
  }
}, 60 * 1000);

function recordApiCall(cost, label) {
  metrics.quotaUsedToday += cost;
  if (metrics.quotaUsedToday % 500 < cost) {
    console.log(`  [Quota] ${label}: +${cost} (today=${metrics.quotaUsedToday}/${QUOTA_DAILY_BUDGET})`);
  }
}

function recordApiError(err, label) {
  metrics.apiErrors++;
  metrics.lastApiError = { at: Date.now(), label, message: err.message || String(err) };
  console.error(`  [API] ${label} error: ${err.message || err}`);
}

// ─── YouTube REST API client (for stream discovery) ────────────
const youtube = google.youtube({ version: 'v3', auth: API_KEY });

// ─── Single HTTP server (health check + overlay + WebSocket upgrade) ─
const fs = require('fs');
const overlayPath = require('path').join(__dirname, 'overlay.html');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const parsedUrl = reqUrl.pathname;

  if (parsedUrl === '/health' || parsedUrl === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      clients: clientCount,
      liveChatId,
      videoId,
      streaming: isStreaming,
      quota: {
        usedToday: metrics.quotaUsedToday,
        dailyBudget: QUOTA_DAILY_BUDGET,
        resetAt: metrics.quotaResetAt,
      },
      uptime: Date.now() - metrics.startedAt,
      messagesRelayed: metrics.messagesRelayed,
      messagesDeleted: metrics.messagesDeleted,
    }));
  } else if (parsedUrl === '/metrics') {
    // Gate metrics behind a token so operational data isn't publicly accessible
    const metricsToken = process.env.METRICS_TOKEN || '';
    if (metricsToken && reqUrl.searchParams.get('token') !== metricsToken) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...metrics,
      clientsCurrent: clientCount,
      streaming: isStreaming,
      videoId,
      liveChatId,
      uniqueIpsConnected: connByIp.size,
      config: {
        QUOTA_DAILY_BUDGET,
        QUOTA_RECONCILE_CEILING,
        MAX_WS_PER_IP,
        RECONCILE_INTERVAL_MS,
        MESSAGE_AGE_GRACE_MS,
      },
    }, null, 2));
  } else if (parsedUrl === '/overlay') {
    try {
      const html = fs.readFileSync(overlayPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end('Overlay not found');
    }
  } else if (parsedUrl === '/webhook/youtube') {
    // GET = PubSub verification challenge; POST = Atom feed notification
    if (req.method === 'GET') {
      const challenge = reqUrl.searchParams.get('hub.challenge');
      const mode = reqUrl.searchParams.get('hub.mode');
      if (challenge) {
        console.log(`  [PubSub] Verification: mode=${mode}, echoing challenge`);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(challenge);
      } else {
        res.writeHead(400);
        res.end('Missing hub.challenge');
      }
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        // Extract videoId from Atom feed via regex (no XML parser dep needed)
        const match = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
        if (match) {
          const notifiedVideoId = match[1];
          console.log(`  [PubSub] Notification: videoId=${notifiedVideoId}`);
          handleLiveCandidate(notifiedVideoId).catch((err) => {
            console.error('  [PubSub] handleLiveCandidate error:', err.message);
          });
        }
        res.writeHead(200);
        res.end();
      });
    } else {
      res.writeHead(405);
      res.end('Method not allowed');
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocket.Server({ server });
let clientCount = 0;

wss.on('connection', (ws, req) => {
  // Token auth: reject unauthorized connections
  if (WS_TOKEN) {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const token = reqUrl.searchParams.get('token');
    if (token !== WS_TOKEN) {
      metrics.wsRejectedForToken++;
      ws.close(4001, 'Unauthorized');
      return;
    }
  }

  // Per-IP connection cap — prevents runaway bot floods
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const current = connByIp.get(ip) || 0;
  if (current >= MAX_WS_PER_IP) {
    metrics.wsRejectedForIp++;
    console.log(`  [WS] Rejected ${ip} — already at ${current} connections`);
    ws.close(4008, 'Too many connections from IP');
    return;
  }
  connByIp.set(ip, current + 1);

  clientCount++;
  metrics.wsConnectsLifetime++;
  console.log(`  [WS] Client connected from ${ip} (${clientCount} total)`);
  ws.send(JSON.stringify({ type: 'system.connected', text: 'TheoChat connected' }));
  // Send current emoji library to new client so they can render custom emojis
  if (Object.keys(emojiLibrary).length > 0) {
    ws.send(JSON.stringify({ type: 'yt.emoji.library', emojis: emojiLibrary }));
  }

  ws.on('close', () => {
    clientCount--;
    const n = (connByIp.get(ip) || 1) - 1;
    if (n <= 0) connByIp.delete(ip); else connByIp.set(ip, n);
    console.log(`  [WS] Client disconnected from ${ip} (${clientCount} total)`);
  });
});

function broadcast(event) {
  // Metrics
  if (event.type === 'yt.message.created') metrics.messagesRelayed++;
  else if (event.type === 'yt.message.deleted') metrics.messagesDeleted++;

  const data = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// Heartbeat ping every 30s so extensions can detect stale connections
setInterval(() => {
  broadcast({ type: 'system.heartbeat', at: Date.now() });
}, 30000);

server.listen(PORT, () => {
  console.log(`  [HTTP] Health check + WebSocket on port ${PORT}`);
});

// ─── Check live status + get liveChatId (1 quota unit) ─────────
async function checkIfLive(targetVideoId) {
  recordApiCall(1, 'videos.list');
  const videoResponse = await youtube.videos.list({
    id: [targetVideoId],
    part: ['liveStreamingDetails', 'snippet'],
  });

  const item = videoResponse.data.items?.[0];
  if (!item) return null;

  const snippet = item.snippet || {};
  const broadcastStatus = snippet.liveBroadcastContent;
  // Connect for both 'live' AND 'upcoming' (waiting room) — chat is active in both
  const isActive = broadcastStatus === 'live' || broadcastStatus === 'upcoming';
  const chatId = item.liveStreamingDetails?.activeLiveChatId;

  if (isActive && chatId) {
    console.log(`  [YT] ${broadcastStatus === 'upcoming' ? 'Waiting room' : 'Live'}: "${snippet.title}" (${targetVideoId})`);
    return chatId;
  }
  console.log(`  [YT] ${targetVideoId} not active (liveBroadcastContent=${broadcastStatus})`);
  return null;
}

// ─── One-time startup discovery (no polling) ───────────────────
// Uses search.list only ONCE at boot if CHANNEL_ID is set and no VIDEO_ID.
// After this, we rely on PubSub webhook notifications, NOT polling.
async function startupDiscovery() {
  if (videoId) {
    const chatId = await checkIfLive(videoId);
    if (chatId) { liveChatId = chatId; return true; }
    return false;
  }
  if (!CHANNEL_ID) return false;

  console.log(`  [YT] Startup check on channel ${CHANNEL_ID}...`);
  try {
    // Search for both live AND upcoming (waiting room with active chat)
    recordApiCall(100, 'search.list(startup-live)');
    const response = await youtube.search.list({
      channelId: CHANNEL_ID,
      eventType: 'live',
      type: ['video'],
      part: ['id,snippet'],
    });

    // If nothing live, also check for upcoming (waiting room)
    if (!response.data.items?.length) {
      recordApiCall(100, 'search.list(startup-upcoming)');
      const upcomingRes = await youtube.search.list({
        channelId: CHANNEL_ID,
        eventType: 'upcoming',
        type: ['video'],
        part: ['id,snippet'],
      });
      if (upcomingRes.data.items?.length) {
        response.data.items = upcomingRes.data.items;
      }
    }
    const live = response.data.items?.[0];
    if (!live) {
      console.log('  [YT] Not live at startup. Waiting for PubSub notifications...');
      return false;
    }
    videoId = live.id.videoId;
    const chatId = await checkIfLive(videoId);
    if (chatId) { liveChatId = chatId; return true; }
  } catch (err) {
    console.error(`  [YT] Startup discovery error: ${err.message}`);
  }
  return false;
}

// ─── Handle a PubSub notification: verify, then connect ────────
async function handleLiveCandidate(candidateVideoId) {
  if (isStreaming) {
    console.log(`  [YT] Already streaming ${videoId}, ignoring notification for ${candidateVideoId}`);
    return;
  }
  const chatId = await checkIfLive(candidateVideoId);
  if (!chatId) return;
  videoId = candidateVideoId;
  liveChatId = chatId;

  // Fetch custom emoji library for this stream (no quota cost)
  fetchEmojiLibrary(videoId).then((map) => {
    emojiLibrary = map;
    broadcast({ type: 'yt.emoji.library', emojis: map });
  });

  connectGrpcStream().catch((err) => {
    console.error('  [YT] gRPC error:', err.message);
    isStreaming = false;
  });
}

// ─── gRPC stream — runs until chat ends, then returns ──────────
async function connectGrpcStream() {
  console.log('  [YT] Connecting to YouTube gRPC stream...');
  isStreaming = true;

  const client = new V3DataLiveChatMessageServiceClient(
    'youtube.googleapis.com:443',
    grpc.credentials.createSsl()
  );

  try {
    while (running && isStreaming) {
      const request = new LiveChatMessageListRequest();
      request.setLiveChatId(liveChatId);
      request.setMaxResults(200);
      request.setPartList(['snippet', 'authorDetails']);
      if (nextPageToken) request.setPageToken(nextPageToken);

      const metadata = new grpc.Metadata();
      metadata.add('x-goog-api-key', API_KEY);

      const stream = client.streamList(request, metadata);

      try {
        for await (const response of stream) {
          const res = response.toObject();
          processMessages(res.itemsList || []);
          nextPageToken = response.getNextPageToken() || '';
          if (!nextPageToken) break;
        }
      } catch (err) {
        if (!running) return;
        if (err.code === 0 || (err.message && err.message.includes('stream ended'))) {
          console.log('  [YT] Stream ended — returning to idle. Waiting for next PubSub notification.');
        } else {
          console.error(`  [YT] Stream error (code ${err.code}): ${err.message}`);
        }
        break;
      }
    }
  } finally {
    const wasVideoId = videoId;
    isStreaming = false;
    liveChatId = null;
    nextPageToken = '';
    broadcast({ type: 'yt.chat.ended' });

    // If stream ended unexpectedly (not a clean shutdown), try reconnecting
    // to the same video in case it was a transient gRPC error.
    if (running && wasVideoId) {
      console.log('  [YT] Attempting reconnect to same stream in 5 seconds...');
      setTimeout(async () => {
        if (isStreaming) return; // something else already reconnected
        try {
          recordApiCall(1, 'videos.list(reconnect)');
          const chatId = await checkIfLive(wasVideoId);
          if (chatId) {
            videoId = wasVideoId;
            liveChatId = chatId;
            connectGrpcStream().catch((err) => {
              console.error('  [YT] Reconnect gRPC error:', err.message);
              isStreaming = false;
            });
          } else {
            console.log('  [YT] Stream no longer live — returning to idle.');
          }
        } catch (err) {
          console.error('  [YT] Reconnect check failed:', err.message);
        }
      }, 5000);
    }
  }
}

// ─── Reconciliation poll — safety net for missed mod actions ──
// Every 45s while streaming, call liveChatMessages.list and compare with
// our activeMessages map. Anything we broadcast that is no longer in the
// live chat response was moderated — broadcast a delete. This catches
// any moderation action regardless of whether it fired a gRPC event.
//
// Quota cost: 5 units per call. 45s interval = ~9,600 units/day when
// streaming continuously. Since Theo streams a few hours/day, real cost
// is a fraction of the daily 10K budget.
const RECONCILE_INTERVAL_MS = 90 * 1000; // 90s — safe for 24/7 streaming (4.8K quota/day)
const MESSAGE_AGE_GRACE_MS = 10 * 60 * 1000; // only reconcile messages <10 min old
const messageTimestamps = new Map(); // messageId -> ts we broadcast it

async function reconcileMessages() {
  if (!liveChatId || !isStreaming) return;

  // Quota budget enforcement — skip reconcile when approaching ceiling
  if (metrics.quotaUsedToday >= QUOTA_RECONCILE_CEILING) {
    metrics.reconcileSkippedQuota++;
    if (metrics.reconcileSkippedQuota % 10 === 1) {
      console.warn(`  [RECONCILE] Skipped — quota ${metrics.quotaUsedToday}/${QUOTA_DAILY_BUDGET} (ceiling ${QUOTA_RECONCILE_CEILING})`);
    }
    return;
  }

  const cutoff = Date.now() - MESSAGE_AGE_GRACE_MS;
  metrics.reconcileRuns++;

  try {
    recordApiCall(5, 'liveChatMessages.list');
    const res = await youtube.liveChatMessages.list({
      liveChatId,
      part: ['id'],
      maxResults: 2000,
    });
    const livePresent = new Set((res.data.items || []).map((m) => m.id));

    let removed = 0;
    for (const [msgId, info] of activeMessages) {
      const ts = messageTimestamps.get(msgId) || 0;
      if (ts < cutoff) continue; // too old to verify; don't touch
      if (!livePresent.has(msgId)) {
        console.log(`  [RECONCILE] Removing ${msgId} (${info.displayName}) — no longer in YouTube chat`);
        activeMessages.delete(msgId);
        messageTimestamps.delete(msgId);
        broadcast({ type: 'yt.message.deleted', messageId: msgId });
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`  [RECONCILE] Swept ${removed} orphaned messages`);
    }
  } catch (err) {
    recordApiError(err, 'reconcile');
  }
}
setInterval(reconcileMessages, RECONCILE_INTERVAL_MS);

// ─── Auto-heal live detection — catches PubSub misses (FREE, no quota) ─
// Scrapes YouTube's public /live HTML every 5 min when idle.
// If Theo is live but PubSub never fired, we notice and connect within 5 min.
const LIVE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// ─── Emoji library scraper ─────────────────────────────────────
// YouTube's v3 Data API doesn't expose custom emoji image URLs, but the
// public live_chat HTML page embeds them in ytInitialData. We scrape it
// once per stream and broadcast the shortcut → image URL map to clients.
// Free, no quota.
let emojiLibrary = {};

async function walkForEmojis(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const v of obj) await walkForEmojis(v, out);
    return;
  }
  // An emoji entry looks like: { emojiId, shortcuts: [":foo:"], image: { thumbnails: [{url}] }, isCustomEmoji: true }
  if (Array.isArray(obj.shortcuts) && obj.image && Array.isArray(obj.image.thumbnails)) {
    const url = obj.image.thumbnails[obj.image.thumbnails.length - 1]?.url;
    if (url) {
      for (const shortcut of obj.shortcuts) {
        if (typeof shortcut === 'string') out[shortcut] = url;
      }
    }
  }
  for (const v of Object.values(obj)) await walkForEmojis(v, out);
}

async function fetchEmojiLibrary(vid) {
  if (!vid) return {};
  try {
    const res = await fetch(`https://www.youtube.com/live_chat?v=${vid}&is_popout=1`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!res.ok) return {};
    const html = await res.text();
    // Extract ytInitialData (YouTube's embedded app state JSON)
    const m = html.match(/ytInitialData\s*=\s*({[\s\S]+?});\s*<\/script>/)
          || html.match(/window\["ytInitialData"\]\s*=\s*({[\s\S]+?});/);
    if (!m) return {};
    const data = JSON.parse(m[1]);
    const map = {};
    await walkForEmojis(data, map);
    console.log(`  [Emoji] Scraped ${Object.keys(map).length} custom emojis for video ${vid}`);
    return map;
  } catch (err) {
    console.error(`  [Emoji] Scrape failed: ${err.message}`);
    return {};
  }
}

async function autoHealLiveCheck() {
  if (!CHANNEL_ID) return;
  if (isStreaming) return; // already good

  try {
    const res = await fetch(`https://www.youtube.com/channel/${CHANNEL_ID}/live`, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 TheoChatAutoheal/1.0' },
    });
    if (!res.ok) return;
    const html = await res.text();

    // Look for the video currently attached to the /live endpoint
    const videoMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    const liveMatch = html.match(/"isLiveContent":(true|false)/);
    const isLiveNow = html.match(/"isLive":(true|false)/);

    if (!videoMatch) return;
    const candidateId = videoMatch[1];
    const looksLive = (liveMatch && liveMatch[1] === 'true') || (isLiveNow && isLiveNow[1] === 'true');
    if (!looksLive) return;

    console.log(`  [AutoHeal] Detected live stream via HTML fallback: ${candidateId}`);
    await handleLiveCandidate(candidateId);
  } catch (err) {
    // Non-fatal — next tick will try again
    console.error(`  [AutoHeal] Check failed (non-fatal): ${err.message}`);
  }
}
setInterval(autoHealLiveCheck, LIVE_CHECK_INTERVAL_MS);

// ─── PubSub subscription ───────────────────────────────────────
async function subscribeToPubSub() {
  if (!CHANNEL_ID) {
    console.log('  [PubSub] No CHANNEL_ID set; skipping subscription.');
    return;
  }
  if (!PUBLIC_URL) {
    console.log('  [PubSub] No PUBLIC_URL set; skipping subscription (will rely on startup check only).');
    return;
  }
  const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
  const callback = `${PUBLIC_URL.replace(/\/$/, '')}/webhook/youtube`;
  const body = new URLSearchParams({
    'hub.callback': callback,
    'hub.topic': topic,
    'hub.verify': 'async',
    'hub.mode': 'subscribe',
    'hub.lease_seconds': '432000', // 5 days
  });

  try {
    const res = await fetch(HUB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.status === 202) {
      console.log(`  [PubSub] Subscription request sent for channel ${CHANNEL_ID} → ${callback}`);
    } else {
      const text = await res.text();
      console.error(`  [PubSub] Subscription failed (${res.status}): ${text}`);
    }
  } catch (err) {
    console.error(`  [PubSub] Subscription error: ${err.message}`);
  }
}

// ─── Process messages and emit events ──────────────────────────
function processMessages(messages) {
  for (const msg of messages) {
    const id = msg.id;
    if (!id || processedIds.has(id)) continue;
    processedIds.add(id);

    const snippet = msg.snippet || {};
    const author = msg.authorDetails || {};
    const type = snippet.type;

    // Diagnostic: log every event type we see so we can build handlers
    // for any moderation actions YouTube might emit with unknown type codes.
    if (type !== undefined && type !== MessageType.TEXT_MESSAGE_EVENT) {
      const typeName = TYPE_NAMES[type] || `UNKNOWN(${type})`;
      console.log(`  [YT][DBG] msgId=${id} type=${typeName} snippetKeys=${Object.keys(snippet).join(',')}`);
    }

    if (type === MessageType.TEXT_MESSAGE_EVENT) {
      const event = {
        type: 'yt.message.created',
        messageId: id,
        userId: author.channelId || '',
        displayName: author.displayName || 'Unknown',
        profileImageUrl: author.profileImageUrl || '',
        publishedAt: snippet.publishedAt || new Date().toISOString(),
        badges: extractBadges(author),
        text: snippet.displayMessage || snippet.textMessageDetails?.messageText || '',
        isSuperChat: false,
        superChatAmount: null
      };
      activeMessages.set(id, { userId: event.userId, displayName: event.displayName });
      messageTimestamps.set(id, Date.now());
      broadcast(event);
      console.log(`  [YT] ${event.displayName}: ${event.text}`);

    } else if (type === MessageType.SUPER_CHAT_EVENT) {
      const sc = snippet.superChatDetails || {};
      const event = {
        type: 'yt.message.created',
        messageId: id,
        userId: author.channelId || '',
        displayName: author.displayName || 'Unknown',
        profileImageUrl: author.profileImageUrl || '',
        publishedAt: snippet.publishedAt || new Date().toISOString(),
        badges: extractBadges(author),
        text: sc.userComment || snippet.displayMessage || '',
        isSuperChat: true,
        superChatAmount: sc.amountDisplayString || null
      };
      activeMessages.set(id, { userId: event.userId, displayName: event.displayName });
      messageTimestamps.set(id, Date.now());
      broadcast(event);
      console.log(`  [YT] SC ${event.superChatAmount} ${event.displayName}: ${event.text}`);

    } else if (
      type === MessageType.MESSAGE_DELETED_EVENT ||
      type === MessageType.MESSAGE_RETRACTED_EVENT ||
      type === MessageType.TOMBSTONE
    ) {
      // YouTube uses several field names depending on event variant — try all.
      const details = snippet.messageDeletedDetails || snippet.messageRetractedDetails || {};
      const deletedId =
        details.deletedMessageId ||
        details.retractedMessageId ||
        snippet.deletedMessageId ||
        snippet.retractedMessageId ||
        '';

      const hadIt = activeMessages.has(deletedId);
      if (deletedId) {
        activeMessages.delete(deletedId);
        messageTimestamps.delete(deletedId);
        broadcast({ type: 'yt.message.deleted', messageId: deletedId });
        console.log(`  [YT] Deleted via ${TYPE_NAMES[type]}: ${deletedId} (we had it: ${hadIt})`);
      } else {
        console.log(`  [YT][WARN] ${TYPE_NAMES[type]} had no id — full snippet: ${JSON.stringify(snippet).slice(0, 500)}`);
      }

    } else if (type === MessageType.USER_BANNED_EVENT) {
      const banned = (snippet.userBannedDetails || {}).bannedUserDetails || {};
      const bannedUserId = banned.channelId || '';
      const toRemove = [];
      for (const [msgId, info] of activeMessages) {
        if (info.userId === bannedUserId) toRemove.push(msgId);
      }
      for (const msgId of toRemove) activeMessages.delete(msgId);
      broadcast({
        type: 'yt.user.banned',
        userId: bannedUserId,
        displayName: banned.displayName || '',
        bannedMessageIds: toRemove
      });
      console.log(`  [YT] Banned: ${banned.displayName || bannedUserId} (${toRemove.length} msgs removed)`);
    }
  }

  // Prune to prevent memory growth
  if (processedIds.size > 10000) {
    const arr = [...processedIds];
    processedIds.clear();
    for (let i = arr.length - 5000; i < arr.length; i++) processedIds.add(arr[i]);
  }
}

function extractBadges(author) {
  const badges = [];
  if (author.isChatOwner) badges.push('owner');
  if (author.isChatModerator) badges.push('moderator');
  if (author.isChatSponsor) badges.push('member');
  if (author.isVerified) badges.push('verified');
  return badges;
}

// ─── Startup — one check, then sit idle for webhooks ───────────
async function main() {
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║       TheoChat Service v1.0.0         ║');
  console.log('  ╚══════════════════════════════════════╝\n');
  console.log(`  [WS] Health check + WebSocket on port ${PORT}`);

  // Subscribe to PubSub so YouTube pushes notifications when channel goes live.
  // Retry every 5 min until successful, then renew every 4 days.
  let pubsubVerified = false;
  async function ensurePubSub() {
    try {
      await subscribeToPubSub();
      pubsubVerified = true;
    } catch (err) {
      console.error('  [PubSub] setup error:', err.message);
      pubsubVerified = false;
    }
  }
  ensurePubSub();

  setInterval(() => {
    if (!pubsubVerified) {
      console.log('  [PubSub] Retrying subscription (previous attempt failed)...');
      ensurePubSub();
    }
  }, 5 * 60 * 1000); // retry every 5 min if not verified

  // Also renew proactively every 4 days (lease is 5 days)
  setInterval(() => ensurePubSub(), 4 * 24 * 60 * 60 * 1000);

  // One-time startup check in case stream is already live when we boot
  try {
    const found = await startupDiscovery();
    if (found) {
      connectGrpcStream().catch((err) => {
        console.error('  [YT] gRPC error:', err.message);
        isStreaming = false;
      });
    }
  } catch (err) {
    console.error('  [YT] Startup error:', err.message);
  }
  // After this, NO polling. PubSub webhook drives everything.
}

// ─── Shutdown ──────────────────────────────────────────────────
process.on('SIGINT', () => { running = false; wss.close(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { running = false; wss.close(); server.close(); process.exit(0); });

main();
