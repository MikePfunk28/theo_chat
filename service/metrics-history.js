// Server-side aggregation of the event log into hourly buckets for the
// stats page. Cached for 15s to keep `/api/metrics/history` cheap even
// under bursty polling. No external DB — reads the JSONL and groups.

const { readEventsSince } = require('./event-log.js');

const CACHE_TTL_MS = 15 * 1000;
let cache = null;

function hourKey(ts) {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:00:00Z`;
}

function emptyBucket(key) {
  return {
    hour: key,
    grpcOpens: 0,
    grpcCloses: 0,
    grpcErrors: 0,
    messagesRelayed: 0,
    deletesRealtime: 0,
    deletesReconcile: 0,
    modActionsDelete: 0,
    modActionsBan: 0,
    modActionsMirrored: 0,
    quotaUnitsUsed: 0,
    wsConnects: 0,
    wsDisconnects: 0,
    reconcileRuns: 0,
    pubsubNotifications: 0,
    sessionsStarted: 0,
    sessionsEnded: 0,
    superchatCount: 0,
    uniqueAuthors: 0,
    peakMsgsPerMinute: 0,
  };
}

function buildRollup(windowMs) {
  const since = Date.now() - windowMs;
  const events = readEventsSince(since);
  const buckets = new Map();
  // Side-structures for computed metrics that need per-bucket state during
  // the scan (Sets for unique authors, per-minute counters for peak rate).
  // Stored separately from the bucket object because they're not
  // JSON-serializable.
  const authorsPerBucket = new Map();
  const perMinutePerBucket = new Map();

  for (const ev of events) {
    const k = hourKey(ev.ts);
    let bucket = buckets.get(k);
    if (!bucket) {
      bucket = emptyBucket(k);
      buckets.set(k, bucket);
      authorsPerBucket.set(k, new Set());
      perMinutePerBucket.set(k, new Map());
    }
    switch (ev.kind) {
      case 'grpc.opened': bucket.grpcOpens++; break;
      case 'grpc.closed':
        bucket.grpcCloses++;
        if (ev.reason && ev.reason.startsWith('error:')) bucket.grpcErrors++;
        break;
      case 'message.relayed': {
        bucket.messagesRelayed++;
        // Unique authors
        if (ev.author) authorsPerBucket.get(k).add(ev.author);
        // Per-minute counter for peak-rate computation
        const minuteKey = Math.floor(ev.ts / 60000);
        const minMap = perMinutePerBucket.get(k);
        minMap.set(minuteKey, (minMap.get(minuteKey) || 0) + 1);
        break;
      }
      case 'message.deleted.realtime': bucket.deletesRealtime++; break;
      case 'message.deleted.reconcile': bucket.deletesReconcile++; break;
      case 'mod.action':
        if (ev.type === 'delete') bucket.modActionsDelete++;
        else if (ev.type === 'ban') bucket.modActionsBan++;
        if (ev.mirrored) bucket.modActionsMirrored++;
        break;
      case 'quota.used': bucket.quotaUnitsUsed += (ev.cost || 0); break;
      case 'ws.connected': bucket.wsConnects++; break;
      case 'ws.disconnected': bucket.wsDisconnects++; break;
      case 'reconcile.swept': bucket.reconcileRuns++; break;
      case 'pubsub.notification': bucket.pubsubNotifications++; break;
      case 'session.started': bucket.sessionsStarted++; break;
      case 'session.ended': bucket.sessionsEnded++; break;
      case 'superchat': bucket.superchatCount++; break;
    }
  }

  // Finalize the side-computed metrics into each bucket.
  for (const [k, bucket] of buckets) {
    bucket.uniqueAuthors = authorsPerBucket.get(k).size;
    const minMap = perMinutePerBucket.get(k);
    let peak = 0;
    for (const count of minMap.values()) if (count > peak) peak = count;
    bucket.peakMsgsPerMinute = peak;
  }

  return [...buckets.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}

function getHistory(windowMs) {
  const now = Date.now();
  if (cache && cache.windowMs === windowMs && now - cache.at < CACHE_TTL_MS) {
    return cache.rollup;
  }
  const rollup = buildRollup(windowMs);
  cache = { at: now, windowMs, rollup };
  return rollup;
}

function invalidateCache() {
  cache = null;
}

module.exports = { getHistory, invalidateCache };
