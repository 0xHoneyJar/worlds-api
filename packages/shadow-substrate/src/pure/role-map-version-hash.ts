/**
 * role-map-version-hash.ts — the FR-7 go_live HARD guard hash (SDD §3.3).
 *
 * PURE. `roleMapVersionHash(rules) → Hex64` = sha256(JCS) over EXACTLY three
 * deterministic rule fields:
 *   { role_rules, scaffolding_config, world_config }
 *
 * ── THE CENTRAL DESIGN CORRECTION (IMP-001/SKP-001×3) ───────────────────────
 * The roster (member ids, role ids, counts, fetch time) is DELIBERATELY
 * EXCLUDED. Folding volatile roster metadata into this hash would make it FLAP
 * between `bind_map` and `go_live` (a `snapshot_at` changes on every re-fetch;
 * member/role counts change on every join/leave), making the go_live
 * report-hash guard impossible to pass in any active server — a non-deterministic
 * "stale_report" trap. The hash covers ONLY the deterministic, operator-authored
 * rules. The roster is a *report input* (consumed by computeProposed/diff and
 * rendered in the Discrepancy), never a version-hash field. The flap-resistance
 * test (401.3) locks this in.
 *
 * Uses `@0xhoneyjar/events` `jcsCanonicalize` + `sha256Hex` so the hash is
 * BYTE-DETERMINISTIC across producers/consumers — it MUST be byte-identical to
 * the canonical events output for the same input (cross-producer determinism is
 * an acceptance gate; do NOT reimplement JCS or sha256 here).
 */
import { jcsCanonicalize, sha256Hex } from '@0xhoneyjar/events';
import type { Hex64 } from '../types.js';
import type { RoleRule, ScaffoldingConfig } from '../schemas/config-surfaces.js';

/**
 * The EXACTLY-hashed world-config fields (SDD §3.3). Deploy-bound; changes only
 * on a manifest edit. NO timestamps, NO roster, NO member/role counts.
 */
export interface WorldConfigHashFields {
  readonly world_slug: string;
  readonly guild_id: string;
  readonly namespace_prefix: string;
  readonly nft_contracts: ReadonlyArray<string>;
}

/**
 * The full set of deterministic inputs the hash covers (SDD §3.3). The roster
 * is structurally ABSENT from this type — there is no field to pass it into.
 */
export interface RoleMapVersionInput {
  readonly role_rules: ReadonlyArray<RoleRule>;
  readonly scaffolding_config: ScaffoldingConfig | undefined;
  readonly world_config: WorldConfigHashFields;
}

/**
 * Compute the content hash. PURE — same input ⇒ same 64-char lowercase-hex
 * digest, byte-for-byte matching the canonical events JCS+sha256.
 *
 * JCS (RFC 8785) sorts object keys recursively, so caller field ORDER does not
 * matter — only field VALUES. We canonicalize an explicit `{ role_rules,
 * scaffolding_config, world_config }` object (the three §3.3 fields, in any
 * order) and hash the canonical string.
 */
export function roleMapVersionHash(input: RoleMapVersionInput): Hex64 {
  // Build EXACTLY the three §3.3 fields. `scaffolding_config: undefined` is
  // dropped by JSON canonicalization (undefined is not serialized), so an
  // absent scaffolding config hashes identically whether passed as `undefined`
  // or omitted — deterministic either way.
  const canonical = jcsCanonicalize({
    role_rules: input.role_rules,
    scaffolding_config: input.scaffolding_config,
    world_config: input.world_config,
  });
  return sha256Hex(canonical) as Hex64;
}
