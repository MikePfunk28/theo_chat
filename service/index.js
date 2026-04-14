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

// ─── YouTube REST API client (for stream discovery) ────────────
const youtube = google.youtube({ version: 'v3', auth: API_KEY });

// ─── Single HTTP server (health check + overlay + WebSocket upgrade) ─
const fs = require('fs');
const overlayPath = require('path').join(__dirname, 'overlay.html');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const parsedUrl = req.url.split('?')[0];

  if (parsedUrl === '/health' || parsedUrl === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      clients: clientCount,
      liveChatId,
      videoId
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

server.listen(PORT, () => {
  console.log(`  [HTTP] Health check + WebSocket on port ${PORT}`);
});

// ─── Discover live stream ──────────────────────────────────────
async function discoverLiveStream() {
  if (videoId) {
    console.log(`  [YT] Using video ID: ${videoId}`);
  } else if (CHANNEL_ID) {
    console.log(`  [YT] Searching for live streams on channel ${CHANNEL_ID}...`);
    const response = await youtube.search.list({
      channelId: CHANNEL_ID,
      eventType: 'live',
      type: ['video'],
      part: ['id,snippet']
    });

    if (response.data.items && response.data.items.length > 0) {
      const live = response.data.items[0];
      videoId = live.id.videoId;
      console.log(`  [YT] Found live stream: "${live.snippet.title}" (${videoId})`);
    } else {
      console.log('  [YT] No active live stream found.');
      return false;
    }
  }

  // Get the live chat ID
  const videoResponse = await youtube.videos.list({
    id: [videoId],
    part: ['liveStreamingDetails']
  });

  if (videoResponse.data.items && videoResponse.data.items.length > 0) {
    liveChatId = videoResponse.data.items[0].liveStreamingDetails?.activeLiveChatId;
    if (liveChatId) {
      console.log(`  [YT] Live chat ID: ${liveChatId}`);
      return true;
    }
    console.log('  [YT] Video found but no active live chat.');
  }
  return false;
}

// ─── gRPC stream ───────────────────────────────────────────────
async function connectGrpcStream() {
  console.log('  [YT] Connecting to YouTube gRPC stream...');

  const client = new V3DataLiveChatMessageServiceClient(
    'youtube.googleapis.com:443',
    grpc.credentials.createSsl()
  );

  while (running) {
    const request = new LiveChatMessageListRequest();
    request.setLiveChatId(liveChatId);
    request.setMaxResults(200);
    request.setPartList(['snippet', 'authorDetails']);
    if (nextPageToken) {
      request.setPageToken(nextPageToken);
    }

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
        console.log('  [YT] Stream ended, reconnecting...');
      } else {
        console.error(`  [YT] Stream error (code ${err.code}): ${err.message}`);
      }
      break;
    }
  }

  if (running) {
    console.log('  [YT] Reconnecting in 2 seconds...');
    await new Promise(r => setTimeout(r, 2000));
    await connectGrpcStream();
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
      const deletedId = (snippet.messageDeletedDetails || {}).deletedMessageId || '';
      if (deletedId) {
        activeMessages.delete(deletedId);
        broadcast({ type: 'yt.message.deleted', messageId: deletedId });
        console.log(`  [YT] Deleted: ${deletedId}`);
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

// ─── Main loop ─────────────────────────────────────────────────
async function main() {
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║       TheoChat Service v1.0.0         ║');
  console.log('  ╚══════════════════════════════════════╝\n');
  console.log(`  [WS] Health check + WebSocket on port ${PORT}`);

  while (running) {
    try {
      const found = await discoverLiveStream();
      if (found) {
        await connectGrpcStream();
      } else {
        console.log('  [YT] Retrying in 30 seconds...');
        await new Promise(r => setTimeout(r, 30000));
      }
    } catch (err) {
      console.error('  [YT] Error:', err.message);
      console.log('  [YT] Retrying in 5 seconds...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─── Shutdown ──────────────────────────────────────────────────
process.on('SIGINT', () => { running = false; wss.close(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { running = false; wss.close(); server.close(); process.exit(0); });

main();
