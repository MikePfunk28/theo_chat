// Tests for service/metrics-history.js
// Run with: node --test service/test/metrics-history.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Prepare a temp dir with synthetic events before loading the modules
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theochat-history-'));
process.env.EVENT_LOG_DIR = tmpDir;

// Seed a file with known events so metrics-history has something to aggregate
const now = Date.now();
const today = new Date(now);
const yyyy = today.getUTCFullYear();
const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
const dd = String(today.getUTCDate()).padStart(2, '0');
const file = path.join(tmpDir, `events-${yyyy}-${mm}-${dd}.jsonl`);

const seedLines = [
  { ts: now - 30_000, kind: 'grpc.opened', videoId: 'v1' },
  { ts: now - 25_000, kind: 'message.relayed' },
  { ts: now - 24_000, kind: 'message.relayed' },
  { ts: now - 23_000, kind: 'quota.used', cost: 5, label: 'liveChatMessages.list' },
  { ts: now - 22_000, kind: 'mod.action', source: 'youtube', type: 'delete_message', mirrored: true },
  { ts: now - 21_000, kind: 'grpc.closed', reason: 'error:RESOURCE_EXHAUSTED', durationMs: 9000 },
  { ts: now - 20_000, kind: 'reconcile.swept', orphans: 2 },
  { ts: now - 10_000, kind: 'ws.connected', ip: '1.2.3.4', total: 1 },
  { ts: now - 5_000, kind: 'ws.disconnected', ip: '1.2.3.4', total: 0 },
];
fs.writeFileSync(file, seedLines.map((e) => JSON.stringify(e)).join('\n') + '\n');

// Purge the metrics-history module from require cache so it re-reads env
delete require.cache[require.resolve('../event-log.js')];
delete require.cache[require.resolve('../metrics-history.js')];

const { getHistory, invalidateCache } = require('../metrics-history.js');

test('getHistory aggregates events into the bucket containing the seeded events', () => {
  invalidateCache();
  const rollup = getHistory(60 * 60 * 1000);
  assert.ok(rollup.length >= 1, 'expected at least one bucket');
  // Locate the bucket by content, not by position. The seeded events
  // use `now - 30s`; if the test runs within 30s of a UTC hour boundary
  // those events fall in the PREVIOUS hour's bucket while the current
  // hour's bucket is empty — the previous "last bucket" assumption flaked
  // CI whenever the run timing lined up with that boundary.
  const hour = rollup.find((b) => b.grpcOpens >= 1);
  assert.ok(hour, 'expected a bucket containing the seeded grpc.opened event');
  assert.ok(hour.grpcCloses >= 1);
  assert.ok(hour.grpcErrors >= 1, 'error-reason close should bump grpcErrors');
  assert.ok(hour.messagesRelayed >= 2);
  assert.ok(hour.modActionsMirrored >= 1);
  assert.ok(hour.quotaUnitsUsed >= 5);
  assert.ok(hour.wsConnects >= 1);
  assert.ok(hour.wsDisconnects >= 1);
  assert.ok(hour.reconcileRuns >= 1);
});

test('getHistory honors window parameter', () => {
  invalidateCache();
  const oneMinute = getHistory(60 * 1000);
  assert.ok(Array.isArray(oneMinute));
});

test('cache returns same object within TTL', () => {
  invalidateCache();
  const a = getHistory(60 * 60 * 1000);
  const b = getHistory(60 * 60 * 1000);
  assert.strictEqual(a, b, 'expected cached object to be reused');
});

test.after(() => {
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
    fs.rmdirSync(tmpDir);
  } catch {}
});
