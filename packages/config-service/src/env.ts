/**
 * env.ts — the single production-signal helper.
 *
 * Both the read-gate (auth.ts `checkServiceToken`) and the JWKS fail-loud
 * (server.ts `resolveTokenVerifier`) branch on "are we in production?". Defining
 * the predicate ONCE here keeps the two fail-closed postures from drifting (a
 * future change to what "production" means — e.g. adding a third env signal —
 * lands in one place and both gates inherit it). FAGAN iter-3 cleanup.
 */

/** True when the process is running in a production posture. */
export function isProduction(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.CONFIG_SERVICE_ENV === 'production'
  );
}
