/**
 * ConfigService — the engine.
 *
 * Ported from Jani's sietch ConfigService
 * (themes/sietch/src/services/config/ConfigService.ts). Keeps the MACHINERY:
 *   - head-pointer O(1) read (getConfig)
 *   - optimistic-locked write (putConfig): read version -> validate ->
 *     append immutable history -> version-guarded head move -> 0-rows = 409
 *   - append-only audit trail (every write inserts a config_record)
 *
 * DROPS the sietch specifics: the threshold/featureGate/roleMap delegated
 * payloads and the SQLite prepared-statement bundle. Instead it is generic
 * over (world_slug, surface) -> validated JSON, talks to a ConfigStore port
 * (no DB import), and validates against the sealed surface-config schema.
 *
 * fail-soft READ: getConfig returns null when no config exists; the caller
 * (HTTP layer / consuming world) uses its own defaults. The engine never
 * invents a default — that's a presentation/consumer decision.
 *
 * fail-closed WRITE: putConfig validates the payload against the sealed schema
 * BEFORE touching the store; invalid -> ConfigValidationError (HTTP 422/400).
 */

import {
  validateSurfacePayload,
  PER_CM_SURFACES,
  type Surface,
  type SurfaceConfigMap,
  type SurfaceConfig,
} from '@freeside-worlds/config-protocol';
import type { ConfigStore, CurrentConfigRow } from './store.js';
import {
  ConfigKeyError,
  ConfigValidationError,
  ConfigVersionConflictError,
} from './errors.js';

/**
 * Is `surface` per-CM (composite-keyed `(world, surface, cm_identity_id)`)? A
 * null/empty/whitespace `cmIdentityId` for such a surface would collapse onto
 * the shared legacy `''` sub-key (defeating B1/SKP-006). The engine fails closed
 * on a missing key for these surfaces — defense-in-depth behind the HTTP guard.
 *
 * FAGAN iter-3 cleanup: this now reads the PROTOCOL-LEVEL `PER_CM_SURFACES` set
 * (config-protocol) — the SAME source the HTTP isolation guard (app.ts) uses —
 * so a future per-CM surface cannot be half-wired (engine-guarded but not
 * HTTP-guarded, or vice-versa). config-engine already depends ONE-WAY on
 * config-protocol (it imports `validateSurfacePayload`/`Surface`), so this adds
 * no new dependency and no circular arrow.
 */
function isPerCmSurface(surface: Surface): boolean {
  return PER_CM_SURFACES.has(surface);
}

/**
 * True when `cmIdentityId` is absent, empty, OR whitespace-only — any of which
 * would let a direct ConfigService caller persist `onboarding-lifecycle` under a
 * blank/garbage composite sub-key, weakening the B1/SKP-006 per-CM isolation
 * invariant. FAGAN iter-3 MAJOR 4: the previous check accepted `'   '` (a
 * whitespace-only key) as PRESENT. We now trim and treat a zero-length trim as
 * missing → fail closed (`ConfigKeyError`). (`null` is handled explicitly so we
 * never call `.trim()` on null.)
 */
function isMissingCmKey(cmIdentityId: string | null): boolean {
  return cmIdentityId === null || cmIdentityId.trim().length === 0;
}

export interface ConfigServiceDeps {
  store: ConfigStore;
  /** Optional structured logger ({ info, warn, error }); defaults to no-op. */
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}

const NOOP_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** What getConfig returns: the full envelope + the version (for the next PUT). */
export interface ReadResult<S extends Surface> {
  envelope: SurfaceConfig<S>;
  version: number;
  updatedAt: string;
}

export interface WriteOk<S extends Surface> {
  envelope: SurfaceConfig<S>;
  version: number;
  recordId: number;
}

export class ConfigService {
  private readonly store: ConfigStore;
  private readonly logger: NonNullable<ConfigServiceDeps['logger']>;

  constructor(deps: ConfigServiceDeps) {
    this.store = deps.store;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  /**
   * O(1) head-pointer read. Returns null when the config has never been set
   * (fail-soft: caller uses defaults). Mirrors sietch getCurrentConfiguration,
   * minus the auto-initialize-with-defaults branch (the engine does NOT invent
   * a row on read — that was a sietch convenience that hides "never configured"
   * from the caller; here 404-on-read is a meaningful signal).
   */
  async getConfig<S extends Surface>(
    worldSlug: string,
    surface: S,
    cmIdentityId: string | null = null,
  ): Promise<ReadResult<S> | null> {
    // FAIL CLOSED at the engine boundary: the per-CM surface REQUIRES a non-null/
    // non-empty cmIdentityId, else the store maps null -> '' and every caller
    // shares one legacy head row (defeats B1/SKP-006 per-CM isolation).
    if (isPerCmSurface(surface) && isMissingCmKey(cmIdentityId)) {
      throw new ConfigKeyError(
        worldSlug,
        surface,
        'onboarding-lifecycle requires a non-empty cmIdentityId (per-CM composite sub-key)',
      );
    }
    const row = await this.store.getCurrent(worldSlug, surface, cmIdentityId);
    if (!row) return null;
    return this.rowToReadResult<S>(row, surface);
  }

  /**
   * Optimistic-locked write. The full port of sietch's update* transaction:
   *
   *   1. validate the payload against the sealed schema (fail-closed).
   *   2. read the current head row (for prev_config + the action discriminator).
   *   3. determine action: CREATE if no row, else UPDATE.
   *   4. delegate to store.applyWrite — which, in ONE transaction, appends the
   *      immutable history row and moves the head pointer with a version guard.
   *   5. store returns null on a 0-row-affected guard -> ConfigVersionConflictError
   *      (HTTP 409).
   *
   * `expectedVersion` is the optimistic-lock token the caller read from a prior
   * GET. On CREATE it is ignored (no row exists yet); the engine passes the
   * sietch-equivalent "no current row" path through to the store.
   */
  async putConfig<S extends Surface>(
    worldSlug: string,
    surface: S,
    config: SurfaceConfigMap[S],
    expectedVersion: number,
    actor: string,
    reason?: string,
    cmIdentityId: string | null = null,
  ): Promise<WriteOk<S>> {
    // 0. FAIL CLOSED at the engine boundary: the per-CM surface REQUIRES a
    // non-null/non-empty cmIdentityId (else the store collapses to the shared
    // '' key — defeats B1/SKP-006). Defense-in-depth behind the HTTP guard.
    if (isPerCmSurface(surface) && isMissingCmKey(cmIdentityId)) {
      throw new ConfigKeyError(
        worldSlug,
        surface,
        'onboarding-lifecycle requires a non-empty cmIdentityId (per-CM composite sub-key)',
      );
    }

    // 1. fail-closed validation BEFORE any store mutation.
    const validation = validateSurfacePayload<S>(worldSlug, surface, config);
    if (!validation.ok) {
      this.logger.warn(
        { worldSlug, surface, issues: validation.errors },
        'config validation failed',
      );
      throw new ConfigValidationError(
        worldSlug,
        surface,
        validation.errors.map((e) => ({ instancePath: e.instancePath, message: e.message })),
      );
    }

    // 2. read current head (prev_config + action) — per-CM for onboarding-lifecycle.
    const current = await this.store.getCurrent(worldSlug, surface, cmIdentityId);
    const isCreate = current === null;

    // On UPDATE, the caller's expectedVersion must match the head before we
    // even try the guarded write — but we still let the store's version-guard
    // be the AUTHORITATIVE check (defends the read->write race). The early
    // check here gives a fast, accurate conflict when versions plainly differ.
    if (!isCreate && current!.version !== expectedVersion) {
      throw new ConfigVersionConflictError(
        worldSlug,
        surface,
        expectedVersion,
        current!.version,
      );
    }

    // 3 + 4. transactional append + version-guarded head move.
    const result = await this.store.applyWrite({
      worldSlug,
      surface,
      cmIdentityId,
      expectedVersion: isCreate ? null : expectedVersion,
      action: isCreate ? 'CREATE' : 'UPDATE',
      prevConfig: isCreate ? null : current!.config,
      newConfig: config,
      actor,
      reason,
    });

    // 5. null => optimistic-lock conflict (0 rows affected on the guard, or a
    // CREATE race where the row appeared between our read and insert).
    if (result === null) {
      const latest = await this.store.getCurrent(worldSlug, surface, cmIdentityId);
      throw new ConfigVersionConflictError(
        worldSlug,
        surface,
        expectedVersion,
        latest ? latest.version : null,
      );
    }

    this.logger.info(
      { worldSlug, surface, actor, action: isCreate ? 'CREATE' : 'UPDATE', version: result.newVersion },
      'config written',
    );

    return {
      envelope: {
        schema_version: '1.0',
        world_slug: worldSlug,
        surface,
        config,
      } as SurfaceConfig<S>,
      version: result.newVersion,
      recordId: result.recordId,
    };
  }

  private rowToReadResult<S extends Surface>(
    row: CurrentConfigRow,
    surface: S,
  ): ReadResult<S> {
    return {
      envelope: {
        schema_version: '1.0',
        world_slug: row.worldSlug,
        surface,
        config: row.config as SurfaceConfigMap[S],
      } as SurfaceConfig<S>,
      version: row.version,
      updatedAt: row.updatedAt,
    };
  }
}
