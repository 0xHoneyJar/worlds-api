/**
 * types.ts — branded primitives + the capability/batch/authz data types.
 *
 * These are the load-bearing shapes the substrate's pure core and the (S1+)
 * effectful gated writer type against. `WriteCapability` in particular is a
 * COMPILE-TIME accident-prevention seam — see the honesty reframe below.
 */
import { Schema as S } from '@effect/schema';

// ─── Branded primitives ────────────────────────────────────────────────────

/**
 * 64-char lowercase-hex sha256 digest (the `roleMapVersionHash` output + the
 * roster fingerprint). Branded so a raw `string` cannot be passed where a hash
 * is required.
 */
export const Hex64 = S.String.pipe(
  S.pattern(/^[0-9a-f]{64}$/),
  S.brand('Hex64'),
);
export type Hex64 = S.Schema.Type<typeof Hex64>;

/**
 * A world slug — references the world-manifest's `slug`
 * (`^[a-z][a-z0-9-]{1,20}$`, matching config-protocol's WORLD_SLUG_PATTERN).
 */
export const WorldSlug = S.String.pipe(
  S.pattern(/^[a-z][a-z0-9-]{1,20}$/),
  S.brand('WorldSlug'),
);
export type WorldSlug = S.Schema.Type<typeof WorldSlug>;

/** A Discord role snowflake id (opaque string; branded). */
export const RoleId = S.String.pipe(S.minLength(1), S.brand('RoleId'));
export type RoleId = S.Schema.Type<typeof RoleId>;

/** A Discord member snowflake id (opaque string; branded). */
export const MemberId = S.String.pipe(S.minLength(1), S.brand('MemberId'));
export type MemberId = S.Schema.Type<typeof MemberId>;

// ─── apply_mode — the single safety-bearing state (SDD §4.1) ─────────────────

export const ApplyMode = S.Literal('SHADOW', 'LIVE');
export type ApplyMode = S.Schema.Type<typeof ApplyMode>;

/** The finite lifecycle event set (SDD §4.1). */
export const TransitionEvent = S.Literal(
  'install',
  'bind_map',
  'go_live',
  'rollback',
  'uninstall',
);
export type TransitionEvent = S.Schema.Type<typeof TransitionEvent>;

// ─── WriteCapability — COMPILE-TIME accident-prevention seam (SDD §4.4.4) ────

declare const __writeCapabilityBrand: unique symbol;

/**
 * `WriteCapability` is a COMPILE-TIME accident-prevention constraint — NOT a
 * runtime security primitive (sprint-flatline B9 honesty reframe, SDD §4.4.4).
 *
 * It stops an honest developer from forgetting the gate: the LIVE `RoleWriter`
 * signature requires a `WriteCapability` argument, so a raw write written by
 * mistake will not type-check. But the branded type is a module-boundary
 * convention, not an unforgeable secret: any code in the same process can in
 * principle bypass it (prototype manipulation, bundler aliasing, dynamic
 * import, a hand-rolled object cast).
 *
 * THE REAL SECURITY BOUNDARY is the substrate-side `GateCheckedRoleWriter`
 * (S1): invocation-time `Ref<ApplyMode>` read + `AuthzContext` validation
 * (server-enforced authz against `admin_principals`) + write-after-audit. The
 * capability *prevents accidents*; the gate + server-side authz + the confirmed
 * audit trail *enforce* the invariant.
 *
 * The constructor is deliberately NOT exported (it is minted only inside the
 * substrate's go_live LIVE path, S1). That absence is asserted by a test
 * (SDD §8.4 proof 1) — it is accident-prevention coverage, NOT a substitute for
 * testing the gate.
 */
export type WriteCapability = {
  readonly [__writeCapabilityBrand]: 'shadow/WriteCapability';
  readonly report_hash: Hex64;
  readonly transition_version: number;
  /** B3: the exact `resolveAuthz` decision this capability is bound to. */
  readonly authz_decision_id: string;
};

// ─── Write-intent batch model (SDD §4.4.1) — data shapes only in S0 ──────────

export const CreateRoleIntent = S.Struct({
  role_key: S.String,
  display_name: S.String,
});
export type CreateRoleIntent = S.Schema.Type<typeof CreateRoleIntent>;

export const AssignRoleIntent = S.Struct({
  role_key: S.String,
  member_id: MemberId,
});
export type AssignRoleIntent = S.Schema.Type<typeof AssignRoleIntent>;

export const WriteOpKind = S.Literal('create_role', 'assign_role');
export type WriteOpKind = S.Schema.Type<typeof WriteOpKind>;

export const WriteOp = S.Struct({
  /** STABLE per logical op (deterministic from {kind, role_key, member_id}). */
  op_id: S.String,
  /** = sha256(JCS({world, op_id, report_hash})) — safe to retry. */
  idempotency_key: Hex64,
  kind: WriteOpKind,
  intent: S.Union(CreateRoleIntent, AssignRoleIntent),
});
export type WriteOp = S.Schema.Type<typeof WriteOp>;

/**
 * Roster-freshness fingerprint (SDD §3.3/§6.2, B1). NON-timestamped fingerprint
 * + base count, carried in `AuthzContext` so go_live can re-eval drift. The
 * `fetched_at` is for staleness display only and is NEVER part of the
 * `roleMapVersionHash` (folding it in would flap the rules-hash guard).
 */
export const RosterVersion = S.Struct({
  fingerprint: Hex64,
  fetched_at: S.String,
  member_count: S.Number,
});
export type RosterVersion = S.Schema.Type<typeof RosterVersion>;

/**
 * The write-batch authz binding (SDD §6.2 — confused-deputy guard + B1/B3).
 * Validated current + hash-matched + decision-id-matched before any write.
 */
export const AuthzContext = S.Struct({
  /** identity-api user_id (claims.sub). */
  actor: S.String,
  world: WorldSlug,
  /** MUST match the go_live transition + current map hash. */
  report_hash: Hex64,
  token_metadata: S.Struct({
    kid: S.String,
    verified_at: S.String,
    exp: S.String,
  }),
  /** Ties the batch to ONE authorized SHADOW→LIVE transition. */
  transition_version: S.Number,
  /** B3: the exact resolveAuthz decision; must match the WriteCapability's. */
  authz_decision_id: S.String,
  /** B1: roster-freshness — the rules-only report_hash does NOT catch drift. */
  roster_version: RosterVersion,
});
export type AuthzContext = S.Schema.Type<typeof AuthzContext>;

export const WriteIntentBatch = S.Struct({
  world: WorldSlug,
  report_hash: Hex64,
  authz: AuthzContext,
  ops: S.Array(WriteOp),
  /** intra-batch in-flight cap (default 4); does NOT prevent cross-batch races. */
  max_concurrent: S.Number,
});
export type WriteIntentBatch = S.Schema.Type<typeof WriteIntentBatch>;

export const GoLiveJobStatus = S.Literal(
  'queued',
  'running',
  'done',
  'partial_failure',
  'failed',
);
export type GoLiveJobStatus = S.Schema.Type<typeof GoLiveJobStatus>;

/**
 * Persisted on the per-CM onboarding-lifecycle record (SDD §3.2/§4.4.1). The
 * idempotent `roles_created` ledger lets a crashed/retried job never
 * double-create.
 */
export const GoLiveJobState = S.Struct({
  job_id: S.String,
  status: GoLiveJobStatus,
  progress: S.Struct({
    total: S.Number,
    completed: S.Number,
    failed: S.Number,
  }),
  roles_created: S.Array(
    S.Struct({ role_key: S.String, role_id: RoleId, op_id: S.String }),
  ),
  op_status: S.Array(
    S.Struct({
      op_id: S.String,
      status: S.Literal('pending', 'ok', 'failed'),
      error: S.optional(S.String),
    }),
  ),
});
export type GoLiveJobState = S.Schema.Type<typeof GoLiveJobState>;

// ─── Authz decision (resolveAuthz output — effectful in S2) ──────────────────

export const AuthzDecision = S.Struct({
  decision: S.Literal('grant', 'deny'),
  authz_decision_id: S.String,
  actor: S.String,
  world: WorldSlug,
  evaluated_at: S.String,
  reason: S.String,
});
export type AuthzDecision = S.Schema.Type<typeof AuthzDecision>;

/**
 * Already-resolved inputs handed to the PURE `transition` (SDD §4.1/§4.2). The
 * function does NO I/O — the report hash, current map hash, and authz decision
 * are resolved by the effectful preflights and passed in.
 */
export interface GuardInputs {
  /** The report's `role_map_hash` (the hash the report was computed against). */
  readonly report_hash: Hex64;
  /** `roleMapVersionHash(current_map)` — re-derived fresh at go_live time. */
  readonly current_map_hash: Hex64;
  /**
   * The resolved authz decision (FR-10). `true` = CM authorized for this world.
   * Resolved by `resolveAuthz` (effectful preflight), NEVER fetched in
   * `transition` (HC5).
   */
  readonly authz_decision: boolean;
  /**
   * SOFT 2-week-soak advisory (FR-7) — surfaced, NEVER a GuardFailed. When
   * `false`, the transition still succeeds; the lens surfaces the advisory.
   */
  readonly soak_satisfied?: boolean;
}
