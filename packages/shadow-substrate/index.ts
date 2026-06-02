/**
 * @freeside-worlds/shadow-substrate — the pure, distributed shadow core (the
 * keystone). A universal preview/diff primitive: compute a proposed effect,
 * project a before→after diff, and apply ONLY behind two substrate-enforced
 * gates. ZERO I/O lives here — all I/O is injected as Layers by the consuming
 * lenses. Distributed git-source/SHA-pinned, never npm.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * EXPORTED-SYMBOL TABLE (FR-8 / SDD §4.6) — each symbol marked PURE or EFFECTFUL
 * ────────────────────────────────────────────────────────────────────────────
 * | Export                                   | Kind          | Purity     |
 * |------------------------------------------|---------------|------------|
 * | transition                               | fn            | PURE *     |
 * | computeProposed, diff                    | fn            | PURE       |
 * | roleMapVersionHash                       | fn            | PURE       |
 * | RosterSource, RoleWriter, ScoreSource    | Context.Tag   | (port)     |
 * | WriteCapability                          | branded type  | (cap.)     |
 * | WriteIntentBatch, WriteOp, GoLiveJobState,| type/schema   | (data)    |
 * |   AuthzContext, AuthzDecision, GuardInputs|              |            |
 * | RoleMapConfig, RoleRule, ApplyModeConfig,| schema        | (data)     |
 * |   OnboardingLifecycle, ScaffoldingConfig |               |            |
 * | Discrepancy, ProposedRoster, CurrentRoster| type/schema  | (data)     |
 * | GuardFailed, ShadowGateRejected,         | error ADT     | (data)     |
 * |   WriteError, AuthzError, AuditError,    |               |            |
 * |   RosterError, ScoreError                |               |            |
 * | Hex64, WorldSlug, RoleId, MemberId,      | branded prim. | (data)     |
 * |   ApplyMode, TransitionEvent             |               |            |
 *
 * * `transition` is PURE: an Effect over ALREADY-RESOLVED guard inputs with NO
 *   requirement channel and NO I/O — its only effect is the typed `GuardFailed`
 *   error channel + a defect on structurally-illegal transitions (§4.2).
 *
 * EFFECTFUL programs (`loadCurrentRoster`, `loadLatentCounts`, `resolveAuthz`,
 * `resolveReader`, `GateCheckedRoleWriter`) land in S1/S2 — they REQUIRE Layers.
 * They are intentionally NOT exported by this S0 barrel.
 *
 * DELIBERATE ABSENCES (asserted by a test — SDD §8.4 proof 1):
 *   - NO raw live-writer constructor (the only RoleWriter path is the S1
 *     GateCheckedRoleWriter).
 *   - NO `WriteCapability` CONSTRUCTOR (the branded type is exported for the
 *     LIVE signature; its mint is internal to the S1 go_live LIVE path).
 */

// ─── PURE functions (the keystone compute core, SDD §4.2) ───────────────────
export {
  roleMapVersionHash,
  computeProposed,
  diff,
  transition,
} from './src/pure/index.js';
export type {
  RoleMapVersionInput,
  WorldConfigHashFields,
  ProposedMembership,
  DiffOptions,
  LatentCounts,
} from './src/pure/index.js';

// ─── Ports — Context.Tags (signatures only; Layers supplied by lenses, S4) ──
export { RosterSource, RoleWriter, ScoreSource } from './src/ports/index.js';

// ─── Branded primitives + capability/batch/authz data types ─────────────────
// NOTE: `WriteCapability` is exported as a TYPE only (`export type`); its
// constructor is NOT exported (SDD §4.4.4 / §8.4 proof 1).
export {
  Hex64,
  WorldSlug,
  RoleId,
  MemberId,
  ApplyMode,
  TransitionEvent,
  CreateRoleIntent,
  AssignRoleIntent,
  WriteOpKind,
  WriteOp,
  RosterVersion,
  AuthzContext,
  WriteIntentBatch,
  GoLiveJobStatus,
  GoLiveJobState,
  AuthzDecision,
} from './src/types.js';
export type { WriteCapability, GuardInputs } from './src/types.js';

// ─── Config-surface payload schemas (authored in-package; S2 re-exports) ────
export {
  RoleRule,
  ScaffoldingConfig,
  RoleMapConfig,
  ApplyModeConfig,
  OnboardingStep,
  LinkState,
  OnboardingLifecycle,
} from './src/schemas/config-surfaces.js';

// ─── Render-model (the lens contract, SDD §6.4) ─────────────────────────────
export {
  BeforeRole,
  AfterRole,
  PreexistingRole,
  LatentQualified,
  RoleCountProjection,
  CurrentRoster,
  ProposedRoster,
  Discrepancy,
} from './src/schemas/render-model.js';

// ─── Typed error ADT (SDD §7.1) ─────────────────────────────────────────────
export {
  GuardFailed,
  ShadowGateRejected,
  WriteError,
  AuthzError,
  AuditError,
  RosterError,
  ScoreError,
} from './src/errors.js';
export type { GuardFailureReason, WriteErrorKind, ShadowError } from './src/errors.js';
