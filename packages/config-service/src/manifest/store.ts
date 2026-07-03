/**
 * Manifest index store — idempotency + lookup by chain/contract.
 *
 * File-backed JSON index (`.kitchen-manifest-index.json` beside registry worlds/)
 * for persistence across restarts. In-memory implementation for tests.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ManifestRecord } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_PATH = join(__dirname, '../../../registry/.kitchen-manifest-index.json');

interface PersistedIndex {
  records: ManifestRecord[];
}

export class ManifestIndexCorruptError extends Error {
  readonly code = 'manifest_index_corrupt' as const;

  constructor(path: string, cause: unknown) {
    super(`manifest index corrupt at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ManifestIndexCorruptError';
  }
}

export interface ManifestStore {
  findByIdempotencyKey(chainId: string, contractAddress: string, orderId: string): Promise<ManifestRecord | null>;
  findByContract(chainId: string, contractAddress: string): Promise<ManifestRecord | null>;
  listSlugs(): Promise<Set<string>>;
  insert(record: ManifestRecord): Promise<void>;
}

/** Minimal structural pg shape (mirrors config-adapters PgPoolLike — no @types/pg dep). */
export interface PgQueryableLike {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

function idempotencyKey(chainId: string, contractAddress: string, orderId: string): string {
  return `${chainId}:${contractAddress}:${orderId}`;
}

function contractKey(chainId: string, contractAddress: string): string {
  return `${chainId}:${contractAddress}`;
}

export class MemoryManifestStore implements ManifestStore {
  private byIdempotency = new Map<string, ManifestRecord>();
  private byContract = new Map<string, ManifestRecord>();
  private slugs = new Set<string>();

  async findByIdempotencyKey(chainId: string, contractAddress: string, orderId: string): Promise<ManifestRecord | null> {
    return this.byIdempotency.get(idempotencyKey(chainId, contractAddress, orderId)) ?? null;
  }

  async findByContract(chainId: string, contractAddress: string): Promise<ManifestRecord | null> {
    return this.byContract.get(contractKey(chainId, contractAddress)) ?? null;
  }

  async listSlugs(): Promise<Set<string>> {
    return new Set(this.slugs);
  }

  async insert(record: ManifestRecord): Promise<void> {
    this.byIdempotency.set(idempotencyKey(record.chainId, record.contractAddress, record.orderId), record);
    this.byContract.set(contractKey(record.chainId, record.contractAddress), record);
    this.slugs.add(record.worldSlug);
  }
}

export class FileManifestStore extends MemoryManifestStore {
  private readonly records: ManifestRecord[] = [];

  constructor(private indexPath: string) {
    super();
    this.load();
  }

  override async insert(record: ManifestRecord): Promise<void> {
    await super.insert(record);
    this.records.push(record);
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.indexPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.indexPath, 'utf-8')) as PersistedIndex;
      for (const rec of raw.records ?? []) {
        super.insert(rec);
        this.records.push(rec);
      }
    } catch (err) {
      throw new ManifestIndexCorruptError(this.indexPath, err);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.indexPath), { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify({ records: this.records }, null, 2), 'utf-8');
  }
}

/**
 * PgManifestStore — DURABLE manifest index (the persistence fix).
 *
 * FileManifestStore wrote to the container's ephemeral FS (no Railway volume),
 * so every fulfilled order's manifest evaporated on the next redeploy. This
 * store persists to freeside-worlds' OWN Postgres (same DATABASE_URL + migration
 * ledger as PgConfigStore; ISOLATION INVARIANT C-1 unchanged).
 * Table: packages/config-adapters/migrations/0002_manifest_index.sql.
 */
interface ManifestRow {
  manifest_ref: string;
  world_slug: string;
  chain_id: string;
  contract_address: string;
  order_id: string;
  display_name: string;
  contact_email: string;
  source: string;
  created_at: string;
}

function rowToRecord(r: ManifestRow): ManifestRecord {
  return {
    manifestRef: r.manifest_ref,
    worldSlug: r.world_slug,
    chainId: r.chain_id,
    contractAddress: r.contract_address,
    orderId: r.order_id,
    displayName: r.display_name,
    contactEmail: r.contact_email,
    source: r.source,
    createdAt: typeof r.created_at === 'string' ? r.created_at : new Date(r.created_at).toISOString(),
  };
}

export class PgManifestStore implements ManifestStore {
  constructor(private readonly pool: PgQueryableLike) {}

  async findByIdempotencyKey(chainId: string, contractAddress: string, orderId: string): Promise<ManifestRecord | null> {
    const res = await this.pool.query<ManifestRow>(
      `SELECT * FROM manifest_index WHERE chain_id = $1 AND contract_address = $2 AND order_id = $3`,
      [chainId, contractAddress, orderId],
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : null;
  }

  async findByContract(chainId: string, contractAddress: string): Promise<ManifestRecord | null> {
    const res = await this.pool.query<ManifestRow>(
      `SELECT * FROM manifest_index WHERE chain_id = $1 AND contract_address = $2
       ORDER BY created_at ASC LIMIT 1`,
      [chainId, contractAddress],
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : null;
  }

  async listSlugs(): Promise<Set<string>> {
    const res = await this.pool.query<{ world_slug: string }>(`SELECT world_slug FROM manifest_index`);
    return new Set(res.rows.map((r) => r.world_slug));
  }

  async insert(record: ManifestRecord): Promise<void> {
    // Idempotent on (chain, contract, order) — a redelivered create is a no-op,
    // matching the service's idempotency contract.
    await this.pool.query(
      `INSERT INTO manifest_index
         (manifest_ref, world_slug, chain_id, contract_address, order_id, display_name, contact_email, source, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (chain_id, contract_address, order_id) DO NOTHING`,
      [
        record.manifestRef,
        record.worldSlug,
        record.chainId,
        record.contractAddress,
        record.orderId,
        record.displayName,
        record.contactEmail,
        record.source,
        record.createdAt,
      ],
    );
  }
}

/**
 * Factory: DURABLE Postgres store when a pool is supplied (deployed path), else
 * the file-backed store for local/dev, else in-memory for tests. The deployed
 * server MUST pass its pool (server.ts) so manifests survive redeploys.
 */
export function createManifestStore(
  poolOrPath?: PgQueryableLike | string,
): ManifestStore {
  if (poolOrPath && typeof poolOrPath !== 'string') {
    return new PgManifestStore(poolOrPath);
  }
  const indexPath = (typeof poolOrPath === 'string' ? poolOrPath : undefined) ?? process.env.MANIFEST_INDEX_PATH ?? DEFAULT_INDEX_PATH;
  return new FileManifestStore(indexPath);
}

/** Normalize contract address for stable lookup keys. */
export function normalizeContractAddress(address: string): string {
  const trimmed = address.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return trimmed.toLowerCase();
}

/** Build manifest_ref from order_id (stable, no PII). */
export function buildManifestRef(orderId: string): string {
  const frag = orderId.replace(/-/g, '').slice(0, 12);
  return `manifest_${frag}`;
}
