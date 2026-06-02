/**
 * pure/index.ts — barrel for the four PURE functions (SDD §4.2). Each is
 * data-in → data-out, NO Layers, NO Effect requirement channel (except
 * `transition`'s `GuardFailed` error channel), deterministic, testable with no
 * mocks.
 */
export { roleMapVersionHash } from './role-map-version-hash.js';
export type { RoleMapVersionInput, WorldConfigHashFields } from './role-map-version-hash.js';
export { computeProposed } from './compute-proposed.js';
export type { ProposedMembership } from './compute-proposed.js';
export { diff } from './diff.js';
export type { DiffOptions, LatentCounts } from './diff.js';
export { transition } from './transition.js';
