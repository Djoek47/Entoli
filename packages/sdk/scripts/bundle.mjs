// Size check + a script-tag build: dist/entoli.min.js (global `Entoli`).
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

await build({ entryPoints: ['src/index.ts'], bundle: true, minify: true, format: 'iife', globalName: 'Entoli', outfile: 'dist/entoli.min.js', target: 'es2020', legalComments: 'none' });
await build({ entryPoints: ['src/index.ts'], bundle: true, minify: true, format: 'esm', outfile: 'dist/entoli.esm.min.js', target: 'es2020', legalComments: 'none' });
const min = readFileSync('dist/entoli.esm.min.js');
const kb = (n) => (n / 1024).toFixed(1) + ' kB';
console.log(`@entoli/sdk  min ${kb(min.length)}  gzip ${kb(gzipSync(min).length)}`);
if (gzipSync(min).length > 30 * 1024) { console.error('bundle over 30 kB gzip budget'); process.exit(1); }
