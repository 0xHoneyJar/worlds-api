/**
 * transition.test.ts — exhaustive state-machine acceptance gates (401.5).
 *
 *   - exhaustive over the finite event set × both source states.
 *   - go_live HARD hash-match guard: mismatch → GuardFailed("stale_report").
 *   - go_live authz guard: not allowlisted → GuardFailed("not_authorized").
 *   - rollback ALWAYS allowed (from LIVE and SHADOW).
 *   - soft 2-week soak is advisory — soak_satisfied:false NEVER fails.
 *   - structurally-illegal transitions fail loud (defect), never a silent no-op.
 *
 * PURE — `transition` returns an Effect over already-resolved guard inputs; we
 * run it with `Effect.runSyncExit`. NO Layers, NO mocks.
 */
import { describe, expect, test } from 'bun:test';
import { Effect, Exit, Cause } from 'effect';
import { transition } from '../src/pure/transition.js';
import { GuardFailed } from '../src/errors.js';
import type { ApplyMode, GuardInputs, TransitionEvent } from '../src/types.js';

const HASH_A = 'a'.repeat(64) as GuardInputs['report_hash'];
const HASH_B = 'b'.repeat(64) as GuardInputs['report_hash'];

const authorizedMatch: GuardInputs = {
  report_hash: HASH_A,
  current_map_hash: HASH_A,
  authz_decision: true,
};

function run(mode: ApplyMode, event: TransitionEvent, gi: GuardInputs) {
  return Effect.runSyncExit(transition(mode, event, gi));
}

const ALL_EVENTS: TransitionEvent[] = [
  'install',
  'bind_map',
  'go_live',
  'rollback',
  'uninstall',
];

describe('transition — exhaustive over the finite event set', () => {
  for (const event of ALL_EVENTS) {
    for (const mode of ['SHADOW', 'LIVE'] as ApplyMode[]) {
      test(`(${mode}, ${event}) resolves to a defined outcome`, () => {
        const exit = run(mode, event, authorizedMatch);
        // Every (state, event) must produce a determinate Exit (success OR a
        // typed failure OR a defect) — never hang / never undefined.
        expect(Exit.isExit(exit)).toBe(true);
      });
    }
  }
});

describe('transition — install', () => {
  test('authorized install → SHADOW', () => {
    const exit = run('SHADOW', 'install', authorizedMatch);
    expect(exit).toEqual(Exit.succeed('SHADOW'));
  });
  test('unauthorized install → GuardFailed("not_authorized")', () => {
    const exit = run('SHADOW', 'install', { ...authorizedMatch, authz_decision: false });
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe('Some');
      const e = (err as { value: GuardFailed }).value;
      expect(e).toBeInstanceOf(GuardFailed);
      expect(e.reason).toBe('not_authorized');
    }
  });
});

describe('transition — bind_map is a no-op self-loop', () => {
  test('SHADOW bind_map → SHADOW', () => {
    expect(run('SHADOW', 'bind_map', authorizedMatch)).toEqual(Exit.succeed('SHADOW'));
  });
  test('LIVE bind_map → LIVE (mode unchanged)', () => {
    expect(run('LIVE', 'bind_map', authorizedMatch)).toEqual(Exit.succeed('LIVE'));
  });
});

describe('transition — go_live (the gated SHADOW→LIVE)', () => {
  test('hash match + authorized → LIVE', () => {
    expect(run('SHADOW', 'go_live', authorizedMatch)).toEqual(Exit.succeed('LIVE'));
  });

  test('MISMATCHED report_hash → GuardFailed("stale_report")', () => {
    const exit = run('SHADOW', 'go_live', {
      report_hash: HASH_A,
      current_map_hash: HASH_B,
      authz_decision: true,
    });
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const e = (Cause.failureOption(exit.cause) as { value: GuardFailed }).value;
      expect(e).toBeInstanceOf(GuardFailed);
      expect(e.reason).toBe('stale_report');
    }
  });

  test('hash match but NOT authorized → GuardFailed("not_authorized")', () => {
    const exit = run('SHADOW', 'go_live', { ...authorizedMatch, authz_decision: false });
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const e = (Cause.failureOption(exit.cause) as { value: GuardFailed }).value;
      expect(e.reason).toBe('not_authorized');
    }
  });

  test('stale_report takes precedence and is checked before authz', () => {
    // Both would fail; the hash guard is the HARD FR-7 guard, evaluated first.
    const exit = run('SHADOW', 'go_live', {
      report_hash: HASH_A,
      current_map_hash: HASH_B,
      authz_decision: false,
    });
    if (Exit.isFailure(exit)) {
      const e = (Cause.failureOption(exit.cause) as { value: GuardFailed }).value;
      expect(e.reason).toBe('stale_report');
    } else {
      throw new Error('expected failure');
    }
  });

  test('SOFT soak: soak_satisfied:false does NOT fail go_live (advisory only)', () => {
    const exit = run('SHADOW', 'go_live', { ...authorizedMatch, soak_satisfied: false });
    expect(exit).toEqual(Exit.succeed('LIVE'));
  });

  test('go_live from LIVE is a DEFECT (illegal source state), not a guard failure', () => {
    const exit = run('LIVE', 'go_live', authorizedMatch);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // It dies (defect), not a typed GuardFailed in the error channel.
      expect(Cause.isDie(exit.cause)).toBe(true);
      expect(Cause.failureOption(exit.cause)._tag).toBe('None');
    }
  });
});

describe('transition — rollback is ALWAYS allowed', () => {
  test('LIVE rollback → SHADOW', () => {
    expect(run('LIVE', 'rollback', authorizedMatch)).toEqual(Exit.succeed('SHADOW'));
  });
  test('SHADOW rollback → SHADOW (idempotent no-op; never refused)', () => {
    expect(run('SHADOW', 'rollback', authorizedMatch)).toEqual(Exit.succeed('SHADOW'));
  });
  test('rollback succeeds even when unauthorized + hash mismatch', () => {
    const exit = run('LIVE', 'rollback', {
      report_hash: HASH_A,
      current_map_hash: HASH_B,
      authz_decision: false,
    });
    expect(exit).toEqual(Exit.succeed('SHADOW'));
  });
});

describe('transition — uninstall ends in the no-write mode', () => {
  test('SHADOW uninstall → SHADOW', () => {
    expect(run('SHADOW', 'uninstall', authorizedMatch)).toEqual(Exit.succeed('SHADOW'));
  });
  test('LIVE uninstall → SHADOW (no write window survives)', () => {
    expect(run('LIVE', 'uninstall', authorizedMatch)).toEqual(Exit.succeed('SHADOW'));
  });
});
