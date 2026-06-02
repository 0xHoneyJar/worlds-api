/**
 * effectful/world-lock.ts — the `WorldLock` port (SDD §4.4.1, task 402.4, B10).
 *
 * The check-then-create sequence is NOT atomic from Discord's perspective: two
 * concurrent batches targeting the same world could both observe a role as
 * absent and both create it (duplicate snowflakes). `idempotency_key` dedupes
 * WITHIN a batch, never ACROSS concurrent ones. So role-creation is serialized
 * per world via a world-scoped advisory lock that wraps the entire
 * check-then-create span — only one batch may be in its create phase for a given
 * world at a time. `max_concurrent` is an INTRA-batch in-flight cap; it does NOT
 * prevent same-world cross-batch races — that is THIS lock's job.
 *
 * The substrate is the GOVERNOR: it defines the lock as an injected effectful
 * SEAM (a port). The concrete impl — a Postgres `pg_advisory_lock` keyed on
 * `world_slug`, a Redis `SETNX`, or a per-world job queue — is the CONSUMER's
 * Layer (S4). S1 provides an in-memory lock Layer (./world-lock.mock.ts) so the
 * concurrency proof (§8.4 / B10) runs with zero real I/O.
 */
import { Context, Effect } from 'effect';
import type { WorldSlug } from '../types.js';
import type { WriteError } from '../errors.js';

/**
 * `WorldLock` — serializes a critical section per world. `withWorldLock(world,
 * effect)` acquires the world-scoped lock, runs `effect`, and releases the lock
 * (even on failure/interrupt). Concurrent calls for the SAME world are
 * serialized; calls for DIFFERENT worlds run in parallel.
 */
export class WorldLock extends Context.Tag('shadow/WorldLock')<
  WorldLock,
  {
    readonly withWorldLock: <A, E>(
      world: WorldSlug,
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | WriteError>;
  }
>() {}
