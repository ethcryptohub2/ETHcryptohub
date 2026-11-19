-- REVIEW DRAFT ONLY. Not in migrations/, not executed by any application script.
-- Requires a separately approved Staging recovery point, role/grant review and
-- transactional database journal adapter before any worker or paper activation.
BEGIN;
CREATE SCHEMA IF NOT EXISTS smartexit_private;
REVOKE ALL ON SCHEMA smartexit_private FROM PUBLIC, anon, authenticated;

CREATE TABLE smartexit_private.paper_account_states (
  tenant_user_id BIGINT PRIMARY KEY REFERENCES public.users(id),
  revision BIGINT NOT NULL CHECK (revision >= 0),
  state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (state ? 'tenantId' AND jsonb_typeof(state->'tenantId') = 'number'
    AND (state->>'tenantId')::BIGINT = tenant_user_id),
  CHECK (state ? 'revision' AND jsonb_typeof(state->'revision') = 'number'
    AND (state->>'revision')::BIGINT = revision)
);
-- Atomic repository requirement: SELECT ... FOR UPDATE per tenant, validate
-- the authenticated actor, then compare revision and update in one transaction.
-- No credential fields are permitted in the state contract.

CREATE TABLE smartexit_private.research_decisions (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('STANDARD','HIGH_RISK')),
  classification TEXT NOT NULL CHECK (classification IN ('WATCH','READY_FOR_RESEARCH','REJECTED')),
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > observed_at),
  reasons JSONB NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object')
);

ALTER TABLE smartexit_private.paper_account_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartexit_private.paper_account_states FORCE ROW LEVEL SECURITY;
ALTER TABLE smartexit_private.research_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartexit_private.research_decisions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA smartexit_private FROM PUBLIC, anon, authenticated;
-- Intentionally no browser policies or app grants. Default deny remains until
-- reviewed worker permissions and the custom-app identity boundary are approved.
-- service_role/postgres bypass RLS; application tenant checks are still mandatory.
COMMIT;
