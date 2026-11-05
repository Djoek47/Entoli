/**
 * App keys. Shown once at creation; only a sha256 hash is stored.
 *   ek_live_<32 base62 chars>
 * The key is a public client key (it ships in the app's bundle, like a
 * Stripe publishable key): it can only spend that app's intents, never read
 * or change anything in the dashboard.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function generateKey(kind: 'live' | 'test' = 'live'): string {
  const bytes = randomBytes(32);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 62];
  return `ek_${kind}_${s}`;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function keyPrefix(key: string): string {
  return key.slice(0, 12);
}

export function looksLikeKey(key: string): boolean {
  return /^ek_(live|test)_[0-9A-Za-z]{32}$/.test(key);
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
