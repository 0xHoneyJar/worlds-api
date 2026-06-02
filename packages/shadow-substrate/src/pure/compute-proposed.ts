/**
 * compute-proposed.ts — PURE `computeProposed(roleMapConfig, roster)` (SDD §4.2).
 *
 * Given the role-map AND an already-loaded roster VALUE (a data parameter,
 * NEVER a port read), computes who *should* hold which managed roles + which
 * managed roles must be created. NO I/O, NO Layers, deterministic.
 *
 * Managed-ness is determined by the role-map: a proposed role exists for each
 * `RoleRule` in the map (the Freeside-namespaced set). A rule whose `role_key`
 * is ABSENT from the current roster (and `create_if_absent`) is a to-create
 * role — marked `created: true` in the AFTER view and listed in `to_create`.
 * Pre-existing (non-managed) roles in the current roster are NOT touched here —
 * they flow through to the `Discrepancy.preexisting` set in `diff`.
 */
import type { RoleMapConfig } from '../schemas/config-surfaces.js';
import type { CurrentRoster, ProposedRoster, AfterRole } from '../schemas/render-model.js';

/**
 * Optional per-rule proposed membership counts. The actual qualifying-member
 * computation depends on score/roster data the EFFECTFUL loaders resolve; the
 * pure function accepts the resolved counts as data. When a rule's count is not
 * supplied, the proposed role keeps the current roster's member count (or 0 for
 * a to-create role) — deterministic from the inputs alone.
 */
export interface ProposedMembership {
  /** role_key → proposed member count for that managed role. */
  readonly [role_key: string]: number;
}

export function computeProposed(
  roleMapConfig: RoleMapConfig,
  roster: CurrentRoster,
  proposedMembership: ProposedMembership = {},
): ProposedRoster {
  // Index current roster roles by role_key for membership lookup.
  const currentByKey = new Map(roster.roles.map((r) => [r.role_key, r]));

  const roles: AfterRole[] = [];
  const to_create: Array<{ role_key: string; display_name: string }> = [];

  for (const rule of roleMapConfig.rules) {
    const existing = currentByKey.get(rule.role_key);
    const willCreate = existing === undefined && rule.create_if_absent;

    // Proposed membership: explicit count if supplied, else current count, else 0.
    const members =
      proposedMembership[rule.role_key] ?? existing?.members ?? 0;

    const after: AfterRole = willCreate
      ? { role_key: rule.role_key, members, managed: true, created: true }
      : { role_key: rule.role_key, members, managed: true };

    roles.push(after);

    if (willCreate) {
      to_create.push({ role_key: rule.role_key, display_name: rule.display_name });
    }
  }

  return { world: roster.world, roles, to_create };
}
