/**
 * effectful/resolve-reader.ts — the READ-PATH authz (SDD §6.1/§6.2, B4).
 *
 * `resolveReader` wraps the ONE authoritative `resolveAuthz` so a REVOKED admin
 * loses READ access within the ≤10s TTL — not only write. The `cm == claims.sub`
 * check (per-CM isolation, S2) is necessary but NOT sufficient for ongoing
 * authority; `resolveReader` re-evaluates `admin_principals` exactly as the write
 * path does. Two consumers of one decision function, never two independent
 * checks.
 *
 * S1 ships the substrate-side decision; S2 wires the config-service GET path to
 * call this and 403 on `deny`.
 */
import { Effect } from 'effect';
import type { AuthzError } from '../errors.js';
import type { AuthzDecision } from '../types.js';
import { resolveAuthz, AdminAllowlistSource, type ResolveAuthzInput } from './resolve-authz.js';
import type { AcvpEmitter } from './acvp-emitter.js';

/**
 * The read-path authz decision. Identical decision flow to the write path
 * (`resolveAuthz`); the CALLER maps `decision === "deny"` to a 403 on GET. Read
 * paths use the (≤10s TTL) cached allowlist by default — `bypassCache` is for the
 * go_live write confirm only (B6), so it is omitted here.
 */
export function resolveReader(
  input: Omit<ResolveAuthzInput, 'bypassCache'>,
): Effect.Effect<AuthzDecision, AuthzError, AdminAllowlistSource | AcvpEmitter> {
  return resolveAuthz(input);
}
