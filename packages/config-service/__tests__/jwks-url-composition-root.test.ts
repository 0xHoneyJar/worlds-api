/**
 * jwks-url-composition-root.test.ts — the COMPOSITION-ROOT JWKS URL validation
 * (S2 FAGAN iter-3, MAJOR 1 + MAJOR 2).
 *
 * The factory (`makeJwksTokenVerifier`) keeps its no-throw-at-construction
 * contract (proved in jose-verifier.test.ts). Misconfiguration must fail LOUD at
 * the COMPOSITION ROOT instead of degrading to a silent always-null verifier (a
 * production 403-storm). These tests pin that:
 *
 *   MAJOR 1 — production REQUIRES https:// (a plaintext JWKS is MITM-forgeable):
 *     http://… in prod → startup THROW; https://… → ok; http://… in dev → ok+warn.
 *   MAJOR 2 — a malformed/non-URL value THROWS in prod (and in dev — a bad URL is
 *     never a valid config) rather than passing the non-empty check and being
 *     swallowed by the factory into an always-null verifier.
 *
 * server.ts guards `main()` behind `import.meta.main`, so importing these
 * composition-root helpers does NOT boot the server.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resolveTokenVerifier, validateJwksUrl } from '../src/server.js';

const SAVED = {
  jwks: process.env.IDENTITY_JWKS_URL,
  nodeEnv: process.env.NODE_ENV,
  svcEnv: process.env.CONFIG_SERVICE_ENV,
};

function setProd(on: boolean) {
  if (on) process.env.CONFIG_SERVICE_ENV = 'production';
  else delete process.env.CONFIG_SERVICE_ENV;
  // Keep NODE_ENV out of the picture for these tests (bun sets it to 'test').
  delete process.env.NODE_ENV;
}

afterEach(() => {
  // Restore every env var we touch so tests don't leak posture into each other.
  if (SAVED.jwks === undefined) delete process.env.IDENTITY_JWKS_URL;
  else process.env.IDENTITY_JWKS_URL = SAVED.jwks;
  if (SAVED.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = SAVED.nodeEnv;
  if (SAVED.svcEnv === undefined) delete process.env.CONFIG_SERVICE_ENV;
  else process.env.CONFIG_SERVICE_ENV = SAVED.svcEnv;
});

describe('validateJwksUrl — composition-root URL validation (MAJOR 1 + 2)', () => {
  test('a valid https URL parses + returns the URL', () => {
    setProd(true);
    const u = validateJwksUrl('https://identity-api/.well-known/jwks.json');
    expect(u.protocol).toBe('https:');
    expect(u.href).toContain('identity-api');
  });

  test('MAJOR 1: an http:// URL in PRODUCTION throws (MITM → key-forgery)', () => {
    setProd(true);
    expect(() => validateJwksUrl('http://identity-api/.well-known/jwks.json')).toThrow(/https:\/\/ in production/);
  });

  test('MAJOR 1: an http:// URL OUTSIDE production is allowed (local dev)', () => {
    setProd(false);
    const u = validateJwksUrl('http://localhost:8080/jwks.json');
    expect(u.protocol).toBe('http:');
  });

  test('MAJOR 2: a malformed/non-URL value throws (would be a silent 403-storm)', () => {
    setProd(true);
    expect(() => validateJwksUrl('not a url')).toThrow(/not a valid URL/);
    // Even outside production a bad URL is never valid config.
    setProd(false);
    expect(() => validateJwksUrl('::::')).toThrow(/not a valid URL/);
  });
});

describe('resolveTokenVerifier — fail-loud wiring (MAJOR 1 + 2)', () => {
  test('PRODUCTION + http:// JWKS URL → THROWS at startup', () => {
    setProd(true);
    process.env.IDENTITY_JWKS_URL = 'http://identity-api/jwks.json';
    expect(() => resolveTokenVerifier()).toThrow(/https:\/\/ in production/);
  });

  test('PRODUCTION + malformed JWKS URL → THROWS at startup', () => {
    setProd(true);
    process.env.IDENTITY_JWKS_URL = 'not a url';
    expect(() => resolveTokenVerifier()).toThrow(/not a valid URL/);
  });

  test('PRODUCTION + valid https JWKS URL → constructs a verifier (no throw)', () => {
    setProd(true);
    process.env.IDENTITY_JWKS_URL = 'https://identity-api/.well-known/jwks.json';
    const v = resolveTokenVerifier();
    expect(typeof v.verify).toBe('function');
  });

  test('PRODUCTION + UNSET JWKS URL → THROWS at startup (unchanged fail-loud)', () => {
    setProd(true);
    delete process.env.IDENTITY_JWKS_URL;
    expect(() => resolveTokenVerifier()).toThrow(/IDENTITY_JWKS_URL required/);
  });

  test('NON-PRODUCTION + UNSET JWKS URL → RejectingTokenVerifier (fail-closed, no throw)', async () => {
    setProd(false);
    delete process.env.IDENTITY_JWKS_URL;
    const v = resolveTokenVerifier();
    // Fail-closed: every token rejected.
    expect(await v.verify('a.b.c')).toBeNull();
  });
});
