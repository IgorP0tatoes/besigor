import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { DB } from './db.js';

const KEEP = 7;

/** Daily consistent SQLite snapshot into DATA_DIR/backups, keeping the last 7. */
export function startBackups(db: DB, dataDir: string, log: FastifyBaseLogger) {
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true });

  const run = async () => {
    const day = new Date().toISOString().slice(0, 10);
    const file = join(dir, `besigor-${day}.db`);
    const existing = readdirSync(dir).filter((f) => /^besigor-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    if (!existing.includes(`besigor-${day}.db`)) {
      try {
        await db.backup(file);
        log.info({ file }, 'database backup written');
        existing.push(`besigor-${day}.db`);
      } catch (err) {
        log.error({ err }, 'database backup failed');
      }
    }
    for (const old of existing.slice(0, Math.max(0, existing.length - KEEP))) rmSync(join(dir, old), { force: true });
  };

  setTimeout(run, 60_000);
  setInterval(run, 3600_000);
}
