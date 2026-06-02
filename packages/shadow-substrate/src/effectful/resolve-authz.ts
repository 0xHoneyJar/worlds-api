/**
 * effectful/resolve-authz.ts — the FR-10 authz SERVICE PREFLIGHT (SDD §6.2/§4.2,
 * task 402.5, B3/B4).
 *
 * `resolveAuthz(actor, world)` is EFFECTFUL and runs BEFORE the pure
 * `transition`; its boolean grant/deny feeds `transition` as a guard input —
 * `transition` itself NEVER touches identity-api (HC5). It is the ONE
 * authoritative decision flow that both `resolveWriter` (write path) and
 * `resolveReader` (read path, B4) consume (S2 wires the HTTP surfaces).
 *
 * The admin-allowlist read is a manifest-read SEAM (`AdminAllowlistSource` port)
 * — the concrete read of `purupuru.yaml`'s `admin_principals` is a Layer the
 * consumer supplies (S4). Token verification (identity-api jwks-validator) lands
 * in the S2 config-service; S1 takes the verified `actor` (claims.sub) +
 * token_metadata as inputs and resolves the allowlist decision.
 *
 * Every decision (grant AND deny) emits a CONFIRMED `shadow.authz.decided.v1`
 * event carrying a stable `authz_decision_id`, which is bound into BOTH the
 * minted `WriteCapability` and the batch `AuthzContext` (B3) so a batch cannot
 * be replayed against a different/revoked decision.
 */
import { Context, Effect } from 'effect';
import { jcsCanonicalize, sha256Hex } from '@0xhoneyjar/events';
import { AuthzError } from '../errors.js';
import type { AuthzDecision, WorldSlug } from '../types.js';
import { AcvpEmitter } from './acvp-emitter.js';
import { SHADOW_AUTHZ_DECIDED } from '../events/shadow-events.js';

/**
 * `AdminAllowlistSource` — the manifest-read seam (SDD §1.9/§6.2). Reads the
 * world's `admin_principals` from the deploy-bound world manifest. The concrete
 * Layer (manifest read, TTL-cached ≤10s, S4) is a consumer concern; an
 * in-memory Layer (./resolve-authz.mock.ts) backs tests. `bypassCache` is honored
 * by the concrete Layer for the go_live fresh re-check (B6); the port signature
 * threads it so the seam is honest about it.
 */
export class AdminAllowlistSource extends Context.Tag('shadow/AdminAllowlistSource')<
  AdminAllowlistSource,
  {
    readonly adminPrincipals: (
      world: WorldSlug,
      opts?: { readonly bypassCache?: boolean },
    ) => Effect.Effect<ReadonlyArray<string>, AuthzError>;
  }
>() {}

/** Inputs to `resolveAuthz` — the actor is the already-verified claims.sub. */
export interface ResolveAuthzInput {
  /** identity-api user_id (claims.sub) — token already verified by the caller. */
  readonly actor: string;
  readonly world: WorldSlug;
  /** ISO timestamp the decision is evaluated at (caller-supplied; no clock read). */
  readonly evaluatedAt: string;
  /** B6: bypass the allowlist cache (true at the go_live confirm). */
  readonly bypassCache?: boolean;
}

/**
 * Derive a stable, content-addressed `authz_decision_id` from the decision
 * inputs + outcome. Deterministic (sha256(JCS(...))) so the same decision is
 * referenced by the same id across the capability + the batch binding (B3), and
 * so tests are reproducible. NOT timestamp-only — the timestamp is included so
 * two decisions for the same actor/world at different times get distinct ids.
 */
function deriveDecisionId(
  actor: string,
  world: WorldSlug,
  decision: 'grant' | 'deny',
  evaluatedAt: string,
): string {
  return sha256Hex(
    jcsCanonicalize({ actor, world, decision, evaluated_at: evaluatedAt }),
  );
}

/**
 * The ONE authoritative authz decision flow (B3/B4). EFFECTFUL — requires
 * `AdminAllowlistSource` (the manifest read) + `AcvpEmitter` (the decision
 * audit). Returns a typed `AuthzDecision`; the audit emit is CONFIRMED (a failed
 * confirm surfaces as `AuthzError` so a decision is never silently un-audited).
 */
export function resolveAuthz(
  input: ResolveAuthzInput,
): Effect.Effect<AuthzDecision, AuthzError, AdminAllowlistSource | AcvpEmitter> {
  return Effect.gen(function* () {
    const allowlistSource = yield* AdminAllowlistSource;
    const emitter = yield* AcvpEmitter;

    const principals = yield* allowlistSource.adminPrincipals(input.world, {
      bypassCache: input.bypassCache,
    });

    // INVARIANT (NON-TEMPORAL): this is a pure ALLOWLIST-MEMBERSHIP decision, not
    // a time-windowed one — `evaluatedAt` is recorded for audit / id derivation
    // but NEVER gates membership. The gate's write-boundary re-check (B4) relies
    // on this: a future change making the decision temporal (e.g. expiring a grant
    // by `evaluatedAt`) would silently reopen the mid-flow-revocation guarantee
    // the bypassCache re-resolve provides — keep membership the sole gate.
    const granted = principals.includes(input.actor);
    const decision: 'grant' | 'deny' = granted ? 'grant' : 'deny';
    const reason = granted
      ? 'actor in admin_principals'
      : 'actor not in admin_principals';
    const authz_decision_id = deriveDecisionId(
      input.actor,
      input.world,
      decision,
      input.evaluatedAt,
    );

    // Audit the decision (grant OR deny). CONFIRMED — a failed confirm is an
    // AuthzError (the decision is never silently un-audited).
    yield* emitter
      .emitConfirmed({
        event_type: SHADOW_AUTHZ_DECIDED,
        payload: {
          world: input.world,
          actor: input.actor,
          decision,
          authz_decision_id,
          reason,
        },
      })
      .pipe(
        Effect.mapError(
          (e) => new AuthzError({ message: `authz decision audit failed: ${e.message}` }),
        ),
      );

    return {
      decision,
      authz_decision_id,
      actor: input.actor,
      world: input.world,
      evaluated_at: input.evaluatedAt,
      reason,
    } satisfies AuthzDecision;
  });
}
