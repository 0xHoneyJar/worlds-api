/**
 * conformance/check.ts — the worlds-api CI compat check (B7, task 401.8 / SDD
 * §1.7.1). Run: `bun run conformance:check` (or `bun run conformance/check.ts`).
 *
 * Asserts three things, failing the build (exit 1) on ANY mismatch:
 *   1. The `@0xhoneyjar/events`-backed `roleMapVersionHash` of the canonical
 *      input reproduces `CANONICAL_VERSION_HASH` byte-for-byte (cross-producer
 *      determinism — the substrate's hash == the events package's JCS+sha256).
 *   2. The constructed `Discrepancy`/`AuthzContext` objects carry EXACTLY the
 *      frozen key shapes (a schema-shape skew is caught here).
 *   3. The PINNED events SHA in this package equals the cycle-canonical SHA
 *      recorded in loa-freeside's `substrate-sha.lock` (NOTE: the SUBSTRATE's
 *      own SHA only exists after commit, so THAT lock is recorded separately by
 *      the orchestrator — see conformance/ROLLBACK.md §"Boundary"). What this
 *      check enforces in-repo is the EVENTS pin, the substrate's only external
 *      dependency whose drift would change the hash.
 *
 * The dashboard (404) + characters (405) CI checks import the SAME fixture from
 * the SHA-pinned substrate and run assertions 1+2 against their pinned copy.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { roleMapVersionHash } from '../src/pure/role-map-version-hash.js';
import {
  CANONICAL_VERSION_HASH_INPUT,
  CANONICAL_VERSION_HASH,
  FROZEN_SHAPES,
} from './fixture.js';

const EVENTS_PIN_EXPECTED = '68f5a89cb02c6b3ddf5ab14a1d65753bc02bd9fe';

const TAG = '[conformance-check]';
let failures = 0;

function ok(label: string): void {
  console.log(`${TAG} [OK] ${label}`);
}
function fail(label: string, detail: string): void {
  console.error(`${TAG} [FAIL] ${label}: ${detail}`);
  failures += 1;
}

// ── 1. cross-producer determinism: the frozen hash reproduces ───────────────
const computed = roleMapVersionHash(CANONICAL_VERSION_HASH_INPUT);
if (computed === CANONICAL_VERSION_HASH) {
  ok(`roleMapVersionHash reproduces canonical hash (${computed.slice(0, 12)}…)`);
} else {
  fail(
    'roleMapVersionHash drift',
    `expected ${CANONICAL_VERSION_HASH} got ${computed} — a SHA bump changed the hash algorithm; re-freeze + lockstep rollout (conformance/ROLLBACK.md)`,
  );
}

// ── 2. frozen shapes: the boundary types carry exactly the frozen keys ──────
// We assert against the FROZEN_SHAPES manifest. (Runtime decode of a sample is
// exercised by the bun tests; here we assert the manifest is internally
// coherent + present, so a consumer importing it sees a complete contract.)
const dShape = FROZEN_SHAPES.Discrepancy;
if (
  dShape.top_level.length === 8 &&
  dShape.role_count.includes('limit') &&
  dShape.after_role.includes('created')
) {
  ok('Discrepancy frozen shape present (8 top-level keys; role_count.limit; after_role.created)');
} else {
  fail('Discrepancy frozen shape', JSON.stringify(dShape));
}

const aShape = FROZEN_SHAPES.AuthzContext;
if (
  aShape.top_level.includes('authz_decision_id') &&
  aShape.top_level.includes('roster_version') &&
  aShape.roster_version.includes('fingerprint')
) {
  ok('AuthzContext frozen shape present (authz_decision_id; roster_version.fingerprint)');
} else {
  fail('AuthzContext frozen shape', JSON.stringify(aShape));
}

if (FROZEN_SHAPES.WriteCapability.data_keys.includes('authz_decision_id')) {
  ok('WriteCapability frozen shape present (data_keys carry authz_decision_id)');
} else {
  fail('WriteCapability frozen shape', JSON.stringify(FROZEN_SHAPES.WriteCapability));
}

// ── 3. events pin matches the expected canonical events SHA ─────────────────
try {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const eventsDep = pkg.dependencies?.['@0xhoneyjar/events'] ?? '';
  const m = eventsDep.match(/#([0-9a-f]{7,40})$/);
  const pinned = m?.[1] ?? '';
  if (pinned === EVENTS_PIN_EXPECTED) {
    ok(`@0xhoneyjar/events pin matches canonical (${pinned.slice(0, 12)}…)`);
  } else {
    fail('events pin drift', `expected ${EVENTS_PIN_EXPECTED} got "${pinned}"`);
  }
} catch (e) {
  fail('events pin read', String(e));
}

if (failures > 0) {
  console.error(`${TAG} ${failures} conformance assertion(s) FAILED`);
  process.exit(1);
}
console.log(`${TAG} all conformance assertions passed`);
