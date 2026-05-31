#!/usr/bin/env bun
/**
 * migrate.ts — minimal forward-only migration runner.
 *
 * Applies every migrations/*.sql in lexical order, tracking applied files in a
 * `_config_migrations` ledger table. Idempotent: re-running skips files already
 * recorded. This is deliberately the SMALLEST runner that works — freeside-worlds
 * has no migration framework today (it's schema/registry only), so C-1 ships its
 * own. If the repo later adopts a shared runner (drizzle-kit, node-pg-migrate),
 * fold this in. See OPEN QUESTION: migration runner.
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun packages/config-adapters/src/migrate.ts
 *
 * ISOLATION INVARIANT (C-1): DATABASE_URL MUST point at freeside-worlds' OWN
 * database — never mibera-db / identity-api spine / a world DB.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../migrations');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required (freeside-worlds OWN database).');
    process.exit(1);
  }

  // `pg` is the only runtime dep this script needs; imported dynamically and
  // typed via the ambient shim (pg-shim.d.ts) so it compiles WITHOUT @types/pg.
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _config_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM _config_migrations WHERE filename = $1', [file]);
      if (applied.rowCount && applied.rowCount > 0) {
        console.log(`= ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _config_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`+ ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log('migrations complete.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
