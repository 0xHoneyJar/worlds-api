/**
 * diff.ts — PURE `diff(currentRoster, proposed, latentCounts) → Discrepancy`
 * (SDD §4.2/§6.4). A pure projection (a read-model, not state): role-by-role
 * before/after + latent qualified members (counts passed in as DATA) + the D3
 * role-count projection. Carries `role_map_hash` (the FR-7 guard hash).
 *
 * Invariants this enforces (acceptance gates):
 *   - The AFTER view marks `created: true` on not-yet-created managed roles;
 *     the BEFORE view OMITS them (they do not exist yet) — SDD §6.4 / OQ-3.
 *   - Pre-existing (`managed: false`) roles NEVER carry change affordances —
 *     they are surfaced ONLY in `preexisting` as locked context (D2).
 *   - `role_count` projects the Discord 250-role overage predictively (D3).
 *
 * NO I/O, NO Layers, deterministic. `generated_at` is supplied by the caller
 * (a pure function must not read the clock) so the projection is reproducible.
 */
import type { Hex64 } from '../types.js';
import type {
  CurrentRoster,
  ProposedRoster,
  Discrepancy,
  BeforeRole,
  AfterRole,
  PreexistingRole,
  LatentQualified,
} from '../schemas/render-model.js';

export interface DiffOptions {
  /** the FR-7 guard hash the report was computed against (`roleMapVersionHash`). */
  readonly roleMapHash: Hex64;
  /**
   * ISO timestamp — supplied by the caller (PURE: no clock read here). Defaults
   * to the empty string if omitted so the function stays total + deterministic.
   */
  readonly generatedAt?: string;
  /** Discord's per-guild hard ceiling. */
  readonly limit?: 250;
}

/**
 * Latent qualified members per managed role (numbers, MOCKED for MVP). The
 * `source` carries honest provenance ("MOCK" in the MVP).
 */
export type LatentCounts = ReadonlyArray<LatentQualified>;

export function diff(
  currentRoster: CurrentRoster,
  proposed: ProposedRoster,
  latentCounts: LatentCounts,
  opts: DiffOptions,
): Discrepancy {
  const limit = opts.limit ?? 250;

  // BEFORE = current MANAGED roles only (managed: true). A to-create managed
  // role is NOT present in the current roster, so it is structurally absent
  // here — the BEFORE view OMITS not-yet-created roles (acceptance gate).
  const before: BeforeRole[] = currentRoster.roles.filter((r) => r.managed === true);

  // PREEXISTING = current NON-managed roles, surfaced as locked context (D2).
  // These never carry change affordances.
  const preexisting: PreexistingRole[] = currentRoster.roles
    .filter((r) => r.managed === false)
    .map((r) => ({ role_key: r.role_key, members: r.members, managed: false as const }));

  // AFTER = the proposed managed roles (carry `created` on to-create roles).
  const after: ReadonlyArray<AfterRole> = proposed.roles;

  // D3 role-count projection: existing = ALL current guild roles (managed +
  // pre-existing); to_create = the proposed to-create count.
  const existing = currentRoster.roles.length;
  const to_create = proposed.to_create.length;
  const projected_total = existing + to_create;

  return {
    world: currentRoster.world,
    role_map_hash: opts.roleMapHash,
    before: { roles: before },
    after: { roles: after },
    preexisting: { roles: preexisting },
    latent_qualified: [...latentCounts],
    role_count: {
      existing,
      to_create,
      projected_total,
      limit,
      exceeds: projected_total > limit,
    },
    generated_at: opts.generatedAt ?? '',
  };
}
