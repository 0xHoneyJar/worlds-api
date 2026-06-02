#!/usr/bin/env bun
/**
 * server.ts — config service entrypoint.
 *
 * Wires PgConfigStore (freeside-worlds' OWN database) -> ConfigService + the
 * FR-10 authorization deps -> the HTTP handler -> Bun.serve. The production
 * composition root.
 *
 * Env:
 *   DATABASE_URL          freeside-worlds OWN Postgres (ISOLATION: never a
 *                         world DB / identity spine). Required.
 *   PORT                  listen port (default 3000 — matches the world module).
 *   CONFIG_SERVICE_TOKEN  coarse read-gate shared token. In PRODUCTION it is
 *                         REQUIRED (unset -> reads DENIED, fail-closed). Outside
 *                         production an unset token leaves reads OPEN (dev
 *                         default) with a loud warning. See auth.checkServiceToken.
 *   ADMIN_PRINCIPALS_JSON FR-10 allowlist source — a JSON object mapping
 *                         world_slug -> [identity_id,...] (every value an ARRAY
 *                         of non-empty strings). The MVP read path for
 *                         `admin_principals` until the registry-YAML read wires
 *                         (DEPLOY STEP — see WorldManifestReader). Unknown world
 *                         -> [] -> every actor denied (fail-closed). A MALFORMED
 *                         shape FAILS CLOSED (treated as empty -> all writes
 *                         denied) — a non-array value is NEVER passed to the
 *                         allowlist source (substring-authorize hazard).
 *   IDENTITY_JWKS_URL     FR-10 LIVE token verifier — the identity-api JWKS
 *                         endpoint. When set, the real jose JWKS verifier is
 *                         installed. In PRODUCTION an UNSET value FAILS LOUD at
 *                         startup (never a silent 403-storm). Outside production
 *                         unset installs RejectingTokenVerifier (fail-closed)
 *                         with a loud warning.
 *   IDENTITY_JWT_ISSUER   (optional) expected `iss` claim. When set, jose rejects
 *                         a token whose `iss` does not match.
 *   IDENTITY_JWT_AUDIENCE (optional, but RECOMMENDED in production) expected `aud`
 *                         claim. ENFORCED ONLY WHEN SET (jose rejects an `aud`
 *                         mismatch); it is NOT hard-required, because we do not
 *                         assume identity-api session tokens carry a
 *                         config-service-scoped `aud` (hard-requiring it could
 *                         break verification if they don't). DEPLOY-NOTE: if the
 *                         identity-api issues an `aud` claim scoped to this
 *                         service, SET IDENTITY_JWT_AUDIENCE to it in production —
 *                         that closes cross-service token replay (a token minted
 *                         for another audience won't verify here). Confirm the
 *                         token's `aud` shape with identity-api before enabling.
 *   NODE_ENV / CONFIG_SERVICE_ENV  'production' signals the prod fail-loud posture.
 *
 * ── FR-10 DEPLOY STEPS ──────────────────────────────────────────────────────
 *   1. LIVE token verifier: WIRED (jose). Set IDENTITY_JWKS_URL in production.
 *   2. LIVE allowlist: replace the ADMIN_PRINCIPALS_JSON map reader with a
 *      registry-YAML reader (read `admin_principals` from purupuru.yaml etc.).
 *   3. LIVE audit emitter: replace the recording emitter with the NATS+Ed25519
 *      `@0xhoneyjar/events` emitter (S4) so `shadow.authz.decided.v1` is signed.
 *
 * Run: DATABASE_URL=postgres://... IDENTITY_JWKS_URL=https://identity-api/.well-known/jwks.json \
 *      bun packages/config-service/src/server.ts
 */
import { ConfigService } from '@freeside-worlds/config-engine';
import { PgConfigStore, type PgPoolLike } from '@freeside-worlds/config-adapters';
import { makeHandler } from './app.js';
import {
  RejectingTokenVerifier,
  makeJwksTokenVerifier,
  type TokenVerifier,
} from './token-verifier.js';
import {
  MapWorldManifestReader,
  makeAdminAllowlistLayer,
  makeRecordingAuthzEmitterLayer,
  type Fr10Deps,
} from './fr10-authz.js';
import { isProduction } from './env.js';

/**
 * Parse + VALIDATE the ADMIN_PRINCIPALS_JSON env map (MVP read path; deploy step
 * replaces). The shape MUST be `Record<string, string[]>` where every value is
 * an array of non-empty strings. A malformed shape — most dangerously a JSON
 * STRING where an array is expected — FAILS CLOSED (returns `{}` → all writes
 * denied), because the substrate downstream does `principals.includes(actor)`
 * and a STRING's `.includes` is a SUBSTRING match (authorize-by-substring). A
 * non-array value is NEVER passed through.
 */
function loadAllowlistMap(): Record<string, ReadonlyArray<string>> {
  const raw = process.env.ADMIN_PRINCIPALS_JSON;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('ADMIN_PRINCIPALS_JSON is not valid JSON — treating as empty (all writes denied).');
    return {};
  }
  // Top level must be a non-null, non-array object.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(
      'ADMIN_PRINCIPALS_JSON is not an object (Record<string,string[]>) — treating as empty (all writes denied).',
    );
    return {};
  }
  const out: Record<string, ReadonlyArray<string>> = {};
  for (const [world, value] of Object.entries(parsed as Record<string, unknown>)) {
    // Each value MUST be an array of non-empty strings. A bare string (the
    // substring hazard) or any non-array shape fails closed for that world.
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.length > 0)) {
      console.warn(
        `ADMIN_PRINCIPALS_JSON["${world}"] is not an array of non-empty strings — ` +
          'dropping that world (its writes are denied; fail-closed).',
      );
      continue;
    }
    out[world] = value as string[];
  }
  return out;
}

/**
 * Validate the configured `IDENTITY_JWKS_URL` at the COMPOSITION ROOT (FAGAN
 * iter-3, MAJOR 1 + 2). The factory (`makeJwksTokenVerifier`) keeps its
 * no-throw-at-construction contract and fails closed per-verify on a bad URL —
 * but a fail-closed-per-verify verifier is INDISTINGUISHABLE from "every request
 * denied" (a SILENT production 403-storm). So misconfiguration must fail LOUD
 * HERE, where we can throw at startup, not silently degrade at runtime.
 *
 * Two hazards closed:
 *   • MAJOR 1 (MITM → key-forgery): a plaintext `http://` JWKS endpoint lets an
 *     on-path attacker serve their OWN signing keys and forge admin tokens. In
 *     production the URL MUST be `https://` — any other scheme FAILS LOUD.
 *   • MAJOR 2 (malformed → silent 403-storm): the prod fail-loud previously
 *     fired ONLY when the URL was UNSET; a malformed/non-URL value passed the
 *     non-empty check and got swallowed by the factory's `new URL()` try/catch →
 *     an always-`null` verifier. We parse `new URL(...)` HERE so a malformed URL
 *     THROWS at startup (same fail-loud posture as unset).
 *
 * Returns the validated `URL` (its `.href` is fed to the factory). Throws in
 * production on a malformed or non-https URL; outside production it allows
 * `http://` (local dev) with a loud warning and tolerates the throw being
 * surfaced by the caller (it does not silently degrade).
 */
export function validateJwksUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      `IDENTITY_JWKS_URL is not a valid URL (got: ${JSON.stringify(rawUrl)}). ` +
        'A malformed URL would yield an always-null verifier — a SILENT 403-storm ' +
        'where every write/authority-read is denied and misconfig is indistinguishable ' +
        'from "all denied". Set it to the identity-api JWKS endpoint (https://…).',
    );
  }
  if (parsed.protocol !== 'https:') {
    if (isProduction()) {
      throw new Error(
        `IDENTITY_JWKS_URL must be https:// in production (got scheme: ${parsed.protocol}). ` +
          'A plaintext JWKS endpoint lets an on-path attacker serve forged signing keys ' +
          '→ admin-token forgery. Refusing to start.',
      );
    }
    console.warn(
      `IDENTITY_JWKS_URL uses a non-https scheme (${parsed.protocol}) — allowed OUTSIDE ` +
        'production for local dev, but an http:// JWKS endpoint is MITM-forgeable. ' +
        'Production REQUIRES https://.',
    );
  }
  return parsed;
}

/**
 * Resolve the FR-10 token verifier from the environment (composition root).
 *   - IDENTITY_JWKS_URL set + VALID  → the LIVE jose JWKS verifier.
 *   - IDENTITY_JWKS_URL set + invalid/non-https-in-prod → FAIL LOUD (throw) —
 *                              see validateJwksUrl (MAJOR 1 + 2).
 *   - unset in PRODUCTION    → FAIL LOUD (throw). Never a production-looking
 *                              factory that silently can't verify and 403-storms.
 *   - unset outside prod     → RejectingTokenVerifier (fail-closed) + loud warning.
 */
export function resolveTokenVerifier(): TokenVerifier {
  const jwksUrl = process.env.IDENTITY_JWKS_URL;
  if (jwksUrl && jwksUrl.length > 0) {
    // Validate + (in prod) require https BEFORE constructing the verifier. A
    // malformed or non-https URL fails LOUD at startup rather than degrading to
    // an always-null verifier (silent 403-storm) at runtime.
    const validated = validateJwksUrl(jwksUrl);
    return makeJwksTokenVerifier({
      jwksUrl: validated.href,
      issuer: process.env.IDENTITY_JWT_ISSUER || undefined,
      audience: process.env.IDENTITY_JWT_AUDIENCE || undefined,
    });
  }
  if (isProduction()) {
    throw new Error(
      'IDENTITY_JWKS_URL required for FR-10 token verification (production). ' +
        'Set it to the identity-api JWKS endpoint. Refusing to start with no ' +
        'verifier (a silent RejectingTokenVerifier would 403-storm every write/authority-read).',
    );
  }
  console.warn(
    'IDENTITY_JWKS_URL is UNSET — installing RejectingTokenVerifier (fail-closed). ' +
      'EVERY write/authority-read will be 403 until you set IDENTITY_JWKS_URL. ' +
      '(This is the dev/non-production default; production FAILS LOUD instead.)',
  );
  return new RejectingTokenVerifier();
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL required (freeside-worlds OWN database).');
    process.exit(1);
  }

  // `pg` imported dynamically so app.ts / handler tests don't pull it in.
  // Typed via the ambient shim in config-adapters/src/pg-shim.d.ts (no
  // @types/pg dependency). Real `pg.Pool` satisfies PgPoolLike at runtime.
  const pg = await import('pg');
  const pool = new pg.Pool({ connectionString: url }) as unknown as PgPoolLike;

  const store = new PgConfigStore(pool);
  const service = new ConfigService({
    store,
    logger: {
      info: (o, m) => console.log(JSON.stringify({ level: 'info', msg: m, ...((o as object) ?? {}) })),
      warn: (o, m) => console.warn(JSON.stringify({ level: 'warn', msg: m, ...((o as object) ?? {}) })),
      error: (o, m) => console.error(JSON.stringify({ level: 'error', msg: m, ...((o as object) ?? {}) })),
    },
  });

  // FR-10 deps. The token verifier is resolved from IDENTITY_JWKS_URL: the LIVE
  // jose JWKS verifier when set; in PRODUCTION an unset URL has already FAILED
  // LOUD above; outside production it is RejectingTokenVerifier (fail-closed,
  // loud warning). NO any-bearer path exists.
  const fr10: Fr10Deps = {
    verifier: resolveTokenVerifier(),
    allowlistLayer: makeAdminAllowlistLayer(new MapWorldManifestReader(loadAllowlistMap())),
    emitterLayer: makeRecordingAuthzEmitterLayer((e) =>
      console.log(JSON.stringify({ level: 'info', msg: 'authz.decided', event_type: e.event_type, payload: e.payload })),
    ),
  };

  const handle = makeHandler({ service, fr10 });
  const port = Number(process.env.PORT ?? 3000);

  // Bun global — typed via @types/bun in the workspace devDeps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Bun = (globalThis as any).Bun;
  if (!Bun?.serve) {
    console.error('This entrypoint requires the Bun runtime.');
    process.exit(1);
  }

  Bun.serve({ port, fetch: handle });
  console.log(`config-service listening on :${port}`);
}

// Run main() ONLY when this file is the direct entrypoint (`bun server.ts`).
// `import.meta.main` is false when the module is IMPORTED (e.g. by a test that
// exercises validateJwksUrl / resolveTokenVerifier in isolation), so importing
// the composition-root helpers does not boot the server or call process.exit.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
