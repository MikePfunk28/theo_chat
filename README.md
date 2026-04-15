# TheoChat

Merges YouTube live chat into your Twitch chat view. YouTube messages appear inline in the native Twitch chat panel with a red `YT` badge. When YouTube mods delete a message or ban a user, those actions sync to the Twitch view instantly. Built for [theo.gg](https://theo.gg) — but works for any streamer who simulcasts to YouTube + Twitch.

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

**Push-based, zero idle quota.** The Railway service subscribes once to YouTube's PubSubHubbub. YouTube pushes a notification the instant you go live. The service verifies with one `videos.list` call (1 quota unit), connects the gRPC stream, and broadcasts messages over WebSocket to the browser extension. No polling, ever.

**Read-only mirror.** YouTube is the source of truth. We never write to YouTube, never touch Twitch's actual chat. We just paint YouTube messages into Theo's Twitch browser tab.

**OBS-compatible.** OBS captures whatever Theo's browser shows, so viewers see the merged chat too. For streamers using OBS's built-in browser source for chat, a standalone transparent overlay is available at `/overlay`.

---

## Architecture

Three deployable surfaces:

| Surface | Stack | Hosted on | Purpose |
|---|---|---|---|
| **Service** | Node.js + gRPC + ws | Railway | Connects to YouTube, relays chat via WebSocket, serves `/overlay` |
| **Landing + API** | Cloudflare Worker | Cloudflare | `t3yt.mikepfunk.com` landing, `/api/config`, `/privacy` |
| **Extension** | WebExtension MV3 | Firefox/Zen/Chrome | Injects YouTube messages into Twitch DOM, popup control rig |

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
- **Instant mod sync** — deletions and bans from YouTube mods reflect in the Twitch view immediately
- **Super chats, member badges, owner badges** pass through with proper styling
- **Auto-reconnect** on both the gRPC and WebSocket layers
- **PubSub auto-renewal** every 4 days (subscription lease is 5 days)
- **Zero-config extension** — fetches WS URL from `t3yt.mikepfunk.com/api/config` at startup; Theo never types a URL

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
│   ├── manifest.json          # Firefox/Zen + Chrome compatible
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

| Variable | Required | Purpose |
|---|---|---|
| `GOOGLE_API_KEY` | ✓ | YouTube Data API key (supports `YOUTUBE_API_KEY` as alias) |
| `YOUTUBE_CHANNEL_ID` | ✓ | Target channel ID (starts with `UC...`) |
| `PUBLIC_URL` | optional | Service's public URL. Auto-derived from Railway's built-in `RAILWAY_PUBLIC_DOMAIN` if not set. Only set manually for non-Railway deploys. |
| `WS_TOKEN` | optional | Shared secret for WebSocket auth |
| `YOUTUBE_VIDEO_ID` | optional | Override for testing — points service at a specific video instead of discovering from channel |
| `PORT` | auto | Set by Railway |

### Cloudflare Worker

The Railway WebSocket URL is hardcoded as `WS_URL` at the top of `worker/src/index.js`. Update + redeploy if the service moves.

### Extension

Auto-configures by fetching from `https://t3yt.mikepfunk.com/api/config`. Users never touch settings unless they want to override via the **Advanced** page (popup footer).

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
Same `extension/` folder works. `chrome://extensions` → Developer Mode → Load unpacked.

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
| Idle (nothing happening) | **0 units** — PubSub is free |
| Stream starts (webhook fires) | **1 unit** (one `videos.list` call) |
| Entire session (hours of chat) | **0 additional** — gRPC stream is included in that 1-unit setup |

Expected daily usage: **< 20 units** even with multiple streams/day. A far cry from the original polling design's 288,000 units/day.

---

## License

MIT.
