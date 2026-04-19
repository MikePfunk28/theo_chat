# TheoChat — YouTube Chat in Twitch for theo.gg

## What This Is
A tool for Theo (theo.gg) that combines YouTube live chat into his Twitch chat view. His YouTube moderators handle moderation on YouTube — this tool reflects those actions (deletions, bans) in real time on the Twitch side.  It is very important we do not show moderated messages.  So essentially just taking youtube chat and putting it in twitch, with all the same functionality working as it did.  

We should make whatever is needed to accomplish this, i.e. an app, website, Zen browser extension, twitch extension, obs plugin.  If we need to make multiple, we need to separate them, so we do not duplicate anything.  The message should come in, and we make copies of it, but also track the ID, not dups.  This is not set in stone, it is whatever is streamlined and easiest for the streamer.  If we can add anything else as a bonus, we should.

## Architecture

### Data Source: YouTube gRPC streamList
- Connects to `youtube.googleapis.com:443` via gRPC server-streaming RPC
- Uses `V3DataLiveChatMessageService/StreamList` from YouTube's protobuf definitions
- Pre-generated JS stubs in `service/grpc/` (from YouTube's `stream_list.proto`)
- 1 quota unit per connection (vs REST polling which burns 10,000/day quota in ~3 hours)
- Receives: text messages, super chats, message deletions, user bans, tombstones

### Auth: Deciding (API key vs OAuth)
- **API key**: Simplest. Mike's key, stored as env secret on Railway. Reads public chat only. Theo does nothing.
- **OAuth (Web app)**: Theo signs in with Google. Required if chat is ever members-only. More complex.
- Google Cloud project: `theochat-492904`
- OAuth redirect: `https://t3yt.mikepfunk.com/api/oauth/callback/google`
- Required scope: `https://www.googleapis.com/auth/youtube.readonly`
- No Twitch API needed (extension reads DOM directly)

### Delivery: Three outputs from the same data source
1. **Zen/Chrome extension** — Content script on Twitch that injects YouTube messages into Twitch chat DOM with [YT] badge. Handles deletions/bans.
2. **OBS overlay** (planned) — HTML page as OBS browser source showing combined chat.
3. **Desktop service** (local fallback) — Same Node.js service running on Theo's Mac instead of hosted.

### Hosting
- **Cloudflare Worker** (`t3yt.mikepfunk.com`) — Landing page, possibly OAuth flow
- **Railway or Fly.io** — Persistent process for gRPC connection + WebSocket server
- **Secrets**: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET stored in Cloudflare dashboard. API key (if used) stored in Railway env.

## Key Technical Decisions
- gRPC over REST polling (quota efficiency)
- Browser extension over Twitch Extension (Twitch Extensions can't inject into native chat DOM)
- Node.js/TypeScript for everything (gRPC client + extension share language)
- Protobuf stubs are pre-generated JS from `yt-livechat-grpc` reference repo, not compiled from .proto source

## Domain
- `t3yt.mikepfunk.com` — the production domain
- Worker name: `t3yt`
- OAuth configured for this domain in Google Cloud Console

## Project Structure
```
theo_chat/
├── service/          # Node.js gRPC + WebSocket service (runs on Railway or desktop)
├── extension/        # Zen/Chrome Manifest V3 browser extension
├── worker/           # Cloudflare Worker source (t3yt.mikepfunk.com)
├── wrangler.toml     # Cloudflare Worker config
├── oauth.json        # Google OAuth credentials (GITIGNORED — do not commit)
└── .claude/          # Harness checkpoints
```

## Sensitive Files (never commit)
- `oauth.json` — Google OAuth client credentials
- `service/config.json` — local service config
- `service/.tokens.json` — OAuth refresh tokens
- Any `.env` files

## Known Pitfalls (READ BEFORE EDITING)

### gRPC `streamList` is server-streaming, NOT REST pagination
`nextPageToken` on gRPC responses marks a **batch boundary**, not a "reopen the stream" signal. Do NOT `break` on empty tokens and do NOT wrap `client.streamList(...)` in an outer `while` that reopens it. Opening it once per broadcast is correct. Reopening dozens of times during one stream trips YouTube's per-window rate limit on streamList opens and causes a production outage.

See [docs/gotchas/grpc-streaming.md](docs/gotchas/grpc-streaming.md) for the full story, including the 2026-04-17 incident that cost a 30-minute cascade failure at hour 3.5 of a Theo stream.

### HTTP/2 keepalive costs zero YouTube API quota
Connection health during quiet chat is detected via `grpc.keepalive_time_ms` PING frames at the transport layer — NOT via polling `checkIfLive` when activity is silent. Don't reintroduce activity-based watchdogs that call REST `videos.list` on quiet stretches; every call is 1 quota unit and they cascade into user-visible restarts.

### `recordApiError` distinguishes daily-exhaustion from rate-limit
YouTube returns "exceeded your quota" strings for both `dailyLimitExceeded` and `rateLimitExceeded` / `userRateLimitExceeded`. Only the first is "we've used all 10k today, stop optional work until midnight PT." The others are per-window throttles, handled via `rateLimitCooldownUntil` with exponential backoff. **Check `err.errors[0].reason` structurally.** Do NOT match the message string.

### The gRPC `streamList` open costs 1 unit
Track it with `recordApiCall(1, 'grpc.streamList')`. The local `quotaUsedToday` counter previously undercounted vs. Google's real counter because opens weren't recorded. Post-fix the stream opens exactly once per broadcast so the undercount is ~1 unit per broadcast, but the tracking is still correct.

### HTML scraping for live detection was removed intentionally
The old `autoHealLiveCheck` scraped `youtube.com/channel/UC.../live` looking for a live video ID. It picked up videos from the recommendations sidebar, causing wrong-channel detections. Replaced by PubSub push + Twitch Helix fallback + `videos.list` hard-reject on `snippet.channelId !== CHANNEL_ID`. Do NOT bring scraping back for live-video detection.

Scraping for **custom emoji library** (`fetchEmojiLibrary`) is fine — it parses a specific known-stable JSON blob from a single videoId's watch page. Zero quota, no channel-ID confusion risk.
