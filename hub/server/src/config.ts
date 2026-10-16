import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

const dataDir = env('DATA_DIR', '/data');
mkdirSync(dataDir, { recursive: true });

// Signing secret for sessions: from env, or generated once and kept in DATA_DIR.
function secret(): string {
  const fromEnv = env('SESSION_SECRET');
  if (fromEnv) return fromEnv;
  const file = join(dataDir, '.session-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const s = randomBytes(32).toString('hex');
  writeFileSync(file, s, { mode: 0o600 });
  return s;
}

export const config = {
  version: env('BESIGOR_VERSION', '0.1.0'),
  port: Number(env('PORT', '8090')),
  host: env('HOST', '0.0.0.0'),
  dataDir,
  dbPath: join(dataDir, 'besigor.db'),
  // Public URL of the hub; shown in the "add server" snippet.
  appUrl: env('APP_URL').replace(/\/+$/, ''),
  adminUser: env('ADMIN_USER', 'admin'),
  adminPassword: env('ADMIN_PASSWORD'),
  // Proxies whose X-Forwarded-For / CF-Connecting-IP are believed.
  // Comma-separated IPs/CIDRs; default trusts private networks (Docker, LAN).
  trustedProxies: env('TRUSTED_PROXIES', '127.0.0.1/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Set when the hub sits behind Cloudflare's proxy (orange cloud).
  trustCloudflare: env('TRUST_CLOUDFLARE') === 'true',
  sessionSecret: secret(),
  webDir: env('WEB_DIR', new URL('../../web/dist', import.meta.url).pathname),
  agentImage: env('AGENT_IMAGE', 'ghcr.io/igorp0tatoes/besigor-agent'),
};

if (!config.adminPassword) {
  console.error('ADMIN_PASSWORD is required');
  process.exit(1);
}
