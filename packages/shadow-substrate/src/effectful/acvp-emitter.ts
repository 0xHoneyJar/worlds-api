/**
 * effectful/acvp-emitter.ts — the `AcvpEmitter` port (SDD §4.4.2/§6.3, task 402.2).
 *
 * A `Context.Tag` with CONFIRM semantics: `emitConfirmed` returns an
 * `Effect<void, AuditError>` that succeeds ONLY when the ACVP envelope has been
 * emitted AND CONFIRMED (published + acknowledged). This is the seam that makes
 * "audit BEFORE write" (write-after-audit, CLUSTER 4) enforceable in the pure
 * governor:
 *
 *   - `GateCheckedRoleWriter` emits + confirms `shadow.role.intent.v1` BEFORE the
 *     inner write. If `emitConfirmed` fails (NATS unavailable), the wrapper fails
 *     `WriteError("audit_unavailable")` and the inner writer is NEVER invoked.
 *   - under SHADOW, `shadow.role.rejected.v1` is confirmed BEFORE the typed
 *     rejection returns — so every rejected write leaves a signed trace.
 *
 * The substrate stays I/O-free: this is a PORT (signature only). The concrete
 * Layer — wrapping the real `@0xhoneyjar/events` `makeEmitter` (NATS + Ed25519
 * signer + hash-chain) — is supplied by the CONSUMER (S2/S4), exactly like the
 * RosterSource/RoleWriter ports. An in-memory recording Layer for tests is
 * provided in ./acvp-emitter.mock.ts.
 *
 * At the events-pin bump (task 402.7) the concrete Layer maps each
 * `(ShadowEventType, payload)` to the registered `SchemaId` and calls the events
 * `Emitter.emit` — the substrate-internal confirm contract is preserved.
 */
import { Context, Effect } from 'effect';
import type { AuditError } from '../errors.js';
import type { ShadowEvent } from '../events/shadow-events.js';

/**
 * `AcvpEmitter` — the confirm-before-write audit seam.
 *
 * `emitConfirmed(event)` resolves ONLY after the envelope is published AND
 * acknowledged. A failed confirm surfaces as `AuditError` in the error channel;
 * the caller (the gated writer) maps that to `WriteError("audit_unavailable")`
 * and refuses the write — there is no un-audited LIVE write (SKP-005).
 */
export class AcvpEmitter extends Context.Tag('shadow/AcvpEmitter')<
  AcvpEmitter,
  {
    readonly emitConfirmed: (event: ShadowEvent) => Effect.Effect<void, AuditError>;
  }
>() {}
