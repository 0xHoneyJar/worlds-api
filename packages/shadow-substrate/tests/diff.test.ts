/**
 * diff.test.ts — PURE `diff → Discrepancy` acceptance gates (401.4 / SDD §6.4).
 *
 *   - AFTER marks created:true on not-yet-created roles; BEFORE OMITS them.
 *   - pre-existing (managed:false) roles NEVER carry change affordances — they
 *     appear ONLY in `preexisting` as locked context (D2).
 *   - role_count projection surfaces the 250-limit overage predictively (D3).
 *   - carries role_map_hash; latent counts pass through as data (honest source).
 *   - validates clean against the @effect/schema Discrepancy shape.
 *
 * PURE — data-in/data-out, NO Layers, NO mocks.
 */
import { describe, expect, test } from 'bun:test';
import { Schema as S } from '@effect/schema';
import { computeProposed } from '../src/pure/compute-proposed.js';
import { diff } from '../src/pure/diff.js';
import { Discrepancy } from '../src/schemas/render-model.js';
import type { RoleMapConfig } from '../src/schemas/config-surfaces.js';
import type { CurrentRoster } from '../src/schemas/render-model.js';
import type { Hex64 } from '../src/types.js';

const HASH = 'c'.repeat(64) as Hex64;

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
      role_key: 'purupuru:whale', // absent → to-create
      display_name: 'Whale',
      qualifies: { source: 'tier', min_tier: 'tier-3' },
      create_if_absent: true,
    },
  ],
};

const roster: CurrentRoster = {
  world: 'purupuru',
  roles: [
    { role_key: 'purupuru:holder', members: 12, managed: true },
    { role_key: 'collabland:verified', members: 30, managed: false },
  ],
};

const proposed = computeProposed(roleMap, roster, { 'purupuru:holder': 18, 'purupuru:whale': 5 });

const latent = [{ role_key: 'purupuru:whale', count: 47, source: 'MOCK' as const }];

describe('diff → Discrepancy', () => {
  const d = diff(roster, proposed, latent, { roleMapHash: HASH, generatedAt: '2026-06-01T00:00:00Z' });

  test('carries the role_map_hash', () => {
    expect(d.role_map_hash).toBe(HASH);
  });

  test('AFTER marks created:true on the not-yet-created role', () => {
    const whale = d.after.roles.find((r) => r.role_key === 'purupuru:whale');
    expect(whale?.created).toBe(true);
  });

  test('BEFORE OMITS the not-yet-created role (it does not exist yet)', () => {
    expect(d.before.roles.find((r) => r.role_key === 'purupuru:whale')).toBeUndefined();
    // the already-existing managed role IS in BEFORE
    expect(d.before.roles.find((r) => r.role_key === 'purupuru:holder')).toBeDefined();
  });

  test('pre-existing (managed:false) roles appear ONLY in preexisting, never in before/after', () => {
    expect(d.before.roles.some((r) => r.role_key === 'collabland:verified')).toBe(false);
    expect(d.after.roles.some((r) => r.role_key === 'collabland:verified')).toBe(false);
    expect(d.preexisting.roles.some((r) => r.role_key === 'collabland:verified')).toBe(true);
  });

  test('preexisting roles carry managed:false and NO change affordance', () => {
    const pre = d.preexisting.roles.find((r) => r.role_key === 'collabland:verified');
    expect(pre?.managed).toBe(false);
    expect((pre as { created?: boolean }).created).toBeUndefined();
  });

  test('latent counts pass through with honest MOCK source', () => {
    expect(d.latent_qualified).toEqual(latent);
    expect(d.latent_qualified[0]?.source).toBe('MOCK');
  });

  test('role_count projection: existing=2, to_create=1, projected_total=3, under limit', () => {
    expect(d.role_count).toEqual({
      existing: 2,
      to_create: 1,
      projected_total: 3,
      limit: 250,
      exceeds: false,
    });
  });

  test('decodes clean against the @effect/schema Discrepancy shape', () => {
    expect(() => S.decodeUnknownSync(Discrepancy)(d)).not.toThrow();
  });

  test('is deterministic — same inputs ⇒ deep-equal output', () => {
    const d2 = diff(roster, proposed, latent, { roleMapHash: HASH, generatedAt: '2026-06-01T00:00:00Z' });
    expect(d2).toEqual(d);
  });
});

describe('diff — D3 predictive 250-limit overage', () => {
  test('exceeds:true when (existing + to_create) > 250', () => {
    // 248 pre-existing roles + 3 to-create managed rules = 251 projected.
    const bigRoster: CurrentRoster = {
      world: 'purupuru',
      roles: Array.from({ length: 248 }, (_, i) => ({
        role_key: `collabland:role-${i}`,
        members: 1,
        managed: false as const,
      })),
    };
    const bigMap: RoleMapConfig = {
      enabled: true,
      namespace_prefix: 'purupuru:',
      rules: ['a', 'b', 'c'].map((k) => ({
        role_key: `purupuru:${k}`,
        display_name: k,
        qualifies: { source: 'tier' as const, min_tier: 'tier-1' },
        create_if_absent: true,
      })),
    };
    const bigProposed = computeProposed(bigMap, bigRoster);
    const d = diff(bigRoster, bigProposed, [], { roleMapHash: HASH });
    expect(d.role_count.existing).toBe(248);
    expect(d.role_count.to_create).toBe(3);
    expect(d.role_count.projected_total).toBe(251);
    expect(d.role_count.exceeds).toBe(true);
  });

  test('exceeds:false exactly at the 250 boundary', () => {
    const roster250: CurrentRoster = {
      world: 'purupuru',
      roles: Array.from({ length: 249 }, (_, i) => ({
        role_key: `collabland:role-${i}`,
        members: 1,
        managed: false as const,
      })),
    };
    const map1: RoleMapConfig = {
      enabled: true,
      namespace_prefix: 'purupuru:',
      rules: [
        {
          role_key: 'purupuru:one',
          display_name: 'One',
          qualifies: { source: 'tier', min_tier: 'tier-1' },
          create_if_absent: true,
        },
      ],
    };
    const p = computeProposed(map1, roster250);
    const d = diff(roster250, p, [], { roleMapHash: HASH });
    expect(d.role_count.projected_total).toBe(250);
    expect(d.role_count.exceeds).toBe(false);
  });
});

describe('diff — generated_at defaults to empty string when omitted (PURE, no clock)', () => {
  test('omitted generatedAt → ""', () => {
    const d = diff(roster, proposed, latent, { roleMapHash: HASH });
    expect(d.generated_at).toBe('');
  });
});
