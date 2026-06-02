/**
 * compute-proposed.test.ts — PURE `computeProposed` acceptance gates (401.4).
 *
 *   - roster is a DATA PARAMETER (never a port read).
 *   - a rule absent from the current roster (create_if_absent) → AFTER role
 *     marked `created: true` + listed in `to_create`.
 *   - a rule already present → AFTER role with NO `created` marking.
 *   - all proposed roles are `managed: true`.
 *   - proposed membership counts come from data (explicit > current > 0).
 *
 * PURE — data-in/data-out, NO Layers, NO mocks.
 */
import { describe, expect, test } from 'bun:test';
import { computeProposed } from '../src/pure/compute-proposed.js';
import type { RoleMapConfig } from '../src/schemas/config-surfaces.js';
import type { CurrentRoster } from '../src/schemas/render-model.js';

const roleMap: RoleMapConfig = {
  enabled: true,
  namespace_prefix: 'purupuru:',
  rules: [
    {
      role_key: 'purupuru:holder',
      display_name: 'Holder',
      qualifies: { source: 'tier', min_tier: 'tier-1' },
      create_if_absent: true,
    },
    {
      role_key: 'purupuru:whale',
      display_name: 'Whale',
      qualifies: { source: 'tier', min_tier: 'tier-3' },
      create_if_absent: true,
    },
  ],
};

const roster: CurrentRoster = {
  world: 'purupuru',
  roles: [
    { role_key: 'purupuru:holder', members: 12, managed: true }, // already exists
    { role_key: 'collabland:verified', members: 30, managed: false }, // pre-existing
  ],
};

describe('computeProposed', () => {
  test('marks a not-yet-created managed role with created:true', () => {
    const proposed = computeProposed(roleMap, roster);
    const whale = proposed.roles.find((r) => r.role_key === 'purupuru:whale');
    expect(whale?.created).toBe(true);
    expect(whale?.managed).toBe(true);
  });

  test('an already-present role has NO created marking', () => {
    const proposed = computeProposed(roleMap, roster);
    const holder = proposed.roles.find((r) => r.role_key === 'purupuru:holder');
    expect(holder?.created).toBeUndefined();
    expect(holder?.managed).toBe(true);
  });

  test('to_create lists exactly the absent create_if_absent rules', () => {
    const proposed = computeProposed(roleMap, roster);
    expect(proposed.to_create).toEqual([
      { role_key: 'purupuru:whale', display_name: 'Whale' },
    ]);
  });

  test('a create_if_absent:false absent rule is NOT created', () => {
    const map: RoleMapConfig = {
      ...roleMap,
      rules: [
        {
          role_key: 'purupuru:ghost',
          display_name: 'Ghost',
          qualifies: { source: 'tier', min_tier: 'tier-1' },
          create_if_absent: false,
        },
      ],
    };
    const proposed = computeProposed(map, roster);
    expect(proposed.to_create).toEqual([]);
    const ghost = proposed.roles.find((r) => r.role_key === 'purupuru:ghost');
    expect(ghost?.created).toBeUndefined();
  });

  test('every proposed role is managed:true', () => {
    const proposed = computeProposed(roleMap, roster);
    expect(proposed.roles.every((r) => r.managed === true)).toBe(true);
  });

  test('explicit proposed membership overrides current count; absent → 0', () => {
    const proposed = computeProposed(roleMap, roster, { 'purupuru:holder': 18 });
    const holder = proposed.roles.find((r) => r.role_key === 'purupuru:holder');
    const whale = proposed.roles.find((r) => r.role_key === 'purupuru:whale');
    expect(holder?.members).toBe(18); // explicit
    expect(whale?.members).toBe(0); // to-create, no explicit count
  });

  test('is deterministic — same inputs ⇒ deep-equal output', () => {
    expect(computeProposed(roleMap, roster)).toEqual(computeProposed(roleMap, roster));
  });
});
