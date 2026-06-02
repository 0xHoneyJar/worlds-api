/**
 * fr10-authz.ts — the FR-10 authorization floor (SDD §1.9/§6.2, C3; closes R-3).
 *
 * THE TWO-PART BOUNDARY (Reconciliation B):
 *   1. TOKEN VERIFICATION (this package's seam) — verify the identity-api token,
 *      extract `claims.sub` (the actor). No verified token → 403. (token-verifier.ts)
 *   2. ALLOWLIST DECISION (the substrate owns it) — delegate to the substrate's
 *      ONE authoritative `resolveAuthz(actor, world)`: actor ∈ admin_principals?
 *      It emits `shadow.authz.decided.v1` and returns an `AuthzDecision` with a
 *      stable `authz_decision_id`. config-service does NOT re-implement the
 *      allowlist decision — it token-verifies and DELEGATES.
 *
 * config-service PROVIDES the two Layers the substrate's `resolveAuthz` requires:
 *   - `AdminAllowlistSource` — reads `world.admin_principals` from the world
 *     manifest, TTL-cached ≤10s (B6). `bypassCache` (go_live confirm) forces a
 *     fresh read.
 *   - `AcvpEmitter` — the decision-audit seam. S2 ships a recording emitter
 *     (confirms locally); the LIVE NATS-backed emitter is an S4/deploy step.
 *
 * THE FLOOR (non-negotiable): NO any-bearer write is ever accepted. Every PUT
 * requires `claims.sub ∈ admin_principals`; every GET re-checks the same
 * decision (B4 — a revoked admin loses READ within the ≤10s TTL, not only WRITE).
 */
import { Effect, Layer } from 'effect';
import {
  resolveAuthz,
  resolveReader,
  AdminAllowlistSource,
  AcvpEmitter,
  AuthzError,
  type AuthzDecision,
  type WorldSlug,
} from '@freeside-worlds/shadow-substrate';
import type { ShadowEvent } from '@freeside-worlds/shadow-substrate';
import { type TokenVerifier, type VerifiedClaims } from './token-verifier.js';

/** The successful resolution: the verified actor + the substrate's decision id. */
export interface AuthzResolution {
  readonly actor: string;
  readonly authz_decision_id: string;
  readonly claims: VerifiedClaims;
}

/**
 * The world-manifest read seam. Yields the `admin_principals` allowlist for a
 * world (SDD §1.9: a deploy-bound manifest field in e.g. purupuru.yaml). The
 * default impl reads from an in-memory map (config-service composition root);
 * the LIVE registry-YAML read is a deploy concern (the registry package owns the
 * manifest parse). Returns `[]` for an unknown world → every actor is denied
 * (fail-closed; no empty-allowlist self-grant).
 */
export interface WorldManifestReader {
  adminPrincipals(world: string): Promise<ReadonlyArray<string>>;
}

/** A static-map manifest reader (tests + the MVP before the registry read wires). */
export class MapWorldManifestReader implements WorldManifestReader {
  private readonly map: ReadonlyMap<string, ReadonlyArray<string>>;
  constructor(entries: Readonly<Record<string, ReadonlyArray<string>>>) {
    this.map = new Map(Object.entries(entries));
  }
  async adminPrincipals(world: string): Promise<ReadonlyArray<string>> {
    return this.map.get(world) ?? [];
  }
}

/**
 * Build the `AdminAllowlistSource` Layer the substrate's `resolveAuthz` requires.
 * Wraps a `WorldManifestReader` with a per-world TTL cache (B6: ttlMs ≤ 10_000).
 * `bypassCache` (the go_live confirm path) forces a fresh manifest read AND
 * refreshes the cache so the revocation window for the highest-risk write is 0.
 */
export function makeAdminAllowlistLayer(
  reader: WorldManifestReader,
  opts: { ttlMs?: number } = {},
): Layer.Layer<AdminAllowlistSource> {
  const ttlMs = Math.min(opts.ttlMs ?? 10_000, 10_000); // B6 DESIGN CALL: ≤10s hard cap.
  const cache = new Map<string, { principals: ReadonlyArray<string>; at: number }>();

  return Layer.succeed(AdminAllowlistSource, {
    adminPrincipals: (world: WorldSlug, callOpts?: { readonly bypassCache?: boolean }) =>
      Effect.tryPromise({
        try: async () => {
          const now = Date.now();
          if (!callOpts?.bypassCache) {
            const hit = cache.get(world);
            if (hit && now - hit.at < ttlMs) return hit.principals;
          }
          const principals = await reader.adminPrincipals(world);
          cache.set(world, { principals, at: now });
          return principals;
        },
        catch: (e) =>
          new AuthzError({
            message: `admin_principals manifest read failed: ${e instanceof Error ? e.message : String(e)}`,
          }),
      }),
  });
}

/**
 * A recording `AcvpEmitter` Layer for the decision audit. S2 confirms locally
 * (the decision is recorded into `sink` so server logs / tests can observe the
 * `shadow.authz.decided.v1` emission). The LIVE NATS+Ed25519 emitter is the
 * S4/deploy step — swapping this Layer is the only change needed there.
 */
export function makeRecordingAuthzEmitterLayer(
  sink?: (event: ShadowEvent) => void,
): Layer.Layer<AcvpEmitter> {
  return Layer.succeed(AcvpEmitter, {
    emitConfirmed: (event: ShadowEvent) =>
      Effect.sync(() => {
        sink?.(event);
      }),
  });
}

/** The bundle of Layers config-service provides to run the substrate authz Effect. */
export interface Fr10Deps {
  readonly verifier: TokenVerifier;
  readonly allowlistLayer: Layer.Layer<AdminAllowlistSource>;
  readonly emitterLayer: Layer.Layer<AcvpEmitter>;
  /** caller-supplied clock for deterministic `evaluated_at` (defaults to Date). */
  readonly now?: () => Date;
}

/**
 * Make an authz-INFRA outage OBSERVABLE while keeping the path FAIL-CLOSED.
 * A thrown `AuthzError` from the substrate flow means the manifest read or the
 * audit-emit failed — an OUTAGE, not a deny decision. Swallowed silently it is
 * indistinguishable from a legitimate 403 and can hide a 403-storm. We log a
 * DISTINCT structured line (`authz.infra_outage`) on a dedicated channel
 * (stderr) so an operator / log-based alert can separate "infra is down" from
 * "this actor was correctly denied". This is a diagnostic signal only — the
 * caller still returns `null` (→ 403). A non-AuthzError (an unexpected bug) is
 * logged too, with `kind: unexpected`, since fail-closed-but-blind is the worst
 * combination.
 */
function logAuthzInfraOutage(
  path: 'read' | 'write',
  world: string,
  actor: string,
  err: unknown,
): void {
  const isAuthzError = err instanceof AuthzError;
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    JSON.stringify({
      level: 'error',
      signal: 'authz.infra_outage',
      kind: isAuthzError ? 'authz_error' : 'unexpected',
      path,
      world,
      actor,
      // FAIL-CLOSED: this outage resolves to a 403, but it is NOT a deny.
      resolved_as: 'fail_closed_403',
      detail: message,
    }),
  );
}

/** Run a substrate authz Effect with config-service's Layers provided. */
function runAuthz(
  deps: Fr10Deps,
  program: Effect.Effect<AuthzDecision, AuthzError, AdminAllowlistSource | AcvpEmitter>,
): Promise<AuthzDecision> {
  return Effect.runPromise(
    program.pipe(Effect.provide(Layer.merge(deps.allowlistLayer, deps.emitterLayer))),
  );
}

/**
 * FR-10 WRITE auth (Reconciliation B). The flow:
 *   verify identity token (jwks/test seam) → claims.sub
 *     → substrate.resolveAuthz(claims.sub, world)   [allowlist DECISION + audit]
 *       → grant ⇒ { actor: claims.sub, authz_decision_id } | deny/error ⇒ null (403)
 *
 * `bypassCache` is set by the go_live confirm path (B6) so the highest-risk
 * write is gated on a FRESH allowlist read, never a cached grant.
 *
 * Returns `null` on ANY of: missing/malformed/unverifiable token, deny, or an
 * authz error — the caller maps `null` to 403. The any-bearer path is GONE.
 */
export async function resolveWriterAuthz(
  rawBearer: string | null,
  world: string,
  deps: Fr10Deps,
  opts: { bypassCache?: boolean } = {},
): Promise<AuthzResolution | null> {
  if (rawBearer === null) return null;
  const claims = await deps.verifier.verify(rawBearer);
  if (!claims) return null; // unverifiable token → 403 (NOT any-bearer).

  const evaluatedAt = (deps.now?.() ?? new Date()).toISOString();
  try {
    const decision = await runAuthz(
      deps,
      resolveAuthz({
        actor: claims.sub,
        world: world as WorldSlug,
        evaluatedAt,
        bypassCache: opts.bypassCache,
      }),
    );
    if (decision.decision !== 'grant') return null; // deny → 403.
    return { actor: decision.actor, authz_decision_id: decision.authz_decision_id, claims };
  } catch (err) {
    // FAIL-CLOSED (still null → 403) BUT make the authz-INFRA outage OBSERVABLE.
    // A manifest-read / audit-emit failure (AuthzError) is NOT a legitimate deny —
    // it is an outage that, swallowed silently, looks identical to a normal 403
    // and can mask a 403-storm. Log it distinctly so an operator can tell an
    // infra outage apart from a real authorization deny.
    logAuthzInfraOutage('write', world, claims.sub, err);
    return null;
  }
}

/**
 * FR-10 READ auth (B4). Wraps the substrate's `resolveReader` (which wraps the
 * SAME `resolveAuthz` decision flow), so a now-revoked admin loses READ access
 * within the ≤10s TTL — not only WRITE. The `cm == claims.sub` per-CM isolation
 * check is the CALLER's job (it is isolation, NOT authority); this is the
 * authority check. Returns the verified actor on grant, else `null` (403).
 */
export async function resolveReaderAuthz(
  rawBearer: string | null,
  world: string,
  deps: Fr10Deps,
): Promise<AuthzResolution | null> {
  if (rawBearer === null) return null;
  const claims = await deps.verifier.verify(rawBearer);
  if (!claims) return null;

  const evaluatedAt = (deps.now?.() ?? new Date()).toISOString();
  try {
    const decision = await runAuthz(
      deps,
      resolveReader({ actor: claims.sub, world: world as WorldSlug, evaluatedAt }),
    );
    if (decision.decision !== 'grant') return null;
    return { actor: decision.actor, authz_decision_id: decision.authz_decision_id, claims };
  } catch (err) {
    // FAIL-CLOSED (still null → 403) BUT make the authz-INFRA outage OBSERVABLE
    // (see resolveWriterAuthz). A swallowed read-path outage is an invisible
    // 403-storm indistinguishable from a legitimate deny.
    logAuthzInfraOutage('read', world, claims.sub, err);
    return null;
  }
}
