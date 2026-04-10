const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const YouTubeChatService = require('./youtube');

// Load config
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('\n  config.json not found! Run "npm run setup" first.\n');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const WS_PORT = config.wsPort || 9300;
const HTTP_PORT = config.httpPort || 9301;

// ─── WebSocket Server ─────────────────────────────────────────────

const wss = new WebSocket.Server({ port: WS_PORT });
let connectedClients = 0;

wss.on('connection', (ws) => {
  connectedClients++;
  console.log(`  [WS] Client connected (${connectedClients} total)`);

  // Send a connection confirmation
  ws.send(JSON.stringify({ type: 'system.connected', text: 'TheoChat service connected' }));

  ws.on('close', () => {
    connectedClients--;
    console.log(`  [WS] Client disconnected (${connectedClients} total)`);
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

// ─── HTTP Status Server ───────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      running: true,
      clients: connectedClients,
      liveChatId: ytService.liveChatId,
      videoId: ytService.videoId
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`  [HTTP] Status server on http://localhost:${HTTP_PORT}/status`);
});

// ─── YouTube Chat Service ─────────────────────────────────────────

const ytService = new YouTubeChatService(config);

ytService.on('event', (event) => {
  // Log to console
  switch (event.type) {
    case 'yt.message.created':
      const badge = event.badges.length > 0 ? `[${event.badges.join(',')}] ` : '';
      const sc = event.isSuperChat ? ` 💰${event.superChatAmount}` : '';
      console.log(`  [YT] ${badge}${event.displayName}: ${event.text}${sc}`);
      break;
    case 'yt.message.deleted':
      console.log(`  [YT] Message deleted: ${event.messageId}`);
      break;
    case 'yt.user.banned':
      console.log(`  [YT] User banned: ${event.displayName} (${event.userId}) — ${event.bannedMessageIds?.length || 0} messages removed`);
      break;
  }

  // Broadcast to all connected WebSocket clients (extension)
  broadcast(event);
});

ytService.on('error', (err) => {
  console.error(`  [YT] Service error: ${err.message}`);
});

// ─── Startup ──────────────────────────────────────────────────────

console.log('\n  ╔══════════════════════════════════════╗');
console.log('  ║       TheoChat Service v1.0.0         ║');
console.log('  ╚══════════════════════════════════════╝\n');
console.log(`  [WS] WebSocket server on ws://localhost:${WS_PORT}`);

ytService.start();

// ─── Graceful Shutdown ────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  ytService.stop();
  wss.close();
  httpServer.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  ytService.stop();
  wss.close();
  httpServer.close();
  process.exit(0);
});
