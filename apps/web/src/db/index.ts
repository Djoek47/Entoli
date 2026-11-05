/**
 * Database. Production: Postgres over Neon's HTTP driver (DATABASE_URL).
 * Local dev and tests: PGlite, Postgres compiled to WASM, in-process, so the
 * dashboard runs with no account at all. Same schema, same migrations.
 */
import path from 'node:path';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from './schema';

export type DB = PgliteDatabase<typeof schema>;

// Kept on globalThis so Next's dev reloads reuse one PGlite instance.
const g = globalThis as unknown as { __entoliDb?: Promise<DB> | null };
let dbPromise: Promise<DB> | null = g.__entoliDb ?? null;

async function pglite(dataDir?: string): Promise<DB> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  if (dataDir) (await import('node:fs')).mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
  return db;
}

async function neon(url: string): Promise<DB> {
  const { neon } = await import('@neondatabase/serverless');
  const { drizzle } = await import('drizzle-orm/neon-http');
  // The two drivers expose the same query builder; transactions are not used.
  return drizzle(neon(url), { schema }) as unknown as DB;
}

export function getDb(): Promise<DB> {
  if (!dbPromise) {
    const url = process.env.DATABASE_URL;
    if (url) dbPromise = neon(url);
    else if (process.env.NODE_ENV === 'production' && !process.env.ENTOLI_ALLOW_PGLITE) {
      throw new Error('DATABASE_URL is not set. Add a Postgres (Neon) connection string.');
    } else dbPromise = pglite(process.env.PGLITE_DIR ?? path.join(process.cwd(), '.data', 'pglite'));
    g.__entoliDb = dbPromise;
  }
  return dbPromise;
}

/** A fresh in-memory database, for tests. */
export function memoryDb(): Promise<DB> {
  return pglite();
}

export { schema };
