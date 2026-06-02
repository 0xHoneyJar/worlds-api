/**
 * render-model.ts — the lens contract (SDD §6.4). `Discrepancy` is the
 * before/after read-model the web + Discord lenses render. PURE data: produced
 * by the pure `diff`, consumed by voiceless lenses (no logic).
 *
 * The JSON shape is frozen to SDD §6.4 exactly (the conformance fixture asserts
 * it). Two load-bearing refinements:
 *   - D2 `managed` per-role flag — only `managed: true` (Freeside-namespaced)
 *     roles ever carry `created`/added/removed change affordances; pre-existing
 *     / Collab.Land roles render as untouched context, NEVER as "would change".
 *   - D3 `role_count` projection — surfaces the Discord 250-role overage
 *     predictively in the preview.
 */
import { Schema as S } from '@effect/schema';
import { Hex64 } from '../types.js';

/** A role entry in the BEFORE view (current reality). */
export const BeforeRole = S.Struct({
  role_key: S.String,
  members: S.Number,
  /** D2: true for the Freeside-managed set; false for pre-existing roles. */
  managed: S.Boolean,
});
export type BeforeRole = S.Schema.Type<typeof BeforeRole>;

/**
 * A role entry in the AFTER view (proposed). `created: true` marks
 * not-yet-created (managed) roles; the BEFORE view OMITS them (SDD §6.4 / OQ-3).
 * Only `managed: true` roles ever carry `created`.
 */
export const AfterRole = S.Struct({
  role_key: S.String,
  members: S.Number,
  managed: S.Boolean,
  /** present (true) only on not-yet-created managed roles; omitted otherwise. */
  created: S.optional(S.Boolean),
});
export type AfterRole = S.Schema.Type<typeof AfterRole>;

/** A pre-existing (non-managed) role — surfaced as locked context (D2). */
export const PreexistingRole = S.Struct({
  role_key: S.String,
  members: S.Number,
  /** always false — pre-existing roles are never Freeside-managed. */
  managed: S.Literal(false),
});
export type PreexistingRole = S.Schema.Type<typeof PreexistingRole>;

/** Latent qualified members (numbers, MOCKED for MVP — honest `source` flag). */
export const LatentQualified = S.Struct({
  role_key: S.String,
  count: S.Number,
  /** FR-6/§8.5: honest provenance — "MOCK" in the MVP. */
  source: S.Literal('MOCK', 'LIVE'),
});
export type LatentQualified = S.Schema.Type<typeof LatentQualified>;

/** D3: the role-count projection so the lens surfaces the 250-limit overage. */
export const RoleCountProjection = S.Struct({
  existing: S.Number,
  to_create: S.Number,
  projected_total: S.Number,
  /** Discord's hard per-guild ceiling. */
  limit: S.Literal(250),
  /** true ⇒ mirrors the substrate's pre-go_live quota refusal (§4.4.1). */
  exceeds: S.Boolean,
});
export type RoleCountProjection = S.Schema.Type<typeof RoleCountProjection>;

/**
 * The CURRENT roster read-model (the BEFORE; loaded live or mock by the
 * effectful `loadCurrentRoster` in S1+). PURE data the pure `diff` consumes.
 */
export const CurrentRoster = S.Struct({
  world: S.String,
  roles: S.Array(BeforeRole),
});
export type CurrentRoster = S.Schema.Type<typeof CurrentRoster>;

/**
 * The PROPOSED roster read-model (the AFTER; produced by the pure
 * `computeProposed`). Carries the managed/created marking + which roles must be
 * created.
 */
export const ProposedRoster = S.Struct({
  world: S.String,
  roles: S.Array(AfterRole),
  /** the managed roles that must be created (FR-4) — drives `to_create`. */
  to_create: S.Array(S.Struct({ role_key: S.String, display_name: S.String })),
});
export type ProposedRoster = S.Schema.Type<typeof ProposedRoster>;

/**
 * The before/after read-model the lens renders (SDD §6.4). `role_map_hash` binds
 * the report to the map it was computed against (the FR-7 go_live HARD guard).
 */
export const Discrepancy = S.Struct({
  world: S.String,
  role_map_hash: Hex64,
  before: S.Struct({ roles: S.Array(BeforeRole) }),
  after: S.Struct({ roles: S.Array(AfterRole) }),
  /** D2: pre-existing roles surfaced explicitly as locked context. */
  preexisting: S.Struct({ roles: S.Array(PreexistingRole) }),
  latent_qualified: S.Array(LatentQualified),
  /** D3: predictive 250-limit projection. */
  role_count: RoleCountProjection,
  generated_at: S.String,
});
export type Discrepancy = S.Schema.Type<typeof Discrepancy>;
