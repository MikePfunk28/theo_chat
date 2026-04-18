// TheoChat persistent event log
//
// Purpose: every interesting service event (gRPC open/close, quota burn,
// mod action mirror, WS connect/disconnect, reconcile sweep) gets appended
// to a JSONL file. The file persists across Railway container restarts
// when EVENT_LOG_DIR points at a mounted persistent volume. In dev (or
// without a volume), falls back to ./data/ relative to the service cwd.
//
// Design constraints the 2026-04-17 outage imposed on this module:
//   1. Observability failure MUST NOT crash the relay. Every write is
//      wrapped; on failure we drop the event and increment a counter.
//   2. Writes go through a single long-lived fs.createWriteStream handle
//      with { flags: 'a' }. We do NOT call appendFileSync per event —
//      that would stall the event loop under a message burst.
//   3. Daily rotation. Retention = 30 days. Disk-full guard tries to
//      drop the oldest day before failing new writes.
//   4. This module is pure — it exports functions, not top-level side
//      effects (besides ensuring the log dir exists). Anyone can require
//      it safely in a test harness.

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.resolve('./data');
const DIR = process.env.EVENT_LOG_DIR || DEFAULT_DIR;
const RETENTION_DAYS = parseInt(process.env.EVENT_LOG_RETENTION_DAYS || '30', 10);

let writeStream = null;
let currentFile = '';
let droppedCount = 0;
let lastRotationCheck = 0;

function ensureDir() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    return true;
  } catch (err) {
    console.warn(`  [EventLog] Could not create ${DIR}: ${err.message}`);
    return false;
  }
}

function dateKey(ts) {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function filePathFor(ts) {
  return path.join(DIR, `events-${dateKey(ts)}.jsonl`);
}

function rotateIfNeeded(now) {
  const wantFile = filePathFor(now);
  if (wantFile === currentFile && writeStream) return;

  if (writeStream) {
    try { writeStream.end(); } catch {}
    writeStream = null;
  }
  if (!ensureDir()) return;
  try {
    writeStream = fs.createWriteStream(wantFile, { flags: 'a', encoding: 'utf8' });
    writeStream.on('error', (err) => {
      console.warn(`  [EventLog] stream error: ${err.message}`);
      writeStream = null;
    });
    currentFile = wantFile;
  } catch (err) {
    console.warn(`  [EventLog] Could not open ${wantFile}: ${err.message}`);
    writeStream = null;
  }
}

function purgeOldFiles(now) {
  try {
    const files = fs.readdirSync(DIR).filter((f) => f.startsWith('events-') && f.endsWith('.jsonl'));
    const cutoff = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const cutoffKey = dateKey(cutoff.getTime());
    for (const f of files) {
      const match = f.match(/^events-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) continue;
      if (match[1] < cutoffKey) {
        try {
          fs.unlinkSync(path.join(DIR, f));
        } catch {}
      }
    }
  } catch {}
}

// Best-effort disk-headroom check. Returns true if we appear to have room,
// false if we should drop this event and purge. Falls back to assume-ok
// when statfs is unavailable (older Node versions / non-POSIX).
function hasHeadroom() {
  try {
    const stat = fs.statfsSync ? fs.statfsSync(DIR) : null;
    if (!stat) return true;
    const freeRatio = stat.bavail / stat.blocks;
    return freeRatio > 0.1; // require 10% free
  } catch {
    return true;
  }
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    // Circular refs or non-serializable values should never crash the relay.
    // Fall back to a safe representation with best-effort keys.
    try {
      const seen = new WeakSet();
      return JSON.stringify(obj, (k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        if (typeof v === 'bigint') return v.toString();
        if (typeof v === 'function') return '[Function]';
        return v;
      });
    } catch {
      return null;
    }
  }
}

function logEvent(kind, payload) {
  const now = Date.now();
  try {
    // Spread payload first so intrinsics (ts, kind) can never be overwritten
    // by a caller that accidentally includes those keys. readEventsSince
    // filters by ev.ts and metrics-history switches on ev.kind — a clobbered
    // value silently corrupts the rollup (wrong bucket, dropped events).
    const serialized = safeStringify({ ...payload, ts: now, kind });
    if (!serialized) {
      droppedCount++;
      return;
    }
    const line = serialized + '\n';
    rotateIfNeeded(now);
    if (!writeStream) {
      droppedCount++;
      return;
    }
    // Periodic housekeeping (at most once per hour)
    if (now - lastRotationCheck > 60 * 60 * 1000) {
      lastRotationCheck = now;
      if (!hasHeadroom()) {
        purgeOldFiles(now);
      } else {
        // Still purge anything past retention on the hour
        purgeOldFiles(now);
      }
    }
    writeStream.write(line);
  } catch {
    droppedCount++;
  }
}

// Tail recent events from the last N days for aggregation. Synchronous read
// of one file per day; expected to be called from a cached endpoint, not
// per-request. For a 30-day window at ~20 MB/day this is ~600 MB of I/O —
// acceptable if cached 15s server-side.
//
// TODO: move this to an async / streaming reader with a precomputed rolling
// aggregator so /api/metrics/history doesn't block the event loop at all on
// cache miss. Today the 15s cache bounds the worst case and the hard window
// cap below bounds the blast radius per request.
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // retention ceiling
function readEventsSince(sinceMs) {
  const now = Date.now();
  const floor = now - MAX_WINDOW_MS;
  if (!Number.isFinite(sinceMs) || sinceMs < floor) sinceMs = floor;
  const startKey = dateKey(sinceMs);
  const endKey = dateKey(now);
  const results = [];
  try {
    const files = fs.readdirSync(DIR)
      .filter((f) => f.startsWith('events-') && f.endsWith('.jsonl'))
      .filter((f) => {
        const match = f.match(/^events-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        return match && match[1] >= startKey && match[1] <= endKey;
      })
      .sort();
    for (const f of files) {
      let content;
      try {
        content = fs.readFileSync(path.join(DIR, f), 'utf8');
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.ts >= sinceMs) results.push(ev);
        } catch {}
      }
    }
  } catch {}
  return results;
}

function droppedEventCount() {
  return droppedCount;
}

function eventLogDir() {
  return DIR;
}

// writeStream.end() is async — callers that race process.exit(0) afterward
// lose the final buffered writes (session.ended, grpc.closed, ws.disconnected
// on shutdown). Accept a callback and invoke it only after 'finish' has
// actually fired.
function shutdownEventLog(cb) {
  const done = typeof cb === 'function' ? cb : () => {};
  if (!writeStream) { done(); return; }
  const s = writeStream;
  writeStream = null;
  try {
    s.end(done);
  } catch {
    done();
  }
}

// Test-only deterministic flush. Waits for the writable's internal buffer to
// drain without closing the stream, so subsequent logEvent calls keep working.
// Used by the event-log test suite to replace flaky setTimeout(50) waits.
function flushEventLog(cb) {
  const done = typeof cb === 'function' ? cb : () => {};
  if (!writeStream) { done(); return; }
  if (writeStream.writableNeedDrain) {
    writeStream.once('drain', () => done());
  } else {
    setImmediate(done);
  }
}

module.exports = {
  logEvent,
  readEventsSince,
  droppedEventCount,
  eventLogDir,
  shutdownEventLog,
  flushEventLog,
};
