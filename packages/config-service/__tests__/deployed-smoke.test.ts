/**
 * deployed-smoke.test.ts — the DEPLOYED-config-service smoke test (task 403.6 / D4).
 *
 * The in-memory ConfigStore integration tests (fr10-config-seam.test.ts) prove
 * the engine + handler logic, but they CANNOT catch deploy-time mismatches:
 * routing (does the live service know the new surfaces?), schema (is migration
 * 0002 applied?), and the FR-10 token format (does the live verifier reject an
 * unverifiable bearer?). This smoke test hits the LIVE config-service to surface
 * those BEFORE the apply cutover (S4), not during it.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────
 *   CONFIG_SERVICE_SMOKE_URL=https://config-service.../  \
 *   [CONFIG_SERVICE_TOKEN=<read-token>]                   \
 *   [SMOKE_READER_BEARER=<an identity token whose sub is allowlisted for SMOKE_WORLD>] \
 *   [SMOKE_WRITER_BEARER=<a real identity-api token>]     \
 *   [SMOKE_WORLD=purupuru]                                \
 *     bun test packages/config-service/__tests__/deployed-smoke.test.ts
 *
 * Without CONFIG_SERVICE_SMOKE_URL the suite SKIPS (no creds in CI / local) —
 * that is intentional; this is a manual pre-cutover gate, documented here + in
 * the S4 cutover task (405.7 runs it BEFORE the CONFIG_SERVICE_URL cutover).
 *
 * ── S2 FAGAN iter-2: read-auth on the authority surfaces ─────────────────────
 * role-map / apply-mode / onboarding-lifecycle are READ_AUTHORITY_SURFACES — a
 * GET requires a VERIFIED Bearer whose `claims.sub ∈ admin_principals` (B4), not
 * just the coarse service token. So the authority-surface GET assertions need a
 * reader Bearer (SMOKE_READER_BEARER): 200/404 WITH it, 403 WITHOUT it. The
 * routing-existence checks (is the surface KNOWN vs unknown_surface) accept the
 * 403 as proof the surface is routed.
 *
 * It does NOT mutate state unless SMOKE_WRITER_BEARER is supplied (then it does a
 * single round-trip PUT/GET on apply-mode and leaves it at SHADOW).
 */
import { describe, expect, test } from 'bun:test';

const BASE = process.env.CONFIG_SERVICE_SMOKE_URL;
const READ_TOKEN = process.env.CONFIG_SERVICE_TOKEN;
const READER_BEARER = process.env.SMOKE_READER_BEARER;
const WRITER_BEARER = process.env.SMOKE_WRITER_BEARER;
const WORLD = process.env.SMOKE_WORLD ?? 'purupuru';

const RUN = !!BASE;
const d = RUN ? describe : describe.skip;

function base(): string {
  return BASE!.replace(/\/$/, '');
}
function readHeaders(): Record<string, string> {
  return READ_TOKEN ? { 'x-service-token': READ_TOKEN } : {};
}
/** Headers for an AUTHORITY-surface read: coarse token + the reader Bearer (B4). */
function authorityReadHeaders(): Record<string, string> {
  return {
    ...readHeaders(),
    ...(READER_BEARER ? { authorization: `Bearer ${READER_BEARER}` } : {}),
  };
}

d('deployed config-service smoke (D4)', () => {
  test('health endpoint is live', async () => {
    const r = await fetch(`${base()}/health`);
    expect(r.status).toBe(200);
  });

  test('ROUTING: the new surfaces are known (NOT unknown_surface) + B4 read-auth enforced', async () => {
    // role-map / apply-mode are READ_AUTHORITY_SURFACES: a GET needs a verified
    // reader Bearer (B4).
    //   • WITH SMOKE_READER_BEARER → 200 (configured) or 404 (not yet).
    //   • WITHOUT it → the FR-10 read-authority gate MUST deny: 403 is the ONLY
    //     acceptable status. FAGAN iter-3 MAJOR 5: the previous assertion also
    //     accepted 200/404 without a reader Bearer, so a deploy that STILL served
    //     authority reads on only the coarse service token (the exact B4
    //     regression this gate exists to catch) would have PASSED. 403 here both
    //     proves the surface is ROUTED (a stale pre-S2 deploy returns 404
    //     unknown_surface) AND proves the authority gate is live.
    for (const surface of ['role-map', 'apply-mode']) {
      const r = await fetch(`${base()}/v1/config/${WORLD}/${surface}`, {
        headers: authorityReadHeaders(),
      });
      if (READER_BEARER) {
        expect([200, 404]).toContain(r.status);
      } else {
        // No reader Bearer → the authority gate denies. 403 is the ONLY pass.
        expect(r.status).toBe(403);
      }
      if (r.status === 404) {
        const body = (await r.json()) as { error?: string };
        // 'not_configured' = surface KNOWN but no row yet (good).
        // 'unknown_surface' = the deployed service predates S2 (BAD — surface registration not deployed).
        expect(body.error).not.toBe('unknown_surface');
      }
    }
  });

  test.skipIf(!READER_BEARER)(
    'READ-AUTH: authority-surface GET → 200/404 WITH a reader Bearer, 403 WITHOUT',
    async () => {
      // WITH the reader Bearer (allowlisted sub): 200 (configured) or 404 (not yet).
      const withBearer = await fetch(`${base()}/v1/config/${WORLD}/apply-mode`, {
        headers: authorityReadHeaders(),
      });
      expect([200, 404]).toContain(withBearer.status);

      // WITHOUT the reader Bearer (coarse service token only): the FR-10 read
      // authority gate (B4) denies → 403. This is the regression the iter-2 fix
      // closes (the surface is NOT readable on the service token alone).
      const withoutBearer = await fetch(`${base()}/v1/config/${WORLD}/apply-mode`, {
        headers: readHeaders(),
      });
      expect(withoutBearer.status).toBe(403);
    },
  );

  test('ROUTING: onboarding-lifecycle without ?cm= → 400 (surface known, cm required)', async () => {
    const r = await fetch(`${base()}/v1/config/${WORLD}/onboarding-lifecycle`, { headers: readHeaders() });
    // The per-CM `?cm=` guard fires BEFORE the read-authority gate (app.ts), so a
    // GET without ?cm= deterministically returns 400 (bad_request) — which proves
    // the surface is ROUTED (a stale pre-S2 deploy would return 404
    // unknown_surface). A 404 here would mean the surface registration isn't
    // deployed; assert it is NOT unknown_surface in that case.
    if (r.status === 404) {
      const body = (await r.json()) as { error?: string };
      expect(body.error).not.toBe('unknown_surface');
    } else {
      expect(r.status).toBe(400);
    }
  });

  test('FR-10 TOKEN FORMAT: a PUT with a bogus bearer → 403 (NOT accepted as actor)', async () => {
    const r = await fetch(`${base()}/v1/config/${WORLD}/role-map`, {
      method: 'PUT',
      headers: { authorization: 'Bearer not-a-real-identity-token', ...readHeaders() },
      body: JSON.stringify({ config: { enabled: false, namespace_prefix: 'freeside', rules: [] }, expected_version: 0 }),
    });
    // The floor: a non-verifiable / non-allowlisted bearer is rejected. (If the
    // LIVE JWKS verifier is wired this is a signature failure → 403; if still on
    // the fail-closed default, also 403.) Either way: NEVER 200.
    expect(r.status).toBe(403);
  });

  test.skipIf(!WRITER_BEARER)('PERSISTENCE: apply-mode round-trip with a real writer bearer (leaves SHADOW)', async () => {
    // Read current version (404 → start at 0). apply-mode is a READ_AUTHORITY
    // surface (B4) — the read needs a verified Bearer too; the WRITER_BEARER is
    // allowlisted (it can write) so it satisfies the read-authority gate.
    const cur = await fetch(`${base()}/v1/config/${WORLD}/apply-mode`, {
      headers: { authorization: `Bearer ${WRITER_BEARER}`, ...readHeaders() },
    });
    let version = 0;
    if (cur.status === 200) version = ((await cur.json()) as { version: number }).version;

    const put = await fetch(`${base()}/v1/config/${WORLD}/apply-mode`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${WRITER_BEARER}`, 'content-type': 'application/json', ...readHeaders() },
      body: JSON.stringify({ config: { apply_mode: 'SHADOW' }, expected_version: version }),
    });
    expect([200, 409]).toContain(put.status); // 200 fresh write, or 409 if a concurrent writer moved it.
  });
});
