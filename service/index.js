const grpc = require('@grpc/grpc-js');
const { google } = require('googleapis');
const WebSocket = require('ws');
const http = require('http');
const { V3DataLiveChatMessageServiceClient } = require('./grpc/stream_list_grpc_pb.js');
const { LiveChatMessageListRequest } = require('./grpc/stream_list_pb.js');
const { logEvent, droppedEventCount, eventLogDir, shutdownEventLog } = require('./event-log.js');
const { getHistory: getMetricsHistory } = require('./metrics-history.js');
const crypto = require('crypto');

// Opaque, non-reversible identifier for metrics aggregation. HMAC-SHA256
// truncated to 16 hex chars. Salt is per-process (rotates on restart) so
// the hash cannot be joined across deploys. Good enough for
// "count unique chatters this session" without retaining user identity.
const METRICS_HASH_SALT = crypto.randomBytes(32);
function hashIdForMetrics(id) {
  if (!id) return '';
  return crypto.createHmac('sha256', METRICS_HASH_SALT).update(String(id)).digest('hex').slice(0, 16);
}

// ─── Config from environment variables ─────────────────────────
const API_KEY = process.env.GOOGLE_API_KEY || process.env.YOUTUBE_API_KEY;
const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || '';
const VIDEO_ID = process.env.YOUTUBE_VIDEO_ID || '';
const PORT = parseInt(process.env.PORT || '9300', 10);
const WS_TOKEN = process.env.WS_TOKEN || '';
const TWITCH_CHANNEL = (process.env.TWITCH_CHANNEL || 'theo').toLowerCase();
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
// Auto-derive public URL from Railway env vars if not explicitly set.
// Always prepends https:// if missing, strips trailing slashes, validates result.
function derivePublicUrl() {
  let raw = process.env.PUBLIC_URL
         || process.env.RAILWAY_PUBLIC_DOMAIN
         || process.env.RAILWAY_STATIC_URL
         || '';
  raw = String(raw).trim();
  if (!raw) return '';
  // Ensure https:// prefix
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    raw = 'https://' + raw;
  }
  // Strip trailing slashes
  raw = raw.replace(/\/+$/, '');
  // Sanity: must look like a URL with at least one dot in the host
  try {
    const u = new URL(raw);
    if (!u.hostname.includes('.')) {
      console.warn(`  [PublicURL] Derived URL has suspicious hostname: ${raw}`);
      return '';
    }
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    console.warn(`  [PublicURL] Could not parse as URL: ${raw}`);
    return '';
  }
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
const pendingCandidateVideoIds = new Set();
let liveCandidateInFlight = false;
let running = true;
let isStreaming = false; // true while connected to an active gRPC stream
let pubsubVerified = false;
let lastGrpcActivityAt = 0;
let lastTwitchLiveCheckAt = 0;
let lastTwitchLiveResult = null;
let grpcWatchdogPending = false;
let reconnectTimer = null;
let grpcStopReason = null;
let rateLimitCooldownMs = 5 * 60 * 1000;
let pendingPubSubVideoId = '';
let pendingPubSubReceivedAt = 0;

// ─── Metrics & safety ──────────────────────────────────────────
const QUOTA_DAILY_BUDGET = parseInt(process.env.QUOTA_DAILY_BUDGET || '9000', 10); // cap at 90% of 10K default
const QUOTA_RECONCILE_CEILING = parseInt(process.env.QUOTA_RECONCILE_CEILING || '7500', 10); // stop reconcile at this point
const MAX_WS_PER_IP = parseInt(process.env.MAX_WS_PER_IP || '5', 10);
// 15 minutes. With HTTP/2 keepalive enabled on the gRPC client, dead TCP
// connections surface within ~40s as a transport error. The activity
// watchdog is a belt-and-suspenders fallback for the pathological case
// where keepalive reports the connection healthy but no real events have
// arrived for an implausibly long time. 75s (the previous value) caused
// false restarts on quiet chat; that's what keepalive eliminates.
const GRPC_STALE_MS = parseInt(process.env.GRPC_STALE_MS || '900000', 10);
const PUBSUB_CANDIDATE_TTL_MS = 6 * 60 * 60 * 1000;

const metrics = {
  startedAt: Date.now(),
  quotaUsedToday: 0,
  quotaResetAt: nextMidnightPT(),
  messagesRelayed: 0,
  messagesDeleted: 0,
  realtimeDeletes: 0,
  reconcileDeletes: 0,
  reconcileRuns: 0,
  reconcileSkippedQuota: 0,
  apiErrors: 0,
  lastApiError: null,
  wsConnectsLifetime: 0,
  wsRejectedForIp: 0,
  wsRejectedForToken: 0,
  pubsubNotifications: 0,
  unknownMessageTypes: 0,
  grpcReconnects: 0,
  grpcStreamsOpened: 0,       // lifetime total of streamList opens — stays ≈1 per session after the 1a fix
  lastGrpcOpenAt: 0,
  grpcOpenRateLimited: 0,     // count of RESOURCE_EXHAUSTED on streamList
  eventLogDropped: 0,         // incremented when persistent log write fails
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
  logEvent('quota.used', { cost, label, runningTotal: metrics.quotaUsedToday });
  if (metrics.quotaUsedToday % 500 < cost) {
    console.log(`  [Quota] ${label}: +${cost} (today=${metrics.quotaUsedToday}/${QUOTA_DAILY_BUDGET})`);
  }
}

function recordApiError(err, label) {
  metrics.apiErrors++;
  const msg = err.message || String(err);
  metrics.lastApiError = { at: Date.now(), label, message: msg };
  console.error(`  [API] ${label} error: ${msg}`);

  // Distinguish daily quota from per-100-second rate limits using the
  // structured `reason` field — not a string match on the error message.
  // A bare 'exceeded your' match triggered on userRateLimitExceeded too,
  // which pinned the daily counter falsely during the 2026-04-17 outage.
  const structuredReason = err.errors?.[0]?.reason
    || err.response?.data?.error?.errors?.[0]?.reason
    || '';
  const structuredDomain = err.errors?.[0]?.domain
    || err.response?.data?.error?.errors?.[0]?.domain
    || '';

  const isDailyExhaustion =
    structuredReason === 'dailyLimitExceeded' ||
    (structuredReason === 'quotaExceeded' && structuredDomain === 'youtube.quota');

  if (isDailyExhaustion) {
    if (metrics.quotaUsedToday < QUOTA_DAILY_BUDGET) {
      console.warn(`  [Quota] YouTube reports dailyLimitExceeded — capping counter at budget`);
      metrics.quotaUsedToday = QUOTA_DAILY_BUDGET;
    }
  }

  // Detect per-window rate limit → exponential cooldown, capped at 30 min.
  // Catches gRPC RESOURCE_EXHAUSTED (err.code === 8), googleapis REST 429
  // (err.response?.status), raw fetch 429 (err.status), and structured
  // rateLimitExceeded / userRateLimitExceeded reasons.
  const restStatus = err.response?.status;
  const isRateLimited =
    err.code === 8 ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.toLowerCase().includes('rate limit') ||
    err.status === 429 ||
    restStatus === 429 ||
    structuredReason === 'rateLimitExceeded' ||
    structuredReason === 'userRateLimitExceeded';

  if (isRateLimited) {
    rateLimitCooldownUntil = Date.now() + rateLimitCooldownMs;
    console.warn(`  [API] Rate limit detected (reason=${structuredReason || 'n/a'}) — cooldown for ${Math.round(rateLimitCooldownMs / 60000)} min`);
    rateLimitCooldownMs = Math.min(rateLimitCooldownMs * 2, 30 * 60 * 1000);
  }
}

let rateLimitCooldownUntil = 0;
function isInRateLimitCooldown() {
  return Date.now() < rateLimitCooldownUntil;
}
function clearRateLimitCooldown() {
  rateLimitCooldownMs = 5 * 60 * 1000;
}

function rememberPubSubCandidate(videoId) {
  pendingPubSubVideoId = videoId;
  pendingPubSubReceivedAt = Date.now();
}

function clearPubSubCandidate() {
  pendingPubSubVideoId = '';
  pendingPubSubReceivedAt = 0;
}

function hasFreshPubSubCandidate() {
  return Boolean(
    pendingPubSubVideoId &&
    pendingPubSubReceivedAt &&
    Date.now() - pendingPubSubReceivedAt < PUBSUB_CANDIDATE_TTL_MS
  );
}

function firstMatch(body, patterns) {
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function parsePubSubNotification(body) {
  return {
    videoId: firstMatch(body, [
      /<yt:videoId>([^<]+)<\/yt:videoId>/,
    ]),
    channelId: firstMatch(body, [
      /<yt:channelId>([^<]+)<\/yt:channelId>/,
      /<uri>\s*https:\/\/www\.youtube\.com\/channel\/([^<\s]+)\s*<\/uri>/,
      /<uri>\s*yt:channel:([^<\s]+)\s*<\/uri>/,
      /<link[^>]+href="https:\/\/www\.youtube\.com\/xml\/feeds\/videos\.xml\?channel_id=([^"&]+)[^"]*"/,
      /<id>\s*yt:channel:([^<\s]+)\s*<\/id>/,
    ]),
  };
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
  const grpcHealthy = Boolean(isStreaming && lastGrpcActivityAt && Date.now() - lastGrpcActivityAt < GRPC_STALE_MS);
  const twitchFallbackConfigured = Boolean(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET);

  if (parsedUrl === '/health' || parsedUrl === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      clients: clientCount,
      liveChatId,
      videoId,
      streaming: isStreaming,
      pubsubVerified,
      twitchFallbackConfigured,
      grpcHealthy,
      lastGrpcActivityAt,
      lastTwitchLiveCheckAt,
      lastTwitchLiveResult,
      pendingPubSubVideoId,
      pendingPubSubReceivedAt,
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
    metrics.eventLogDropped = droppedEventCount();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...metrics,
      clientsCurrent: clientCount,
      streaming: isStreaming,
      pubsubVerified,
      twitchFallbackConfigured,
      grpcHealthy,
      lastGrpcActivityAt,
      lastTwitchLiveCheckAt,
      lastTwitchLiveResult,
      pendingPubSubVideoId,
      pendingPubSubReceivedAt,
      videoId,
      liveChatId,
      uniqueIpsConnected: connByIp.size,
      eventLogDir: eventLogDir(),
      config: {
        QUOTA_DAILY_BUDGET,
        QUOTA_RECONCILE_CEILING,
        MAX_WS_PER_IP,
        RECONCILE_INTERVAL_MS,
        MESSAGE_AGE_GRACE_MS,
        GRPC_STALE_MS,
        PUBSUB_CANDIDATE_TTL_MS,
      },
    }, null, 2));
  } else if (parsedUrl === '/api/metrics/history') {
    // Same auth as /metrics — operational data, not public.
    const metricsToken = process.env.METRICS_TOKEN || '';
    if (!metricsToken || reqUrl.searchParams.get('token') !== metricsToken) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const windowParam = reqUrl.searchParams.get('window') || '24h';
    const windowMap = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000 };
    // Strict validation — unknown values return 400 so misconfigured callers
    // see the problem instead of getting wrong-window rollups silently.
    if (!Object.prototype.hasOwnProperty.call(windowMap, windowParam)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid window', allowed: Object.keys(windowMap) }));
      return;
    }
    const windowMs = windowMap[windowParam];
    try {
      const rollup = getMetricsHistory(windowMs);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ window: windowParam, generatedAt: Date.now(), buckets: rollup }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else if (parsedUrl === '/stats') {
    try {
      const statsPath = require('path').join(__dirname, 'stats.html');
      const html = fs.readFileSync(statsPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end('Stats page not found');
    }
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
        pubsubVerified = true;
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
        metrics.pubsubNotifications++;
        const notification = parsePubSubNotification(body);
        const notifiedVideoId = notification.videoId;
        const notifiedChannelId = notification.channelId;
        logEvent('pubsub.notification', { videoId: notifiedVideoId, channelId: notifiedChannelId });

        if (!notifiedChannelId) {
          console.warn('  [PubSub] Ignoring notification without a channel ID');
        } else if (CHANNEL_ID && notifiedChannelId !== CHANNEL_ID) {
          console.log(`  [PubSub] Ignoring channel ${notifiedChannelId} (expected ${CHANNEL_ID})`);
        } else if (notifiedVideoId) {
          console.log(`  [PubSub] Notification: channelId=${notifiedChannelId || 'unknown'} videoId=${notifiedVideoId}`);
          rememberPubSubCandidate(notifiedVideoId);
          if (clientCount > 0) {
            handleLiveCandidate(notifiedVideoId, { source: 'pubsub', notifiedChannelId }).catch((err) => {
              console.error('  [PubSub] handleLiveCandidate error:', err.message);
            });
          } else {
            console.log('  [PubSub] No active clients — cached candidate for on-demand verification');
          }
        } else {
          console.warn('  [PubSub] Ignoring notification without a video ID');
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
  logEvent('ws.connected', { ip, total: clientCount });
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
    logEvent('ws.disconnected', { ip, total: clientCount });
    console.log(`  [WS] Client disconnected from ${ip} (${clientCount} total)`);
    // If this was the last client, start the idle grace period
    if (clientCount === 0) scheduleIdleShutdown();
  });
  // If a client connects during a grace period, cancel the shutdown
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (clientCount === 1) {
    kickoffDetectionForActiveClient().catch((err) => {
      console.error(`  [Detect] Initial detection failed: ${err.message}`);
    });
  }
});

function broadcast(event) {
  // Metrics + persistent event log. Every relay path flows through here,
  // so logging at this choke point means the rollups and /api/metrics/history
  // actually have data to aggregate (the charts were "NO DATA YET"
  // because message + mod events weren't instrumented).
  // Privacy: do NOT persist chat author identifiers (displayName,
  // channelId, messageId) to the 30-day JSONL log. The rollup only needs
  // counts + uniqueness hashes; concrete PII in a long-lived file creates
  // retention risk. Rollup aggregation uses a short-lived in-memory Set
  // seeded from an opaque hash so unique-author counts still work without
  // the original identifier ever touching disk.
  if (event.type === 'yt.message.created') {
    metrics.messagesRelayed++;
    logEvent('message.relayed', {
      authorHash: hashIdForMetrics(event.userId),
      messageLen: event.message ? event.message.length : 0,
      isOwner: (event.badges || []).includes('owner'),
      isMod: (event.badges || []).includes('moderator'),
      isMember: (event.badges || []).includes('member'),
      isSuperChat: Boolean(event.superChatAmount),
    });
    if (event.superChatAmount) {
      logEvent('superchat', {
        authorHash: hashIdForMetrics(event.userId),
        amountText: event.superChatAmount,
        currency: event.currency || null,
        tierColor: event.superChatColor || null,
      });
    }
  } else if (event.type === 'yt.message.deleted') {
    metrics.messagesDeleted++;
    logEvent('mod.action', {
      type: 'delete',
      source: 'youtube',
      mirrored: true,
    });
  } else if (event.type === 'yt.user.banned') {
    logEvent('mod.action', {
      type: 'ban',
      source: 'youtube',
      targetHash: hashIdForMetrics(event.userId),
      messagesRemoved: event.messagesRemoved || 0,
      mirrored: true,
    });
  }

  const data = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// ─── Idle shutdown — when no clients, close YouTube connection ─
// Grace period of 60s lets Theo refresh/switch tabs without churn.
const IDLE_GRACE_MS = 60 * 1000;
let idleTimer = null;

function scheduleIdleShutdown() {
  if (idleTimer) return;
  console.log(`  [Idle] No clients connected — scheduling gRPC close in ${IDLE_GRACE_MS / 1000}s`);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (clientCount > 0) return;
    if (isStreaming) {
      console.log('  [Idle] Grace expired — cancelling gRPC stream');
      stopGrpcStream('idle');
    }
  }, IDLE_GRACE_MS);
}

// Module-level ref to the active gRPC stream so we can cancel it on idle
let activeGrpcStream = null;

function clearTrackedMessages(messageIds) {
  for (const messageId of messageIds) {
    activeMessages.delete(messageId);
    messageTimestamps.delete(messageId);
  }
}

async function kickoffDetectionForActiveClient() {
  if (isStreaming) return;

  let candidateHandled = false;
  if (hasFreshPubSubCandidate()) {
    const candidateVideoId = pendingPubSubVideoId;
    console.log(`  [PubSub] Verifying cached candidate ${candidateVideoId} on first client connect`);
    await handleLiveCandidate(candidateVideoId, { source: 'pubsub-cached', notifiedChannelId: CHANNEL_ID });
    candidateHandled = isStreaming;
  } else {
    clearPubSubCandidate();
  }

  if (!candidateHandled) {
    const hadTwitchFallback = Boolean(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET);
    await twitchPoll();
    if (!isStreaming && !hadTwitchFallback) {
      await triggerYouTubeSearch('client-connect');
    }
  }
}

function stopGrpcStream(reason) {
  grpcStopReason = reason;
  isStreaming = false;
  if (reason !== 'restart' && reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (activeGrpcStream) {
    try { activeGrpcStream.cancel(); } catch {}
    activeGrpcStream = null;
  }
}

function scheduleReconnect(videoIdToRetry, delayMs, reason) {
  if (!running || reconnectTimer || !videoIdToRetry) return;
  // If rate-limit cooldown is active, defer the reconnect until the
  // cooldown expires (plus a small jitter). This is the recovery path
  // that was missing during the 2026-04-17 outage — gRPC errors never
  // set rateLimitCooldownUntil because recordApiError wasn't wired into
  // the gRPC catch block. Now it is, and scheduleReconnect honors it.
  if (isInRateLimitCooldown()) {
    const waitMs = Math.max(delayMs, rateLimitCooldownUntil - Date.now() + Math.floor(Math.random() * 5000));
    console.warn(`  [YT] Rate-limit cooldown active — deferring reconnect (${reason}) by ${Math.round(waitMs / 1000)}s`);
    delayMs = waitMs;
  }
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!running || isStreaming) return;
    if (isInRateLimitCooldown()) {
      // Re-check at fire time; if the cooldown got extended in the meantime,
      // defer again rather than burning a checkIfLive call into the wall.
      const retryIn = Math.max(1000, rateLimitCooldownUntil - Date.now() + 1000);
      console.warn(`  [YT] Cooldown still active at reconnect fire time — retrying in ${Math.round(retryIn / 1000)}s`);
      scheduleReconnect(videoIdToRetry, retryIn, reason);
      return;
    }
    if (metrics.quotaUsedToday >= QUOTA_RECONCILE_CEILING) {
      console.warn(`  [YT] Skipping reconnect (${reason}) — quota near ceiling`);
      return;
    }

    try {
      metrics.grpcReconnects++;
      const chatId = await checkIfLive(videoIdToRetry);
      if (!chatId) {
        console.log(`  [YT] Reconnect aborted (${reason}) — stream no longer live`);
        videoId = null;
        liveChatId = null;
        return;
      }
      videoId = videoIdToRetry;
      liveChatId = chatId;
      connectGrpcStream().catch((err) => {
        console.error(`  [YT] Reconnect gRPC error (${reason}): ${err.message}`);
        isStreaming = false;
      });
    } catch (err) {
      console.error(`  [YT] Reconnect failed (${reason}): ${err.message}`);
    }
  }, delayMs);
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
  clearRateLimitCooldown();

  const item = videoResponse.data.items?.[0];
  if (!item) return null;

  const snippet = item.snippet || {};

  // HARD CHECK: reject any video not owned by our configured channel.
  // Even if the upstream detector returned a wrong id (autoHeal, PubSub,
  // manual webhook, anything), we refuse to connect to another channel.
  if (CHANNEL_ID && snippet.channelId && snippet.channelId !== CHANNEL_ID) {
    console.log(`  [YT] REJECT ${targetVideoId} — belongs to ${snippet.channelId}, not ${CHANNEL_ID}`);
    return null;
  }

  const broadcastStatus = snippet.liveBroadcastContent;
  const isActive = broadcastStatus === 'live' || broadcastStatus === 'upcoming';
  const chatId = item.liveStreamingDetails?.activeLiveChatId;

  if (isActive && chatId) {
    const label = broadcastStatus === 'upcoming' ? 'Waiting room' : 'Live';
    console.log(`  [YT] ${label}: "${snippet.title}" (${targetVideoId})`);
    return chatId;
  }
  console.log(`  [YT] ${targetVideoId} not live (liveBroadcastContent=${broadcastStatus})`);
  return null;
}

// ─── Test-only startup discovery ───────────────────────────────
async function startupDiscovery() {
  if (VIDEO_ID) {
    console.log(`  [YT] Manual VIDEO_ID override set — checking ${VIDEO_ID}`);
    const chatId = await checkIfLive(VIDEO_ID);
    if (chatId) {
      videoId = VIDEO_ID;
      liveChatId = chatId;
      return true;
    }
    return false;
  }
  return false;
}

// ─── Handle a PubSub notification: verify, then connect ────────
async function handleLiveCandidate(candidateVideoId, { source = 'unknown', notifiedChannelId = '' } = {}) {
  if (notifiedChannelId && CHANNEL_ID && notifiedChannelId !== CHANNEL_ID) {
    console.log(`  [YT] Rejecting ${candidateVideoId} from ${source} — notified channel ${notifiedChannelId} !== ${CHANNEL_ID}`);
    return;
  }
  if (source.startsWith('pubsub')) {
    clearPubSubCandidate();
  }
  if (pendingCandidateVideoIds.has(candidateVideoId)) {
    console.log(`  [YT] Candidate ${candidateVideoId} already being handled (${source})`);
    return;
  }
  if (liveCandidateInFlight) {
    console.log(`  [YT] Another live candidate is already in flight — skipping ${candidateVideoId} (${source})`);
    return;
  }
  if (isStreaming) {
    console.log(`  [YT] Already streaming ${videoId}, ignoring notification for ${candidateVideoId}`);
    return;
  }
  pendingCandidateVideoIds.add(candidateVideoId);
  liveCandidateInFlight = true;
  try {
    const chatId = await checkIfLive(candidateVideoId);
    if (!chatId) return;
    videoId = candidateVideoId;
    liveChatId = chatId;
    nextPageToken = '';
    lastGrpcActivityAt = Date.now();

    // Fetch custom emoji library for this stream (no quota cost)
    fetchEmojiLibrary(videoId).then((map) => {
      emojiLibrary = map;
      broadcast({ type: 'yt.emoji.library', emojis: map });
    });

    connectGrpcStream().catch((err) => {
      console.error('  [YT] gRPC error:', err.message);
      isStreaming = false;
    });
  } finally {
    liveCandidateInFlight = false;
    pendingCandidateVideoIds.delete(candidateVideoId);
  }
}

// ─── gRPC stream — runs until chat ends, then returns ──────────
//
// YouTube's streamList is a server-streaming RPC. ONE call opens a stream
// that stays alive for the entire broadcast; the server pushes responses as
// chat events happen. We do NOT re-call streamList on empty nextPageToken —
// that treats server-streaming like REST pagination and caused the
// 2026-04-17 outage (3.5 hours of churn trips YouTube's per-window rate
// limit on streamList opens). Instead: open once, iterate the async
// iterator until YouTube closes it or an error is thrown, then let
// scheduleReconnect (the single reopen path) handle it with cooldown
// honored.
//
// HTTP/2 keepalive detects dead connections accurately during quiet-chat
// stretches without us having to guess from message activity. No false
// "connection is stale" restarts triggered by a quiet crowd.
async function connectGrpcStream() {
  console.log('  [YT] Connecting to YouTube gRPC stream...');
  isStreaming = true;
  grpcStopReason = null;
  const openedAt = Date.now();
  lastGrpcActivityAt = openedAt;
  metrics.grpcStreamsOpened++;
  metrics.lastGrpcOpenAt = openedAt;
  // Opening the gRPC streamList costs 1 quota unit (same as videos.list).
  // Previously untracked — before the 1a fix we were churning many opens
  // per broadcast and undercounting local quota vs Google's real counter.
  recordApiCall(1, 'grpc.streamList');
  logEvent('grpc.opened', { videoId, liveChatId });
  logEvent('session.started', { videoId, liveChatId });

  const client = new V3DataLiveChatMessageServiceClient(
    'youtube.googleapis.com:443',
    grpc.credentials.createSsl(),
    {
      'grpc.keepalive_time_ms': 30000,           // send PING every 30s
      'grpc.keepalive_timeout_ms': 10000,        // 10s for PONG before connection considered dead
      'grpc.keepalive_permit_without_calls': 1,  // ping even during quiet chat stretches
      'grpc.http2.max_pings_without_data': 0,    // no cap on pings when no data
    }
  );

  const request = new LiveChatMessageListRequest();
  request.setLiveChatId(liveChatId);
  request.setMaxResults(200);
  request.setPartList(['snippet', 'authorDetails']);

  const metadata = new grpc.Metadata();
  metadata.add('x-goog-api-key', API_KEY);

  const stream = client.streamList(request, metadata);
  activeGrpcStream = stream;

  try {
    for await (const response of stream) {
      lastGrpcActivityAt = Date.now();
      const res = response.toObject();
      processMessages(res.itemsList || []);
      // nextPageToken on a server-streaming response is NOT a reconnect
      // signal — it's the server marking a batch boundary. We keep reading
      // from the same stream until the server half-closes it or an error.
    }
    // Natural end: server half-closed the stream (broadcast ended,
    // backend rotation, etc). Fall through to finally → shouldReconnect
    // decides whether to reconnect via scheduleReconnect (the single
    // reopen path, which honors cooldown).
    console.log('  [YT] Stream closed by server — returning to finally for reconnect decision');
  } catch (err) {
    if (!running) return;
    // gRPC code 1 (CANCELLED) and any close where we set grpcStopReason
    // ourselves are intentional shutdowns — not API errors. Routing those
    // through recordApiError was inflating apiErrors / lastApiError and could
    // engage the rate-limit cooldown on a clean idle/restart shutdown.
    const isIntentionalStop = err.code === 1 || Boolean(grpcStopReason);
    if (err.code === 0 || isIntentionalStop || (err.message && err.message.includes('stream ended'))) {
      console.log(`  [YT] Stream closed (reason=${grpcStopReason || 'server-half-close'})`);
    } else {
      console.error(`  [YT] Stream error (code ${err.code}): ${err.message}`);
      // Route the error through recordApiError so rate-limit cooldowns
      // actually engage. Without this, gRPC RESOURCE_EXHAUSTED (code 8)
      // used to just log and reconnect every 10s, amplifying the rate
      // limit into a full outage.
      recordApiError(err, 'grpc-stream');
      if (err.code === 8) {
        metrics.grpcOpenRateLimited++;
      }
    }
  } finally {
    const wasVideoId = videoId;
    const closedAt = Date.now();
    const durationMs = closedAt - openedAt;
    const stopReason = grpcStopReason || 'stream-ended';
    const shouldReconnect =
      running &&
      wasVideoId &&
      stopReason !== 'idle' &&
      stopReason !== 'twitch-offline' &&
      metrics.quotaUsedToday < QUOTA_RECONCILE_CEILING;
    isStreaming = false;
    nextPageToken = '';
    activeGrpcStream = null;
    grpcStopReason = null;
    logEvent('grpc.closed', { reason: stopReason, durationMs, videoId: wasVideoId });

    // Always run cleanup. Previously an early `return` inside `finally` for
    // the 'restart' path skipped session.ended logging AND the
    // clearTrackedMessages sweep — which re-introduced exactly the stale-id
    // reconcile bug this block is meant to prevent. Instead: always log,
    // always clear tracked messages, always null liveChatId, then branch on
    // stopReason at the end to pick the reconnect cadence.
    logEvent('session.ended', {
      videoId: wasVideoId,
      durationMs,
      reason: stopReason,
      messagesRelayed: metrics.messagesRelayed,
      messagesDeleted: metrics.messagesDeleted,
    });

    liveChatId = null;
    clearTrackedMessages([...activeMessages.keys()]);
    if (!shouldReconnect && stopReason !== 'restart') {
      videoId = null;
      emojiLibrary = {};
    }

    // Close the gRPC client so its HTTP/2 channel + keepalive timers are
    // released deterministically. Without this, every reconnect accumulated
    // a stale client and its keepalive PING timer over a long stream.
    try { client.close(); } catch {}

    if (stopReason === 'idle' || stopReason === 'twitch-offline' || stopReason === 'stream-ended') {
      broadcast({ type: 'yt.chat.ended' });
    }

    if (stopReason === 'restart') {
      console.log('  [YT] Restarting gRPC stream after watchdog recovery');
      scheduleReconnect(wasVideoId, 1000, stopReason);
    } else if (shouldReconnect) {
      console.log('  [YT] Attempting reconnect in 10 seconds...');
      scheduleReconnect(wasVideoId, 10000, stopReason);
    } else if (running && wasVideoId && stopReason !== 'idle' && stopReason !== 'twitch-offline') {
      console.warn('  [YT] NOT retrying — quota exhausted. Waiting for reset or manual trigger.');
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
const RECONCILE_INTERVAL_MS = 15 * 1000; // 15s — tighter moderation safety while still inside quota for normal streams
const MESSAGE_AGE_GRACE_MS = 10 * 60 * 1000; // only reconcile messages <10 min old
const messageTimestamps = new Map(); // messageId -> ts we broadcast it

async function reconcileMessages() {
  if (!liveChatId || !isStreaming) return;
  if (clientCount === 0) return; // nobody watching — don't burn quota on reconcile
  if (isInRateLimitCooldown()) return;

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
    clearRateLimitCooldown();
    const livePresent = new Set((res.data.items || []).map((m) => m.id));

    let removed = 0;
    for (const [msgId, info] of activeMessages) {
      const ts = messageTimestamps.get(msgId) || 0;
      if (ts < cutoff) continue; // too old to verify; don't touch
      if (!livePresent.has(msgId)) {
        console.log(`  [RECONCILE] Removing ${msgId} (${info.displayName}) — no longer in YouTube chat`);
        clearTrackedMessages([msgId]);
        broadcast({ type: 'yt.message.deleted', messageId: msgId });
        removed++;
      }
    }
    if (removed > 0) {
      metrics.reconcileDeletes += removed;
      console.log(`  [RECONCILE] Swept ${removed} orphaned messages`);
    }
    logEvent('reconcile.swept', { orphans: removed });
    broadcast({ type: 'system.reconciled', at: Date.now() });
  } catch (err) {
    recordApiError(err, 'reconcile');
  }
}
setInterval(reconcileMessages, RECONCILE_INTERVAL_MS);

async function grpcWatchdog() {
  if (!isStreaming || !videoId || !liveChatId || clientCount === 0 || grpcWatchdogPending) return;
  if (!lastGrpcActivityAt || Date.now() - lastGrpcActivityAt < GRPC_STALE_MS) return;
  if (metrics.quotaUsedToday >= QUOTA_RECONCILE_CEILING || isInRateLimitCooldown()) return;

  grpcWatchdogPending = true;
  try {
    let twitchLive = null;
    if (TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET) {
      twitchLive = await isTwitchLive();
      if (twitchLive === false) {
        console.warn('  [Watchdog] Twitch says Theo is offline — stopping gRPC');
        stopGrpcStream('twitch-offline');
        return;
      }
    }

    const chatId = await checkIfLive(videoId);
    if (chatId) {
      liveChatId = chatId;
      console.warn('  [Watchdog] gRPC stream went stale — restarting');
      stopGrpcStream('restart');
    } else {
      console.warn('  [Watchdog] YouTube no longer reports the stream as live');
      videoId = null;
      stopGrpcStream('stream-ended');
    }
  } catch (err) {
    recordApiError(err, 'grpc-watchdog');
  } finally {
    grpcWatchdogPending = false;
  }
}
setInterval(() => {
  grpcWatchdog().catch((err) => {
    console.error(`  [Watchdog] Failed: ${err.message}`);
  });
}, 15000);

// NOTE: The old HTML-scraping autoHeal has been removed entirely.
// Live detection now uses exclusively SDK + channel-scoped paths:
//   1. PubSub webhook + videos.list (channel-verified)
//   2. Twitch Helix poll + search.list (channel-scoped)
//   3. Startup check on first client connect
// Each path funnels through checkIfLive() which hard-rejects any video
// whose snippet.channelId !== CHANNEL_ID. Zero chance of wrong-channel leakage.

// ─── Twitch Helix live detection ───────────────────────────────
// Reliable "is Theo live on Twitch?" signal. Free, 120 req/min limit.
// When Twitch flips from offline→online, trigger a single YouTube
// search.list to find the current YouTube broadcast (100 quota, one-time).
// Falls back gracefully to PubSub-only if credentials are missing/invalid.
let twitchToken = null;
let twitchTokenExpiresAt = 0;
let twitchLastLive = false;
let twitchAuthFailed = false;

async function getTwitchToken() {
  if (twitchAuthFailed) return null;
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null;
  if (twitchToken && Date.now() < twitchTokenExpiresAt - 60000) return twitchToken;

  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials',
      }).toString(),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`  [Twitch] Auth failed (${res.status}): ${body.slice(0, 200)}`);
      twitchAuthFailed = true;
      return null;
    }
    const data = await res.json();
    twitchToken = data.access_token;
    twitchTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    console.log('  [Twitch] Got access token');
    return twitchToken;
  } catch (err) {
    console.error(`  [Twitch] Auth error: ${err.message}`);
    return null;
  }
}

async function isTwitchLive() {
  const token = await getTwitchToken();
  if (!token) return null; // unknown — auth missing or failed

  try {
    const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(TWITCH_CHANNEL)}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Client-Id': TWITCH_CLIENT_ID,
      },
    });
    if (res.status === 401) {
      twitchToken = null; // token expired — will refresh on next call
      return null;
    }
    if (!res.ok) {
      console.error(`  [Twitch] streams check failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    lastTwitchLiveCheckAt = Date.now();
    lastTwitchLiveResult = (data.data || []).length > 0;
    return lastTwitchLiveResult;
  } catch (err) {
    console.error(`  [Twitch] isLive error: ${err.message}`);
    return null;
  }
}

async function twitchPoll() {
  // Only poll while someone's using the extension — zero-idle guarantee
  if (clientCount === 0) return;
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return;

  const nowLive = await isTwitchLive();
  if (nowLive === null) return; // unknown state — skip

  // Transition offline → online: Theo just started on Twitch
  if (nowLive && !twitchLastLive) {
    console.log('  [Twitch] Theo went LIVE — triggering YouTube check');
    triggerYouTubeSearch();
  }
  // Transition online → offline: clean up gRPC
  if (!nowLive && twitchLastLive && isStreaming) {
    console.log('  [Twitch] Theo went OFFLINE on Twitch — closing gRPC');
    stopGrpcStream('twitch-offline');
  }
  twitchLastLive = nowLive;
}

async function triggerYouTubeSearch(reason = 'twitch-triggered') {
  if (isStreaming) return;
  if (metrics.quotaUsedToday >= QUOTA_RECONCILE_CEILING) return;
  if (clientCount === 0) return;
  try {
    recordApiCall(100, `search.list(${reason})`);
    const res = await youtube.search.list({
      channelId: CHANNEL_ID,
      eventType: 'live',
      type: ['video'],
      part: ['id'],
    });
    clearRateLimitCooldown();
    const item = res.data.items?.[0];
    if (item?.id?.videoId) {
      await handleLiveCandidate(item.id.videoId, { source: reason });
    } else {
      console.log(`  [Detect] No live broadcast found on YouTube yet (${reason})`);
    }
  } catch (err) {
    recordApiError(err, `search.list(${reason})`);
  }
}

// Poll Twitch every 60s
setInterval(twitchPoll, 60 * 1000);

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

// ─── PubSub subscription ───────────────────────────────────────
async function subscribeToPubSub() {
  if (!CHANNEL_ID) {
    console.log('  [PubSub] No CHANNEL_ID set; skipping subscription.');
    return;
  }
  if (!PUBLIC_URL) {
    console.log('  [PubSub] No PUBLIC_URL set; skipping subscription.');
    return;
  }
  const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
  const callback = `${PUBLIC_URL.replace(/\/$/, '')}/webhook/youtube`;
  console.log(`  [PubSub] PUBLIC_URL=${PUBLIC_URL}`);
  console.log(`  [PubSub] callback=${callback}`);
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
      if (!TYPE_NAMES[type]) metrics.unknownMessageTypes++;
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
        clearTrackedMessages([deletedId]);
        metrics.realtimeDeletes++;
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
      clearTrackedMessages(toRemove);
      metrics.realtimeDeletes += toRemove.length;
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
  async function ensurePubSub() {
    try {
      await subscribeToPubSub();
    } catch (err) {
      console.error('  [PubSub] setup error:', err.message);
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

  // Zero-quota-idle: no discovery work at boot. Detection fires on the
  // first WS client connect via kickoffDetectionForActiveClient(), which
  // handles cached PubSub candidates, Twitch Helix fallback, and a
  // one-time YouTube search. When nobody is on Twitch watching Theo, we
  // burn zero YouTube quota.
}

// ─── Shutdown ──────────────────────────────────────────────────
// Graceful shutdown. writeStream.end() is async — the old handlers called it
// and then raced process.exit(0), so the final burst of events (session.ended,
// grpc.closed, ws.disconnected) was routinely lost. Now we stop accepting new
// work, close sockets, then wait for the event log to finish flushing before
// exiting.
let shuttingDown = false;
function gracefulExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`  [Shutdown] ${signal} received — draining...`);
  running = false;
  try { wss.close(); } catch {}
  try { server.close(); } catch {}
  // Cancel any in-flight gRPC stream cleanly so the server sees a proper
  // CANCELLED instead of a TCP drop. stopGrpcStream sets grpcStopReason
  // so the catch block treats it as intentional (no false recordApiError,
  // no rate-limit cooldown).
  try { stopGrpcStream('shutdown'); } catch {}
  // Safety net: if the flush hangs for any reason, force-exit after 5s so we
  // don't leave an undead process in Railway's container.
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref();
  shutdownEventLog(() => process.exit(0));
}
process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));

main();
