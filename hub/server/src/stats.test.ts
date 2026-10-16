import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from './db.js';
import { insertMinutes, mergeSamples, querySeries, rollup } from './stats.js';
import type { Sample } from './types.js';

function sample(ts: number, over: Partial<Sample> = {}): Sample {
  return {
    ts, cpu: 10, cpuUser: 6, cpuSys: 3, cpuIowait: 1, cpuSteal: 0, load: [1, 1, 1],
    memUsed: 1000, memTotal: 4000, memBuffCache: 500, swapUsed: 0, swapTotal: 100,
    disks: [{ mount: '/', dev: 'vda', fs: 'ext4', total: 100, used: 50 }],
    diskRead: 100, diskWrite: 200, net: [{ iface: 'eth0', rx: 600, tx: 300 }], rx: 600, tx: 300, uptime: 1,
    ...over,
  };
}

test('mergeSamples averages gauges and sums byte counters', () => {
  const m = mergeSamples([sample(0, { cpu: 10 }), sample(60, { cpu: 30, rx: 400 })], 0);
  assert.equal(m.cpu, 20);
  assert.equal(m.rx, 1000);
  assert.equal(m.net?.[0]?.rx, 1200);
  assert.equal(m.ts, 0);
});

test('insert is idempotent and acks the newest timestamp', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO servers (id, name, token_hash, created_at) VALUES ('s', 's', 'h', 0)").run();
  assert.equal(insertMinutes(db, 's', [sample(60), sample(120)]), 120);
  assert.equal(insertMinutes(db, 's', [sample(120), sample(125)]), 120, 'non-minute ts is skipped');
  const n = db.prepare('SELECT COUNT(*) AS n FROM stats_1m').get() as { n: number };
  assert.equal(n.n, 2);
});

test('rollup and query produce rates per second', () => {
  const db = openDb(':memory:');
  const now = 1_700_003_600;
  const base = Math.floor((now - 1800) / 900) * 900;
  const recs = Array.from({ length: 15 }, (_, i) => sample(base + i * 60));
  insertMinutes(db, 's', recs);
  rollup(db, now);
  const row = db.prepare('SELECT data FROM stats_15m WHERE ts = ?').get(base) as { data: string };
  assert.equal((JSON.parse(row.data) as Sample).rx, 600 * 15);

  const s = querySeries(db, 's', '1h', now);
  assert.equal(s.ts.length, 15);
  assert.equal(s.rx[0], 10, '600 bytes per minute = 10 B/s');
  assert.equal(s.disks[0]?.used.length, 15);
});
