/**
 * primitives.ts — the BLOCKER-1 bounded-string write-side hardening primitive.
 *
 * ── GROUNDING NOTE (SDD §1.4 vs repo reality) ───────────────────────────────
 * The SDD/sprint say to "reuse `BoundedString` from
 * `packages/config-protocol/surface-config.ts`". In repo reality, that package
 * declares `BoundedString`/`NonEmptyBounded` as MODULE-PRIVATE consts (NOT
 * exported — see surface-config.ts ~line 90/101; the barrel `index.ts` only
 * re-exports the public schema/types). So they cannot be imported.
 *
 * Per the dispatch's allowance ("import BoundedString from config-protocol OR
 * define a local one and note it"), this module defines a BYTE-IDENTICAL local
 * copy: same `CONTROL_OR_ZEROWIDTH` regex (same `\u` ranges), same `filter`
 * message, same `S.maxLength`/`S.minLength` composition. This PRESERVES the
 * one-way dependency arrow `shadow-substrate → config-protocol` (SDD §1.4): the
 * substrate does NOT import config-protocol for this; instead S2 RE-EXPORTS
 * these substrate payload schemas INTO config-protocol. Making config-protocol
 * export `BoundedString` (so both share one definition) is a S2 refactor the
 * substrate must not force by reaching backwards.
 *
 * Source of truth for the byte-identity:
 *   freeside-worlds/packages/config-protocol/surface-config.ts (BLOCKER-1).
 */
import { Schema as S } from '@effect/schema';

/**
 * Reject C0 control bytes (0x00–0x1F), DEL (0x7F), C1 control bytes
 * (0x80–0x9F), and zero-width Cf characters. Built from `\u` escapes via
 * `new RegExp` so the source carries NO raw control bytes (diff-clean).
 * Zero-width set (Cf): U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+FEFF.
 *
 * Byte-identical to config-protocol/surface-config.ts `CONTROL_OR_ZEROWIDTH`.
 */
const CONTROL_OR_ZEROWIDTH = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]',
);

/**
 * A length-capped string that rejects control bytes + zero-width chars. The
 * single BLOCKER-1 write-side string primitive — every CM-editable / stored
 * string field is built from this so length + control-byte defense is
 * impossible to forget per-field.
 *
 * Byte-identical to config-protocol/surface-config.ts `BoundedString`.
 */
export const BoundedString = (max: number) =>
  S.String.pipe(
    S.maxLength(max),
    S.filter((s): true | string =>
      CONTROL_OR_ZEROWIDTH.test(s)
        ? 'string contains a control byte or zero-width character (rejected)'
        : true,
    ),
  );

/** Non-empty bounded string (ids, names, required copy). */
export const NonEmptyBounded = (max: number) => BoundedString(max).pipe(S.minLength(1));

// Field-specific caps (mirrors config-protocol's BLOCKER-1 length bounds).
export const ID_MAX = 200;
export const NAME_MAX = 200;
export const DESCRIPTION_MAX = 1000;
export const PROP_STRING_MAX = 4000;
