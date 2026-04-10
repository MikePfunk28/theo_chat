// TheoChat — Cloudflare Worker (landing page + health proxy)
// Serves the t3yt.mikepfunk.com landing page

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers for API routes
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check endpoint
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'theochat-worker' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Landing page
    return new Response(landingPage(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};

function landingPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TheoChat — YouTube Chat in Twitch</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0e0e10;
      color: #efeff1;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .container { max-width: 600px; text-align: center; }
    h1 {
      font-size: 2.5rem;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #ff0000, #9146ff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      color: #adadb8;
      font-size: 1.1rem;
      margin-bottom: 2rem;
    }
    .card {
      background: #18181b;
      border: 1px solid #303032;
      border-radius: 12px;
      padding: 2rem;
      margin-bottom: 1.5rem;
    }
    .card h2 {
      font-size: 1.2rem;
      margin-bottom: 0.75rem;
      color: #efeff1;
    }
    .card p {
      color: #adadb8;
      line-height: 1.6;
    }
    .badges {
      display: flex;
      gap: 0.75rem;
      justify-content: center;
      margin-top: 1.5rem;
      flex-wrap: wrap;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: #303032;
      padding: 0.4rem 0.8rem;
      border-radius: 6px;
      font-size: 0.85rem;
    }
    .badge-yt { border-left: 3px solid #ff0000; }
    .badge-tw { border-left: 3px solid #9146ff; }
    .badge-mod { border-left: 3px solid #00ad03; }
    footer {
      margin-top: 2rem;
      color: #606064;
      font-size: 0.85rem;
    }
    a { color: #bf94ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>TheoChat</h1>
    <p class="subtitle">YouTube live chat, inside Twitch — built for theo.gg</p>

    <div class="card">
      <h2>What is this?</h2>
      <p>
        TheoChat pulls YouTube live chat messages into Twitch chat in real time.
        Moderation actions (deletions, bans) from YouTube mods are reflected instantly.
        No extra setup for the streamer — just install the browser extension.
      </p>
    </div>

    <div class="card">
      <h2>How it works</h2>
      <p>
        A backend service connects to YouTube's live chat via gRPC streaming.
        Messages are forwarded over WebSocket to a Zen/Chrome browser extension
        that injects them directly into the Twitch chat DOM with a [YT] badge.
      </p>
    </div>

    <div class="badges">
      <span class="badge badge-yt">YouTube Chat</span>
      <span class="badge badge-tw">Twitch Chat</span>
      <span class="badge badge-mod">Moderation Sync</span>
    </div>

    <footer>
      <p>TheoChat &middot; <a href="https://theo.gg" target="_blank">theo.gg</a></p>
    </footer>
  </div>
</body>
</html>`;
}
