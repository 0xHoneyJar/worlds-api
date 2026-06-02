/**
 * transition.ts — PURE `transition(applyMode, event, guardInputs)` (SDD §4.1/§4.2).
 *
 * The only safety-bearing state machine. PURE: a decision over ALREADY-RESOLVED
 * guard inputs (`{ report_hash, current_map_hash, authz_decision }`) — it does
 * NO I/O. Authz is resolved by the `resolveAuthz` service preflight (S2) and the
 * boolean result is passed IN; `transition` never touches identity-api (HC5).
 *
 * Returns `Effect<ApplyMode, GuardFailed>`:
 *   - guard failures (FR-7/FR-10) fail loud in the TYPED error channel as
 *     `GuardFailed` with one of the §7.1 reasons.
 *   - structurally-illegal (source-state, event) pairs are a DEFECT — they
 *     `Effect.die` (unrecoverable programmer error) rather than pollute the
 *     typed guard-failure channel with a non-§7.1 reason. The lens fires only
 *     legal events for the current state; an illegal pair is a bug, surfaced
 *     loud, never a silently-swallowed no-op.
 *
 * State machine (SDD §4.1):
 *   install   : → SHADOW                     [CM authorized]
 *   bind_map  : SHADOW → SHADOW (self-loop)   [no mode change]
 *   go_live   : SHADOW → LIVE                 [HARD: report_hash == current_map_hash] AND [CM authorized]
 *   rollback  : LIVE → SHADOW (instant)       [always allowed]
 *   uninstall : SHADOW|LIVE → SHADOW          [teardown, non-destructive — ends in the no-write mode]
 *
 * NOTE on the SOFT 2-week soak (FR-7): it is a SURFACED ADVISORY, NEVER a
 * GuardFailed. `guardInputs.soak_satisfied === false` does NOT fail go_live —
 * the transition still succeeds; the lens surfaces the advisory. The roster-
 * freshness guard (`GuardFailed("roster_drift")`, B1) is resolved at go_live in
 * S1; its reason code is already in the §7.1 ADT.
 */
import { Effect } from 'effect';
import { GuardFailed } from '../errors.js';
import type { ApplyMode, TransitionEvent, GuardInputs } from '../types.js';

export function transition(
  applyMode: ApplyMode,
  event: TransitionEvent,
  guardInputs: GuardInputs,
): Effect.Effect<ApplyMode, GuardFailed> {
  switch (event) {
    case 'install': {
      // Valid from either state (re-install). CM must be authorized (FR-10).
      if (!guardInputs.authz_decision) {
        return Effect.fail(
          new GuardFailed({
            reason: 'not_authorized',
            message: 'you are not an admin for this world',
          }),
        );
      }
      return Effect.succeed('SHADOW');
    }

    case 'bind_map': {
      // No state change — validate/stage happens upstream (schema decode). A
      // bind_map is a self-loop in whatever the current mode is (the diagram
      // shows SHADOW→SHADOW; in LIVE it is likewise a no-op mode-wise).
      return Effect.succeed(applyMode);
    }

    case 'go_live': {
      // ONLY legal from SHADOW (the diagram has no LIVE→LIVE go_live). A
      // go_live from LIVE is a defect (the lens should not offer it).
      if (applyMode !== 'SHADOW') {
        return Effect.die(
          new Error(`illegal transition: go_live from ${applyMode} (only SHADOW→LIVE)`),
        );
      }
      // HARD hash-match guard (FR-7) — roster EXCLUDED so it does not flap (§3.3).
      if (guardInputs.report_hash !== guardInputs.current_map_hash) {
        return Effect.fail(
          new GuardFailed({
            reason: 'stale_report',
            message: 're-preview before going live (the role map changed since this report)',
          }),
        );
      }
      // CM authorized (FR-10).
      if (!guardInputs.authz_decision) {
        return Effect.fail(
          new GuardFailed({
            reason: 'not_authorized',
            message: 'you are not an admin for this world',
          }),
        );
      }
      // SOFT soak advisory (FR-7): soak_satisfied === false does NOT fail.
      return Effect.succeed('LIVE');
    }

    case 'rollback': {
      // Always allowed (instant). Only meaningful from LIVE; from SHADOW it is
      // an idempotent no-op (stay SHADOW) — rollback can never be refused.
      return Effect.succeed('SHADOW');
    }

    case 'uninstall': {
      // Teardown — non-destructive (keeps created roles, R-6). End in the
      // no-write mode (SHADOW) so no write window survives an uninstall.
      return Effect.succeed('SHADOW');
    }
  }
}
