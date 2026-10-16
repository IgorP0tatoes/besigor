import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from './db.js';
import { mergeBuckets, ProbeStore, validateProbe } from './probes.js';

test('validateProbe rejects bad targets and fills defaults', () => {
  assert.equal(typeof validateProbe({ type: 'http', target: 'example.com' }), 'string');
  assert.equal(typeof validateProbe({ type: 'tcp', target: 'example.com' }), 'string', 'tcp needs a port');
  const p = validateProbe({ type: 'tcp', target: '1.1.1.1', port: 443 });
  assert.ok(typeof p !== 'string');
  assert.equal(p.name, '1.1.1.1:443');
  assert.equal(p.interval, 60);
});

test('ingest aggregates per minute and tracks failures in a row', () => {
  const db = openDb(':memory:');
  const store = new ProbeStore(db);
  const id = store.create('s1', { name: 'x', type: 'icmp', target: '1.1.1.1', port: null, interval: 10, dnsServer: null });
  const t = 1_700_000_040;
  store.ingest('s1', [
    { id, ts: t, ok: true, ms: 10, loss: 0 },
    { id, ts: t + 10, ok: true, ms: 30, loss: 0 },
    { id, ts: t + 20, ok: false, ms: 0, loss: 100, error: 'timeout' },
  ]);
  store.ingest('s1', [{ id, ts: t + 30, ok: false, ms: 0, loss: 100 }]);
  assert.equal(store.stateOf(id).fails, 2);
  const s = store.series(id, 3600, t + 60);
  assert.equal(s.ts.length, 1);
  assert.equal(s.avg[0], 20);
  assert.equal(s.loss[0], 50);
  assert.equal(s.uptime, 50);
  assert.equal(mergeBuckets([], 0).n, 0);
});
