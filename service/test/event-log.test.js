// Tests for service/event-log.js
// Run with: node --test service/test/event-log.test.js
//
// Uses a temp dir so no production data is touched. Runs purely offline.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Prepare a temp dir BEFORE requiring the module so the module reads the env
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theochat-eventlog-'));
process.env.EVENT_LOG_DIR = tmpDir;

// Clear Node's require cache in case event-log.js was loaded elsewhere
const modulePath = require.resolve('../event-log.js');
delete require.cache[modulePath];

const { logEvent, readEventsSince, droppedEventCount, eventLogDir, shutdownEventLog, flushEventLog } = require('../event-log.js');

// Deterministic replacement for arbitrary setTimeout(50) flush waits. Resolves
// once the write stream's internal buffer has drained, so the JSONL file is
// readable from disk.
function flush() {
  return new Promise((resolve) => flushEventLog(resolve));
}

test('eventLogDir returns the configured directory', () => {
  assert.strictEqual(eventLogDir(), tmpDir);
});

test('logEvent writes a JSON line with kind and payload', async () => {
  logEvent('grpc.opened', { videoId: 'abc123', liveChatId: 'xyz' });
  await flush();
  const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length >= 1, 'expected at least one JSONL file');
  const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1, 'expected at least one line written');
  const parsed = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(parsed.kind, 'grpc.opened');
  assert.strictEqual(parsed.videoId, 'abc123');
  assert.strictEqual(parsed.liveChatId, 'xyz');
  assert.ok(typeof parsed.ts === 'number');
});

test('readEventsSince returns recent events', async () => {
  const since = Date.now() - 60_000;
  logEvent('test.marker', { value: 42 });
  await flush();
  const events = readEventsSince(since);
  const found = events.find((e) => e.kind === 'test.marker' && e.value === 42);
  assert.ok(found, 'expected to find the test.marker event');
});

test('droppedEventCount does not increment on successful writes', () => {
  const before = droppedEventCount();
  logEvent('test.drop.check', { ok: true });
  const after = droppedEventCount();
  assert.strictEqual(after, before, 'drop counter should not move on success');
});

test('logEvent intrinsics (ts, kind) cannot be overwritten by payload', async () => {
  // Regression: prior code spread payload last, so a caller accidentally
  // passing { ts: 1, kind: 'other' } would clobber the event's real ts/kind.
  // downstream readEventsSince filters by ts and metrics-history switches on
  // kind, so a bad caller silently broke the rollup.
  const before = Date.now();
  logEvent('intrinsic.guard', { kind: 'OVERWRITTEN', ts: 1, value: 'keep' });
  await flush();
  const events = readEventsSince(before - 1000);
  const found = events.find((e) => e.value === 'keep');
  assert.ok(found, 'expected the event to be written');
  assert.strictEqual(found.kind, 'intrinsic.guard', 'kind must win over payload');
  assert.ok(found.ts >= before, 'ts must win over payload (real ts, not 1)');
});

test('logEvent never throws (observability must not crash the relay)', () => {
  // The relay contract: no matter what we pass in, logEvent returns cleanly.
  assert.doesNotThrow(() => logEvent('bad.event', { circular: undefined }));
  // Circular references are caught internally; no throw.
  const circ = { self: null };
  circ.self = circ;
  assert.doesNotThrow(() => logEvent('bad.circular', { data: circ }));
});

test('shutdownEventLog closes cleanly', () => {
  assert.doesNotThrow(() => shutdownEventLog());
});

test.after(() => {
  shutdownEventLog();
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
    fs.rmdirSync(tmpDir);
  } catch {}
});
