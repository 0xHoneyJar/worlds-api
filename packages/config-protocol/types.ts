/**
 * Surface Config — protocol types
 *
 * The TypeScript face of surface-config.schema.json. Ported verbatim from
 * Jani's sietch Theme model (themes/sietch/src/ui/builder/src/types/index.ts)
 * into freeside-worlds (C-1 extraction).
 *
 * FIDELITY NOTE: the Theme / ThemeBranding / PageLayout / ComponentInstance
 * shapes below are Jani's, field-for-field. The only additions are the
 * SurfaceConfig envelope (the (world_slug, surface) keyed wrapper) and the
 * VerifyMessageConfig V1 surface payload — both NEW, not part of sietch.
 *
 * CONVENTION NOTE: freeside-worlds' protocol layer is JSON-Schema-first
 * (Draft 2020-12 + Ajv), NOT Effect.Schema. The cluster's zod->@effect/schema
 * transition applies to identity-api/freeside-auth packages, not here. These
 * types are the hand-written TS face of the sealed JSON Schema, mirroring how
 * packages/registry consumes world-manifest.schema.json. If freeside-worlds
 * later adopts Effect.Schema repo-wide, regenerate these from the .schema.json.
 */

// ─── Jani's sietch Theme model (ported verbatim) ──────────────────────────

export interface ComponentInstance {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: ComponentInstance[];
}

export interface PageLayout {
  id: string;
  name: string;
  slug: string;
  components: ComponentInstance[];
}

export interface ThemeBranding {
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    surface: string;
    text: string;
  };
  fonts: {
    heading: { family: string; weight: number };
    body: { family: string; weight: number };
  };
  borderRadius: 'none' | 'sm' | 'md' | 'lg' | 'full';
  spacing: 'compact' | 'comfortable' | 'spacious';
}

export interface Theme {
  id: string;
  name: string;
  description?: string;
  branding: ThemeBranding;
  pages: PageLayout[];
  createdAt: string;
  updatedAt: string;
}

// ─── NEW: SurfaceConfig envelope + V1 verify-message surface ───────────────

/** The V1 community-manager-editable verify-message surface payload. */
export interface VerifyMessageConfig {
  enabled: boolean;
  copy: {
    title: string;
    body: string;
    buttonLabel: string;
  };
  /** Optional Jani Theme override; omit to inherit the world's default theme. */
  theme?: Theme;
}

/** The known surfaces. Enum-locked; additive minor bumps add surfaces. */
export type Surface = 'verify-message';

/** Map of surface -> its validated config shape. */
export interface SurfaceConfigMap {
  'verify-message': VerifyMessageConfig;
}

/**
 * The wire envelope keyed by (world_slug, surface). `config` is the
 * surface-specific validated payload. Generic by design: surface -> validated
 * JSON, NOT a type per surface table.
 */
export interface SurfaceConfig<S extends Surface = Surface> {
  schema_version: '1.0';
  world_slug: string;
  surface: S;
  config: SurfaceConfigMap[S];
}

export const SURFACE_CONFIG_SCHEMA_VERSION = '1.0' as const;
export const KNOWN_SURFACES: readonly Surface[] = ['verify-message'] as const;
