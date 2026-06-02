/**
 * auth.ts — the config-service auth seam.
 *
 * ── FR-10 floor (S2, shadow-onboarding-substrate; closes R-3) ───────────────
 * The C-1 any-bearer write stub is GONE. The write/read gates now delegate to
 * the FR-10 authorization floor (fr10-authz.ts): verify the identity token →
 * `claims.sub` → the substrate's ONE authoritative `resolveAuthz` allowlist
 * decision. NO any-bearer write is ever accepted; every PUT requires
 * `claims.sub ∈ world.admin_principals`, and every GET re-checks the same
 * decision (B4 — a revoked admin loses READ too).
 *
 * The READ-gate service token (`checkServiceToken`) is the EXISTING coarse read
 * gate (a shared service token); the FR-10 `resolveReaderAuthz` is the per-actor
 * authority check layered ON TOP for the lifecycle/config surfaces. They are
 * orthogonal: the service token says "this caller may reach the API"; the FR-10
 * read check says "this verified actor is still an admin for this world".
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  resolveWriterAuthz,
  resolveReaderAuthz,
  type Fr10Deps,
  type AuthzResolution,
} from './fr10-authz.js';
import { extractBearer } from './token-verifier.js';
import { isProduction } from './env.js';

export interface Writer {
  /** Actor string written to the append-only audit trail (the verified claims.sub). */
  actor: string;
  /** The substrate authz decision this write is bound to (FR-10 audit / B3). */
  authzDecisionId: string;
}

/**
 * Constant-time string comparison — avoids the timing oracle of `===`/`includes`
 * on a secret.
 *
 * FAGAN iter-3 cleanup: the previous `max(a.length, b.length)` walk made the
 * compare cost proportional to the LONGER input — a timing channel that still
 * leaked the secret's length (a caller could grow `provided` and watch the
 * compare get slower). We close that by DIGESTING both inputs to a fixed 32
 * bytes (SHA-256) FIRST, then comparing the two equal-length digests with
 * `crypto.timingSafeEqual`. The compare is now over a constant 32-byte width
 * regardless of either input's length, so the secret's length cannot be probed
 * via the compare. SHA-256 of distinct inputs differs, so digest-equality still
 * implies (collision-resistant) input-equality. Dependency-light: `node:crypto`
 * is a runtime builtin (Bun-native), no new package.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  // Both digests are exactly 32 bytes — timingSafeEqual's contract (equal-length
  // buffers) holds, and the compare width is independent of the secret length.
  return timingSafeEqual(da, db);
}

/**
 * Read gate (coarse). Returns true if the request may read config. A shared
 * service token (`x-service-token` == env `CONFIG_SERVICE_TOKEN`), compared in
 * CONSTANT TIME (no timing oracle).
 *
 * When `CONFIG_SERVICE_TOKEN` is UNSET:
 *   - in PRODUCTION → FAIL CLOSED (deny reads). A missing read-gate secret in
 *     production is a misconfiguration, not an invitation to open the API.
 *   - outside production → reads are OPEN (dev default) with a loud warning.
 *
 * The per-actor FR-10 read authority is the separate `resolveReaderAuthz` check
 * (below); this is the orthogonal coarse gate.
 */
/** One-shot guard so the dev-default warning is LOUD but not per-request noise. */
let warnedUnsetServiceToken = false;

export function checkServiceToken(req: Request): boolean {
  const expected = process.env.CONFIG_SERVICE_TOKEN;
  if (!expected) {
    if (isProduction()) {
      console.error(
        'CONFIG_SERVICE_TOKEN is UNSET in production — DENYING reads (fail-closed). ' +
          'Set CONFIG_SERVICE_TOKEN to the shared read-gate secret.',
      );
      return false; // fail-closed in prod.
    }
    if (!warnedUnsetServiceToken) {
      warnedUnsetServiceToken = true;
      console.warn(
        'CONFIG_SERVICE_TOKEN is UNSET — reads are OPEN (dev default). ' +
          'This is fail-closed in production.',
      );
    }
    return true; // dev default.
  }
  const provided = req.headers.get('x-service-token');
  if (provided === null) return false;
  return constantTimeEqual(provided, expected);
}

/**
 * FR-10 WRITE gate. Verifies the Bearer identity token and asserts the verified
 * `claims.sub` is in the world's `admin_principals` (delegated to the substrate
 * `resolveAuthz`). Returns the `Writer` (verified actor + decision id) on grant,
 * or `null` → the caller responds 403. The any-bearer path is removed.
 *
 * `bypassCache` is set on the go_live confirm (apply-mode → LIVE) so the
 * highest-risk write is gated on a fresh allowlist read (B6).
 */
export async function resolveWriter(
  req: Request,
  worldSlug: string,
  deps: Fr10Deps,
  opts: { bypassCache?: boolean } = {},
): Promise<Writer | null> {
  const bearer = extractBearer(req.headers.get('authorization'));
  const resolution = await resolveWriterAuthz(bearer, worldSlug, deps, opts);
  if (!resolution) return null;
  return { actor: resolution.actor, authzDecisionId: resolution.authz_decision_id };
}

/**
 * FR-10 READ authority gate (B4). Verifies the Bearer token and re-checks
 * `admin_principals` via the substrate `resolveReader` (the SAME decision flow
 * as the write path), so a now-revoked admin loses READ access within the ≤10s
 * TTL. Returns the resolution (actor + claims) on grant, else `null` → 403.
 *
 * Per-CM isolation (`cm == claims.sub`) is enforced by the CALLER on top of this
 * — that is isolation, not authority.
 */
export async function resolveReaderAuthority(
  req: Request,
  worldSlug: string,
  deps: Fr10Deps,
): Promise<AuthzResolution | null> {
  const bearer = extractBearer(req.headers.get('authorization'));
  return resolveReaderAuthz(bearer, worldSlug, deps);
}
