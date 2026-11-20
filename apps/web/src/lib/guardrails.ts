/**
 * Guardrails for the developer's own coding agent.
 *
 * The agent does the heavy lifting; Entoli limits what it may do. Four rules,
 * all checked here before a submitted change is even shown to the developer
 * (who still approves every diff):
 *
 *   1. FILES      only files Entoli expects an integration to touch
 *   2. ACTS       only acts the developer exposed (never an "off" act, never an invented one)
 *   3. CONTRACT   never weaker than the skill: radius, undo, exact, voiceOnly, layer
 *   4. PACKAGES   package.json may only gain @entoli/sdk
 *
 * Pure functions: no I/O, so each rule is tested on its own.
 */
import { actLayer, validateSkill, type Radius, type Skill, type SkillAct } from '@entoli/sdk/skill';
import ts from 'typescript';

export type Verdict = { ok: true; warnings: string[] } | { ok: false; reasons: string[] };
const ok = (warnings: string[] = []): Verdict => ({ ok: true, warnings });
const no = (...reasons: string[]): Verdict => ({ ok: false, reasons });

export const MAX_FILE_BYTES = 200_000;
export const MAX_CHANGES = 30;

const RADIUS: Record<Radius, number> = { self: 0, 'other-person': 1, external: 2 };
/** How much AI reach a layer gives: off < L1 (device only) < L2 (AI answers). */
const REACH = { off: 0, L1: 1, L2: 2 } as const;

// ---- 1. files --------------------------------------------------------------------------------

const ENTRY_FILES = ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js', 'src/index.tsx', 'src/index.jsx', 'src/index.js', 'app/layout.tsx', 'src/app/layout.tsx', 'app/layout.jsx', 'src/app/layout.jsx'];
const NEW_FILES = ['entoli.skill.json', 'package.json', 'src/entoli.ts', 'src/entoli.theme.css', 'entoli.theme.css', 'components/EntoliBar.tsx', 'src/components/EntoliBar.tsx'];

export function normalizePath(raw: string): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 300 || raw.includes('\0') || raw.includes('\\')) return null;
  if (raw.startsWith('/')) return null;
  const parts: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/** Every directory above the files the analysis found: the places a package.json or entry may live. */
function ancestors(files: string[]): string[] {
  const dirs = new Set<string>(['']);
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs];
}

/** The complete list of paths an integration may write. */
export function allowedFiles(skill: Skill, sources: Record<string, { file: string }[]>): string[] {
  const exposed = skill.acts.filter((a) => actLayer(skill, a) !== 'off');
  const sourceFiles = new Set(exposed.flatMap((a) => (sources[a.name] ?? []).map((s) => s.file)));
  const out = new Set<string>(sourceFiles);
  for (const d of ancestors([...sourceFiles])) {
    for (const f of [...NEW_FILES, ...ENTRY_FILES]) out.add(d ? `${d}/${f}` : f);
  }
  return [...out].sort();
}

export function checkFile(raw: string, allowed: string[]): Verdict & { path?: string } {
  const path = normalizePath(raw);
  if (!path) return no(`"${raw}" is not a valid repository path (no absolute paths, "..", or backslashes).`);
  if (!allowed.includes(path)) return no(`"${path}" is not a file this integration may touch. Allowed: the source files of the exposed acts, the app entry, entoli.skill.json, package.json and the Entoli bootstrap/theme files. Ask the developer to expose the feature first if it lives elsewhere.`);
  return { ...ok(), path };
}

const PROJECT_BLOCKED = /(^|\/)(node_modules|\.git|\.next|\.vercel|\.env[^/]*)(\/|$)/i;

/** In a project built on Entoli the agent writes the app itself, so any normal source path is allowed (never secrets, git or installed packages). */
export function checkProjectFile(raw: string): Verdict & { path?: string } {
  const path = normalizePath(raw);
  if (!path) return no(`"${raw}" is not a valid project path (no absolute paths, "..", or backslashes).`);
  if (PROJECT_BLOCKED.test(path)) return no(`"${path}" is not a file a project may hold (secrets, git data and installed packages are never part of it).`);
  return { ...ok(), path };
}

// ---- 2 + 3. acts and contract in code ------------------------------------------------------------

function litString(e: ts.Expression | undefined): string | undefined {
  return e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined;
}

/** The checks that apply to every useEntoli / defineAct call in a file. */
export function checkCode(path: string, content: string, skill: Skill): Verdict {
  if (!/\.(tsx?|jsx?|mjs)$/.test(path)) return ok();
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const byName = new Map(skill.acts.map((a) => [a.name, a]));

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : '';
      if (name === 'useEntoli' || name === 'defineAct' || (name === 'register' && ts.isPropertyAccessExpression(c) && /entoli/i.test(c.expression.getText(sf)))) {
        const at = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        const actName = litString(n.arguments[0]);
        if (!actName) { reasons.push(`${path}:${at}: the act name must be a string literal so it can be checked against the skill.`); }
        else {
          const act = byName.get(actName);
          if (!act) reasons.push(`${path}:${at}: "${actName}" is not an act in the skill. Entoli only wires acts the developer declared.`);
          else if (actLayer(skill, act) === 'off') reasons.push(`${path}:${at}: "${actName}" is set to "off" (not connected). Do not wire it.`);
          else checkOptions(act, n.arguments[3], `${path}:${at}`, reasons, warnings);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return reasons.length ? { ok: false, reasons } : ok(warnings);
}

function checkOptions(act: SkillAct, arg: ts.Expression | undefined, where: string, reasons: string[], warnings: string[]): void {
  if (!arg) return; // nothing declared in code: the skill's contract applies as is
  if (!ts.isObjectLiteralExpression(arg)) { reasons.push(`${where}: options for "${act.name}" must be an object literal so the contract can be checked (no variables or spreads).`); return; }
  for (const p of arg.properties) {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p) && !ts.isMethodDeclaration(p)) {
      reasons.push(`${where}: options for "${act.name}" must not use spreads or computed members.`);
      continue;
    }
    const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : '';
    if (!key) { reasons.push(`${where}: options for "${act.name}" must not use computed members.`); continue; }
    const init = ts.isPropertyAssignment(p) ? p.initializer : undefined;
    if (key === 'radius') {
      const r = litString(init) as Radius | undefined;
      if (!r || !(r in RADIUS)) reasons.push(`${where}: radius for "${act.name}" must be a literal "self", "other-person" or "external".`);
      else if (RADIUS[r] < RADIUS[act.radius]) reasons.push(`${where}: "${act.name}" declares radius "${r}", weaker than the skill's "${act.radius}".`);
    } else if (key === 'exact' || key === 'voiceOnly') {
      const off = init?.kind === ts.SyntaxKind.FalseKeyword;
      const skillSays = key === 'exact' ? !!act.exact : !!act.voiceOnly;
      if (off && skillSays) reasons.push(`${where}: "${act.name}" turns ${key} off, but the skill requires it.`);
      else if (!off && init?.kind !== ts.SyntaxKind.TrueKeyword && skillSays) reasons.push(`${where}: ${key} for "${act.name}" must be a literal true or false.`);
    } else if (key === 'kind') {
      const k = litString(init);
      if (act.kind === 'setting' && k !== 'setting') reasons.push(`${where}: "${act.name}" is a setting in the skill and must stay one.`);
    } else if (key === 'undo') {
      if (!act.undo) reasons.push(`${where}: "${act.name}" has no undo in the skill, so code must not add one (that would let it run without a yes).`);
    } else if (!['describe', 'prepare', 'title', 'phrases'].includes(key)) {
      warnings.push(`${where}: unknown option "${key}" for "${act.name}" (ignored by the SDK).`);
    }
  }
}

// ---- 3. contract in the skill file --------------------------------------------------------------------

/** A changed entoli.skill.json may tighten things, never loosen them, and never add acts. */
export function checkSkillChange(content: string, current: Skill): Verdict {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch (e) { return no(`entoli.skill.json is not valid JSON: ${(e as Error).message}`); }
  const v = validateSkill(parsed);
  if (!v.ok) return no(...v.errors.slice(0, 6).map((e) => `entoli.skill.json: ${e}`));
  const next = v.skill;
  const reasons: string[] = [];
  const old = new Map(current.acts.map((a) => [a.name, a]));

  for (const a of next.acts) {
    const o = old.get(a.name);
    if (!o) { reasons.push(`entoli.skill.json adds the act "${a.name}". Only the developer can add acts (in the dashboard).`); continue; }
    if (RADIUS[a.radius] < RADIUS[o.radius]) reasons.push(`"${a.name}": radius "${a.radius}" is weaker than "${o.radius}".`);
    if (a.undo && !o.undo) reasons.push(`"${a.name}": undo was added; the skill said it cannot be undone.`);
    if (o.exact && !a.exact) reasons.push(`"${a.name}": exact was removed.`);
    if (o.voiceOnly && !a.voiceOnly) reasons.push(`"${a.name}": voiceOnly was removed.`);
    if (o.kind === 'setting' && a.kind !== 'setting') reasons.push(`"${a.name}": no longer marked as a setting.`);
    if (REACH[actLayer(next, a)] > REACH[actLayer(current, o)]) reasons.push(`"${a.name}": layer ${actLayer(next, a)} gives the AI more reach than ${actLayer(current, o)}.`);
  }
  for (const a of current.acts) if (!next.acts.some((x) => x.name === a.name)) reasons.push(`entoli.skill.json removes the act "${a.name}". Ask the developer; use layer "off" in the dashboard instead.`);
  return reasons.length ? { ok: false, reasons } : ok();
}

/** A project's package.json: valid, and no install-time scripts (they would run on the developer's machine and in the sandbox). */
export function checkProjectPackageJson(next: string): Verdict {
  let n: { scripts?: Record<string, string>; dependencies?: Record<string, string> };
  try { n = JSON.parse(next); } catch (e) { return no(`package.json is not valid JSON: ${(e as Error).message}`); }
  const bad = Object.keys(n.scripts ?? {}).filter((k) => ['preinstall', 'install', 'postinstall', 'prepare'].includes(k));
  if (bad.length) return no(`package.json has install-time scripts (${bad.join(', ')}). They run on install, so they are not allowed.`);
  if (!n.scripts?.dev && !n.scripts?.start) return ok(['package.json has no "dev" or "start" script, so the sandbox cannot start the project.']);
  return ok();
}

// ---- 4. packages -----------------------------------------------------------------------------------------

/** package.json may only gain @entoli/sdk: everything else byte-for-byte equal in meaning. */
export function checkPackageJson(base: string | null, next: string): Verdict {
  let n: Record<string, unknown>;
  try { n = JSON.parse(next) as Record<string, unknown>; } catch (e) { return no(`package.json is not valid JSON: ${(e as Error).message}`); }
  if (base === null) return no('package.json does not exist in the repository; Entoli does not create it.');
  let b: Record<string, unknown>;
  try { b = JSON.parse(base) as Record<string, unknown>; } catch { return no('The current package.json could not be read.'); }
  const strip = (o: Record<string, unknown>) => {
    const copy = JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
    const deps = (copy.dependencies ?? {}) as Record<string, string>;
    delete deps['@entoli/sdk'];
    copy.dependencies = deps;
    return JSON.stringify(sortKeys(copy));
  };
  if (strip(b) !== strip(n)) return no('package.json changed beyond adding "@entoli/sdk" to dependencies (scripts, other dependencies or fields differ). Entoli only adds its own SDK.');
  const added = ((n.dependencies ?? {}) as Record<string, string>)['@entoli/sdk'];
  if (added === undefined && ((b.dependencies ?? {}) as Record<string, string>)['@entoli/sdk'] === undefined) return no('package.json does not add "@entoli/sdk".');
  return ok();
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

/** Everything that applies to one submitted file. */
export function checkSubmission(input: { path: string; content: string; base: string | null; skill: Skill; project?: boolean }): Verdict {
  const { path, content, base, skill } = input;
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) return no(`The file is over ${MAX_FILE_BYTES / 1000} kB.`);
  const name = path.split('/').pop()!;
  if (name === 'entoli.skill.json') return checkSkillChange(content, skill);
  if (name === 'package.json') return input.project ? checkProjectPackageJson(content) : checkPackageJson(base, content);
  if (/\.(tsx?|jsx?|mjs)$/.test(path)) {
    const syntax = ts.transpileModule(content, { fileName: path, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).diagnostics ?? [];
    if (syntax.length) return no(`${path} does not parse: ${ts.flattenDiagnosticMessageText(syntax[0]!.messageText, ' ')}`);
    return checkCode(path, content, skill);
  }
  return ok();
}
