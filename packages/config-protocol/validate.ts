/**
 * validate.ts — surface-config validator
 *
 * Compiles surface-config.schema.json with Ajv (Draft 2020-12 + formats),
 * mirroring packages/registry/bin/validate.ts. This is the SERVICE-BOUNDARY
 * gate: the config service validates an incoming config payload BEFORE it
 * writes to the head pointer (fail-closed on write). Reads are trusted
 * (fail-soft) — already-validated data is returned as-is.
 *
 * Usage (library):
 *   import { validateSurfaceConfig } from "@freeside-worlds/config-protocol/validate";
 *   const result = validateSurfaceConfig(envelope);
 *   if (!result.ok) { ... result.errors ... }
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Surface, SurfaceConfig, SurfaceConfigMap } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, 'surface-config.schema.json');

let _validate: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (!_validate) {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    _validate = ajv.compile(schema);
  }
  return _validate;
}

export interface ValidationOk<S extends Surface> {
  ok: true;
  value: SurfaceConfig<S>;
}

export interface ValidationErr {
  ok: false;
  errors: { instancePath: string; message: string; params?: unknown }[];
}

export type ValidationResult<S extends Surface> = ValidationOk<S> | ValidationErr;

/** Validate a full SurfaceConfig envelope against the sealed schema. */
export function validateSurfaceConfig<S extends Surface = Surface>(
  candidate: unknown,
): ValidationResult<S> {
  const validate = getValidator();
  const ok = validate(candidate);
  if (ok) {
    return { ok: true, value: candidate as SurfaceConfig<S> };
  }
  return {
    ok: false,
    errors: (validate.errors ?? []).map((e: ErrorObject) => ({
      instancePath: e.instancePath || '/',
      message: e.message ?? 'invalid',
      params: e.params,
    })),
  };
}

/**
 * Validate just the inner `config` payload for a given surface by wrapping it
 * in a minimal envelope. Used by the PUT handler when the caller sends only
 * `{ config }` and the (world, surface) come from the URL path.
 */
export function validateSurfacePayload<S extends Surface>(
  world_slug: string,
  surface: S,
  config: SurfaceConfigMap[S],
): ValidationResult<S> {
  return validateSurfaceConfig<S>({
    schema_version: '1.0',
    world_slug,
    surface,
    config,
  });
}
