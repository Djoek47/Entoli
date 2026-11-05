/**
 * entoli analyze <path> [--out entoli.skill.json] [--no-ai] [--model id] [--max-input-tokens n] [--print]
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyze } from './index.js';

const HELP = `Usage: entoli analyze <path> [options]

Reads a React / Next.js / Vue repository and drafts entoli.skill.json.

Options:
  --out <file>              where to write the skill (default: <path>/entoli.skill.json)
  --print                   print the skill to stdout instead of writing it
  --no-ai                   static heuristics only, even if ANTHROPIC_API_KEY is set
  --model <id>              Claude model for the review pass (default: claude-opus-5-5)
  --max-input-tokens <n>    cap on the scan summary sent to the model (default 60000)
  -h, --help                this help

With ANTHROPIC_API_KEY set, Claude reviews the draft. It can only refine acts
backed by controls found in the code; anything else is dropped.`;

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return args.length === 0 ? 1 : 0;
  }
  const cmd = args.shift();
  if (cmd !== 'analyze') {
    console.error(`Unknown command "${cmd}".\n\n${HELP}`);
    return 1;
  }
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const bool = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  const out = flag('--out');
  const model = flag('--model');
  const maxIn = flag('--max-input-tokens');
  const noAi = bool('--no-ai');
  const print = bool('--print');
  const path = args[0];
  if (!path) {
    console.error('Missing <path>.');
    return 1;
  }

  const r = await analyze(path, {
    ...(noAi ? { ai: false } : {}),
    ...(model ? { model } : {}),
    ...(maxIn ? { maxInputTokens: Number(maxIn) } : {}),
    log: (l) => console.error(`› ${l}`),
  });
  const json = JSON.stringify(r.skill, null, 2) + '\n';
  if (print) process.stdout.write(json);
  else {
    const file = resolve(out ?? resolve(path, 'entoli.skill.json'));
    writeFileSync(file, json);
    console.error(`✓ Wrote ${file}`);
  }
  const review = r.guesses.filter((g) => g.radius !== 'self' || !g.undo);
  if (review.length) {
    console.error('\nReview these contract guesses:');
    for (const g of review) console.error(`  ${g.act.padEnd(28)} ${g.radius.padEnd(13)} ${g.undo ? 'undo' : 'no undo'}  (${g.why})`);
  }
  return 0;
}
