/**
 * Engine-local types. Re-exports the protocol Surface/SurfaceConfig and adds
 * the action enum used by the store/history.
 */
export type ConfigAction = 'CREATE' | 'UPDATE' | 'RESTORE';

export type { Surface, SurfaceConfig, SurfaceConfigMap, VerifyMessageConfig, Theme } from '@freeside-worlds/config-protocol';
