# gRPC server-streaming is not REST pagination

If you're reading this, you're probably about to touch `connectGrpcStream` in
`service/index.js`. Stop. Read the whole doc first. We shipped this bug once.
It cost a production outage. Don't ship it again.

## The mistake

YouTube's live chat data source is a **gRPC server-streaming RPC** called
`V3DataLiveChatMessageService/StreamList`. It looks similar to the REST
`liveChatMessages.list` because responses include a `nextPageToken` field.
**They are not the same.**

- REST `liveChatMessages.list`: you poll repeatedly. `nextPageToken` is a
  bookmark — you pass it in the next request to resume where you left off.
  Each poll is a separate API call (5 units each).
- gRPC `streamList`: you open the stream **once**. The server pushes
  responses as chat events happen. An empty `nextPageToken` on a response
  just means "no batch queued right now" — it does not mean "reopen the
  stream." The stream stays open for the entire broadcast.

If you treat the gRPC stream like REST pagination (break the for-await on
empty `nextPageToken`, reopen inside an outer `while`), you:

1. Churn fresh gRPC connections every time chat has a quiet moment.
2. Accumulate dozens to hundreds of `streamList` opens per broadcast.
3. Trip YouTube's per-window rate limit on streamList opens, an
   undocumented but real threshold we measured at ~3.5 hours of Theo's
   volume on 2026-04-17.
4. Get RESOURCE_EXHAUSTED forever until the window resets.

## The correct shape

```js
const stream = client.streamList(request, metadata);
try {
  for await (const response of stream) {
    lastGrpcActivityAt = Date.now();
    processMessages(response.toObject().itemsList || []);
    // Do NOT break on empty nextPageToken. Do NOT reopen. The server
    // pushes. We read. That's all.
  }
  // for-await exits cleanly → server half-closed → fall through to
  // finally → let scheduleReconnect decide with cooldown gating.
} catch (err) {
  // On error, route through recordApiError so rate-limit cooldown
  // engages. Without that, a transient RESOURCE_EXHAUSTED becomes a
  // permanent outage via the 10s retry loop.
  recordApiError(err, 'grpc-stream');
}
```

## How to know the connection is alive during quiet chat

Don't poll REST. Don't break and reopen. The HTTP/2 transport underneath
gRPC has built-in keepalive PING frames. Enable them when creating the
client:

```js
const client = new V3DataLiveChatMessageServiceClient(
  'youtube.googleapis.com:443',
  grpc.credentials.createSsl(),
  {
    'grpc.keepalive_time_ms': 30000,           // PING every 30s
    'grpc.keepalive_timeout_ms': 10000,        // 10s for PONG
    'grpc.keepalive_permit_without_calls': 1,  // ping during idle
    'grpc.http2.max_pings_without_data': 0,
  }
);
```

- PING frames cost **zero YouTube API units**. They're at the TCP/HTTP-2
  layer, not the API layer.
- If the transport is dead, gRPC rejects the stream with an error within
  ~40 seconds. Our catch block handles it.
- Activity-based watchdogs ("no message for 75 seconds = connection is
  dead, restart") cause false positives on quiet chat and waste
  `videos.list` units. The activity watchdog is a belt-and-suspenders
  fallback now (`GRPC_STALE_MS = 15 min`), not the primary path.

The service also keeps a runtime reconnect circuit breaker around
`streamList` opens. If the process tries to open too many streams in a
short window, it freezes auto-reconnect and surfaces that state in
`/health` and `/metrics` instead of burning more quota.

## Quota cost per broadcast, correctly accounted

- `videos.list` on first connect: 1 unit
- `streamList` open: 1 unit (tracked via `recordApiCall(1, 'grpc.streamList')`)
- `streamList` running: 0 units once open
- Keepalive PINGs: 0 units
- Reconcile `liveChatMessages.list` every 15s: 5 units × 240/hour = 1,200/hr

A clean 8-hour stream burns ~9,602 units. Fits in the 10k default quota
with very little headroom. Raise reconcile to 30s or request a quota
increase for breathing room.

## Known-bad patterns that this doc is watching for

1. `if (!nextPageToken) break` inside the stream's for-await. **Never.**
2. Outer `while (isStreaming)` around a single `client.streamList(...)`
   call — at most one opens per function invocation.
3. Activity-based watchdogs firing `checkIfLive` / `videos.list` during
   normal quiet chat.
4. Catch block that logs + schedules reconnect without calling
   `recordApiError` — rate-limit cooldown never engages.
5. `recordApiError` treating any `"exceeded your"` string as daily
   exhaustion. It must check `err.errors[0].reason` structurally and
   distinguish `dailyLimitExceeded` from `rateLimitExceeded` /
   `userRateLimitExceeded`.

## Incident reference

2026-04-17 outage. See git log for commits on `fix/grpc-lifecycle-and-observability`
branch. The streamList reopen-churn bug had been present since the
initial service implementation; it was exposed by a long Theo stream
pushing total opens over the per-window threshold.
