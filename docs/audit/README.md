# TheoChat — Source File Audit

Last audit pass: 2026-04-17, after the streamList outage. Every source file
below has been read line-by-line. Known concerns are flagged inline. Fixed
items reference the commit that addressed them.

---

## service/index.js (~1040 lines)

### Purpose
Single process. Owns the YouTube gRPC stream connection, HTTP+WS server,
PubSub webhook, Twitch Helix live-state polling, reconcile safety-net
poll, message fan-out to WebSocket clients, moderation-event mirroring,
per-IP rate limiting, quota metering, and idle shutdown.

### Function-level summary

- **`derivePublicUrl()`** — normalizes `PUBLIC_URL` / `RAILWAY_PUBLIC_DOMAIN`
  / `RAILWAY_STATIC_URL` to a valid `https://host[/path]` form. Validates
  via `new URL()`. Returns '' on failure rather than throwing.
- **`nextMidnightPT()`** — naive UTC calculation for PT midnight. Does not
  account for DST transitions precisely; within a few hours of truth
  which is fine for quota-reset timing.
- **`recordApiCall(cost, label)`** — increments `metrics.quotaUsedToday`,
  emits a `quota.used` event. Includes `cost === 1` for the gRPC
  `streamList` open.
- **`recordApiError(err, label)`** — structured-reason-based (not string
  match). Pins daily counter only on `dailyLimitExceeded`. Rate-limit
  cooldown engages on gRPC `RESOURCE_EXHAUSTED`, REST 429 via
  `err.response.status`, and structured `rateLimitExceeded` /
  `userRateLimitExceeded`. **FIXED 2026-04-17.**
- **`isInRateLimitCooldown()` / `clearRateLimitCooldown()`** — honored by
  `scheduleReconnect` (was not honored pre-fix) and by `reconcileMessages`.
- **`parsePubSubNotification(body)`** — extracts `videoId` and `channelId`
  from the Atom feed. Trusts XML structure.
- **WS auth** — `WS_TOKEN` query param or header. Per-IP cap via
  `MAX_WS_PER_IP`.
- **`wss.on('connection', ...)`** — counts connections, emits
  `ws.connected` / `ws.disconnected` events. Sends emoji library to new
  clients if one is cached.
- **`broadcast(event)`** — fan-out to all WS clients; increments
  `metrics.messagesRelayed` / `messagesDeleted` appropriately.
- **`handleLiveCandidate(videoId, options)`** — guarded by
  `liveCandidateInFlight` and `pendingCandidateVideoIds` against
  concurrent triggers (PubSub + Twitch + manual can all fire near-
  simultaneously). Rejects mismatched `notifiedChannelId`.
- **`stopGrpcStream(reason)`** — sets `grpcStopReason`, cancels
  `activeGrpcStream` via `cancel()`. **CONCERN: only tracks the most
  recent stream reference.** If a hypothetical race ever causes
  overlapping opens (shouldn't after the 1a fix, but worth defending),
  older streams would leak. Worth promoting to a `Set<stream>` in a
  follow-up.
- **`scheduleReconnect(videoIdToRetry, delayMs, reason)`** — single reopen
  path. Honors `isInRateLimitCooldown()` by deferring, quota ceiling by
  aborting, and `reconnectTimer` presence by no-op. **FIXED 2026-04-17**
  (previously used fixed 10s regardless of error type).
- **`checkIfLive(videoId)`** — `videos.list`, 1 unit. Hard-rejects
  non-CHANNEL_ID videos. Accepts `liveBroadcastContent` of 'live' or
  'upcoming' (waiting room counts). **FIXED 2026-04-17** ('upcoming'
  restored after an over-aggressive earlier revert).
- **`connectGrpcStream()`** — **THE** function that caused the outage.
  Now opens `streamList` exactly once per call, reads the async iterator
  until server half-close or error, recordApiError on error, clean exit
  via `finally` → `shouldReconnect` → `scheduleReconnect` (single reopen
  path). HTTP/2 keepalive enabled. See `docs/gotchas/grpc-streaming.md`
  for the full story.
- **`reconcileMessages()`** — `liveChatMessages.list` every
  `RECONCILE_INTERVAL_MS` (15s default). Compares live set with our
  `activeMessages` map, synthesizes deletes for orphans. Skipped during
  cooldown or when quota > ceiling.
- **`grpcWatchdog()`** — 15-min stale detector now that keepalive handles
  dead-connection detection. Belt-and-suspenders only. Guarded by quota
  and cooldown.
- **Twitch integration (`getTwitchToken`, `isTwitchLive`, `twitchPoll`,
  `triggerYouTubeSearch`)** — only runs when Twitch credentials exist and
  `clientCount > 0`. **CONCERN: token refresh is reactive on 401, not
  proactive pre-expiry.** Expired-edge requests get one guaranteed
  failure. Acceptable for now; fix in a follow-up if it becomes flaky.
- **PubSub layer (`subscribeToPubSub`, `ensurePubSub`)** — renewed every
  4 days (subscription lease is 5). **CONCERN: single `setInterval` not
  persistent across restarts.** If the service restarts mid-renewal
  window, a cycle skips. Rare; acceptable for single-tenant.
- **`/health`, `/metrics`, `/api/metrics/history`** — metrics token guards
  the latter two. `/api/metrics/history` is new this PR for the stats
  dashboard.

---

## service/event-log.js (new this PR)

### Purpose
Persistent JSONL event log on Railway volume. Rotated daily, retained 30
days. Never crashes the relay on observability failure. Long-lived
`fs.createWriteStream({ flags: 'a' })` handle, not per-event
`appendFileSync`.

### Notes
- Falls back to `./data/` relative to cwd when `EVENT_LOG_DIR` unset.
- Circular references handled via `safeStringify`.
- Headroom check via `fs.statfsSync` (Node 20+ only); falls back to
  assume-ok on older Node.
- Purge runs at most hourly to avoid stat-racing on every event.

---

## service/metrics-history.js (new this PR)

### Purpose
Server-side aggregation of the event log into hourly buckets for the
stats dashboard. Cached for 15s to keep `/api/metrics/history` cheap.

### Notes
- Reads JSONL one file per day. At ~20 MB/day × 30 days worst case this
  is ~600 MB of I/O. The 15s cache absorbs bursty polling; load test
  before removing the TTL.
- No SQLite yet — if query patterns grow, promote to `better-sqlite3`
  rollups. For now keep it simple.

---

## worker/src/index.js (~398 lines)

### Purpose
Cloudflare Worker at `t3yt.mikepfunk.com`. Serves landing page,
`/api/config`, `/privacy`, `/download` (302 to GitHub Release), and soon
`/stats` for the dashboard (Part 2).

### Notes
- `getRuntimeConfig(env)` pulls `WS_URL` + `TWITCH_CHANNEL` from CF env
  bindings. No hardcoded values.
- HTML string-concat inside `Response` bodies — no templating
  framework. Keep it that way; a Worker is the wrong place for a full
  SSR system.
- **CONCERN: no rate limiting on `/download` redirect endpoint.** Low
  risk because it only 302s to GitHub; worst case someone harasses our
  bandwidth by looping redirects.
- Cloudflare's bot-protection challenge will serve a "Just a moment…"
  HTML to curl-without-UA requests. Real browsers pass without issue.

---

## extension/content.js (~600 lines)

### Purpose
Twitch content script. Connects to the service via WebSocket, injects
YouTube messages into Twitch's chat DOM with `[YT]` prefix + badges.
Handles delete/ban events. Inert on non-Theo Twitch pages.

### Notes
- `isTargetChannelPage()` gate at the top of every entry point.
- SPA nav observer on `document.body`: childList + subtree. **CONCERN:
  may fire many times per navigation; `lastUrl` check debounces but
  worth profiling if we ever see lag.**
- `MAX_PENDING = 200` queue cap.
- `teardown()` resets `reconnectAttempts = 0` and clears all pending
  timers. Safe to call repeatedly.
- Heartbeat `setInterval` gated on `isTargetChannelPage()`. **FIXED
  2026-04-17** (previously firing on all Twitch pages).
- `getNameColor(name)` hashes `charCodeAt` positions — not unicode-safe,
  so emoji usernames may collide. Cosmetic only.

---

## extension/background.js

### Purpose
Service worker for the extension. Polls `/health` every 30s only when a
target Twitch tab is open or the popup is open. Sends notifications on
connection state changes.

### Notes
- `hasTargetTabOpen()` iterates all tabs to check for
  `twitch.tv/theo`. Cheap; runs on the poll timer.
- Does not persist state beyond `chrome.storage.sync`.

---

## extension/popup.js / popup.html / popup.css

### Purpose
Control-rig popup with signal LEDs, master toggle, telemetry tiles, and
a RECONNECT button.

### Notes
- The 30s delay slider is **hard-locked at 30s** (min=max=value=30,
  disabled). Mod-safety-window guarantee.
- Uses Impeccable-aligned OKLCH palette; `cubic-bezier(.22, 1, .36, 1)`
  transitions.

---

## extension/options.js / options.html

### Purpose
Advanced page for WS URL override + a "LOCKED TARGET" read-out showing
`theo` is the only allowed channel.

### Notes
- WS URL override exists for dev/debug and fallback when
  `/api/config` is unreachable. Validated via `new URL()` before save.

---

## service/overlay.html

### Purpose
OBS browser-source overlay that renders a combined YouTube+Twitch chat
for streamers who use it as a browser source instead of the extension.

### Notes
- Inline CSS + JS. Uses the same design tokens as the extension popup.
- Connects to the same `/ws` endpoint as the extension.

---

## Open follow-up items (not fixed this PR)

1. `stopGrpcStream` → `Set<stream>` for overlapping-open defense.
2. Proactive Twitch token refresh pre-expiry.
3. PubSub subscription renewal persisted across restarts.
4. True `nextPageToken` resumption after a disconnect (small message-gap
   savings on reconnect).
5. Rate limit on Worker `/download` endpoint.
6. Unicode-safe `getNameColor` in extension.
