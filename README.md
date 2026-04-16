# TheoChat

Merges Theo's YouTube live chat into Theo's Twitch chat view. YouTube messages appear inline in the native Twitch chat panel with a red `YT` badge. When YouTube mods delete a message or ban a user, those actions are mirrored into the Twitch view immediately, with a `30s` fallback reconciliation sweep while live.

**Live site:** [t3yt.mikepfunk.com](https://t3yt.mikepfunk.com)

---

## How It Works

```
YouTube goes live
       │
       ▼
YouTube PubSub push ───► [Railway service] ──(videos.list, 1 quota)──► gRPC stream
                               │
                               ▼ (WebSocket)
                        [Browser extension]
                               │
                               ▼ (DOM injection)
                         Twitch chat panel ─── YT messages + mod sync
```

**Push-first, zero idle YouTube quota.** The Railway service subscribes once to YouTube's PubSubHubbub. YouTube pushes a notification the instant Theo goes live. If nobody is using the bridge yet, the service caches that candidate and waits. Once a client connects, it verifies the cached candidate or falls back to Twitch Helix + a single channel-scoped YouTube `search.list`. During an active stream, the service also runs a `30s` `liveChatMessages.list` reconciliation sweep for moderation safety. Offline YouTube quota remains `0`.

**Read-only mirror.** YouTube is the source of truth. We never write to YouTube, never touch Twitch's actual chat. We just paint YouTube messages into Theo's Twitch browser tab.

**OBS-compatible.** OBS captures whatever Theo's browser shows, so viewers see the merged chat too. For streamers using OBS's built-in browser source for chat, a standalone transparent overlay is available at `/overlay`.

---

## Architecture

Three deployable surfaces:

| Surface | Stack | Hosted on | Purpose |
|---|---|---|---|
| **Service** | Node.js + gRPC + ws | Railway | Connects to YouTube, relays chat via WebSocket, serves `/overlay` |
| **Landing + API** | Cloudflare Worker | Cloudflare | `t3yt.mikepfunk.com` landing, `/api/config`, `/privacy` |
| **Extension** | WebExtension MV3 | Zen / Firefox | Injects YouTube messages into Twitch DOM, popup control rig |

### Design language

Every surface shares the same Impeccable-aligned visual system:

- **Palette:** OKLCH, purple-tinted neutrals (hue 270), YouTube red `oklch(0.64 0.24 28)`, Twitch purple `oklch(0.68 0.21 295)`, live-green, caution-amber
- **Typography:** Syne (display, Extrabold wordmarks) + Instrument Sans (body)
- **Layout:** flat hierarchy, 1px industrial dividers, no cards-in-cards
- **Motion:** `cubic-bezier(.22, 1, .36, 1)` — exponential decel, pulse only on live signals
- **Never:** glassmorphism, gradient text, rounded-drop-shadow card grids

### Key features

- **Zero-delay by default** — messages appear instant
- **Opt-in mod buffer** — slider in popup lets Theo hold messages 0–30s so mods can delete on YouTube before viewers ever see them; deleted-while-buffered messages never render
- **Two-layer mod sync** — deletions and bans reflect immediately when YouTube emits the event, with a `30s` fallback sweep for missed moderation events
- **Super chats, member badges, owner badges** pass through with proper styling
- **Auto-reconnect** with exponential backoff (3s → 6s → 12s → 24s → max 30s) on both the gRPC and WebSocket layers
- **Heartbeat watchdog** — service pings every 30s; extension force-reconnects if no heartbeat for 90s (detects stuck connections)
- **Defensive error isolation** — all event handlers wrapped in `try/catch` so a malformed message or DOM glitch never affects native Twitch chat
- **Visible errors + manual reconnect** — last error surfaces in the popup with a RECONNECT button for recovery without reloading the tab
- **PubSub auto-renewal** every 4 days (subscription lease is 5 days)
- **On-demand activation** — PubSub candidates are cached, but YouTube API work only begins when at least one client is actually connected
- **Zero-config extension** — fetches WS URL + Twitch channel from `t3yt.mikepfunk.com/api/config` at startup; Theo never types a URL
- **Identity locked** — Twitch injection is locked to `theo`, and YouTube verification is locked server-side to `YOUTUBE_CHANNEL_ID`

---

## Project Structure

```
theo_chat/
├── service/                   # Node.js backend (Railway)
│   ├── index.js               # HTTP+WS server, PubSub webhook, gRPC stream handler
│   ├── overlay.html           # OBS browser-source overlay (served at /overlay)
│   ├── grpc/                  # Pre-generated YouTube protobuf stubs
│   │   ├── stream_list_pb.js
│   │   └── stream_list_grpc_pb.js
│   └── package.json
│
├── extension/                 # Browser extension (WebExtension MV3)
│   ├── manifest.json          # Zen / Firefox MV3 manifest
│   ├── content.js             # Twitch DOM injection, delay queue, WS client
│   ├── theochat.css           # Injected message styling
│   ├── popup.html             # Control rig — toggle, delay slider, telemetry
│   ├── popup.css
│   ├── popup.js
│   ├── options.html           # Advanced overrides
│   ├── options.css
│   └── options.js
│
├── worker/
│   └── src/index.js           # Cloudflare Worker — landing, /api/config, /privacy
│
├── Dockerfile                 # Railway container build
├── railway.toml               # Railway build/deploy config
├── wrangler.toml              # Cloudflare Worker config (custom_domain = true)
└── package.json               # Root (Cloudflare Pages build shim)
```

---

## Configuration

### Railway environment variables

Configure these in the Railway service **Variables** tab. They are read at runtime from `process.env.*` and are **not** committed to git.

| Variable | Required | Purpose |
|---|---|---|
| `GOOGLE_API_KEY` | ✓ | YouTube Data API key (supports `YOUTUBE_API_KEY` as alias) |
| `YOUTUBE_CHANNEL_ID` | ✓ | Theo's canonical YouTube channel ID (starts with `UC...`) |
| `TWITCH_CHANNEL` | recommended | Theo's Twitch login. Defaults to `theo` |
| `TWITCH_CLIENT_ID` | recommended | Enables Twitch Helix live-state fallback |
| `TWITCH_CLIENT_SECRET` | recommended | Enables Twitch Helix live-state fallback |
| `PUBLIC_URL` | optional | Service's public URL. Auto-derived from Railway's built-in `RAILWAY_PUBLIC_DOMAIN` if not set. Only set manually for non-Railway deploys. |
| `WS_TOKEN` | optional | Shared secret for WebSocket auth |
| `YOUTUBE_VIDEO_ID` | optional | Test override — points the service at a specific live video instead of waiting for PubSub/Twitch fallback |
| `METRICS_TOKEN` | optional | Protects the `/metrics` endpoint |
| `PORT` | auto | Set by Railway |

### Cloudflare Worker

Set these as Worker **Variables / Secrets** in the Cloudflare dashboard or via `wrangler secret put`. They are read at runtime from `env.*` and are **not** committed to git.

- `WS_URL` — Railway service WebSocket URL
- `TWITCH_CHANNEL` — Theo's Twitch login, usually `theo`

### Extension

Auto-configures by fetching from `https://t3yt.mikepfunk.com/api/config`. Users never touch settings unless they want to override the service endpoint via the **Advanced** page (popup footer). The extension does not expose a streamer/channel selector; production identity stays locked to Theo.

---

## Deployment

Both services auto-deploy on `git push origin main`:

- **Cloudflare Workers Builds** watches the repo → runs `pnpm build` (no-op, see root `package.json`) → deploys the Worker via `wrangler deploy` → provisions the custom domain + DNS automatically (because `wrangler.toml` uses `custom_domain = true`)
- **Railway** watches the repo → builds the Dockerfile → runs the Node service → applies environment variables from the dashboard

No manual deploys needed unless you're iterating without committing.

---

## Testing Without a Real Stream

Three ways to exercise the pipeline without Theo being live:

### Point at any public live stream
```
Railway → Variables → YOUTUBE_VIDEO_ID = <some-live-video-id>
```
Service connects to that stream's chat. Remove the var to fall back to `YOUTUBE_CHANNEL_ID`.

### Simulate a PubSub notification
```bash
curl -X POST https://theochat-production.up.railway.app/webhook/youtube \
  -H "Content-Type: application/atom+xml" \
  -d '<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
            xmlns="http://www.w3.org/2005/Atom">
        <entry><yt:videoId>LIVE_VIDEO_ID</yt:videoId></entry>
      </feed>'
```

### Your own unlisted YouTube live stream
`studio.youtube.com → Create → Go Live → Unlisted`. Change `YOUTUBE_CHANNEL_ID` on Railway to your test channel. Full control over every event type.

---

## Installing the Extension

### For Zen / Firefox (sideload, development)
1. Clone this repo
2. `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
3. Pick `extension/manifest.json`
4. Click the TheoChat icon in the toolbar → control rig opens

### For Zen / Firefox (signed, persistent)
Submit `extension/` to [addons.mozilla.org](https://addons.mozilla.org/developers/) for unlisted signing. AMO returns a signed `.xpi` you can host at `t3yt.mikepfunk.com/download` for one-click install.

### For Chrome / Chromium
Not the primary target for this repo. Validate MV3 behavior separately before treating Chromium as production-ready.

---

## Release Playbook

Publishing a new signed extension version:

1. **Bump the version** in `extension/manifest.json` (e.g. `"version": "1.1.0"`)
2. **Zip the extension folder contents** (files at zip root, not nested):
   ```powershell
   cd extension
   Compress-Archive -Path .\* -DestinationPath ..\theochat-extension.zip -Force
   ```
3. **Submit to AMO** — [addons.mozilla.org/developers/addon/theochat/versions/submit/](https://addons.mozilla.org/developers/addon/theochat/versions/submit/) → upload the zip → choose **"On your own"** (unlisted) → wait ~1–60 min for auto-signing → download the signed `.xpi` from the **Manage Version** page
4. **Rename the signed file to `theochat.xpi`** (required — the `/download` route depends on this exact filename)
5. **Publish a GitHub Release:**
   - Tag: `v1.1.0` (match `manifest.json` version)
   - Title: `TheoChat 1.1.0`
   - Attach `theochat.xpi` as a release asset
   - Body: short changelog (what changed, bugs fixed)
6. **Done.** The Worker's `/download` route always redirects to `releases/latest/download/theochat.xpi`, so `t3yt.mikepfunk.com/download` instantly serves the new version to anyone who clicks "Install".

Existing extension users won't auto-update unless you also publish the `.xpi`'s `update_url` and add an `updates.json` manifest. For v1, manual re-install works; auto-update is a future enhancement.

---

## Quota Math

YouTube Data API has a default 10,000 units/day. TheoChat's design:

| State | Cost |
|---|---|
| Idle (nothing happening) | **0 units** — PubSub is free and the service does not call YouTube while offline |
| Stream starts (PubSub path) | **1 unit** (`videos.list`) |
| Stream starts (Twitch fallback path) | **~101 units** (`search.list` + `videos.list`) |
| Active session | **~600 units/hour** (`liveChatMessages.list` every 30s) |

Expected usage depends on stream length, but idle remains `0/day` and the fallback path only spends quota while Theo is actually live or being recovered.

---

## License

MIT.
