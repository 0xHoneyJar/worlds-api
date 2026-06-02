# Substrate SHA-bump rollback procedure (B7 / SDD §1.7.1)

`@freeside-worlds/shadow-substrate` is the security boundary, consumed
**git-source / SHA-pinned** by three repos:

- `freeside-worlds` (owner)
- `freeside-characters` (Discord lens)
- `freeside-dashboard` (web lens)

If the three pin **different** substrate SHAs, the web lens, the `AuthzContext`,
and the live writer can silently disagree on schemas, the `roleMapVersionHash`
algorithm, or the `WriteCapability` shape — a dangerous skew on the boundary
that enforces "SHADOW ⇒ zero writes." The MVP therefore ships a **single-SHA
version contract** with this rollback procedure.

## Boundary (what this repo records vs what the orchestrator records)

There are **two** SHAs in play; keep them distinct:

| SHA | Recorded where | Owned by |
|-----|----------------|----------|
| `@0xhoneyjar/events` pin (the substrate's only external dep) | this package's `package.json` (`#68f5a89…`) + asserted by `conformance/check.ts` | the substrate |
| The canonical **substrate** git SHA (what the 3 consumers pin) | `grimoires/loa/cycles/shadow-onboarding-substrate/substrate-sha.lock` in **loa-freeside** | the cycle orchestrator |

> The substrate's own SHA **does not exist until this branch is committed**, so
> the canonical `substrate-sha.lock` is written by the orchestrator AFTER the S0
> commit lands — it is intentionally NOT authored inside this package. This
> package owns the **conformance fixture** (`conformance/fixture.ts`) and the
> **CI compat check** (`conformance/check.ts`); the lockfile recording is the
> orchestrator's act.

## Roll FORWARD (a deliberate substrate SHA bump)

1. Land the substrate change; note the new substrate git SHA.
2. Update `substrate-sha.lock` (loa-freeside cycle artifact) to the new SHA.
3. If the change altered `roleMapVersionHash` output or a boundary schema shape:
   re-freeze `CANONICAL_VERSION_HASH` / `FROZEN_SHAPES` in
   `conformance/fixture.ts` as part of the SAME change.
4. Bump **all three** consumer lockfile pins to the new SHA in lockstep.
5. Run `bun run conformance:check` in each consumer (imports the fixture from
   the pinned substrate) — all three MUST pass.
6. Deploy.

## Roll BACK

1. Revert `substrate-sha.lock` to the prior SHA.
2. Revert the three consumer lockfile pins to the prior SHA.
3. Re-run `bun run conformance:check` in each consumer (must pass against the
   prior fixture).
4. Redeploy.

**Never leave consumers on mixed SHAs.** A mixed state means the boundary types
disagree — the exact skew this contract exists to prevent.
