/**
 * Config engine errors — ported from Jani's sietch ConfigService error model
 * (themes/sietch/src/services/config/ConfigService.ts: ConfigNotFoundError,
 * OptimisticLockError). Renamed/regeneralized for the (world_slug, surface)
 * key and the V1 verify-message surface.
 */

export class ConfigNotFoundError extends Error {
  readonly worldSlug: string;
  readonly surface: string;
  constructor(worldSlug: string, surface: string) {
    super(`Config not found for ${worldSlug}/${surface}`);
    this.name = 'ConfigNotFoundError';
    this.worldSlug = worldSlug;
    this.surface = surface;
  }
}

/**
 * Optimistic-lock conflict. Maps to HTTP 409 ConfigVersionConflict.
 * Direct port of sietch's OptimisticLockError — thrown when the head-pointer
 * UPDATE ... WHERE version = expected affects 0 rows.
 */
export class ConfigVersionConflictError extends Error {
  readonly worldSlug: string;
  readonly surface: string;
  readonly expected: number;
  readonly actual: number | null;
  constructor(worldSlug: string, surface: string, expected: number, actual: number | null) {
    super(
      `Version conflict for ${worldSlug}/${surface}: expected ${expected}, got ${actual ?? 'unknown'}`,
    );
    this.name = 'ConfigVersionConflictError';
    this.worldSlug = worldSlug;
    this.surface = surface;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Thrown when a composite-key invariant is violated at the ENGINE boundary —
 * specifically the per-CM surface (`onboarding-lifecycle`) being called with a
 * null/empty `cmIdentityId`. The store maps `null -> ''`, so accepting a null
 * key would collapse every such call onto ONE shared legacy head row, defeating
 * the B1/SKP-006 per-CM isolation for any DIRECT ConfigService caller (the HTTP
 * layer guards this too; this is defense-in-depth at the engine). Maps to HTTP
 * 400 (bad request — the caller MUST supply the per-CM sub-key).
 */
export class ConfigKeyError extends Error {
  readonly worldSlug: string;
  readonly surface: string;
  constructor(worldSlug: string, surface: string, detail: string) {
    super(`Config key error for ${worldSlug}/${surface}: ${detail}`);
    this.name = 'ConfigKeyError';
    this.worldSlug = worldSlug;
    this.surface = surface;
  }
}

/** Thrown when an incoming config payload fails sealed-schema validation. */
export class ConfigValidationError extends Error {
  readonly issues: { instancePath: string; message: string }[];
  constructor(worldSlug: string, surface: string, issues: { instancePath: string; message: string }[]) {
    super(`Config validation failed for ${worldSlug}/${surface}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}
