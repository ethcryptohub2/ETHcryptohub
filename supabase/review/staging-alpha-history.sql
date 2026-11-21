-- Review only. Do not add to the migration chain before Staging-specific approval.
-- smartexit_alpha_history is an independently approved, restricted login role.
BEGIN;
CREATE SCHEMA smartexit_alpha;
REVOKE ALL ON SCHEMA smartexit_alpha FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE smartexit_alpha.observations (
  alpha_id text NOT NULL CHECK (alpha_id ~ '^ALPHA_[0-9]{1,12}$'),
  chain text NOT NULL CHECK (length(chain) BETWEEN 1 AND 40),
  contract text NOT NULL CHECK (contract ~ '^[A-Za-z0-9:._-]{1,128}$'),
  market text NOT NULL CHECK (market = alpha_id || 'USDT' OR market = alpha_id || 'USDC'),
  observed_at timestamptz NOT NULL,
  collected_at timestamptz NOT NULL CHECK (observed_at <= collected_at AND collected_at - observed_at <= interval '60 seconds'),
  measurements jsonb NOT NULL CHECK (jsonb_typeof(measurements) = 'object'
    AND measurements->>'signalStatus' IS NOT DISTINCT FROM 'OBSERVATION_ONLY'),
  PRIMARY KEY (alpha_id, chain, contract, market, observed_at)
);
CREATE INDEX alpha_observation_recency ON smartexit_alpha.observations (collected_at DESC, alpha_id, market);
ALTER TABLE smartexit_alpha.observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartexit_alpha.observations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON smartexit_alpha.observations FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA smartexit_alpha TO smartexit_alpha_history;
GRANT SELECT, INSERT ON smartexit_alpha.observations TO smartexit_alpha_history;
CREATE POLICY alpha_history_read ON smartexit_alpha.observations FOR SELECT TO smartexit_alpha_history USING (true);
CREATE POLICY alpha_history_insert ON smartexit_alpha.observations FOR INSERT TO smartexit_alpha_history
  WITH CHECK (collected_at <= statement_timestamp() AND collected_at >= statement_timestamp() - interval '30 seconds');
COMMIT;
