/**
 * effectful/loaders.ts — the EFFECTFUL roster/score loaders (SDD §4.2, task 402.6).
 *
 * These are the thin Effect programs that REQUIRE the I/O ports and produce the
 * DATA the pure `computeProposed`/`diff` consume. They do the I/O; the pure
 * functions stay data-in/data-out. The Layers (LIVE Discord / MOCK fixtures) are
 * supplied by the consuming lenses (S4) — never here.
 *
 *   - `loadCurrentRoster(world)` : Effect<CurrentRoster, RosterError, RosterSource>
 *       resolves the BEFORE roster (live guild roles+members, or mock fixture).
 *   - `loadLatentCounts(world, rules)` : Effect<LatentCounts, ScoreError, ScoreSource>
 *       resolves latent-member counts per rule (MOCKED — honest `source:"MOCK"`).
 *       score-api is NOT ours (#164/#221); the count provenance is always "MOCK"
 *       in the MVP, surfaced honestly in the `Discrepancy` (SDD §8.5).
 */
import { Effect } from 'effect';
import type { WorldSlug } from '../types.js';
import type { RosterError, ScoreError } from '../errors.js';
import type { CurrentRoster, LatentQualified } from '../schemas/render-model.js';
import type { RoleRule } from '../schemas/config-surfaces.js';
import { RosterSource, ScoreSource } from '../ports/index.js';

/** Resolve the BEFORE roster via the `RosterSource` port (live or mock). */
export function loadCurrentRoster(
  world: WorldSlug,
): Effect.Effect<CurrentRoster, RosterError, RosterSource> {
  return Effect.gen(function* () {
    const source = yield* RosterSource;
    return yield* source.currentRoster(world);
  });
}

/**
 * Resolve latent-member counts per managed rule via the `ScoreSource` port. The
 * counts are MOCKED for the MVP — the provenance is tagged `source: "MOCK"`
 * honestly (FR-6/§8.5). Returns one `LatentQualified` per rule, keyed by
 * `role_key`.
 */
export function loadLatentCounts(
  world: WorldSlug,
  rules: ReadonlyArray<RoleRule>,
): Effect.Effect<ReadonlyArray<LatentQualified>, ScoreError, ScoreSource> {
  return Effect.gen(function* () {
    const source = yield* ScoreSource;
    const out: LatentQualified[] = [];
    for (const rule of rules) {
      const count = yield* source.latentQualified(world, rule);
      out.push({ role_key: rule.role_key, count, source: 'MOCK' });
    }
    return out;
  });
}
