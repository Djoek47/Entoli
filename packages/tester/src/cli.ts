/**
 * entoli-test <entoli.skill.json> <url> [--json] [--upload <dashboard-url> --key <ek_live_…>] [--min <coverage%>]
 */
import { readFileSync } from 'node:fs';
import { assertSkill } from '@entoli/sdk/skill';
import { testApp } from './index.js';

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const flag = (n: string) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const bool = (n: string) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
  const json = bool('--json');
  const upload = flag('--upload');
  const key = flag('--key') ?? process.env.ENTOLI_KEY;
  const min = Number(flag('--min') ?? 0);
  const [skillPath, url] = args;
  if (!skillPath || !url) {
    console.error('Usage: entoli-test <entoli.skill.json> <url> [--json] [--min 80] [--upload https://entoli.dev --key ek_live_…]');
    return 1;
  }
  const skill = assertSkill(JSON.parse(readFileSync(skillPath, 'utf8')));
  const report = await testApp(skill, url, json ? {} : { log: (l) => console.error(l) });
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.error(`\nCoverage ${report.coverage}% (${report.verified}/${report.checked} checked, ${report.unchecked.length} not checkable) in ${report.ms} ms`);
    for (const b of report.broken) console.error(`  ✗ ${b.title}: ${b.reason}`);
  }
  if (upload) {
    if (!key) { console.error('--upload needs --key (or ENTOLI_KEY)'); return 1; }
    const res = await fetch(`${upload.replace(/\/$/, '')}/api/test-runs`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(report) });
    console.error(res.ok ? 'Report uploaded to the dashboard.' : `Upload failed: HTTP ${res.status}`);
    if (!res.ok) return 1;
  }
  // 2: something is broken, or coverage is under --min. Useful as a CI gate.
  return report.broken.length > 0 || report.coverage < min ? 2 : 0;
}
