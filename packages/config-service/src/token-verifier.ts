/**
 * token-verifier.ts — the identity-token verification SEAM (FR-10, SDD §6.2/C3).
 *
 * ── S2 FAGAN iter-2: the LIVE jose JWKS verifier is WIRED ────────────────────
 * Earlier this module shipped a `makeJwksTokenVerifier` THROWING stub behind a
 * production-looking factory; `server.ts` always installed `RejectingTokenVerifier`,
 * so even with a JWKS URL configured every write/authority-read was denied. That
 * was a production-looking factory that silently could not verify. It is GONE.
 *
 * `makeJwksTokenVerifier` now performs REAL verification via `jose`
 * (`createRemoteJWKSet` + `jwtVerify`). It is pure-JS (bun-compatible, no native
 * deps). Construction NEVER throws — it only fails-closed per verify (returns
 * `null`) on ANY verification or network error. The composition root (server.ts)
 * decides production-fail-loud-if-unset; this module just verifies what it is given.
 *
 * ── The FR-10 floor is NON-NEGOTIABLE ───────────────────────────────────────
 * The any-bearer stub is GONE. `resolveWriter`/`resolveReader` (fr10-authz.ts)
 * REQUIRE a verified `claims.sub` AND an `admin_principals` membership check. A
 * token that does not verify yields `null` claims → 403. There is no fail-open
 * path: a verifier error, a network failure to the JWKS endpoint, an expired
 * token, a wrong-key signature, or a `sub`-less token all return `null`.
 */

import {
  createRemoteJWKSet,
  createLocalJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JSONWebKeySet,
} from 'jose';

/** The verified token claims the FR-10 authz flow consumes. */
export interface VerifiedClaims {
  /** identity-api user_id (claims.sub) — the actor for authz + audit. REQUIRED. */
  readonly sub: string;
  /** key id the token was signed with (for AuthzContext.token_metadata). */
  readonly kid: string;
  /** ISO timestamp the token was verified at. */
  readonly verified_at: string;
  /** ISO timestamp the token expires (for AuthzContext.token_metadata). */
  readonly exp: string;
}

/**
 * The token-verification port. `verify` takes the raw Bearer token value (the
 * part AFTER `Bearer `) and returns the verified claims, or `null` if the token
 * is absent/malformed/unverifiable. NEVER throws — an unverifiable token is a
 * `null` return (mapped to 403 upstream), so a verifier failure can never
 * accidentally fail-open.
 */
export interface TokenVerifier {
  verify(rawToken: string): Promise<VerifiedClaims | null>;
}

/**
 * FAIL-CLOSED default verifier — every token is rejected (returns `null`). Used
 * by the composition root OUTSIDE production when no `IDENTITY_JWKS_URL` is set
 * (a loud stderr warning is emitted there). In PRODUCTION, an unset JWKS URL
 * FAILS LOUD at startup instead — see server.ts. This guarantees the FR-10
 * floor: with no verifier configured, NO write is ever authorized (the opposite
 * of the old any-bearer stub, which authorized ALL).
 */
export class RejectingTokenVerifier implements TokenVerifier {
  async verify(_rawToken: string): Promise<VerifiedClaims | null> {
    return null;
  }
}

/**
 * Test/dev verifier backed by a fixed token→claims map. Deterministic: a token
 * present in the map verifies to its claims; anything else returns `null`. Used
 * by the integration tests (403.5) to exercise grant/deny/revocation without a
 * live JWKS endpoint. NOT for production (it trusts a static map, not a signed
 * token) — production uses the LIVE JWKS verifier (`makeJwksTokenVerifier`).
 */
export class MapTokenVerifier implements TokenVerifier {
  private readonly map: ReadonlyMap<string, VerifiedClaims>;
  constructor(entries: Readonly<Record<string, VerifiedClaims>>) {
    this.map = new Map(Object.entries(entries));
  }
  async verify(rawToken: string): Promise<VerifiedClaims | null> {
    return this.map.get(rawToken) ?? null;
  }
}

/**
 * Options for the LIVE jose JWKS verifier.
 *
 * EXACTLY ONE key source is required:
 *   - `jwksUrl`: a remote JWKS endpoint (production — the identity-api JWKS URL,
 *     env-configurable, NEVER hardcoded).
 *   - `localJwks`: an in-memory JWKS (tests — `createLocalJWKSet`, no network).
 */
export interface JwksVerifierOpts {
  readonly jwksUrl?: string;
  readonly localJwks?: JSONWebKeySet;
  /** Expected `iss` claim (optional — checked by jose when set). */
  readonly issuer?: string;
  /** Expected `aud` claim (optional — checked by jose when set). */
  readonly audience?: string;
}

/** The algorithms the identity-api signs with (ES256 primary, RS256 fallback). */
const ALLOWED_ALGS = ['ES256', 'RS256'] as const;

/**
 * LIVE jose JWKS token verifier (FR-10 §6.2). Verifies the identity-api session
 * token's signature against the JWKS, checks `exp`/`iss`/`aud`, extracts
 * `claims.sub`, and returns `VerifiedClaims`. FAIL-CLOSED on EVERY error path:
 * malformed token, bad signature, expired, wrong issuer/audience, network
 * failure to the JWKS endpoint, OR a verified-but-`sub`-less token → `null`.
 *
 * Construction NEVER throws (the dispatch's CRITICAL.2 invariant): we build the
 * key resolver eagerly (it is lazy under the hood — `createRemoteJWKSet` does
 * not fetch until first verify), and any error becomes a per-verify `null`. The
 * production-fail-loud-if-unset decision is the composition root's (server.ts),
 * not this factory's.
 *
 * DEPLOY: set `IDENTITY_JWKS_URL` to the identity-api JWKS endpoint (and
 * optionally `IDENTITY_JWT_ISSUER` / `IDENTITY_JWT_AUDIENCE`); server.ts wires
 * those into this factory.
 */
export function makeJwksTokenVerifier(opts: JwksVerifierOpts): TokenVerifier {
  if (!opts.jwksUrl && !opts.localJwks) {
    // This is a programming error in the composition root, not a per-verify
    // condition — but we STILL do not throw at module scope; the factory's
    // contract is "never throw at construction". server.ts guards the
    // unset-URL case (fail-loud in prod). If somehow both are absent, build a
    // resolver that always rejects (fail-closed), never fail-open.
  }

  let getKey: JWTVerifyGetKey | null = null;
  try {
    if (opts.localJwks) {
      getKey = createLocalJWKSet(opts.localJwks);
    } else if (opts.jwksUrl) {
      getKey = createRemoteJWKSet(new URL(opts.jwksUrl));
    }
  } catch {
    // A malformed jwksUrl (bad URL) must NOT crash construction — fail-closed
    // per verify instead.
    getKey = null;
  }

  return {
    async verify(rawToken: string): Promise<VerifiedClaims | null> {
      if (!getKey) return null; // no key source → fail-closed.
      if (typeof rawToken !== 'string' || rawToken.length === 0) return null;
      try {
        const { payload, protectedHeader } = await jwtVerify(rawToken, getKey, {
          algorithms: [...ALLOWED_ALGS],
          // FR-10 / FAGAN iter-3 MAJOR 3: REQUIRE `exp`. Without this, jose
          // happily verifies a token that carries NO expiration — a
          // non-expiring bearer credential, contradicting the bounded-session
          // floor. `requiredClaims: ['exp']` makes a no-exp token throw (→
          // fail-closed null below).
          requiredClaims: ['exp'],
          ...(opts.issuer ? { issuer: opts.issuer } : {}),
          ...(opts.audience ? { audience: opts.audience } : {}),
        });

        const claims = payload as JWTPayload;
        const sub = claims.sub;
        // `sub` is REQUIRED — a verified-but-sub-less token is rejected (no actor).
        if (typeof sub !== 'string' || sub.length === 0) return null;

        // `exp` is REQUIRED (defense-in-depth behind jose `requiredClaims`): a
        // verified claim must carry a NUMERIC exp. We NEVER return an
        // empty-string exp (the old `: ''` fallback minted a non-expiring
        // VerifiedClaims even when exp was absent/garbage). Absent/non-numeric →
        // fail-closed null.
        if (typeof claims.exp !== 'number') return null;
        const exp = new Date(claims.exp * 1000).toISOString();
        const kid = typeof protectedHeader.kid === 'string' ? protectedHeader.kid : '';

        return {
          sub,
          kid,
          verified_at: new Date().toISOString(),
          exp,
        };
      } catch {
        // ANY verification error (bad signature, expired, wrong iss/aud,
        // network failure to the JWKS endpoint, malformed token) → fail-closed.
        return null;
      }
    },
  };
}

/** Extract the raw Bearer token value from an `Authorization` header, or null. */
export function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return null;
  const token = match[1]!.trim();
  return token.length === 0 ? null : token;
}
