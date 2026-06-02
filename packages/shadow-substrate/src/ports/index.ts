/**
 * ports/index.ts — the I/O seam (SDD §4.3), declared as `Context.Tag`s.
 *
 * SIGNATURES ONLY. The Layer implementations (MOCK + LIVE) are supplied by the
 * consuming lenses (freeside-characters / freeside-dashboard) in S4 — never
 * here. The substrate has NO HTTP/DB/discord.js dependency; that absence is the
 * invariant that makes "SHADOW ⇒ zero writes" provable.
 *
 * Follows the existing persona-engine `ambient/{ports,mock,live}` idiom exactly
 * (`Context.Tag` with a service-shape; `Layer.succeed` mock / `Layer.effect`
 * live at the call site).
 */
import { Context, Effect } from 'effect';
import type { WorldSlug, RoleId, WriteCapability } from '../types.js';
import type { CreateRoleIntent, AssignRoleIntent } from '../types.js';
import type { CurrentRoster } from '../schemas/render-model.js';
import type { RoleRule } from '../schemas/config-surfaces.js';
import type {
  RosterError,
  WriteError,
  ShadowGateRejected,
  ScoreError,
} from '../errors.js';

/**
 * `RosterSource` — reads the current Discord guild roster (roles + members).
 * MOCK returns fixtures (zero Discord calls); LIVE reads the real guild.
 */
export class RosterSource extends Context.Tag('shadow/RosterSource')<
  RosterSource,
  {
    readonly currentRoster: (
      world: WorldSlug,
    ) => Effect.Effect<CurrentRoster, RosterError>;
  }
>() {}

/**
 * `RoleWriter` — the role-mutation port. The GATE is internal
 * (`GateCheckedRoleWriter`, S1); a concrete LIVE adapter is reachable ONLY
 * through it. Every write REQUIRES a `WriteCapability` (a COMPILE-TIME
 * accident-prevention seam — NOT a runtime secret; SDD §4.4.4): a raw write
 * written by mistake will not type-check. The enforced boundary is the gate +
 * server-side authz + write-after-audit, not the token's runtime forgeability.
 */
export class RoleWriter extends Context.Tag('shadow/RoleWriter')<
  RoleWriter,
  {
    readonly createRole: (
      cap: WriteCapability,
      intent: CreateRoleIntent,
    ) => Effect.Effect<RoleId, WriteError | ShadowGateRejected>;
    readonly assignRole: (
      cap: WriteCapability,
      intent: AssignRoleIntent,
    ) => Effect.Effect<void, WriteError | ShadowGateRejected>;
  }
>() {}

/**
 * `ScoreSource` — latent-member numbers (qualified-but-not-joined wallets).
 * MOCKED for the MVP (score-api is not ours; #164/#221). Output feeds the pure
 * `diff` as `latentCounts` data.
 */
export class ScoreSource extends Context.Tag('shadow/ScoreSource')<
  ScoreSource,
  {
    readonly latentQualified: (
      world: WorldSlug,
      rule: RoleRule,
    ) => Effect.Effect<number, ScoreError>;
  }
>() {}
