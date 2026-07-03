-- Durable manifest index (fulfilled-order → world_slug lookup).
-- Replaces the ephemeral container-FS FileManifestStore: without a Railway
-- volume, every fulfilled order's manifest evaporated on the next redeploy.
-- ISOLATION INVARIANT (C-1): freeside-worlds' OWN database only.

CREATE TABLE IF NOT EXISTS manifest_index (
  manifest_ref     TEXT NOT NULL,
  world_slug       TEXT NOT NULL,
  chain_id         TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  order_id         TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  contact_email    TEXT NOT NULL,
  source           TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract_address, order_id)
);

-- Lookup by (chain, contract) returns the earliest manifest for that collection.
CREATE INDEX IF NOT EXISTS manifest_index_contract_idx
  ON manifest_index (chain_id, contract_address, created_at ASC);
