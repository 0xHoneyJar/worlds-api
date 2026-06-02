/**
 * jose-verifier.test.ts — the LIVE jose JWKS verifier (S2 FAGAN iter-2, CRITICAL).
 *
 * Proves `makeJwksTokenVerifier` does REAL signature verification and is
 * FAIL-CLOSED on every error path. Uses a locally-generated keypair served as an
 * in-memory JWKS (jose `createLocalJWKSet`) — no network, deterministic.
 *
 *   valid ES256 token        → verifies (claims.sub extracted)
 *   valid RS256 token        → verifies (the fallback alg)
 *   expired token            → null (fail-closed)
 *   wrong-key token          → null (signature mismatch, fail-closed)
 *   sub-less token           → null (no actor, fail-closed)
 *   issuer/audience mismatch → null (fail-closed)
 *   malformed token          → null (fail-closed)
 *   construction never throws (even with a bogus URL)
 */
import { describe, expect, test } from 'bun:test';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JSONWebKeySet,
  type JWK,
  type KeyLike,
} from 'jose';
import { makeJwksTokenVerifier } from '../src/token-verifier.js';

const SUB = 'user-12345';

/** Generate a keypair, return the signer + a JWKS (public) with a fixed kid. */
async function makeKeyMaterial(alg: 'ES256' | 'RS256', kid: string) {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = kid;
  publicJwk.alg = alg;
  publicJwk.use = 'sig';
  const jwks: JSONWebKeySet = { keys: [publicJwk] };
  return { privateKey, jwks, kid, alg };
}

async function sign(
  privateKey: KeyLike,
  alg: string,
  kid: string,
  claims: Record<string, unknown>,
  opts: { exp?: string | number; iss?: string; aud?: string } = {},
): Promise<string> {
  let jwt = new SignJWT(claims).setProtectedHeader({ alg, kid }).setIssuedAt();
  if (opts.exp !== undefined) jwt = jwt.setExpirationTime(opts.exp);
  if (opts.iss) jwt = jwt.setIssuer(opts.iss);
  if (opts.aud) jwt = jwt.setAudience(opts.aud);
  return jwt.sign(privateKey);
}

describe('makeJwksTokenVerifier — LIVE jose verification', () => {
  test('a valid ES256 token verifies and extracts claims.sub', async () => {
    const km = await makeKeyMaterial('ES256', 'svc-es256');
    const v = makeJwksTokenVerifier({ localJwks: km.jwks });
    const token = await sign(km.privateKey, km.alg, km.kid, { sub: SUB }, { exp: '1h' });

    const claims = await v.verify(token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(SUB);
    expect(claims!.kid).toBe('svc-es256');
    expect(typeof claims!.verified_at).toBe('string');
    expect(typeof claims!.exp).toBe('string');
  });

  test('a valid RS256 token verifies (the fallback alg)', async () => {
    const km = await makeKeyMaterial('RS256', 'svc-rs256');
    const v = makeJwksTokenVerifier({ localJwks: km.jwks });
    const token = await sign(km.privateKey, km.alg, km.kid, { sub: SUB }, { exp: '1h' });

    const claims = await v.verify(token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(SUB);
  });

  test('an EXPIRED token → null (fail-closed)', async () => {
    const km = await makeKeyMaterial('ES256', 'svc-es256');
    const v = makeJwksTokenVerifier({ localJwks: km.jwks });
    // Expired one hour ago.
    const token = await sign(km.privateKey, km.alg, km.kid, { sub: SUB }, {
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(await v.verify(token)).toBeNull();
  });

  test('a WRONG-KEY token (signed by a key NOT in the JWKS) → null (fail-closed)', async () => {
    const serving = await makeKeyMaterial('ES256', 'svc-es256');
    const attacker = await makeKeyMaterial('ES256', 'svc-es256'); // same kid, different key.
    const v = makeJwksTokenVerifier({ localJwks: serving.jwks });
    // Signed with the attacker's private key — signature won't verify against the served JWKS.
    const token = await sign(attacker.privateKey, attacker.alg, 'svc-es256', { sub: SUB }, { exp: '1h' });
    expect(await v.verify(token)).toBeNull();
  });

  test('a NO-EXP token (verified signature, no claims.exp) → null (fail-closed, MAJOR 3)', async () => {
    const km = await makeKeyMaterial('ES256', 'svc-es256');
    const v = makeJwksTokenVerifier({ localJwks: km.jwks });
    // Valid signature + sub, but NO expiration set — a non-expiring bearer.
    // jose `requiredClaims: ['exp']` must reject it → null (never a bounded-less
    // credential, never an empty-exp VerifiedClaims).
    const token = await sign(km.privateKey, km.alg, km.kid, { sub: SUB });
    expect(await v.verify(token)).toBeNull();
  });

  test('a SUB-LESS token (verified signature, no claims.sub) → null (fail-closed)', async () => {
    const km = await makeKeyMaterial('ES256', 'svc-es256');
    const v = makeJwksTokenVerifier({ localJwks: km.jwks });
    // Valid signature, valid exp, but NO `sub` — no actor → reject.
    const token = await sign(km.privateKey, km.alg, km.kid, { role: 'admin' }, { exp: '1h' });
    expect(await v.verify(token)).toBeNull();
  });

  test('an ISSUER mismatch → null (fail-closed)', async () => {
    const km = await makeKeyMaterial('ES256', 'svc-es256');
    const v = makeJwksTokenVerifier({ localJwks: km.jwks, issuer: 'https://expected-issuer' });
    const token = await sign(km.privateKey, km.alg, km.kid, { sub: SUB }, {
      exp: '1h',
      iss: 'https://wrong-issuer',
    });
    expect(await v.verify(token)).toBeNull();
  });

  test('an AUDIENCE mismatch → null (fail-closed)', async () => {
    const km = await makeKeyMaterial('ES256', 'svc-es256');
    const v = makeJwksTokenVerifier({ localJwks: km.jwks, audience: 'config-service' });
    const token = await sign(km.privateKey, km.alg, km.kid, { sub: SUB }, {
      exp: '1h',
      aud: 'some-other-service',
    });
    expect(await v.verify(token)).toBeNull();
  });

  test('a MALFORMED token (not a JWT) → null (fail-closed)', async () => {
    const km = await makeKeyMaterial('ES256', 'svc-es256');
    const v = makeJwksTokenVerifier({ localJwks: km.jwks });
    expect(await v.verify('not-a-jwt')).toBeNull();
    expect(await v.verify('')).toBeNull();
    expect(await v.verify('a.b.c')).toBeNull();
  });

  test('construction NEVER throws (even with a bogus jwksUrl); verify fails-closed', async () => {
    // A malformed URL must not crash construction.
    let v: ReturnType<typeof makeJwksTokenVerifier> | null = null;
    expect(() => {
      v = makeJwksTokenVerifier({ jwksUrl: 'not a url' });
    }).not.toThrow();
    expect(v).not.toBeNull();
    // And a verify against a never-fetchable endpoint fails-closed (null).
    expect(await v!.verify('a.b.c')).toBeNull();
  });

  test('a token signed with a DISALLOWED alg (HS256) → null (alg allowlist)', async () => {
    const km = await makeKeyMaterial('ES256', 'svc-es256');
    const v = makeJwksTokenVerifier({ localJwks: km.jwks });
    // HS256 is symmetric and not in the ES256/RS256 allowlist — jose rejects.
    const secret = new TextEncoder().encode('shared-secret-shared-secret-shared');
    const token = await new SignJWT({ sub: SUB })
      .setProtectedHeader({ alg: 'HS256', kid: 'svc-es256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret);
    expect(await v.verify(token)).toBeNull();
  });
});
