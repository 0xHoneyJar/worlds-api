/**
 * PgManifestStore integration + the REDEPLOY-SURVIVAL kill-test (L-4).
 * Gated behind PG_TEST_URL — skipped loud when absent so a green run can never
 * imply durable-store coverage. Proves a manifest survives a store re-instantiation
 * (the "redeploy" — a fresh process against the same DB), which the ephemeral
 * FileManifestStore did NOT.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PgManifestStore } from '../src/manifest/store.js';
import type { ManifestRecord } from '../src/manifest/types.js';

const PG_TEST_URL = process.env.PG_TEST_URL;

function rec(orderId: string): ManifestRecord {
  return {
    manifestRef: `manifest_${orderId.slice(0, 8)}`,
    worldSlug: 'azuki',
    chainId: '1',
    contractAddress: '0xed5af388653567af2f388e6224dcc93746104133',
    orderId,
    displayName: 'Azuki',
    contactEmail: 'demo@freeside.test',
    source: 'ordering-service',
    createdAt: new Date().toISOString(),
  };
}

if (!PG_TEST_URL) {
  console.warn('⚠ PgManifestStore tests SKIPPED — set PG_TEST_URL (L-4 durability gate)');
}

describe.skipIf(!PG_TEST_URL)('PgManifestStore (PG_TEST_URL)', () => {
  let pool: { query: (t: string, v?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>; end: () => Promise<void> };
  let store: PgManifestStore;
  const order = `o-${Date.now().toString(36)}`;

  beforeAll(async () => {
    const pg = await import('pg');
    pool = new pg.Pool({ connectionString: PG_TEST_URL }) as never;
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(new URL('../../config-adapters/migrations/0002_manifest_index.sql', import.meta.url), 'utf8');
    await pool.query(sql);
    store = new PgManifestStore(pool as never);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('insert → findByContract / idempotencyKey / listSlugs round-trip', async () => {
    await store.insert(rec(order));
    expect((await store.findByContract('1', '0xed5af388653567af2f388e6224dcc93746104133'))?.worldSlug).toBe('azuki');
    expect((await store.findByIdempotencyKey('1', '0xed5af388653567af2f388e6224dcc93746104133', order))?.orderId).toBe(order);
    expect((await store.listSlugs()).has('azuki')).toBe(true);
  });

  it('insert is idempotent on (chain, contract, order)', async () => {
    await store.insert(rec(order));
    await store.insert(rec(order)); // no throw, no duplicate
    expect((await store.findByIdempotencyKey('1', '0xed5af388653567af2f388e6224dcc93746104133', order))?.orderId).toBe(order);
  });

  it('KILL-TEST: manifest survives a "redeploy" (fresh store, same DB)', async () => {
    const order2 = `${order}-survive`;
    await store.insert(rec(order2));
    // Simulate a redeploy: a brand-new store instance over the same pool/DB.
    const afterRedeploy = new PgManifestStore(pool as never);
    const found = await afterRedeploy.findByIdempotencyKey('1', '0xed5af388653567af2f388e6224dcc93746104133', order2);
    expect(found?.worldSlug).toBe('azuki'); // FileManifestStore would return null here
  });
});
