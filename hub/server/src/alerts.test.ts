import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import type { AgentHub } from './agents.js';
import { AlertEngine, setAlert, setMute, type Category } from './alerts.js';
import { openDb } from './db.js';
import { bus } from './live.js';
import type { Sample } from './types.js';

const log = { error() {}, warn() {}, info() {} } as unknown as FastifyBaseLogger;

function sample(ts: number, cpu: number, disk = 50): Sample {
  return {
    ts, cpu, cpuUser: cpu, cpuSys: 0, cpuIowait: 0, cpuSteal: 0, load: [0, 0, 0],
    memUsed: 1, memTotal: 10, memBuffCache: 0, swapUsed: 0, swapTotal: 0,
    disks: [{ mount: '/', dev: 'vda', fs: 'ext4', total: 100, used: disk }],
    diskRead: 0, diskWrite: 0, net: [], rx: 0, tx: 0, uptime: 1,
  };
}

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO servers (id, name, token_hash, created_at, host_info, last_seen) VALUES ('s1', 'nl-1', 'h', 0, '{\"cores\":2}', 0)").run();
  const sent: { cat: Category; text: string }[] = [];
  let online = true;
  const agents = { isOnline: () => online } as unknown as AgentHub;
  const engine = new AlertEngine(db, agents, { notify: (cat, text) => sent.push({ cat, text }) }, log);
  engine.start();
  return { db, sent, engine, setOnline: (v: boolean) => (online = v) };
}

test('metric alert fires after the window is covered and resolves', () => {
  const { db, sent, engine } = setup();
  setAlert(db, 's1', { type: 'cpu', enabled: true, value: 80, minutes: 2 });
  const t0 = 1_700_000_000;
  for (let t = t0; t <= t0 + 60; t += 10) bus.publish({ type: 'live', serverId: 's1', sample: sample(t, 95) });
  engine.tick(t0 + 60);
  assert.equal(sent.length, 0, 'window of 2 min not covered yet');
  for (let t = t0 + 70; t <= t0 + 130; t += 10) bus.publish({ type: 'live', serverId: 's1', sample: sample(t, 95) });
  engine.tick(t0 + 120);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /процессор/);
  engine.tick(t0 + 125);
  assert.equal(sent.length, 1, 'no repeats while firing');
  for (let t = t0 + 140; t <= t0 + 260; t += 10) bus.publish({ type: 'live', serverId: 's1', sample: sample(t, 5) });
  engine.tick(t0 + 260);
  assert.equal(sent.length, 2);
  assert.match(sent[1]!.text, /в норме/);
  engine.stop();
});

test('offline alert and recovery; mute suppresses messages', () => {
  const { db, sent, engine, setOnline } = setup();
  const now = 1_700_000_000;
  db.prepare('UPDATE servers SET last_seen = ?').run(now - 30);
  setOnline(false);
  engine.tick(now);
  assert.equal(sent.length, 0, 'down for 30s < 2 min');
  engine.tick(now + 120);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.cat, 'offline');
  setOnline(true);
  engine.tick(now + 300);
  assert.match(sent[1]!.text, /снова в сети/);

  setMute(db, 's1', 4);
  setOnline(false);
  db.prepare('UPDATE servers SET last_seen = ?').run(now);
  engine.tick(now + 1000);
  assert.equal(sent.length, 2, 'muted server stays quiet');
  assert.equal(engine.active().length, 1, 'but the state is still tracked');
  engine.stop();
});
