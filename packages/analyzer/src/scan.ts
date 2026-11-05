/**
 * The static pass. Reads a React / Next.js / Vue repository WITHOUT running it
 * and finds what a person can do in the app: screens (routes), buttons, links,
 * forms and their fields, and settings.
 *
 * TypeScript's parser (no type checking) gives a real AST for .ts/.tsx/.js/.jsx;
 * Vue single-file components get a lighter template reading. Nothing here
 * executes the repository's code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import type { SlotType } from '@entoli/sdk/skill';

export type Field = { name: string; label: string; type: SlotType; inputType?: string; options?: string[]; required?: boolean };

export type ControlKind = 'button' | 'link' | 'form' | 'input' | 'select' | 'toggle';

export type Control = {
  id: string;
  kind: ControlKind;
  label: string;
  handler?: string;
  /** For links and navigate('/x') calls. */
  href?: string;
  file: string;
  line: number;
  component?: string;
  testId?: string;
  elementId?: string;
  name?: string;
  fields?: Field[];
  options?: string[];
  inputType?: string;
  setting: boolean;
  /** The screen this control was assigned to ('shared' when several screens use it). */
  screen?: string;
};

export type Screen = { id: string; path: string; title: string; component?: string; file?: string };

export type ScanResult = {
  root: string;
  appName: string;
  frameworks: string[];
  files: number;
  skipped: number;
  truncated: boolean;
  screens: Screen[];
  controls: Control[];
};

export type ScanOptions = { maxFiles?: number; maxFileBytes?: number };

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output', 'coverage', '.turbo', '.vercel', 'vendor', '__tests__', '__mocks__', 'test', 'tests', 'e2e', 'cypress', '.storybook', 'storybook-static', 'public', 'static', '.cache', 'tmp']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue']);
const SKIP_FILE = /\.(test|spec|stories|story|d)\.[jt]sx?$|\.config\.[cm]?[jt]s$/;

const SETTINGS_PLACE = /setting|preference|config|account|profile|appearance|options/i;
const SETTINGS_WORD = /\b(theme|dark|light|font|language|locale|notification|email|password|timezone|time ?zone|currency|units?|privacy|appearance|display name|username)\b/i;

// ---- files -------------------------------------------------------------------

function walk(root: string, opts: Required<ScanOptions>): { files: string[]; packages: string[]; skipped: number; truncated: boolean } {
  const files: string[] = [];
  const packages: string[] = [];
  let skipped = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries.sort()) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isSymbolicLink?.()) continue;
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.startsWith('.')) stack.push(p);
        continue;
      }
      if (name === 'package.json') { packages.push(p); continue; }
      if (!CODE_EXT.has(extname(name)) || SKIP_FILE.test(name)) continue;
      if (st.size > opts.maxFileBytes) { skipped++; continue; }
      if (files.length >= opts.maxFiles) { truncated = true; continue; }
      files.push(p);
    }
  }
  return { files: files.sort(), packages, skipped, truncated };
}

// ---- helpers -------------------------------------------------------------------

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function humanize(s: string): string {
  const out = s.replace(/^(handle|on)(?=[A-Z])/, '').replace(/[-_.:/]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function slotTypeFor(inputType: string | undefined, name: string, hasOptions: boolean): SlotType {
  const t = (inputType ?? '').toLowerCase();
  if (hasOptions || t === 'radio' || t === 'checkbox') return 'choice';
  if (t === 'number' || t === 'range') return 'quantity';
  if (t === 'date' || t === 'datetime-local' || t === 'time' || t === 'month' || t === 'week') return 'when';
  if (/\b(assignee|owner|person|user|member|recipient|to|invitee|contact)\b/i.test(humanize(name))) return 'person';
  if (/\b(amount|count|qty|quantity|size|age|price|limit|number)\b/i.test(humanize(name))) return 'quantity';
  if (/\b(date|due|deadline|when|time|at)\b/i.test(humanize(name))) return 'when';
  return 'freeText';
}

function safeName(s: string): string {
  const parts = s.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!parts.length) return '';
  const camel = parts.map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1))).join('');
  return /^[a-zA-Z]/.test(camel) ? camel : `f${camel}`;
}

// ---- TS / JSX ------------------------------------------------------------------

type Found = { controls: Omit<Control, 'id' | 'setting'>[]; routes: { path: string; component?: string; file: string }[]; imports: string[]; components: string[] };

function scriptKind(file: string): ts.ScriptKind {
  const e = extname(file);
  if (e === '.tsx') return ts.ScriptKind.TSX;
  if (e === '.ts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX;
}

function attrMap(el: ts.JsxOpeningLikeElement): Map<string, ts.JsxAttribute> {
  const m = new Map<string, ts.JsxAttribute>();
  for (const p of el.attributes.properties) if (ts.isJsxAttribute(p)) m.set(p.name.getText(), p);
  return m;
}

function attrString(a: ts.JsxAttribute | undefined): string | undefined {
  const i = a?.initializer;
  if (!i) return a ? 'true' : undefined;
  if (ts.isStringLiteral(i)) return i.text;
  if (ts.isJsxExpression(i) && i.expression) {
    const e = i.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (e.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  }
  return undefined;
}

function attrExpr(a: ts.JsxAttribute | undefined): ts.Expression | undefined {
  const i = a?.initializer;
  return i && ts.isJsxExpression(i) ? i.expression : undefined;
}

function jsxText(node: ts.Node): string {
  let out = '';
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) out += ` ${n.text}`;
    else if (ts.isJsxExpression(n) && n.expression && (ts.isStringLiteral(n.expression) || ts.isNoSubstitutionTemplateLiteral(n.expression))) out += ` ${n.expression.text}`;
    else if (ts.isJsxSelfClosingElement(n)) {
      const a = attrMap(n);
      const t = attrString(a.get('aria-label')) ?? attrString(a.get('title')) ?? attrString(a.get('alt'));
      if (t) out += ` ${t}`;
    } else ts.forEachChild(n, visit);
  };
  if (ts.isJsxElement(node)) node.children.forEach(visit);
  return clip(squash(out));
}

function directText(node: ts.JsxElement): string {
  return clip(squash(node.children.filter(ts.isJsxText).map((c) => c.text).join(' ')));
}

const NAV_CALLS = new Set(['navigate', 'push', 'replace', 'navigateTo', 'redirect']);
/** Calls that say nothing about what a control does. */
const NOISE_CALLS = new Set(['preventDefault', 'stopPropagation', 'log', 'warn', 'error', 'info', 'debug', 'trim', 'toLowerCase', 'toUpperCase', 'toString', 'includes', 'indexOf', 'some', 'every', 'find', 'findIndex', 'filter', 'map', 'reduce', 'forEach', 'join', 'split', 'slice', 'concat', 'parseInt', 'parseFloat', 'Number', 'String', 'Boolean', 'stringify', 'parse', 'keys', 'values', 'entries', 'assign', 'from', 'isArray', 'test', 'match', 'max', 'min', 'round', 'floor', 'ceil', 'now', 'getTime', 'focus', 'blur']);

/** What an event handler expression calls: a name, and a route when it navigates. */
function handlerOf(e: ts.Expression | undefined): { handler?: string; href?: string } {
  if (!e) return {};
  if (ts.isIdentifier(e)) return { handler: e.text };
  if (ts.isPropertyAccessExpression(e)) return { handler: e.name.text };
  if (ts.isCallExpression(e)) {
    const c = e.expression;
    if (ts.isPropertyAccessExpression(c) && ['bind', 'call', 'apply'].includes(c.name.text)) return handlerOf(c.expression);
    return handlerOf(c);
  }
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    let found: { handler?: string; href?: string } = {};
    const visit = (n: ts.Node): void => {
      if (found.handler) return;
      if (ts.isCallExpression(n)) {
        const c = n.expression;
        const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : undefined;
        if (name && !NOISE_CALLS.has(name)) {
          const arg = n.arguments[0];
          if (NAV_CALLS.has(name) && arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && arg.text.startsWith('/')) {
            found = { handler: name, href: arg.text };
          } else found = { handler: name };
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(e.body);
    return found;
  }
  return {};
}

function enclosingComponent(n: ts.Node): string | undefined {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name && /^[A-Z]/.test(p.name.text)) return p.name.text;
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name) && /^[A-Z]/.test(p.parent.name.text)) return p.parent.name.text;
    if (ts.isClassDeclaration(p) && p.name) return p.name.text;
  }
  return undefined;
}

function tagOf(el: ts.JsxOpeningLikeElement): string {
  return el.tagName.getText();
}

function fieldFromInput(el: ts.JsxOpeningLikeElement, full: ts.Node): Field | null {
  const a = attrMap(el);
  const tag = tagOf(el).toLowerCase();
  const inputType = tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : attrString(a.get('type')) ?? 'text';
  if (['submit', 'button', 'hidden', 'reset', 'image', 'file'].includes(inputType)) return null;
  const rawName = attrString(a.get('name')) ?? attrString(a.get('id')) ?? attrString(a.get('aria-label')) ?? attrString(a.get('placeholder')) ?? '';
  const valueExpr = attrExpr(a.get('value')) ?? attrExpr(a.get('checked'));
  const fromValue = valueExpr && (ts.isIdentifier(valueExpr) ? valueExpr.text : ts.isPropertyAccessExpression(valueExpr) ? valueExpr.name.text : '');
  const name = safeName(rawName || fromValue || inputType);
  if (!name) return null;
  const options = tag === 'select' ? optionsIn(full) : undefined;
  const label = attrString(a.get('aria-label')) ?? attrString(a.get('placeholder')) ?? humanize(rawName || fromValue || name);
  // A select is a choice even when its options are built at runtime.
  const f: Field = { name, label: clip(label, 40), type: tag === 'select' ? 'choice' : slotTypeFor(inputType, name, !!options?.length), inputType };
  if (options?.length) f.options = options;
  if (a.has('required')) f.required = true;
  return f;
}

function optionsIn(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isJsxElement(n) && tagOf(n.openingElement) === 'option') || (ts.isJsxSelfClosingElement(n) && tagOf(n) === 'option')) {
      const open = ts.isJsxElement(n) ? n.openingElement : n;
      const v = attrString(attrMap(open).get('value')) ?? (ts.isJsxElement(n) ? jsxText(n) : '');
      if (v) out.push(v);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return [...new Set(out)].slice(0, 30);
}

function routeComponent(e: ts.Expression | undefined): string | undefined {
  if (!e) return undefined;
  if (ts.isJsxSelfClosingElement(e)) return tagOf(e);
  if (ts.isJsxElement(e)) return tagOf(e.openingElement);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isArrowFunction(e) || ts.isCallExpression(e)) {
    // () => import('./views/Settings.vue') / lazy(() => import('./Settings'))
    let spec: string | undefined;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) spec = n.arguments[0].text;
      ts.forEachChild(n, visit);
    };
    visit(e);
    if (spec) return basename(spec).replace(/\.\w+$/, '');
  }
  return undefined;
}

function scanScript(file: string, text: string, kind = scriptKind(file), lineOffset = 0): Found {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found: Found = { controls: [], routes: [], imports: [], components: [] };
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 + lineOffset;
  const inForm = new Set<ts.Node>();

  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) found.imports.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) found.imports.push(n.arguments[0].text);
    if (ts.isFunctionDeclaration(n) && n.name && /^[A-Z]/.test(n.name.text)) found.components.push(n.name.text);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^[A-Z]/.test(n.name.text) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer) || ts.isCallExpression(n.initializer))) found.components.push(n.name.text);

    // Route objects: { path: '/x', element: <X/> } / { path, component: X }
    if (ts.isObjectLiteralExpression(n)) {
      const props = new Map<string, ts.Expression>();
      for (const p of n.properties) if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) props.set(p.name.text, p.initializer);
      const path = props.get('path');
      if (path && (ts.isStringLiteral(path) || ts.isNoSubstitutionTemplateLiteral(path)) && (props.has('element') || props.has('component') || props.has('Component') || props.has('lazy') || props.has('children'))) {
        const comp = routeComponent(props.get('element') ?? props.get('component') ?? props.get('Component') ?? props.get('lazy'));
        found.routes.push({ path: path.text, file, ...(comp ? { component: comp } : {}) });
      }
    }

    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const el = ts.isJsxElement(n) ? n.openingElement : n;
      const tag = tagOf(el);
      const lower = tag.toLowerCase();
      const a = attrMap(el);
      const base = { file, line: line(el), ...(enclosingComponent(n) ? { component: enclosingComponent(n)! } : {}) } as Omit<Control, 'id' | 'setting' | 'kind' | 'label'>;
      const testId = attrString(a.get('data-testid')) ?? attrString(a.get('data-test')) ?? attrString(a.get('data-cy'));
      if (testId) base.testId = testId;
      const elementId = attrString(a.get('id'));
      if (elementId) base.elementId = elementId;

      if (tag === 'Route' || tag === 'Route.Route') {
        const path = attrString(a.get('path'));
        const comp = routeComponent(attrExpr(a.get('element')) ?? attrExpr(a.get('component')) ?? attrExpr(a.get('Component')));
        if (path) found.routes.push({ path, file, ...(comp ? { component: comp } : {}) });
      } else if (lower === 'form' && ts.isJsxElement(n)) {
        const fields: Field[] = [];
        let submitLabel = '';
        const inner = (c: ts.Node) => {
          if (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) {
            const ce = ts.isJsxElement(c) ? c.openingElement : c;
            const ct = tagOf(ce).toLowerCase();
            if (ct === 'input' || ct === 'textarea' || ct === 'select') {
              inForm.add(ce);
              const f = fieldFromInput(ce, c);
              if (f && !fields.some((x) => x.name === f.name)) fields.push(f);
            }
            if ((ct === 'button' || /button$/i.test(tagOf(ce))) && ts.isJsxElement(c)) {
              const typ = attrString(attrMap(ce).get('type'));
              if (typ === 'submit' || (!typ && !attrMap(ce).has('onClick'))) { submitLabel = jsxText(c); inForm.add(ce); }
            }
          }
          ts.forEachChild(c, inner);
        };
        n.children.forEach(inner);
        const { handler } = handlerOf(attrExpr(a.get('onSubmit')) ?? attrExpr(a.get('action')));
        const label = submitLabel || attrString(a.get('aria-label')) || (handler ? humanize(handler) : 'Form');
        found.controls.push({ ...base, kind: 'form', label, ...(handler ? { handler } : {}), fields });
      } else if (lower === 'input' || lower === 'select' || lower === 'textarea' || /^(switch|toggle|checkbox|slider)$/i.test(tag)) {
        if (!inForm.has(el)) {
          const onChange = attrExpr(a.get('onChange')) ?? attrExpr(a.get('onCheckedChange')) ?? attrExpr(a.get('onValueChange')) ?? attrExpr(a.get('onInput'));
          if (onChange) {
            const f = fieldFromInput(el, n);
            const { handler } = handlerOf(onChange);
            const type = attrString(a.get('type'));
            const kind: ControlKind = lower === 'select' ? 'select' : type === 'checkbox' || /^(switch|toggle|checkbox)$/i.test(tag) ? 'toggle' : 'input';
            const label = attrString(a.get('aria-label')) ?? attrString(a.get('placeholder')) ?? (f ? f.label : humanize(handler ?? tag));
            const c: Omit<Control, 'id' | 'setting'> = { ...base, kind, label: clip(label, 40), ...(handler ? { handler } : {}) };
            if (f?.options) c.options = f.options;
            if (f) { c.fields = [f]; c.name = f.name; c.inputType = f.inputType ?? type ?? kind; }
            found.controls.push(c);
          }
        }
      } else if (lower === 'a' || tag === 'Link' || tag === 'NavLink' || tag === 'RouterLink' || tag === 'router-link') {
        const href = attrString(a.get('href')) ?? attrString(a.get('to'));
        if (href && href.startsWith('/') && !href.startsWith('//')) {
          const label = ts.isJsxElement(n) ? jsxText(n) : attrString(a.get('aria-label')) ?? href;
          found.controls.push({ ...base, kind: 'link', label: label || href, href });
        }
      } else if (lower === 'button' || /button$/i.test(tag) || a.has('onClick')) {
        if (!inForm.has(el)) {
          const { handler, href } = handlerOf(attrExpr(a.get('onClick')));
          const isButton = lower === 'button' || /button$/i.test(tag) || attrString(a.get('role')) === 'button';
          // A clickable container's nested text is its content, not its name.
          const text = ts.isJsxElement(n) ? (isButton ? jsxText(n) : directText(n)) : '';
          const label = attrString(a.get('aria-label')) || text || attrString(a.get('title')) || (handler ? humanize(handler) : '');
          if (label || handler) found.controls.push({ ...base, kind: href ? 'link' : 'button', label: label || humanize(handler!), ...(handler ? { handler } : {}), ...(href ? { href } : {}) });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

// ---- Vue -------------------------------------------------------------------------

const VUE_ATTR = (attrs: string, name: string) => new RegExp(`(?:^|\\s)(?:${name})\\s*=\\s*"([^"]*)"`).exec(attrs)?.[1];

function scanVue(file: string, text: string): Found {
  const script = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(text);
  const found: Found = script
    ? scanScript(file, script[1]!, /lang=["']ts["']/.test(script[0]) ? ts.ScriptKind.TS : ts.ScriptKind.JS, text.slice(0, script.index).split('\n').length - 1)
    : { controls: [], routes: [], imports: [], components: [] };
  const tpl = /<template\b[^>]*>([\s\S]*)<\/template>/i.exec(text);
  if (!tpl) return found;
  const t = tpl[1]!;
  const lineAt = (i: number) => text.slice(0, tpl.index + i).split('\n').length;
  const component = basename(file, '.vue');
  const clean = (s: string) => clip(squash(s.replace(/<[^>]+>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ')));

  for (const m of t.matchAll(/<(button|[A-Z]\w*Button|a|router-link|RouterLink)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const [, tag, attrs = '', inner = ''] = m;
    const click = VUE_ATTR(attrs, '@click(?:\\.\\w+)*|v-on:click');
    const href = VUE_ATTR(attrs, 'to|href');
    const testId = VUE_ATTR(attrs, 'data-testid|data-test|data-cy');
    const label = clean(inner) || VUE_ATTR(attrs, 'aria-label|title') || '';
    const base = { file, line: lineAt(m.index ?? 0), component, ...(testId ? { testId } : {}) };
    if (href && href.startsWith('/')) found.controls.push({ ...base, kind: 'link', label: label || href, href });
    else if (click || /button/i.test(tag!)) {
      const handler = click ? /^\s*([A-Za-z_$][\w$]*)/.exec(click)?.[1] : undefined;
      if (label || handler) found.controls.push({ ...base, kind: 'button', label: label || humanize(handler!), ...(handler ? { handler } : {}) });
    }
  }
  for (const m of t.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    const submit = VUE_ATTR(m[1] ?? '', '@submit(?:\\.\\w+)*|v-on:submit');
    const fields: Field[] = [];
    for (const f of (m[2] ?? '').matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
      const attrs = f[2] ?? '';
      const type = f[1] === 'input' ? VUE_ATTR(attrs, 'type') ?? 'text' : f[1]!;
      if (['submit', 'button', 'hidden'].includes(type)) continue;
      const name = safeName(VUE_ATTR(attrs, 'name|v-model|id|placeholder') ?? type);
      if (name && !fields.some((x) => x.name === name)) fields.push({ name, label: humanize(name), type: slotTypeFor(type, name, false), inputType: type });
    }
    found.controls.push({ file, line: lineAt(m.index ?? 0), component, kind: 'form', label: submit ? humanize(submit) : 'Form', ...(submit ? { handler: submit.replace(/\(.*$/, '') } : {}), fields });
  }
  for (const m of t.matchAll(/<(select|input)\b([^>]*v-model\s*=\s*"([^"]+)"[^>]*)>/g)) {
    if (/<form\b[\s\S]*$/.test(t.slice(0, m.index)) && !/<\/form>[\s\S]*$/.test(t.slice(0, m.index))) continue;
    const name = safeName(m[3]!.split('.').pop()!);
    const type = m[1] === 'select' ? 'select' : VUE_ATTR(m[2] ?? '', 'type') ?? 'text';
    let options: string[] | undefined;
    if (m[1] === 'select') {
      const close = t.indexOf('</select>', m.index);
      options = [...t.slice(m.index, close).matchAll(/<option\b[^>]*value="([^"]+)"/g)].map((o) => o[1]!);
    }
    const field: Field = { name, label: humanize(name), type: slotTypeFor(type, name, !!options?.length), inputType: type, ...(options?.length ? { options } : {}) };
    const handler = `set${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    found.controls.push({ file, line: lineAt(m.index ?? 0), component, kind: type === 'checkbox' ? 'toggle' : m[1] === 'select' ? 'select' : 'input', label: humanize(name), name, handler, inputType: type, fields: [field], ...(options?.length ? { options } : {}) });
  }
  return found;
}

// ---- routes from the file system (Next.js) --------------------------------------

function nextRoute(rel: string, frameworks: string[]): string | null {
  const p = rel.split(sep).join('/');
  if (frameworks.includes('nuxt')) {
    const v = /(?:^|\/)pages\/(.+)\.vue$/.exec(p);
    if (v) return `/${v[1]!.replace(/(^|\/)index$/, '').split('/').filter(Boolean).map((x) => x.replace(/^\[(.+)\]$/, ':$1')).join('/')}`;
  }
  if (!frameworks.includes('next')) return null;
  let m = /(?:^|\/)(?:src\/)?app\/(.*?)\/?page\.(?:t|j)sx?$/.exec(p) ?? (/(?:^|\/)(?:src\/)?app\/page\.(?:t|j)sx?$/.test(p) ? ['', ''] : null);
  if (m) {
    const segs = (m[1] ?? '').split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'));
    return `/${segs.map((s) => s.replace(/^\[\.{3}(.+)\]$/, ':$1*').replace(/^\[(.+)\]$/, ':$1')).join('/')}`;
  }
  m = /(?:^|\/)(?:src\/)?pages\/(.+)\.(?:t|j)sx?$/.exec(p);
  if (m && !/^(_app|_document|_error|api\/)/.test(m[1]!) && !m[1]!.startsWith('api/')) {
    const r = m[1]!.replace(/(^|\/)index$/, '');
    return `/${r.split('/').filter(Boolean).map((s) => s.replace(/^\[(.+)\]$/, ':$1')).join('/')}`;
  }
  return null;
}

// ---- import graph ------------------------------------------------------------------

function resolveImport(from: string, spec: string, known: Set<string>, aliasRoots: string[]): string | null {
  let bases: string[] = [];
  if (spec.startsWith('.')) bases = [resolve(dirname(from), spec)];
  else if (spec.startsWith('@/') || spec.startsWith('~/')) bases = aliasRoots.map((r) => join(r, spec.slice(2)));
  else return null;
  for (const b of bases) {
    // Plain string joins (not path.join) so bundlers do not mistake these for file references.
    for (const cand of [b, ...['.tsx', '.ts', '.jsx', '.js', '.vue', '.mjs'].map((e) => b + e), ...['tsx', 'ts', 'jsx', 'js'].map((e) => `${b}${sep}index.${e}`)]) {
      if (known.has(cand)) return cand;
    }
  }
  return null;
}

function titleFor(path: string, component?: string): string {
  if (path === '/' || path === '') return component ? humanize(component.replace(/(Page|Screen|View|Route)$/, '')) || 'Home' : 'Home';
  const last = path.split('/').filter(Boolean).filter((s) => !s.startsWith(':')).pop();
  return humanize(last ?? component ?? path);
}

function screenId(path: string, taken: Set<string>): string {
  let id = path === '/' ? 'home' : path.replace(/^\//, '').replace(/[:*]/g, '').replace(/\//g, '.').replace(/[^a-zA-Z0-9.-]/g, '') || 'screen';
  while (taken.has(id)) id = `${id}_`;
  taken.add(id);
  return id;
}

function appNameOf(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; productName?: string };
    const n = pkg.productName ?? pkg.name;
    if (n) return humanize(n.replace(/^@[^/]+\//, ''));
  } catch { /* no package.json */ }
  return humanize(basename(resolve(root)));
}

function frameworksOf(pkgFile: string): string[] {
  const out: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) out.push('next');
    if (deps.react) out.push('react');
    if (deps['react-router'] || deps['react-router-dom']) out.push('react-router');
    if (deps.vue) out.push('vue');
    if (deps['vue-router']) out.push('vue-router');
    if (deps.nuxt) out.push('nuxt');
  } catch { /* unreadable */ }
  return out;
}

/** Monorepos: every package.json counts, and each file belongs to its nearest one. */
function detectFrameworks(root: string, files: string[], packages: string[]): { all: string[]; forFile: (f: string) => string[] } {
  const byDir = new Map<string, string[]>();
  for (const p of [join(root, 'package.json'), ...packages]) if (!byDir.has(dirname(p))) byDir.set(dirname(p), frameworksOf(p));
  const all = new Set<string>([...byDir.values()].flat());
  if (files.some((f) => f.endsWith('.vue'))) all.add('vue');
  if (files.some((f) => /\.(t|j)sx$/.test(f))) all.add('react');
  const forFile = (f: string) => {
    for (let d = dirname(f); d.startsWith(root); d = dirname(d)) {
      const fw = byDir.get(d);
      if (fw && fw.length) return fw;
      if (d === root || dirname(d) === d) break;
    }
    return [];
  };
  return { all: [...all], forFile };
}

// ---- main -------------------------------------------------------------------------

export function scanRepo(rootIn: string, options: ScanOptions = {}): ScanResult {
  const root = resolve(rootIn);
  const opts: Required<ScanOptions> = { maxFiles: options.maxFiles ?? 3000, maxFileBytes: options.maxFileBytes ?? 300_000 };
  const { files, packages, skipped, truncated } = walk(root, opts);
  const known = new Set(files);
  const aliasRoots = [join(root, 'src'), root];
  const rel = (f: string) => relative(root, f).split(sep).join('/');

  const perFile = new Map<string, Found>();
  let parseSkipped = 0;
  for (const f of files) {
    let text: string;
    try { text = readFileSync(f, 'utf8'); } catch { parseSkipped++; continue; }
    try { perFile.set(f, f.endsWith('.vue') ? scanVue(f, text) : scanScript(f, text)); } catch { parseSkipped++; }
  }

  // Which file declares which component, for route elements.
  const componentFile = new Map<string, string>();
  for (const [f, r] of perFile) for (const c of r.components) if (!componentFile.has(c)) componentFile.set(c, f);
  for (const f of files) if (f.endsWith('.vue')) componentFile.set(basename(f, '.vue'), f);

  // Screens: file-system routes first (Next), then declared routes.
  const taken = new Set<string>();
  const screens: Screen[] = [];
  const screenFiles = new Map<string, string>(); // file -> screen id
  const addScreen = (path: string, component: string | undefined, file: string | undefined) => {
    const norm = path === '' ? '/' : path.startsWith('/') ? path : `/${path}`;
    if (screens.some((s) => s.path === norm)) return;
    const id = screenId(norm, taken);
    const s: Screen = { id, path: norm, title: titleFor(norm, component) };
    if (component) s.component = component;
    if (file) { s.file = rel(file); screenFiles.set(file, id); }
    screens.push(s);
  };
  const fw = detectFrameworks(root, files, packages);
  const frameworks = fw.all;
  for (const f of files) {
    // Routes are relative to the package that owns the file (monorepos).
    const owner = fw.forFile(f);
    const pkgDir = packages.map(dirname).filter((d) => f.startsWith(d + sep)).sort((a, b) => b.length - a.length)[0] ?? root;
    const r = nextRoute(relative(pkgDir, f), owner);
    if (r !== null) addScreen(r, undefined, f);
  }
  for (const [, r] of perFile) {
    for (const route of r.routes) {
      if (route.path === '*' || route.path === '**' || route.path.includes(':pathMatch')) continue;
      addScreen(route.path, route.component, route.component ? componentFile.get(route.component) : undefined);
    }
  }
  if (screens.length === 0) {
    // No router: every *Page / *Screen / *View component is a screen; else one "App" screen.
    for (const [name, f] of componentFile) if (/(Page|Screen|View)$/.test(name)) addScreen(`/${name.replace(/(Page|Screen|View)$/, '').toLowerCase()}`, name, f);
    if (screens.length === 0) addScreen('/', 'App', undefined);
  }

  // Assign each file to the one screen that reaches it through imports.
  const graph = new Map<string, string[]>();
  for (const [f, r] of perFile) graph.set(f, r.imports.map((s) => resolveImport(f, s, known, aliasRoots)).filter((x): x is string => !!x));
  const owners = new Map<string, Set<string>>();
  for (const [file, sid] of screenFiles) {
    const seen = new Set([file]);
    const queue = [file];
    while (queue.length) {
      const cur = queue.shift()!;
      (owners.get(cur) ?? owners.set(cur, new Set()).get(cur)!).add(sid);
      for (const nx of graph.get(cur) ?? []) if (!seen.has(nx) && !screenFiles.has(nx)) { seen.add(nx); queue.push(nx); }
    }
  }
  const single = screens.length === 1 ? screens[0]!.id : undefined;

  const controls: Control[] = [];
  let n = 0;
  for (const [f, r] of perFile) {
    const ownedBy = screenFiles.get(f) ?? (owners.get(f)?.size === 1 ? [...owners.get(f)!][0] : undefined) ?? single;
    for (const c of r.controls) {
      const fileRel = rel(c.file);
      const words = `${c.label} ${c.handler ?? ''} ${c.name ?? ''} ${(c.fields ?? []).map((x) => x.name).join(' ')}`;
      const place = `${fileRel} ${c.component ?? ''} ${ownedBy ?? ''}`;
      const setting = c.kind !== 'link' && c.kind !== 'button'
        ? SETTINGS_PLACE.test(place) || SETTINGS_WORD.test(humanize(words))
        : SETTINGS_PLACE.test(place) && SETTINGS_WORD.test(humanize(words));
      controls.push({ ...c, id: `c${++n}`, file: fileRel, setting, screen: ownedBy ?? 'shared' });
    }
  }

  return { root, appName: appNameOf(root), frameworks, files: files.length, skipped: skipped + parseSkipped, truncated, screens, controls };
}
