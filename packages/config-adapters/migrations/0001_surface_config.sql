-- 0001_surface_config.sql
--
-- C-1 extraction: ports Jani's sietch ConfigService machinery
-- (themes/sietch/src/services/config/ConfigService.ts + its SQLite schema)
-- into freeside-worlds as a PostgreSQL config store.
--
-- TWO TABLES, the head-pointer + append-only pattern:
--   1. current_config  — O(1) head pointer, one row per (world_slug, surface),
--                        carries `version` for optimistic locking.
--   2. config_record   — append-only audit history; every write inserts a row
--                        with prev_config + new_config + action + actor.
--
-- DIVERGENCE FROM SIETCH (intentional, per C-1 brief "port the MACHINERY,
-- not its exact SQL"):
--   * sietch keyed by single `server_id` (Discord guild); we key by the
--     composite (world_slug, surface) so one world can have many surfaces.
--   * sietch used a delegated-payload pattern (config_records -> {threshold,
--     featureGate,roleMap}_changes via recordable_type/recordable_id). We
--     inline prev_config/new_config as JSONB on config_record — simpler,
--     self-contained, and matches the brief's spec. The delegated pattern
--     is recoverable later if payloads get large.
--   * SQLite -> PostgreSQL: TEXT json -> JSONB, datetime('now') -> now(),
--     INTEGER version -> INTEGER (unchanged), AUTOINCREMENT -> BIGSERIAL.
--
-- ISOLATION INVARIANT: this is freeside-worlds' OWN store. It NEVER connects
-- to mibera-db, identity-api's spine, or any world's DB. `world_slug` is a
-- REFERENCE to a world-manifest slug, not a foreign key into another DB.

-- ─── action enum ──────────────────────────────────────────────────────────
-- CREATE: first config for this (world, surface).
-- UPDATE: optimistic-locked replace of an existing config.
-- RESTORE: re-point head at a prior config_record's new_config (history rewind;
--          deferred to a follow-up but the enum value is reserved now so the
--          append-only log never needs a migration to add it).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'config_action') THEN
    CREATE TYPE config_action AS ENUM ('CREATE', 'UPDATE', 'RESTORE');
  END IF;
END$$;

-- ─── head pointer ─────────────────────────────────────────────────────────
-- One row per (world_slug, surface). O(1) read. `version` is the optimistic
-- lock counter: every successful UPDATE does `WHERE version = expected` and
-- increments; 0 rows affected -> 409 ConfigVersionConflict.
CREATE TABLE IF NOT EXISTS current_config (
  world_slug      TEXT        NOT NULL,
  surface         TEXT        NOT NULL,
  schema_version  TEXT        NOT NULL DEFAULT '1.0',
  config          JSONB       NOT NULL,
  version         INTEGER     NOT NULL DEFAULT 1,
  last_record_id  BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_slug, surface)
);

-- ─── append-only history ──────────────────────────────────────────────────
-- Every write appends one row. prev_config is NULL on the initial CREATE.
-- NEVER updated or deleted — the audit trail is immutable (the head pointer
-- is the only mutable row; history is write-once).
CREATE TABLE IF NOT EXISTS config_record (
  id           BIGSERIAL     PRIMARY KEY,
  world_slug   TEXT          NOT NULL,
  surface      TEXT          NOT NULL,
  action       config_action NOT NULL,
  prev_config  JSONB,
  new_config   JSONB         NOT NULL,
  actor        TEXT          NOT NULL,
  reason       TEXT,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- History query path: most-recent-first per (world, surface).
CREATE INDEX IF NOT EXISTS idx_config_record_key_created
  ON config_record (world_slug, surface, created_at DESC);

-- last_record_id back-reference (head pointer -> most recent history row).
-- Deferred-FK style: not a hard FK because config_record is append-only and
-- the head pointer is written in the same transaction; a hard FK would force
-- ordering constraints the optimistic-lock UPDATE doesn't need.
