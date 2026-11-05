import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appJwt, installationToken } from '@/lib/github';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

describe('GitHub App', () => {
  it('signs a valid RS256 app JWT', () => {
    const jwt = appJwt('123', pem.replace(/\n/g, '\\n'), 1_700_000_000);
    const [h, b, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(b!, 'base64url').toString())).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: '123' });
    expect(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
  });

  it('asks for read-only tokens by default, write only when asked', async () => {
    process.env.GITHUB_APP_ID = '1'; process.env.GITHUB_APP_PRIVATE_KEY = pem;
    const bodies: unknown[] = [];
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ token: 't' })); }) as unknown as typeof fetch;
    await installationToken('9', { repo: 'a/b' }, f);
    await installationToken('9', { repo: 'a/b', write: true }, f);
    expect(bodies[0]).toEqual({ permissions: { contents: 'read', metadata: 'read' }, repositories: ['b'] });
    expect(bodies[1]).toMatchObject({ permissions: { contents: 'write', pull_requests: 'write' } });
  });
});
