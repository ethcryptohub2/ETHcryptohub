-- Review only. Requires 202611110007 and separately approved Staging installation.
CREATE SCHEMA smartexit_demo_auto;
REVOKE ALL ON SCHEMA smartexit_demo_auto FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE smartexit_demo_auto.controls (
    admin_user_id integer NOT NULL,
    admin_scope text NOT NULL DEFAULT 'ADMIN' CHECK (admin_scope = 'ADMIN'),
    provider public.admin_demo_provider NOT NULL,
    environment text NOT NULL CHECK ((provider = 'GATE' AND environment = 'TESTNET') OR (provider <> 'GATE' AND environment = 'DEMO')),
    account_id uuid NOT NULL,
    credential_id bigint NOT NULL,
    quote_asset text NOT NULL DEFAULT 'USDT' CHECK (quote_asset = 'USDT'),
    enabled boolean NOT NULL DEFAULT false,
    stopped boolean NOT NULL DEFAULT true,
    approved_from timestamptz NOT NULL,
    approved_until timestamptz NOT NULL CHECK (approved_until > approved_from AND approved_until <= approved_from + interval '1 hour'),
    connectivity_verified_at timestamptz NOT NULL CHECK (connectivity_verified_at <= approved_from),
    lifecycle_verified_at timestamptz NOT NULL CHECK (lifecycle_verified_at <= approved_from),
    risk_policy jsonb NOT NULL CHECK (jsonb_typeof(risk_policy) = 'object'),
    PRIMARY KEY (admin_user_id, provider, environment, account_id),
    UNIQUE (provider, environment, account_id),
    UNIQUE (credential_id),
    FOREIGN KEY (credential_id, admin_user_id, admin_scope, provider, environment)
      REFERENCES public.admin_demo_exchange_credentials (id, admin_user_id, admin_scope, provider, environment)
      ON DELETE RESTRICT
);

CREATE TABLE smartexit_demo_auto.reservations (
    id uuid PRIMARY KEY,
    admin_user_id integer NOT NULL,
    provider public.admin_demo_provider NOT NULL,
    environment text NOT NULL,
    account_id uuid NOT NULL,
    client_key text NOT NULL CHECK (client_key ~ '^[A-Za-z0-9_-]{1,36}$'),
    signal_id bigint NOT NULL REFERENCES public.market_signals(id) ON DELETE RESTRICT,
    intent_sha text NOT NULL CHECK (intent_sha ~ '^[a-f0-9]{64}$'),
    approval_sha text NOT NULL CHECK (approval_sha ~ '^[a-f0-9]{64}$'),
    symbol text NOT NULL CHECK (symbol ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
    strategy text NOT NULL CHECK (strategy IN ('STANDARD','HIGH_RISK')),
    direction text NOT NULL CHECK (direction IN ('LONG','SHORT')),
    quantity numeric(30,12) NOT NULL CHECK (quantity > 0),
    entry_price numeric(30,12) NOT NULL CHECK (entry_price > 0),
    stop_price numeric(30,12) NOT NULL CHECK (stop_price > 0),
    notional numeric(65,24) GENERATED ALWAYS AS (quantity * entry_price) STORED,
    maximum_loss numeric(65,24) GENERATED ALWAYS AS (quantity * abs(entry_price - stop_price)) STORED,
    state text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED','DISPATCHING','PROTECTED','RECONCILIATION_REQUIRED','CLOSED')),
    reserved_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK ((direction = 'LONG' AND stop_price < entry_price) OR (direction = 'SHORT' AND stop_price > entry_price)),
    UNIQUE (admin_user_id, provider, environment, account_id, client_key),
    UNIQUE (admin_user_id, provider, environment, account_id, signal_id),
    FOREIGN KEY (admin_user_id, provider, environment, account_id)
      REFERENCES smartexit_demo_auto.controls (admin_user_id, provider, environment, account_id) ON DELETE RESTRICT
);
CREATE INDEX demo_auto_reservations_scope_history ON smartexit_demo_auto.reservations
    (admin_user_id, provider, environment, account_id, reserved_at);

CREATE TABLE smartexit_demo_auto.audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reservation_id uuid NOT NULL REFERENCES smartexit_demo_auto.reservations(id) ON DELETE RESTRICT,
    state text NOT NULL CHECK (state IN ('RESERVED','DISPATCHING','PROTECTED','RECONCILIATION_REQUIRED','CLOSED')),
    recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (reservation_id, state)
);
CREATE FUNCTION smartexit_demo_auto.reject_audit_changes() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'Demo auto-execution audit is append-only';
END;
$$;
CREATE TRIGGER demo_auto_audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON smartexit_demo_auto.audit
    FOR EACH STATEMENT EXECUTE FUNCTION smartexit_demo_auto.reject_audit_changes();

ALTER TABLE smartexit_demo_auto.controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartexit_demo_auto.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartexit_demo_auto.audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartexit_demo_auto.controls FORCE ROW LEVEL SECURITY;
ALTER TABLE smartexit_demo_auto.reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE smartexit_demo_auto.audit FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA smartexit_demo_auto FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA smartexit_demo_auto FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION smartexit_demo_auto.reject_audit_changes() FROM PUBLIC, anon, authenticated, service_role;
-- No execution grants. A dedicated Staging role, RLS policies and a verified
-- account-identity mapping must be independently reviewed before installing a caller.
