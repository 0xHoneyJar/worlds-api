/**
 * effectful/resolve-authz.mock.ts — an IN-MEMORY `AdminAllowlistSource` Layer
 * for tests (SDD §8 / task 402.5). The real Layer reads `admin_principals` from
 * the deploy-bound world manifest (`purupuru.yaml`), TTL-cached ≤10s (S4); this
 * mock returns a fixed allowlist and supports MID-FLOW revocation so the
 * revocation-during-onboarding test (B3/B4) can flip the allowlist between calls.
 */
import { Effect, Layer } from 'effect';
import type { WorldSlug } from '../types.js';
import { AdminAllowlistSource } from './resolve-authz.js';

/** A mutable allowlist a test can revoke mid-flow. */
export interface AllowlistController {
  /** replace the allowlist for a world (models a manifest redeploy + cache flush). */
  set(world: WorldSlug, principals: ReadonlyArray<string>): void;
  /** remove one principal (models revocation). */
  revoke(world: WorldSlug, principal: string): void;
}

/**
 * Build an in-memory `AdminAllowlistSource` Layer + a controller to mutate it.
 * `bypassCache` is a no-op here (the in-memory map is always "fresh"); the
 * controller's `set`/`revoke` are the test's way to model a manifest redeploy.
 */
export function makeInMemoryAllowlist(
  initial: Readonly<Record<string, ReadonlyArray<string>>> = {},
): { readonly layer: Layer.Layer<AdminAllowlistSource>; readonly controller: AllowlistController } {
  const map = new Map<string, string[]>(
    Object.entries(initial).map(([w, ps]) => [w, [...ps]]),
  );

  const controller: AllowlistController = {
    set: (world, principals) => map.set(world, [...principals]),
    revoke: (world, principal) => {
      const cur = map.get(world);
      if (cur) map.set(world, cur.filter((p) => p !== principal));
    },
  };

  const layer = Layer.succeed(AdminAllowlistSource, {
    adminPrincipals: (world: WorldSlug) =>
      Effect.sync(() => (map.get(world) ?? []) as ReadonlyArray<string>),
  });

  return { layer, controller };
}
