// Smoke test against your real accounts. Run once the keys are set:
//
//   pnpm --filter @entoli/web smoke           # every check whose keys are present
//   pnpm --filter @entoli/web smoke stripe    # only the named checks
//
// Each check prints PASS, FAIL (with the reason) or SKIP (keys not set). It never
// prints a secret, never charges anything (Stripe is read-only here), and cleans
// up what it creates (the sandbox is stopped). Exit code 1 if anything FAILS.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const only = new Set(process.argv.slice(2));
const results = [];
const env = (k) => process.env[k] || '';
const have = (...ks) => ks.every((k) => env(k));

async function check(name, needs, fn) {
  if (only.size && !only.has(name)) return;
  const missing = needs.filter((k) => !env(k));
  if (missing.length) { results.push(['SKIP', name, `set ${missing.join(', ')}`]); return; }
  try { results.push(['PASS', name, (await fn()) || '']); }
  catch (e) { results.push(['FAIL', name, String(e?.message ?? e).split('\n')[0].slice(0, 300)]); }
}

const need = (cond, msg) => { if (!cond) throw new Error(msg); };

await check('app', ['APP_URL', 'AUTH_SECRET'], async () => {
  need(/^https:\/\//.test(env('APP_URL')), 'APP_URL must be https://…');
  need(env('AUTH_SECRET').length >= 32, 'AUTH_SECRET should be at least 32 characters (openssl rand -base64 32)');
  const r = await fetch(`${env('APP_URL')}/api/health`).catch(() => null);
  need(r?.ok, `${env('APP_URL')}/api/health does not answer: is the project deployed and APP_URL right?`);
  return 'site answers';
});

await check('database', ['DATABASE_URL'], async () => {
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(env('DATABASE_URL'));
  await sql`select 1`;
  const rows = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`.catch(() => null);
  need(rows, 'connected, but the migrations table is missing: run pnpm --filter @entoli/web db:migrate');
  const expected = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')).entries.length;
  need(rows[0].n >= expected, `only ${rows[0].n} of ${expected} migrations applied: run pnpm --filter @entoli/web db:migrate`);
  return `${rows[0].n} migrations applied`;
});

await check('github-oauth', ['AUTH_GITHUB_ID', 'AUTH_GITHUB_SECRET'], async () => {
  // A bad client id/secret pair answers "incorrect_client_credentials"; a good one answers bad_verification_code.
  const r = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ client_id: env('AUTH_GITHUB_ID'), client_secret: env('AUTH_GITHUB_SECRET'), code: 'smoke-test' }) });
  const j = await r.json();
  need(j.error !== 'incorrect_client_credentials', 'GitHub rejects this client id/secret');
  return `credentials accepted (${j.error})`;
});

await check('github-app', ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_SLUG'], async () => {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 30, exp: now + 300, iss: env('GITHUB_APP_ID') })}`;
  const sig = createSign('RSA-SHA256').update(head).sign(env('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n')).toString('base64url');
  const r = await fetch('https://api.github.com/app', { headers: { authorization: `Bearer ${head}.${sig}`, accept: 'application/vnd.github+json', 'user-agent': 'entoli-smoke' } });
  need(r.ok, `GitHub answered ${r.status} for the app JWT (check GITHUB_APP_ID and the private key)`);
  const j = await r.json();
  need(j.slug === env('GITHUB_APP_SLUG'), `the app's slug is "${j.slug}", but GITHUB_APP_SLUG is "${env('GITHUB_APP_SLUG')}"`);
  const p = j.permissions ?? {};
  need(p.contents === 'write' && p.pull_requests === 'write', `needs Contents and Pull requests = write (has contents=${p.contents}, pull_requests=${p.pull_requests})`);
  return `${j.name}: permissions ok`;
});

await check('anthropic', ['ANTHROPIC_API_KEY'], async () => {
  const model = env('ENTOLI_MODEL') || 'claude-opus-5-5';
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Say ok.' }] }) });
  need(r.ok, `Anthropic answered ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return `${model} answers`;
});

await check('stripe', ['STRIPE_SECRET_KEY'], async () => {
  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(env('STRIPE_SECRET_KEY'));
  const live = env('STRIPE_SECRET_KEY').startsWith('sk_live') || env('STRIPE_SECRET_KEY').startsWith('rk_live');
  const keys = ['entoli_l1_monthly', 'entoli_l2_monthly', 'entoli_managed_setup', 'entoli_text_overage', 'entoli_voice_l2'];
  const found = await stripe.prices.list({ lookup_keys: keys, limit: 10 });
  const missing = keys.filter((k) => !found.data.some((p) => p.lookup_key === k));
  need(!missing.length, `missing prices ${missing.join(', ')}: run node scripts/stripe-setup.mjs`);
  const meters = (await stripe.billing.meters.list({ limit: 100 })).data.map((m) => m.event_name);
  for (const m of ['entoli_voice_turns', 'entoli_text_overage']) need(meters.includes(m), `missing meter ${m}: run node scripts/stripe-setup.mjs`);
  need(!env('STRIPE_WEBHOOK_SECRET') || /^whsec_/.test(env('STRIPE_WEBHOOK_SECRET')), 'STRIPE_WEBHOOK_SECRET should start with whsec_');
  const hooks = await stripe.webhookEndpoints.list({ limit: 20 });
  const mine = hooks.data.find((h) => h.url === `${env('APP_URL')}/api/stripe/webhook`);
  return `${live ? 'LIVE' : 'test'} mode, 5 prices and 2 meters found, webhook endpoint ${mine ? `registered (${mine.status})` : 'NOT registered at APP_URL/api/stripe/webhook'}`;
});

await check('openai-realtime', ['OPENAI_API_KEY'], async () => {
  const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', { method: 'POST', headers: { authorization: `Bearer ${env('OPENAI_API_KEY')}`, 'content-type': 'application/json' }, body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 120 }, session: { type: 'realtime', model: env('VOICE_MODEL') || 'gpt-realtime', instructions: 'smoke test' } }) });
  need(r.ok, `OpenAI answered ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const j = await r.json();
  need(typeof j.value === 'string' && j.value.length > 10, 'no short-lived key in the response');
  return 'a short-lived key was minted (audio itself is not tested here)';
});

await check('sandbox', ['SANDBOX_PROVIDER'], async () => {
  need(env('SANDBOX_PROVIDER') === 'vercel', 'only the vercel provider is smoke-tested (local is for development)');
  const { Sandbox } = await import('@vercel/sandbox');
  const creds = have('VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID') ? { token: env('VERCEL_TOKEN'), teamId: env('VERCEL_TEAM_ID'), projectId: env('VERCEL_PROJECT_ID') } : {};
  const sbx = await Sandbox.create({ runtime: 'node22', timeout: 120_000, ...creds });
  try {
    const r = await sbx.runCommand({ cmd: 'node', args: ['-e', 'console.log(6*7)'] });
    need((await r.stdout()).trim() === '42', 'the sandbox ran, but node did not print 42');
    return 'booted, ran node, stopping';
  } finally { await sbx.stop(); }
});

await check('browser', ['BROWSER_WS_ENDPOINT'], async () => {
  const { chromium } = await import('playwright');
  const b = await chromium.connect(env('BROWSER_WS_ENDPOINT'));
  try {
    const page = await b.newPage();
    await page.setContent('<title>smoke</title><h1>ok</h1>');
    need((await page.title()) === 'smoke', 'connected, but the page did not render');
    return 'connected and rendered a page';
  } finally { await b.close(); }
});

await check('cron', ['CRON_SECRET', 'APP_URL'], async () => {
  // Without the secret the route must refuse. (We do not call it WITH the secret: that would report real usage to Stripe.)
  need(env('CRON_SECRET').length >= 16, 'CRON_SECRET should be a long random string');
  const r = await fetch(`${env('APP_URL')}/api/cron/usage`);
  need(r.status === 401, `the cron route answered ${r.status} without the secret (expected 401)`);
  return 'route is up and refuses callers without the secret';
});

const icon = { PASS: '✓', FAIL: '✗', SKIP: '·' };
for (const [s, n, m] of results) console.log(`${icon[s]} ${s.padEnd(4)} ${n.padEnd(16)} ${m}`);
const fail = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.filter((r) => r[0] === 'PASS').length} passed, ${fail} failed, ${results.filter((r) => r[0] === 'SKIP').length} skipped`);
process.exit(fail ? 1 : 0);
