/**
 * effectful/acvp-emitter.mock.ts — an IN-MEMORY recording `AcvpEmitter` Layer
 * for tests (SDD §8 / task 402.2/402.8). NOT for production — the real Layer
 * wraps `@0xhoneyjar/events` `makeEmitter` and is a consumer concern (S2/S4).
 *
 * Records every confirmed event into a shared `RecordedEvents` array so a test
 * can assert e.g. "a confirmed `shadow.role.rejected.v1` was emitted per
 * attempted write" or "zero `shadow.role.applied.v1` under SHADOW". A
 * configurable `failOn` predicate lets the audit-under-NATS-failure proof
 * (proof 3) inject an emitter whose `shadow.role.intent.v1` confirm FAILS.
 */
import { Context, Effect, Layer } from 'effect';
import { AuditError } from '../errors.js';
import type { ShadowEvent, ShadowEventType } from '../events/shadow-events.js';
import { AcvpEmitter } from './acvp-emitter.js';

/** A mutable recorder a test reads after running a program. */
export interface Recorder {
  readonly events: ShadowEvent[];
  /** count of confirmed events of a given type. */
  countOf(type: ShadowEventType): number;
}

/** Options controlling the mock emitter's behavior. */
export interface MockEmitterOptions {
  /**
   * When this predicate returns true for an event, `emitConfirmed` FAILS with
   * `AuditError` instead of recording it (simulates a NATS confirm failure).
   * Used by proof 3 (audit-under-NATS-failure) to fail the intent emit.
   */
  readonly failOn?: (event: ShadowEvent) => boolean;
}

/**
 * Build a recording `AcvpEmitter` Layer plus the shared `Recorder` the test
 * inspects. The recorder is captured by closure so the test sees every
 * confirmed event after `Effect.runPromise`.
 */
export function makeRecordingEmitter(opts: MockEmitterOptions = {}): {
  readonly layer: Layer.Layer<AcvpEmitter>;
  readonly recorder: Recorder;
} {
  const events: ShadowEvent[] = [];
  const recorder: Recorder = {
    events,
    countOf: (type) => events.filter((e) => e.event_type === type).length,
  };

  const service: Context.Tag.Service<AcvpEmitter> = {
    emitConfirmed: (event) =>
      Effect.suspend(() => {
        if (opts.failOn?.(event)) {
          return Effect.fail(
            new AuditError({
              message: `ACVP confirm failed (NATS unavailable) for ${event.event_type}`,
            }),
          );
        }
        events.push(event);
        return Effect.void;
      }),
  };

  return { layer: Layer.succeed(AcvpEmitter, service), recorder };
}
