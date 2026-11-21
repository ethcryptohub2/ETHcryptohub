-- Review only. Requires the canonical Admin Demo migration and a separately approved role.
-- A future transport must verify the exact Preview approval before calling this function,
-- commit a successful claim before contacting the provider, and never release a consumed claim.
-- The claim table contains approval metadata only. There is no application or browser grant.
BEGIN;
CREATE SCHEMA smartexit_demo_read;
REVOKE ALL ON SCHEMA smartexit_demo_read FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE smartexit_demo_read.claims (
    release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
    provider public.admin_demo_provider NOT NULL CHECK (provider IN ('BINANCE', 'BYBIT', 'OKX', 'GATE')),
    admin_user_id integer NOT NULL CHECK (admin_user_id > 0),
    approved_until timestamptz NOT NULL,
    claimed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (release_sha, provider, admin_user_id, approved_until),
    CHECK (approved_until > claimed_at AND approved_until <= claimed_at + interval '15 minutes')
);
ALTER TABLE smartexit_demo_read.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartexit_demo_read.claims FORCE ROW LEVEL SECURITY;
REVOKE ALL ON smartexit_demo_read.claims FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION smartexit_demo_read.claim_once(
    target_sha text, target_provider public.admin_demo_provider, actor_id integer, expires_at timestamptz
) RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
    WITH inserted AS (
        INSERT INTO smartexit_demo_read.claims (release_sha, provider, admin_user_id, approved_until)
        SELECT target_sha, target_provider, actor_id, expires_at
        WHERE expires_at > statement_timestamp()
          AND expires_at <= statement_timestamp() + interval '15 minutes'
          AND EXISTS (
              SELECT FROM public.admin_demo_identities
              WHERE admin_user_id = actor_id AND admin_scope = 'ADMIN' AND is_active
          )
        ON CONFLICT DO NOTHING
        RETURNING 1
    )
    SELECT EXISTS (SELECT FROM inserted);
$$;
REVOKE ALL ON FUNCTION smartexit_demo_read.claim_once(text, public.admin_demo_provider, integer, timestamptz)
    FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
