/**
 * effectful/gate-checked-role-writer.ts — THE GATE (SDD §4.4, tasks 402.1/.2/.4).
 *
 * `GateCheckedRoleWriter` is the substrate-provided wrapper around the inner
 * (actor-supplied) `RoleWriter`. It is THE ENFORCED SECURITY BOUNDARY (B9): the
 * `WriteCapability` is only a compile-time accident-prevention seam — the gate's
 * invocation-time mode read + authz validation + write-after-audit are what
 * actually enforce "SHADOW ⇒ zero writes". A consumer NEVER calls a raw writer
 * directly; the only reachable write path is `applyBatch` on this wrapper.
 *
 * Per `applyBatch(batch, cap)`:
 *   1. B5 read-lock: acquire a read-lock on the mode `Ref` for the WHOLE batch
 *      duration so a concurrent `rollback` (LIVE→SHADOW) serializes to a batch
 *      boundary — never interleaving mid-batch.
 *   2. R-10 invocation read: read `apply_mode` from the `Ref` AT INVOCATION
 *      (never captured at Layer-build).
 *   3. B3/B14 confused-deputy guard: assert `batch.authz` is bound to THIS
 *      authorization — report_hash matches the current map hash AND the
 *      capability's; `authz_decision_id` matches the capability's.
 *   4. SHADOW ⇒ per attempted op: emit CONFIRMED `shadow.role.rejected.v1`, then
 *      fail `ShadowGateRejected`. The inner writer is invoked ZERO times.
 *   5. LIVE ⇒ per op (skipping ops already `ok` from a prior run — idempotent
 *      reconciliation): emit + CONFIRM `shadow.role.intent.v1` BEFORE the write
 *      (a failed confirm ⇒ `WriteError("audit_unavailable")`, write does NOT
 *      run); create-ops run inside the per-world lock (B10) with check-then-
 *      create against the `roles_created` ledger; emit `shadow.role.applied.v1`
 *      after success; record per-op status + the ledger.
 */
import { Context, Effect, Layer, Ref } from 'effect';
import {
  ShadowGateRejected,
  WriteError,
  type AuditError,
} from '../errors.js';
import type { ModeControl } from './mode-control.js';
import type {
  AuthzContext,
  WriteCapability,
  WriteIntentBatch,
  WriteOp,
  GoLiveJobState,
  WorldSlug,
  RoleId,
} from '../types.js';
import { RoleWriter } from '../ports/index.js';
import { AcvpEmitter } from './acvp-emitter.js';
import { WorldLock } from './world-lock.js';
import {
  SHADOW_ROLE_REJECTED,
  SHADOW_ROLE_INTENT,
  SHADOW_ROLE_APPLIED,
  type ShadowEvent,
} from '../events/shadow-events.js';

// ─── The gate service shape ──────────────────────────────────────────────────

/**
 * The result of an `applyBatch`. Carries the terminal `GoLiveJobState`-shaped
 * outcome (per-op status + the idempotent `roles_created` ledger) the lens polls.
 */
export type ApplyBatchResult = Omit<GoLiveJobState, 'job_id'>;

/**
 * The gate service. `applyBatch` is the ONLY write path. A SHADOW batch fails
 * `ShadowGateRejected` (after confirming a rejection per op); a LIVE batch
 * returns the terminal job state.
 */
export interface GateCheckedRoleWriterService {
  readonly applyBatch: (
    batch: WriteIntentBatch,
    cap: WriteCapability,
    /** prior op_status for reconciliation (retry re-runs only pending/failed). */
    priorState?: ApplyBatchResult,
  ) => Effect.Effect<
    ApplyBatchResult,
    WriteError | ShadowGateRejected,
    RoleWriter | AcvpEmitter | WorldLock
  >;
}

export class GateCheckedRoleWriter extends Context.Tag('shadow/GateCheckedRoleWriter')<
  GateCheckedRoleWriter,
  GateCheckedRoleWriterService
>() {}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Map an op to the audit payload's intent fields. */
function intentFields(op: WriteOp): {
  op_id: string;
  kind: 'create_role' | 'assign_role';
  role_key: string;
  member_id?: string;
} {
  const member_id =
    op.kind === 'assign_role' ? (op.intent as { member_id: string }).member_id : undefined;
  return { op_id: op.op_id, kind: op.kind, role_key: op.intent.role_key, member_id };
}

/**
 * Assert the batch's `AuthzContext` is bound to THIS authorization (B3/B14
 * confused-deputy + replay guard). Fails `WriteError("op_failed")` with a clear
 * message — these are NOT transient, NOT rate-limit, and NOT a SHADOW rejection;
 * a binding mismatch is a hard refusal.
 */
function assertAuthzBound(
  authz: AuthzContext,
  cap: WriteCapability,
  currentMapHash: string,
): Effect.Effect<void, WriteError> {
  if (authz.report_hash !== currentMapHash) {
    return Effect.fail(
      new WriteError({
        kind: 'op_failed',
        message: `authz binding: batch report_hash ≠ current map hash (stale/unbound batch)`,
      }),
    );
  }
  if (authz.report_hash !== cap.report_hash) {
    return Effect.fail(
      new WriteError({
        kind: 'op_failed',
        message: `authz binding: batch report_hash ≠ capability report_hash (confused-deputy)`,
      }),
    );
  }
  if (authz.authz_decision_id !== cap.authz_decision_id) {
    return Effect.fail(
      new WriteError({
        kind: 'op_failed',
        message: `authz binding: batch authz_decision_id ≠ capability authz_decision_id (replay against a different/revoked decision)`,
      }),
    );
  }
  if (authz.transition_version !== cap.transition_version) {
    return Effect.fail(
      new WriteError({
        kind: 'op_failed',
        message: `authz binding: batch transition_version ≠ capability transition_version`,
      }),
    );
  }
  return Effect.void;
}

// ─── The wrapper Layer factory (SDD §4.4.3) ──────────────────────────────────

/**
 * Build the `GateCheckedRoleWriter` Layer.
 *
 * @param mode  the SHARED `ModeControl` (the apply_mode `Ref` + the batch-
 *              duration read-lock). The writer reads the `Ref` AT INVOCATION
 *              (R-10) and holds the SHARED lock for the whole batch (B5) — a
 *              `rollback` that takes the same lock (`rollbackUnderLock`, go-live.ts)
 *              therefore serializes to a batch boundary, never mid-batch.
 * @param currentMapHash  a thunk resolving `roleMapVersionHash(current map)` —
 *                 read fresh per applyBatch so the authz-binding guard checks the
 *                 CURRENT map (not a captured value).
 *
 * The inner `RoleWriter`, `AcvpEmitter`, and `WorldLock` are pulled from context
 * (the actor supplies them as Layers) — this Layer composes them; it does NOT
 * capture them at build time in a way that bypasses the gate.
 */
export function makeGateCheckedRoleWriter(
  mode: ModeControl,
  currentMapHash: () => string,
): Layer.Layer<GateCheckedRoleWriter, never, RoleWriter | AcvpEmitter | WorldLock> {
  return Layer.effect(
    GateCheckedRoleWriter,
    Effect.gen(function* () {
      const inner = yield* RoleWriter;
      const emitter = yield* AcvpEmitter;
      const worldLock = yield* WorldLock;

      const emitConfirmed = (event: ShadowEvent): Effect.Effect<void, AuditError> =>
        emitter.emitConfirmed(event);

      const service: GateCheckedRoleWriterService = {
        applyBatch: (batch, cap, priorState) =>
          // B5: hold the SHARED mode read-lock for the ENTIRE batch.
          mode.withModeLock(
            Effect.gen(function* () {
              // R-10: read apply_mode AT INVOCATION (never captured at build).
              const mode_value = yield* Ref.get(mode.ref);

              if (mode_value === 'SHADOW') {
                // SHADOW ⇒ ZERO inner writes. Per attempted op, confirm a
                // rejection event, then fail loud. The FIRST op's rejection is
                // confirmed before the typed failure returns; we confirm a
                // rejection for EACH op so the trace shows one rejection per
                // attempted write (the §8.4 invariant).
                for (const op of batch.ops) {
                  const f = intentFields(op);
                  yield* emitConfirmed({
                    event_type: SHADOW_ROLE_REJECTED,
                    payload: {
                      world: batch.world,
                      op_id: f.op_id,
                      kind: f.kind,
                      role_key: f.role_key,
                      member_id: f.member_id,
                      apply_mode: 'SHADOW',
                    },
                  }).pipe(
                    Effect.mapError(
                      (e) =>
                        new WriteError({
                          kind: 'audit_unavailable',
                          message: `rejection audit failed: ${e.message}`,
                        }),
                    ),
                  );
                }
                return yield* Effect.fail(
                  new ShadowGateRejected({
                    world: batch.world,
                    message: 'write attempted under SHADOW — apply_mode is not LIVE',
                  }),
                );
              }

              // LIVE path. First the confused-deputy / replay guard (B3/B14).
              yield* assertAuthzBound(batch.authz, cap, currentMapHash());

              return yield* applyLiveBatch({
                batch,
                cap,
                priorState,
                inner,
                emitConfirmed,
                worldLock,
              });
            }),
          ),
      };

      return service;
    }),
  );
}

// ─── The LIVE apply loop (SDD §4.4.1/§4.4.3) ─────────────────────────────────

interface ApplyLiveDeps {
  readonly batch: WriteIntentBatch;
  readonly cap: WriteCapability;
  readonly priorState: ApplyBatchResult | undefined;
  readonly inner: Context.Tag.Service<RoleWriter>;
  readonly emitConfirmed: (event: ShadowEvent) => Effect.Effect<void, AuditError>;
  readonly worldLock: Context.Tag.Service<WorldLock>;
}

type OpStatus = { op_id: string; status: 'pending' | 'ok' | 'failed'; error?: string };
type LedgerEntry = { role_key: string; role_id: RoleId; op_id: string };

function applyLiveBatch(
  deps: ApplyLiveDeps,
): Effect.Effect<ApplyBatchResult, WriteError, never> {
  const { batch, cap, priorState, inner, emitConfirmed, worldLock } = deps;

  return Effect.gen(function* () {
    // Reconciliation: ops already `ok` in a prior run are SKIPPED (idempotent).
    const priorOk = new Set(
      (priorState?.op_status ?? [])
        .filter((s) => s.status === 'ok')
        .map((s) => s.op_id),
    );
    // The roles_created ledger carries forward across retries so check-then-
    // create never double-creates.
    const ledger: LedgerEntry[] = [...(priorState?.roles_created ?? [])];
    const ledgerByKey = new Map(ledger.map((e) => [e.role_key, e]));
    const opStatus: OpStatus[] = [];

    for (const op of batch.ops) {
      if (priorOk.has(op.op_id)) {
        // already done in a prior run — skip (no re-write, no re-audit).
        opStatus.push({ op_id: op.op_id, status: 'ok' });
        continue;
      }

      const f = intentFields(op);

      // AUDIT FIRST (write-after-audit, CLUSTER 4): confirm the intent BEFORE
      // the write. A failed confirm ⇒ WriteError("audit_unavailable") and the
      // write does NOT run. This fails the WHOLE batch loud (no un-audited LIVE
      // write) — it is NOT a per-op partial failure.
      yield* emitConfirmed({
        event_type: SHADOW_ROLE_INTENT,
        payload: {
          world: batch.world,
          op_id: f.op_id,
          kind: f.kind,
          role_key: f.role_key,
          member_id: f.member_id,
          report_hash: batch.report_hash,
        },
      }).pipe(
        Effect.mapError(
          (e) =>
            new WriteError({
              kind: 'audit_unavailable',
              message: `intent audit failed before write — write blocked: ${e.message}`,
            }),
        ),
      );

      // The write. Create-ops are serialized per world via the WorldLock and do
      // check-then-create against the ledger (B10); assigns are naturally
      // idempotent. A 429 (rate_limited) or op_failed is a PER-OP failure that
      // does NOT abort the batch (partial_failure); audit_unavailable already
      // short-circuited above.
      const opResult = yield* runOp({
        op,
        cap,
        world: batch.world,
        inner,
        worldLock,
        ledgerByKey,
        ledger,
      }).pipe(
        Effect.map((roleId) => ({ ok: true as const, roleId })),
        // Recover per-op WriteError into a recorded failure (partial_failure)
        // EXCEPT audit_unavailable which must fail the batch (handled above; a
        // write-time audit_unavailable cannot occur here).
        Effect.catchTag('WriteError', (e) =>
          e.kind === 'audit_unavailable'
            ? Effect.fail(e)
            : Effect.succeed({ ok: false as const, error: `${e.kind}: ${e.message}` }),
        ),
      );

      if (opResult.ok) {
        opStatus.push({ op_id: op.op_id, status: 'ok' });
        // applied event AFTER a successful write.
        const roleId = opResult.roleId;
        yield* emitConfirmed({
          event_type: SHADOW_ROLE_APPLIED,
          payload: {
            world: batch.world,
            op_id: f.op_id,
            kind: f.kind,
            role_key: f.role_key,
            member_id: f.member_id,
            role_id: roleId,
            actor: batch.authz.actor,
          },
        }).pipe(
          // an applied-event confirm failure does not un-do the write; record it
          // but keep the op `ok` (the write already happened + the intent is
          // audited). Surface as a failed op only if you want stricter semantics;
          // MVP keeps the op ok and ignores the post-write audit hiccup.
          Effect.catchAll(() => Effect.void),
        );
      } else {
        opStatus.push({ op_id: op.op_id, status: 'failed', error: opResult.error });
      }
    }

    const completed = opStatus.filter((s) => s.status === 'ok').length;
    const failed = opStatus.filter((s) => s.status === 'failed').length;
    const status: GoLiveJobState['status'] =
      failed === 0 ? 'done' : completed === 0 ? 'failed' : 'partial_failure';

    return {
      status,
      progress: { total: batch.ops.length, completed, failed },
      roles_created: ledger,
      op_status: opStatus,
    } satisfies ApplyBatchResult;
  });
}

interface RunOpDeps {
  readonly op: WriteOp;
  readonly cap: WriteCapability;
  readonly world: WorldSlug;
  readonly inner: Context.Tag.Service<RoleWriter>;
  readonly worldLock: Context.Tag.Service<WorldLock>;
  readonly ledgerByKey: Map<string, LedgerEntry>;
  readonly ledger: LedgerEntry[];
}

/**
 * Run a single op. `create_role` runs inside the per-world lock with
 * check-then-create against the ledger (B10) — exactly one create per role_key
 * per world even under concurrent batches. `assign_role` is naturally idempotent
 * (re-assign is a no-op at Discord) and needs no world lock. Returns the role id
 * (the created/looked-up id for creates; an empty `RoleId` for assigns since the
 * port's assign returns void).
 */
function runOp(deps: RunOpDeps): Effect.Effect<RoleId | undefined, WriteError> {
  const { op, cap, world, inner, worldLock, ledgerByKey, ledger } = deps;

  if (op.kind === 'create_role') {
    // Serialize the entire check-then-create span per world (B10).
    return worldLock.withWorldLock(
      world,
      Effect.gen(function* () {
        // check: a role already created for this key? reuse it (idempotent).
        const existing = ledgerByKey.get(op.intent.role_key);
        if (existing !== undefined) {
          return existing.role_id;
        }
        // create.
        const roleId = yield* inner.createRole(cap, op.intent as never).pipe(
          // a ShadowGateRejected from the inner LIVE writer should never happen
          // (we only get here under LIVE); normalize it to op_failed.
          Effect.catchTag('ShadowGateRejected', (e) =>
            Effect.fail(new WriteError({ kind: 'op_failed', message: e.message })),
          ),
        );
        const entry: LedgerEntry = { role_key: op.intent.role_key, role_id: roleId, op_id: op.op_id };
        ledger.push(entry);
        ledgerByKey.set(op.intent.role_key, entry);
        return roleId;
      }),
    );
  }

  // assign_role — idempotent; no world lock needed.
  return inner.assignRole(cap, op.intent as never).pipe(
    Effect.catchTag('ShadowGateRejected', (e) =>
      Effect.fail(new WriteError({ kind: 'op_failed', message: e.message })),
    ),
    Effect.as(undefined),
  );
}
