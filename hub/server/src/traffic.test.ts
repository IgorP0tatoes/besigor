import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from './db.js';
import { insertMinutes } from './stats.js';
import { period, setSettings, summary } from './traffic.js';
import type { Sample } from './types.js';

test('period follows the reset day across month boundaries', () => {
  const p = period(15, new Date(Date.UTC(2026, 9, 3)));
  assert.equal(p.start.toISOString().slice(0, 10), '2026-09-15');
  assert.equal(p.end.toISOString().slice(0, 10), '2026-10-15');
  const q = period(1, new Date(Date.UTC(2026, 0, 1, 12)));
  assert.equal(q.start.toISOString().slice(0, 10), '2026-01-01');
});

test('traffic is counted once per minute record and respects the mode', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO servers (id, name, token_hash, created_at) VALUES ('s', 's', 'h', 0)").run();
  const ts = Math.floor(Date.UTC(2026, 9, 10) / 1000);
  const rec = { ts, rx: 1000, tx: 3000 } as Sample;
  insertMinutes(db, 's', [rec]);
  insertMinutes(db, 's', [rec]); // replay after reconnect
  setSettings(db, 's', { limit: 10_000, resetDay: 1, mode: 'max' });
  const t = summary(db, 's', new Date(Date.UTC(2026, 9, 11)))!;
  assert.equal(t.rx, 1000);
  assert.equal(t.used, 3000);
  assert.equal(t.periodStart, '2026-10-01');
});
