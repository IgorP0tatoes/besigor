import Database from 'better-sqlite3';

export type DB = Database.Database;

// Each entry runs once, in order; the index is stored in user_version.
const migrations: string[] = [
  `
  CREATE TABLE servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    host_info   TEXT,
    last_seen   INTEGER,
    sort        INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE stats_1m  (server_id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (server_id, ts)) WITHOUT ROWID;
  CREATE TABLE stats_15m (server_id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (server_id, ts)) WITHOUT ROWID;
  CREATE TABLE stats_1h  (server_id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (server_id, ts)) WITHOUT ROWID;
  CREATE TABLE sessions (
    id_hash    TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  CREATE TABLE alerts (
    server_id TEXT NOT NULL,
    type      TEXT NOT NULL,
    enabled   INTEGER NOT NULL,
    value     REAL NOT NULL,
    minutes   INTEGER NOT NULL,
    PRIMARY KEY (server_id, type)
  ) WITHOUT ROWID;
  CREATE TABLE alert_state (
    server_id TEXT NOT NULL,
    type      TEXT NOT NULL,
    key       TEXT NOT NULL DEFAULT '',
    since     INTEGER NOT NULL,
    value     REAL,
    PRIMARY KEY (server_id, type, key)
  ) WITHOUT ROWID;
  CREATE TABLE mutes (server_id TEXT PRIMARY KEY, until INTEGER);
  CREATE TABLE recipients (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    chat_id    TEXT NOT NULL,
    thread_id  INTEGER,
    categories TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE probes (
    id         TEXT PRIMARY KEY,
    server_id  TEXT NOT NULL,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL,
    target     TEXT NOT NULL,
    port       INTEGER,
    interval   INTEGER NOT NULL,
    dns_server TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX probes_server ON probes (server_id);
  CREATE TABLE probe_1m (probe_id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (probe_id, ts)) WITHOUT ROWID;
  CREATE TABLE probe_1h (probe_id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (probe_id, ts)) WITHOUT ROWID;
  `,
];

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let i = current; i < migrations.length; i++) {
    db.transaction(() => {
      db.exec(migrations[i]!);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setSetting(db: DB, key: string, value: unknown) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}
