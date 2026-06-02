/**
 * effectful/write-capability.ts — the `WriteCapability` MINT (SDD §4.4.4, task
 * 402.3, B9 honesty reframe).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * `mintWriteCapability` is the ONLY constructor for a `WriteCapability`. It is
 * exported from this MODULE but DELIBERATELY NOT re-exported from the package
 * barrel (index.ts) — the `tests/exports.test.ts` reachability gate (SDD §8.4
 * proof 1) asserts no `WriteCapability` constructor is reachable through the
 * public surface. Within the substrate, only the authorized SHADOW→LIVE path
 * (the gated writer's go_live mint, ./gate-checked-role-writer.ts) calls it.
 *
 * ── WHAT THIS IS NOT (B9, the load-bearing honesty comment) ──────────────────
 * `WriteCapability` is a COMPILE-TIME accident-prevention seam, NOT a runtime
 * security primitive. An unexported constructor is a MODULE CONVENTION, not an
 * unforgeable runtime secret: same-process code can in principle fabricate a
 * `WriteCapability`-shaped object (a hand-rolled `as` cast, prototype
 * manipulation, bundler aliasing, dynamic import). It exists only to stop an
 * HONEST developer from forgetting the gate — the LIVE `RoleWriter` signature
 * will not type-check without it.
 *
 * THE ENFORCED SECURITY BOUNDARY is `GateCheckedRoleWriter`:
 *   (1) invocation-time `Ref<ApplyMode>` read (under a batch-duration read-lock),
 *   (2) `AuthzContext` validation (server-enforced authz against `admin_principals`,
 *       current + report_hash-matched + authz_decision_id-matched), and
 *   (3) write-after-audit (confirmed `shadow.role.intent.v1` before the write).
 * The capability PREVENTS ACCIDENTS; the gate + server-side authz + the confirmed
 * audit trail ENFORCE the invariant. The §8.4 property test exercises the GATE
 * path under adversarial input — possession of a (forged) token does not bypass
 * the gate's mode/authz/audit checks.
 */
import type { Hex64, WriteCapability } from '../types.js';

/**
 * The brand symbol used by the `WriteCapability` type. We re-declare a local
 * `unique symbol` here and cast through `unknown` — the brand is a phantom
 * marker, never read at runtime; the cast is the standard branded-type mint.
 * (This is exactly why B9 is honest: the brand is not enforceable at runtime.)
 */
const brandKey = Symbol.for('shadow/WriteCapability');

export interface MintWriteCapabilityInput {
  readonly report_hash: Hex64;
  readonly transition_version: number;
  /** B3: the exact `resolveAuthz` decision this capability is bound to. */
  readonly authz_decision_id: string;
}

/**
 * Mint a `WriteCapability`. INTERNAL — see the module header: this constructor
 * is not exported from the package barrel, and only the gated writer's
 * authorized go_live path may call it. Carries `report_hash`,
 * `transition_version`, and `authz_decision_id` (B3) so the gate can assert the
 * batch is bound to THIS authorization (confused-deputy / replay guard).
 */
export function mintWriteCapability(input: MintWriteCapabilityInput): WriteCapability {
  // The brand field is a phantom; the runtime object carries only the data
  // fields. The cast is the branded-type mint (B9: a convention, not a secret).
  return {
    [brandKey]: 'shadow/WriteCapability',
    report_hash: input.report_hash,
    transition_version: input.transition_version,
    authz_decision_id: input.authz_decision_id,
  } as unknown as WriteCapability;
}
