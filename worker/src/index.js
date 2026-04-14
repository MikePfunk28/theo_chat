// TheoChat — Cloudflare Worker
// Serves t3yt.mikepfunk.com: landing, /api/config, /api/health, /privacy

// Railway service WebSocket URL. Update here + redeploy if the service moves.
const WS_URL = 'wss://theochat-production.up.railway.app';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ── API ───────────────────────────────────────────────────
    if (url.pathname === '/api/health') {
      return json({ status: 'ok', service: 'theochat-worker' }, corsHeaders);
    }

    // Extension fetches this at startup to auto-discover the Railway WS URL.
    // Set via: pnpm dlx wrangler secret put WS_URL
    if (url.pathname === '/api/config') {
      return json({ wsUrl: WS_URL }, corsHeaders);
    }

    // ── Pages ─────────────────────────────────────────────────
    if (url.pathname === '/privacy') {
      return html(privacyPage());
    }

    // Landing (default)
    return html(landingPage());
  },
};

function json(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function html(body) {
  return new Response(body, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ─── Shared design tokens (keep in sync with extension popup.css) ───

const SHARED_TOKENS = `
  :root {
    --stage: oklch(0.14 0.012 270);
    --stage-raised: oklch(0.18 0.014 270);
    --stage-deep: oklch(0.10 0.008 270);
    --line: oklch(0.26 0.015 270);
    --line-hot: oklch(0.42 0.02 270);
    --ink: oklch(0.96 0.005 270);
    --ink-muted: oklch(0.66 0.015 270);
    --ink-dim: oklch(0.46 0.018 270);
    --yt: oklch(0.64 0.24 28);
    --tw: oklch(0.68 0.21 295);
    --live: oklch(0.80 0.19 152);
    --caution: oklch(0.80 0.17 85);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: var(--stage); color: var(--ink); font-family: 'Instrument Sans', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  body {
    min-height: 100vh;
    background:
      linear-gradient(180deg, oklch(0.14 0.018 270) 0%, var(--stage) 40%),
      repeating-linear-gradient(90deg, transparent 0 95px, oklch(0.18 0.01 270 / 0.3) 95px 96px);
  }
  a { color: var(--tw); text-decoration: none; border-bottom: 1px dotted var(--tw); }
  a:hover { color: var(--ink); border-bottom-color: var(--ink); }
`;

const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Syne:wght@500;700;800&family=Instrument+Sans:wght@400;500;600&display=swap">`;

const WORDMARK = `<span class="wordmark"><span class="wordmark__t">THEO</span><span class="wordmark__dot"></span><span class="wordmark__c">CHAT</span></span>`;

// ─── Landing page ──────────────────────────────────────────────

function landingPage() {
  const wsUrl = WS_URL;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TheoChat — YouTube chat, inside Twitch</title>
<meta name="description" content="Merges YouTube live chat into a Twitch chat view with real-time moderation sync.">
${FONT_LINKS}
<style>
${SHARED_TOKENS}

/* Layout */
main { max-width: 920px; margin: 0 auto; padding: clamp(32px, 6vw, 80px) clamp(20px, 4vw, 48px); }

/* Header */
.nav { display: flex; justify-content: space-between; align-items: center; padding-bottom: 40px; border-bottom: 1px solid var(--line); }
.wordmark { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 20px; letter-spacing: -0.02em; line-height: 1; display: inline-flex; align-items: center; gap: 2px; }
.wordmark__dot { width: 6px; height: 6px; background: var(--yt); border-radius: 50%; margin: 0 3px 2px; box-shadow: 0 0 8px oklch(0.64 0.24 28 / 0.6); }
.nav__meta { font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 500; letter-spacing: 0.12em; color: var(--ink-dim); }

/* Hero */
.hero { padding: clamp(48px, 10vw, 112px) 0 clamp(40px, 8vw, 80px); }
.hero__tag { font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.22em; color: var(--yt); margin-bottom: 20px; }
.hero__title { font-family: 'Syne', sans-serif; font-weight: 800; font-size: clamp(44px, 8vw, 96px); line-height: 0.92; letter-spacing: -0.03em; margin-bottom: 28px; max-width: 12ch; }
.hero__title em { font-style: normal; color: var(--yt); }
.hero__sub { font-size: clamp(16px, 2vw, 20px); line-height: 1.5; color: var(--ink-muted); max-width: 52ch; margin-bottom: 40px; }

/* Signal strip */
.signals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); margin-bottom: 48px; max-width: 620px; }
.sig { background: var(--stage-deep); padding: 14px 18px; position: relative; }
.sig__led { width: 8px; height: 8px; border-radius: 50%; position: absolute; top: 16px; right: 16px; background: var(--ink-dim); }
.sig__led[data-state="live"] { background: var(--yt); box-shadow: 0 0 10px oklch(0.64 0.24 28 / 0.8); animation: pulse 1.4s ease-in-out infinite; }
.sig__led[data-state="ok"] { background: var(--live); box-shadow: 0 0 8px oklch(0.80 0.19 152 / 0.7); }
.sig__label { font-family: 'Syne', sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 0.16em; color: var(--ink-dim); display: block; margin-bottom: 4px; }
.sig__value { font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700; color: var(--ink); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

/* CTAs */
.cta-row { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; gap: 10px; padding: 14px 22px 13px; background: var(--stage-raised); color: var(--ink); border: 1px solid var(--line); border-left: 3px solid var(--live); font-family: 'Syne', sans-serif; font-weight: 700; font-size: 14px; letter-spacing: 0.04em; text-transform: uppercase; cursor: pointer; transition: background 160ms cubic-bezier(.22,1,.36,1), border-left-color 160ms; text-decoration: none; }
.btn:hover { background: oklch(0.21 0.015 270); color: var(--ink); border-bottom: none; border-left-color: var(--tw); }
.btn__arrow { font-size: 18px; line-height: 1; }
.btn--ghost { border-left-color: var(--line-hot); color: var(--ink-muted); }
.btn--ghost:hover { color: var(--ink); border-left-color: var(--tw); }

/* How it works — offset numbered blocks, asymmetric */
section { padding-block: clamp(48px, 8vw, 96px); border-top: 1px solid var(--line); }
.section__tag { font-family: 'Syne', sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 0.22em; color: var(--yt); margin-bottom: 20px; }
.section__title { font-family: 'Syne', sans-serif; font-weight: 800; font-size: clamp(28px, 4vw, 40px); line-height: 1.05; letter-spacing: -0.02em; margin-bottom: 48px; max-width: 20ch; }

.steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 40px 32px; }
.step { display: grid; grid-template-columns: auto 1fr; gap: 14px; align-items: start; }
.step__num { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 40px; letter-spacing: -0.04em; color: var(--yt); line-height: 1; min-width: 1ch; }
.step__body h3 { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 15px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink); margin-bottom: 6px; }
.step__body p { color: var(--ink-muted); line-height: 1.55; font-size: 15px; }

/* Spec / facts grid — asymmetric, not cards */
.spec { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
.spec__row { background: var(--stage-deep); padding: 22px 24px; }
.spec__key { font-family: 'Syne', sans-serif; font-size: 10px; font-weight: 600; letter-spacing: 0.18em; color: var(--ink-dim); margin-bottom: 8px; }
.spec__val { font-family: 'Syne', sans-serif; font-size: 18px; font-weight: 700; color: var(--ink); line-height: 1.2; }
.spec__val span { color: var(--yt); }

/* OBS overlay callout — raw, terminal-ish */
.overlay-box { margin-top: 28px; padding: 18px 20px; background: var(--stage-deep); border: 1px solid var(--line); border-left: 3px solid var(--caution); }
.overlay-box__label { font-family: 'Syne', sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 0.18em; color: var(--caution); margin-bottom: 10px; }
.overlay-box__copy { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.overlay-box__url { flex: 1; min-width: 240px; font-family: 'Syne', sans-serif; font-size: 14px; color: var(--ink); background: var(--stage); padding: 10px 12px; border: 1px solid var(--line); word-break: break-all; font-weight: 500; letter-spacing: 0.01em; }
.copy-btn { all: unset; cursor: pointer; padding: 10px 14px; background: var(--stage-raised); border: 1px solid var(--line-hot); color: var(--ink); font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; }
.copy-btn:hover { background: oklch(0.21 0.015 270); }
.copy-btn[data-copied="true"] { border-color: var(--live); color: var(--live); }

/* Footer */
footer { border-top: 1px solid var(--line); padding: 32px 0 40px; display: flex; justify-content: space-between; align-items: center; gap: 20px; flex-wrap: wrap; font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 500; letter-spacing: 0.1em; color: var(--ink-dim); }
footer a { font-family: inherit; font-size: inherit; letter-spacing: inherit; }
footer .foot__links { display: flex; gap: 20px; }
</style>
</head>
<body>
<main>
  <header class="nav">
    ${WORDMARK}
    <span class="nav__meta">v1.0 — BUILT FOR THEO.GG</span>
  </header>

  <section class="hero">
    <p class="hero__tag">YOUTUBE × TWITCH</p>
    <h1 class="hero__title">One chat. <em>Two platforms.</em></h1>
    <p class="hero__sub">TheoChat merges YouTube live chat into your Twitch chat panel in real time, with moderation sync and an opt-in mod-delay buffer. Zero-delay by default. Mods get a window to delete; deleted messages never show.</p>

    <div class="signals" id="signals">
      <div class="sig"><span class="sig__led" data-state="off" id="sigService"></span><span class="sig__label">SERVICE</span><span class="sig__value" id="sigServiceVal">—</span></div>
      <div class="sig"><span class="sig__led" data-state="off" id="sigYoutube"></span><span class="sig__label">YOUTUBE</span><span class="sig__value" id="sigYoutubeVal">—</span></div>
      <div class="sig"><span class="sig__led" data-state="off" id="sigBridge"></span><span class="sig__label">BRIDGE</span><span class="sig__value" id="sigBridgeVal">IDLE</span></div>
    </div>

    <div class="cta-row">
      <a class="btn" href="/download" id="installBtn"><span>Install for Zen / Firefox</span><span class="btn__arrow">→</span></a>
      <a class="btn btn--ghost" href="#how"><span>How it works</span></a>
    </div>
  </section>

  <section id="how">
    <p class="section__tag">HOW IT WORKS</p>
    <h2 class="section__title">Push-based. Zero polling. Zero latency.</h2>
    <div class="steps">
      <div class="step">
        <span class="step__num">01</span>
        <div class="step__body">
          <h3>YouTube goes live</h3>
          <p>YouTube PubSub pushes a notification the instant the stream starts. No polling, no quota burn while idle.</p>
        </div>
      </div>
      <div class="step">
        <span class="step__num">02</span>
        <div class="step__body">
          <h3>gRPC stream opens</h3>
          <p>The service attaches to YouTube's live-chat gRPC stream. Messages, super chats, and moderation events arrive in real time.</p>
        </div>
      </div>
      <div class="step">
        <span class="step__num">03</span>
        <div class="step__body">
          <h3>Inject into Twitch DOM</h3>
          <p>The browser extension renders each message inside the native Twitch chat with a YT badge. Mod deletions and bans sync instantly.</p>
        </div>
      </div>
    </div>
  </section>

  <section>
    <p class="section__tag">SPEC</p>
    <h2 class="section__title">Built the way a streamer actually works.</h2>
    <div class="spec">
      <div class="spec__row"><div class="spec__key">LATENCY</div><div class="spec__val">&lt;200<span> MS</span></div></div>
      <div class="spec__row"><div class="spec__key">IDLE QUOTA</div><div class="spec__val">0<span> /DAY</span></div></div>
      <div class="spec__row"><div class="spec__key">MOD DELAY</div><div class="spec__val">0 – 30<span> S</span></div></div>
      <div class="spec__row"><div class="spec__key">TRACKING</div><div class="spec__val">NONE</div></div>
    </div>

    <div class="overlay-box">
      <div class="overlay-box__label">OBS BROWSER SOURCE — OPTIONAL</div>
      <div class="overlay-box__copy">
        <code class="overlay-box__url" id="overlayUrl">—</code>
        <button class="copy-btn" id="copyOverlay" type="button">COPY</button>
      </div>
    </div>
  </section>

  <footer>
    <div>© THEOCHAT — BUILT FOR THEO.GG</div>
    <div class="foot__links">
      <a href="/privacy">Privacy</a>
      <a href="https://github.com" target="_blank" rel="noopener">Source</a>
      <a href="https://theo.gg" target="_blank" rel="noopener">theo.gg</a>
    </div>
  </footer>
</main>

<script>
(async function() {
  const wsUrl = ${JSON.stringify(wsUrl)};

  // Overlay URL
  const overlayUrlEl = document.getElementById('overlayUrl');
  if (wsUrl) {
    const base = wsUrl.replace(/^ws(s)?:\\/\\//, 'https://').replace(/\\/+$/, '');
    overlayUrlEl.textContent = base + '/overlay';
  } else {
    overlayUrlEl.textContent = 'Service URL not configured';
  }

  // Copy handler
  const copyBtn = document.getElementById('copyOverlay');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(overlayUrlEl.textContent);
      copyBtn.textContent = 'COPIED';
      copyBtn.dataset.copied = 'true';
      setTimeout(() => { copyBtn.textContent = 'COPY'; delete copyBtn.dataset.copied; }, 1600);
    } catch {}
  });

  // Live signals
  try {
    if (!wsUrl) throw new Error('no-url');
    const healthUrl = wsUrl.replace(/^ws(s)?:\\/\\//, 'https://').replace(/\\/+$/, '') + '/health';
    const res = await fetch(healthUrl, { cache: 'no-store' });
    const data = await res.json();
    if (data.status === 'ok') {
      document.getElementById('sigService').dataset.state = 'ok';
      document.getElementById('sigServiceVal').textContent = 'LIVE';
      document.getElementById('sigBridge').dataset.state = 'ok';
      document.getElementById('sigBridgeVal').textContent = 'READY';
    } else {
      document.getElementById('sigServiceVal').textContent = 'DOWN';
    }
    if (data.streaming) {
      document.getElementById('sigYoutube').dataset.state = 'live';
      document.getElementById('sigYoutubeVal').textContent = 'STREAM';
    } else {
      document.getElementById('sigYoutubeVal').textContent = 'IDLE';
    }
  } catch {
    document.getElementById('sigServiceVal').textContent = 'DOWN';
    document.getElementById('sigYoutubeVal').textContent = 'IDLE';
    document.getElementById('sigBridgeVal').textContent = 'IDLE';
  }
})();
</script>
</body>
</html>`;
}

// ─── Privacy page ──────────────────────────────────────────────

function privacyPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Privacy — TheoChat</title>
${FONT_LINKS}
<style>
${SHARED_TOKENS}
main { max-width: 720px; margin: 0 auto; padding: clamp(32px, 6vw, 80px) clamp(20px, 4vw, 48px); }
.nav { display: flex; justify-content: space-between; align-items: center; padding-bottom: 40px; border-bottom: 1px solid var(--line); }
.wordmark { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 20px; letter-spacing: -0.02em; line-height: 1; display: inline-flex; align-items: center; gap: 2px; }
.wordmark__dot { width: 6px; height: 6px; background: var(--yt); border-radius: 50%; margin: 0 3px 2px; }
.nav__meta { font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 500; letter-spacing: 0.12em; color: var(--ink-dim); }

article { padding-block: clamp(40px, 6vw, 72px); }
article .tag { font-family: 'Syne', sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 0.22em; color: var(--yt); margin-bottom: 20px; }
article h1 { font-family: 'Syne', sans-serif; font-weight: 800; font-size: clamp(40px, 6vw, 64px); line-height: 1; letter-spacing: -0.03em; margin-bottom: 16px; }
article .updated { color: var(--ink-dim); font-size: 13px; margin-bottom: 48px; font-family: 'Syne', sans-serif; letter-spacing: 0.1em; }
article h2 { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 14px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--yt); margin-top: 40px; margin-bottom: 12px; border-top: 1px solid var(--line); padding-top: 32px; }
article h2:first-of-type { border-top: 0; padding-top: 0; }
article p { color: var(--ink-muted); line-height: 1.65; font-size: 16px; max-width: 58ch; margin-bottom: 16px; }
article strong { color: var(--ink); font-weight: 600; }
article ul { color: var(--ink-muted); margin-bottom: 16px; padding-left: 20px; }
article li { margin-bottom: 8px; line-height: 1.6; max-width: 56ch; }

footer { border-top: 1px solid var(--line); padding: 32px 0 40px; font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 500; letter-spacing: 0.1em; color: var(--ink-dim); }
</style>
</head>
<body>
<main>
  <header class="nav">
    <a href="/" style="text-decoration:none;border:0;color:inherit;">${WORDMARK}</a>
    <span class="nav__meta">PRIVACY POLICY</span>
  </header>
  <article>
    <p class="tag">POLICY</p>
    <h1>Nothing to track.</h1>
    <p class="updated">Last updated — 2026-04-14</p>

    <h2>What TheoChat does</h2>
    <p>TheoChat is a two-part tool: a backend service that reads <strong>YouTube's public live-chat feed</strong> using the YouTube Data API, and a browser extension that displays those messages inside the Twitch tab you are already watching.</p>
    <p>The chat data is never modified, stored on disk, or forwarded to any third party. The service holds only in-memory state for the duration of a live broadcast.</p>

    <h2>Data collected</h2>
    <p><strong>None.</strong> TheoChat does not collect, store, transmit, sell, or share any personal information. Specifically:</p>
    <ul>
      <li>No account system — there is nothing to sign in to.</li>
      <li>No cookies, localStorage beacons, or fingerprinting.</li>
      <li>No analytics — no Google Analytics, no Plausible, no Mixpanel, nothing.</li>
      <li>No server-side logging of YouTube messages or Twitch activity.</li>
      <li>No tracking pixels, no third-party scripts.</li>
    </ul>

    <h2>What the extension accesses</h2>
    <p>The extension requests the minimum permissions needed to function:</p>
    <ul>
      <li><strong>Content access on twitch.tv</strong> — to inject YouTube messages into the chat DOM you are viewing.</li>
      <li><strong>Storage</strong> — to remember your toggle state and optional mod-delay preference across sessions, stored only in your browser.</li>
      <li><strong>Network to the TheoChat service</strong> — to receive the YouTube chat stream.</li>
    </ul>

    <h2>What YouTube sees</h2>
    <p>The TheoChat service authenticates to YouTube using the operator's API key (read-only access to public live-chat data). YouTube's own privacy policy governs what they log about those API calls. The service never sees or forwards any user credentials — yours or the operator's.</p>

    <h2>Open source</h2>
    <p>The entire code base is open source. If a claim above is wrong, the code proves it.</p>

    <h2>Contact</h2>
    <p>Questions or concerns: open an issue on the project repository or reach out via <a href="https://theo.gg" target="_blank" rel="noopener">theo.gg</a>.</p>
  </article>
  <footer>© THEOCHAT — BUILT FOR THEO.GG · <a href="/">Back to landing</a></footer>
</main>
</body>
</html>`;
}
