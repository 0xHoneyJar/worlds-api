/**
 * effectful/mode-control.ts — the apply_mode `Ref` + its batch-duration
 * read-lock, packaged together (SDD §4.4.0/§4.5, B5/R-10).
 *
 * The B5 inverse-race fix requires that a `rollback` (LIVE→SHADOW) and an
 * in-flight `applyBatch` serialize against the SAME lock — so the transition is
 * observed at a batch BOUNDARY, never mid-batch. If the writer held a private
 * lock the rollback could not reach, the serialization would not hold. So the
 * mode `Ref` AND the lock are minted together here and SHARED: the gated writer
 * takes the lock for the whole batch; `rollbackUnderLock` takes the same lock to
 * flip the `Ref`.
 *
 * `makeModeControl(initial)` returns the `Ref`, the shared lock (an
 * `Effect.Semaphore(1)`), and a `withModeLock` combinator. All effectful (the
 * `Ref` + semaphore are created in Effect).
 */
import { Effect, Ref } from 'effect';
import type { Semaphore } from 'effect/Effect';
import type { ApplyMode } from '../types.js';

export interface ModeControl {
  readonly ref: Ref.Ref<ApplyMode>;
  readonly lock: Semaphore;
  /** run `effect` while holding the shared mode lock (1 permit). */
  readonly withModeLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export function makeModeControl(initial: ApplyMode): Effect.Effect<ModeControl> {
  return Effect.gen(function* () {
    const ref = yield* Ref.make(initial);
    const lock = yield* Effect.makeSemaphore(1);
    return {
      ref,
      lock,
      withModeLock: (effect) => lock.withPermits(1)(effect),
    };
  });
}
