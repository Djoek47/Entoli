import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./results/', import.meta.url));

/** Print a table and keep the numbers (evals/results/<name>.json) so runs can be compared. */
export function report(name: string, rows: Record<string, string | number>[], summary: Record<string, number | string>) {
  const cols = Object.keys(rows[0] ?? {});
  const line = (r: Record<string, string | number>) => cols.map((c) => String(r[c] ?? '').slice(0, 44).padEnd(c === 'ok' ? 3 : 14)).join(' ');
  const bad = rows.filter((r) => r.ok === '✗');
  console.log(`\n── ${name} ──`);
  if (bad.length) { console.log(cols.join(' ')); bad.forEach((r) => console.log(line(r))); }
  console.log(Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join('   '));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${name}.json`, JSON.stringify({ at: new Date().toISOString(), summary, failures: bad }, null, 2) + '\n');
}
