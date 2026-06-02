/**
 * role-map-version-hash.test.ts — the FR-7 guard hash acceptance gates (401.3).
 *
 *   - FLAP-RESISTANCE (closes IMP-001/SKP-001): mutate ONLY roster metadata
 *     and assert the hash is IDENTICAL (roster is structurally excluded).
 *   - CROSS-PRODUCER DETERMINISM: the substrate hash == the canonical
 *     `@0xhoneyjar/events` JCS+sha256 for the same input.
 *   - rules changes DO change the hash (the guard is meaningful).
 *   - field-ORDER independence (JCS sorts keys).
 *   - scaffolding `undefined` vs omitted hash identically.
 *
 * PURE — data-in/data-out, NO Layers, NO mocks.
 */
import { describe, expect, test } from 'bun:test';
import { jcsCanonicalize, sha256Hex } from '@0xhoneyjar/events';
import { roleMapVersionHash } from '../src/pure/role-map-version-hash.js';
import type { RoleMapVersionInput } from '../src/pure/role-map-version-hash.js';
import { CANONICAL_VERSION_HASH, CANONICAL_VERSION_HASH_INPUT } from '../conformance/fixture.js';

const baseInput: RoleMapVersionInput = {
  role_rules: [
    {
      role_key: 'purupuru:holder',
      display_name: 'Purupuru Holder',
      qualifies: { source: 'tier', min_tier: 'tier-1' },
      create_if_absent: true,
    },
  ],
  scaffolding_config: { channels: [{ key: 'lounge', label: 'Holder Lounge' }] },
  world_config: {
    world_slug: 'purupuru',
    guild_id: '111122223333444455',
    namespace_prefix: 'purupuru:',
    nft_contracts: ['0xabc'],
  },
};

describe('roleMapVersionHash — determinism + shape', () => {
  test('is a 64-char lowercase hex digest', () => {
    const h = roleMapVersionHash(baseInput);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('is deterministic — same input ⇒ same hash', () => {
    expect(roleMapVersionHash(baseInput)).toBe(roleMapVersionHash(baseInput));
  });

  test('matches the frozen canonical fixture hash (cross-repo conformance)', () => {
    expect(roleMapVersionHash(CANONICAL_VERSION_HASH_INPUT) as string).toBe(CANONICAL_VERSION_HASH);
  });
});

describe('roleMapVersionHash — CROSS-PRODUCER DETERMINISM (acceptance gate)', () => {
  test('equals the canonical @0xhoneyjar/events JCS+sha256 over the SAME three fields', () => {
    // Reproduce the events pipeline directly over EXACTLY {role_rules,
    // scaffolding_config, world_config} — the substrate hash MUST be
    // byte-identical (do NOT reimplement JCS/sha256; this asserts we route
    // through the canonical producer).
    const canonical = jcsCanonicalize({
      role_rules: baseInput.role_rules,
      scaffolding_config: baseInput.scaffolding_config,
      world_config: baseInput.world_config,
    });
    const expected = sha256Hex(canonical);
    expect(roleMapVersionHash(baseInput) as string).toBe(expected);
  });
});

describe('roleMapVersionHash — FLAP-RESISTANCE (closes IMP-001/SKP-001)', () => {
  const expected = roleMapVersionHash(baseInput);

  test('mutating roster member/role COUNTS does not change the hash', () => {
    // The input type has NO roster field — but a naive caller might try to
    // smuggle roster metadata in. Adding extraneous roster-shaped fields to a
    // SEPARATE object and hashing only the three §3.3 fields must be identical.
    // We assert by constructing an input that differs ONLY in roster-like data
    // that the function never reads.
    const withRosterNoise = { ...baseInput } as RoleMapVersionInput & {
      member_count?: number;
      role_count?: number;
      snapshot_at?: string;
    };
    withRosterNoise.member_count = 9999;
    withRosterNoise.role_count = 42;
    withRosterNoise.snapshot_at = '2026-06-01T12:34:56Z';
    expect(roleMapVersionHash(withRosterNoise)).toBe(expected);
  });

  test('a DIFFERENT roster-noise payload still yields the IDENTICAL hash', () => {
    const noiseA = { ...baseInput, member_count: 1, snapshot_at: 'a' } as RoleMapVersionInput;
    const noiseB = { ...baseInput, member_count: 2, snapshot_at: 'b' } as RoleMapVersionInput;
    expect(roleMapVersionHash(noiseA)).toBe(roleMapVersionHash(noiseB));
    expect(roleMapVersionHash(noiseA)).toBe(expected);
  });
});

describe('roleMapVersionHash — the guard is meaningful (rules DO version)', () => {
  test('changing a role rule changes the hash', () => {
    const changed: RoleMapVersionInput = {
      ...baseInput,
      role_rules: [
        {
          ...baseInput.role_rules[0]!,
          // change a qualification field — should re-version the hash
          qualifies: { source: 'tier', min_tier: 'tier-9' },
        },
      ],
    };
    expect(roleMapVersionHash(changed)).not.toBe(roleMapVersionHash(baseInput));
  });

  test('changing scaffolding changes the hash', () => {
    const changed: RoleMapVersionInput = {
      ...baseInput,
      scaffolding_config: { channels: [{ key: 'vault', label: 'The Vault' }] },
    };
    expect(roleMapVersionHash(changed)).not.toBe(roleMapVersionHash(baseInput));
  });

  test('changing a world_config field (guild_id) changes the hash', () => {
    const changed: RoleMapVersionInput = {
      ...baseInput,
      world_config: { ...baseInput.world_config, guild_id: '999988887777666655' },
    };
    expect(roleMapVersionHash(changed)).not.toBe(roleMapVersionHash(baseInput));
  });
});

describe('roleMapVersionHash — JCS normalization', () => {
  test('field ORDER of the three top-level keys does not matter', () => {
    const reordered: RoleMapVersionInput = {
      world_config: baseInput.world_config,
      scaffolding_config: baseInput.scaffolding_config,
      role_rules: baseInput.role_rules,
    };
    expect(roleMapVersionHash(reordered)).toBe(roleMapVersionHash(baseInput));
  });

  test('scaffolding undefined vs omitted hash identically', () => {
    const omitted = {
      role_rules: baseInput.role_rules,
      world_config: baseInput.world_config,
    } as RoleMapVersionInput;
    const explicitUndefined: RoleMapVersionInput = {
      ...baseInput,
      scaffolding_config: undefined,
    };
    expect(roleMapVersionHash(omitted)).toBe(roleMapVersionHash(explicitUndefined));
  });
});
