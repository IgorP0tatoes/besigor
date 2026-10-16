import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { FastifyRequest } from 'fastify';
import { config } from './config.js';

const trusted = new BlockList();
for (const entry of config.trustedProxies) {
  const [addr, bits] = entry.split('/');
  const type = isIP(addr ?? '') === 6 ? 'ipv6' : 'ipv4';
  if (!addr || !isIP(addr)) continue;
  if (bits) trusted.addSubnet(addr, Number(bits), type);
  else trusted.addAddress(addr, type);
}

function normalize(ip: string) {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function isTrustedProxy(ip: string | undefined): boolean {
  if (!ip) return false;
  const n = normalize(ip);
  return trusted.check(n, isIP(n) === 6 ? 'ipv6' : 'ipv4');
}

function header(h: IncomingMessage['headers'], name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Real client address: CF-Connecting-IP / X-Forwarded-For only from trusted proxies. */
export function clientIpFrom(remote: string | undefined, headers: IncomingMessage['headers']): string {
  const peer = normalize(remote ?? '');
  if (!isTrustedProxy(peer)) return peer;
  // Only behind Cloudflare: otherwise anyone can send this header through the proxy.
  const cf = config.trustCloudflare ? header(headers, 'cf-connecting-ip') : undefined;
  if (cf && isIP(cf.trim())) return cf.trim();
  const xff = header(headers, 'x-forwarded-for');
  if (xff) {
    // walk right-to-left, skipping our own proxies
    const hops = xff.split(',').map((s) => normalize(s.trim())).filter((s) => isIP(s));
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!isTrustedProxy(hops[i])) return hops[i]!;
    }
    if (hops[0]) return hops[0];
  }
  return peer;
}

export function clientIp(req: FastifyRequest): string {
  return clientIpFrom(req.raw.socket.remoteAddress, req.headers);
}

export function isHttps(req: FastifyRequest): boolean {
  if (isTrustedProxy(req.raw.socket.remoteAddress)) {
    const proto = header(req.headers, 'x-forwarded-proto');
    if (proto) return proto.split(',')[0]!.trim() === 'https';
  }
  return req.protocol === 'https';
}
