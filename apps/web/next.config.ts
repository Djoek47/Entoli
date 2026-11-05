import type { NextConfig } from 'next';

const config: NextConfig = {
  // The marketing page is the original static site, served as is (see scripts/build-site.mjs).
  async rewrites() {
    return { beforeFiles: [{ source: '/', destination: '/site.html' }], afterFiles: [], fallback: [] };
  },
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Frame-Options', value: 'DENY' },
    ] }];
  },
  serverExternalPackages: ['@electric-sql/pglite'],
};
export default config;
