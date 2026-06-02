/**
 * errors.ts — the substrate's typed error ADT (SDD §7.1, fail-loud / NFR-2).
 *
 * Every illegal transition, gate rejection, and port failure fails loud as a
 * typed, tagged error — never a silent `null`/`undefined`. These are
 * `Data.TaggedError` classes so they compose into the Effect error channel and
 * are exhaustively matchable (`Match`/`catchTag`).
 *
 * S0 (this sprint) USES `GuardFailed`, `ShadowGateRejected` in the pure core
 * (`transition`). The remaining errors (`WriteError`, `AuthzError`,
 * `AuditError`, `RosterError`, `ScoreError`) are declared here so the ADT is
 * complete and exported for the EFFECTFUL programs that land in S1/S2/S4 — they
 * are part of the contract the lenses + gated writer type against.
 */
import { Data } from 'effect';

/**
 * The discrete guard-failure reasons (SDD §7.1).
 *
 * - `stale_report`  : go_live report hash ≠ current map hash (FR-7).
 * - `roster_drift`  : go_live roster-freshness re-eval found newly-qualifying
 *                     members > ROSTER_DRIFT_THRESHOLD since report-gen (B1).
 *                     (Resolved at go_live in S1; the reason code is part of the
 *                     S0 contract so consumers can match it.)
 * - `not_authorized`: CM not in the world admin allowlist (FR-10).
 */
export type GuardFailureReason = 'stale_report' | 'roster_drift' | 'not_authorized';

/**
 * A lifecycle `transition` guard failed (FR-7/FR-10/B1). Pure — raised by the
 * pure `transition` over already-resolved guard inputs (it does NO I/O; the
 * authz decision + hashes are resolved by the effectful preflights and passed
 * in — SDD §4.1/§4.2).
 */
export class GuardFailed extends Data.TaggedError('GuardFailed')<{
  readonly reason: GuardFailureReason;
  readonly message: string;
}> {}

/**
 * A RoleWriter write was attempted while `apply_mode == SHADOW` (FR-3). Should
 * never reach a user — it is logged + audited (`shadow.role.rejected.v1`). The
 * existence of this typed rejection (rather than a silent no-op) is what makes
 * "SHADOW ⇒ zero writes" provable from the trace (SDD §4.4.5/§8.4).
 */
export class ShadowGateRejected extends Data.TaggedError('ShadowGateRejected')<{
  readonly world: string;
  readonly message: string;
}> {}

/**
 * A LIVE write failed (SDD §7.1). The `kind` distinguishes the recovery posture:
 * - `rate_limited`      : Discord 429 — TRANSIENT; exponential backoff + jitter,
 *                         bounded retries; NEVER treated as a hard failure /
 *                         does not trigger rollback (CLUSTER 2).
 * - `op_failed`         : a single batch op failed (perms, Discord outage);
 *                         per-op status recorded, batch ends `partial_failure`.
 * - `audit_unavailable` : ACVP intent emit failed BEFORE the write (CLUSTER 4);
 *                         fail-loud — the write does NOT proceed, go-live blocks,
 *                         never an un-audited LIVE write (SKP-005).
 */
export type WriteErrorKind = 'rate_limited' | 'op_failed' | 'audit_unavailable';

export class WriteError extends Data.TaggedError('WriteError')<{
  readonly kind: WriteErrorKind;
  readonly message: string;
}> {}

/**
 * FR-10 authz preflight failed (token invalid / actor not allowlisted /
 * revoked). Resolved by `resolveAuthz` BEFORE `transition` (HC5); surfaced as a
 * 403 to the CM. Effectful path (S2).
 */
export class AuthzError extends Data.TaggedError('AuthzError')<{
  readonly message: string;
}> {}

/**
 * ACVP envelope construction / signing failure (CLUSTER 4). Surfaced; blocks
 * the gated write (write-after-audit). Effectful path (S1).
 */
export class AuditError extends Data.TaggedError('AuditError')<{
  readonly message: string;
}> {}

/** RosterSource read failed (SDD §7.1). Effectful path (S4). */
export class RosterError extends Data.TaggedError('RosterError')<{
  readonly message: string;
}> {}

/** ScoreSource read failed (latent-member numbers, MOCKED). Effectful path. */
export class ScoreError extends Data.TaggedError('ScoreError')<{
  readonly message: string;
}> {}

/** The union of all substrate errors (for exhaustive handling at the seam). */
export type ShadowError =
  | GuardFailed
  | ShadowGateRejected
  | WriteError
  | AuthzError
  | AuditError
  | RosterError
  | ScoreError;
