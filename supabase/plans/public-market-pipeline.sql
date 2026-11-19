-- REVIEW DRAFT ONLY. Outside automatic migrations; NOT APPLIED.
-- Requires verified Staging backup/recovery and explicit schema/grant approval.
CREATE SCHEMA IF NOT EXISTS smartexit_private;
REVOKE ALL ON SCHEMA smartexit_private FROM PUBLIC, anon, authenticated;
CREATE TABLE smartexit_private.public_market_streams (
  source_id TEXT PRIMARY KEY CHECK (source_id = 'BINANCE_USDM_STAGING'),
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  cursor JSONB NOT NULL CHECK (jsonb_typeof(cursor)='object' AND octet_length(cursor::text)<=4096),
  checkpoint JSONB NOT NULL CHECK (jsonb_typeof(checkpoint)='object' AND octet_length(checkpoint::text)<=4194304),
  last_batch_id TEXT NOT NULL CHECK (last_batch_id ~ '^[a-f0-9]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE smartexit_private.public_market_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartexit_private.public_market_streams FORCE ROW LEVEL SECURITY;
REVOKE ALL ON smartexit_private.public_market_streams FROM PUBLIC, anon, authenticated;
-- No roles, grants, policies, SECURITY DEFINER RPCs or data seeds are activated.
-- A future narrowly scoped server role/policy design needs separate review.
-- Cursor and projection are updated in one transaction by an unwired adapter.
