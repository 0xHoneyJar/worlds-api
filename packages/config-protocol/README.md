# @freeside-worlds/config-protocol

Sealed schema + TS types for **world surface-config** — the runtime-editable,
per-surface config a community manager edits live (copy, theme), keyed by
`(world_slug, surface)`.

C-1 extraction: ports Jani's sietch **Theme model**
(`themes/sietch/src/ui/builder/src/types/index.ts`) verbatim, and the
head-pointer / append-only / optimistic-lock **machinery**
(`themes/sietch/src/services/config/ConfigService.ts`) into freeside-worlds.

## The two faces of a per-world model

| | world-manifest (`packages/protocol`) | surface-config (this package) |
|---|---|---|
| **what** | infra declaration | runtime content |
| **when** | deploy-time (terraform-bound) | live (CM edits) |
| **carries** | hosting, identity, secrets, `tenant_id`, `guild_ids`, `auth` | per-surface `{enabled, copy, theme?}` |
| **key** | `slug` | `(world_slug, surface)` |

surface-config **references** `world_slug` only — it NEVER duplicates the
manifest's `tenant_id` / `guild_ids` / `auth`. Those stay the manifest's
source-of-truth.

## Convention

freeside-worlds' protocol layer is **JSON-Schema-first** (Draft 2020-12 + Ajv),
NOT Effect.Schema. `surface-config.schema.json` is the sealed contract;
`types.ts` is its hand-written TS face (Jani's model, field-for-field).
Validation runs at the **service boundary** (`validate.ts`), mirroring
`packages/registry/bin/validate.ts`. Governance per
`packages/protocol/VERSIONING.md` (enum-locked `schema_version`, additive-only
minor bumps).

## Surfaces (v1.0)

- `verify-message` — `{ enabled, copy: {title, body, buttonLabel}, theme? }`

Adding a surface = additive minor bump (new enum value + new `$defs` block +
new `allOf` discriminator).
