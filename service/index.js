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
// How often to self-heal by checking YouTube's public /live HTML page (free, no quota).
// PubSub is unreliable for go-live events; this fallback catches what it misses.
const LIVE_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

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
const MessageType = {
  TEXT_MESSAGE_EVENT: 1,
  TOMBSTONE: 2,
  MESSAGE_DELETED_EVENT: 8,
  USER_BANNED_EVENT: 10,
  SUPER_CHAT_EVENT: 15
};

// ─── State ─────────────────────────────────────────────────────
let liveChatId = null;
let videoId = VIDEO_ID || null;
let nextPageToken = '';
const processedIds = new Set();
const activeMessages = new Map(); // messageId -> { userId, displayName }
let running = true;
let isStreaming = false; // true while connected to an active gRPC stream

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
    }));
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
      ws.close(4001, 'Unauthorized');
      return;
    }
  }

  clientCount++;
  console.log(`  [WS] Client connected (${clientCount} total)`);
  ws.send(JSON.stringify({ type: 'system.connected', text: 'TheoChat connected' }));
  ws.on('close', () => {
    clientCount--;
    console.log(`  [WS] Client disconnected (${clientCount} total)`);
  });
});

function broadcast(event) {
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
  const videoResponse = await youtube.videos.list({
    id: [targetVideoId],
    part: ['liveStreamingDetails', 'snippet'],
  });

  const item = videoResponse.data.items?.[0];
  if (!item) return null;

  const snippet = item.snippet || {};
  const isLive = snippet.liveBroadcastContent === 'live';
  const chatId = item.liveStreamingDetails?.activeLiveChatId;

  if (isLive && chatId) {
    console.log(`  [YT] Live: "${snippet.title}" (${targetVideoId})`);
    return chatId;
  }
  console.log(`  [YT] ${targetVideoId} not live (liveBroadcastContent=${snippet.liveBroadcastContent})`);
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
    const response = await youtube.search.list({
      channelId: CHANNEL_ID,
      eventType: 'live',
      type: ['video'],
      part: ['id,snippet'],
    });
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
    isStreaming = false;
    liveChatId = null;
    nextPageToken = '';
    broadcast({ type: 'yt.chat.ended' });
  }
}

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
    // for moderation actions YouTube may use besides the standard four.
    // Remove this block after all types are handled.
    if (type !== undefined && type !== MessageType.TEXT_MESSAGE_EVENT) {
      console.log(`  [YT][DBG] msgId=${id} type=${type} snippetKeys=${Object.keys(snippet).join(',')}`);
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
      broadcast(event);
      console.log(`  [YT] SC ${event.superChatAmount} ${event.displayName}: ${event.text}`);

    } else if (type === MessageType.MESSAGE_DELETED_EVENT || type === MessageType.TOMBSTONE) {
      // Multiple possible shapes YouTube uses for the deleted-id reference
      const details = snippet.messageDeletedDetails || {};
      const deletedId = details.deletedMessageId || snippet.deletedMessageId || '';
      if (deletedId) {
        activeMessages.delete(deletedId);
        broadcast({ type: 'yt.message.deleted', messageId: deletedId });
        console.log(`  [YT] Deleted: ${deletedId}`);
      } else {
        console.log(`  [YT][WARN] delete/tombstone with no deletedMessageId — snippet: ${JSON.stringify(snippet).slice(0, 300)}`);
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

  // Subscribe to PubSub so YouTube pushes notifications when channel goes live
  subscribeToPubSub().catch((err) => console.error('  [PubSub] setup error:', err.message));

  // Renew subscription every 4 days (lease is 5 days)
  setInterval(() => subscribeToPubSub().catch(() => {}), 4 * 24 * 60 * 60 * 1000);

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
