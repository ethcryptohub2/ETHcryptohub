-- Review only. This file is not in the migration chain.
-- Apply only after separate approval for the named Staging project and role.
CREATE TABLE public.scanner_pilot_runs (
    slot_at timestamptz PRIMARY KEY,
    approved_sha text NOT NULL CHECK (approved_sha ~ '^[a-f0-9]{40}$'),
    symbols text[] NOT NULL CHECK (cardinality(symbols) = 3),
    state text NOT NULL DEFAULT 'RUNNING' CHECK (state IN ('RUNNING','COMPLETED','FAILED')),
    started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    finished_at timestamptz,
    failure_code text,
    report jsonb,
    CHECK (
      (state = 'RUNNING' AND finished_at IS NULL AND failure_code IS NULL AND report IS NULL)
      OR (state = 'COMPLETED' AND finished_at IS NOT NULL AND failure_code IS NULL AND report IS NOT NULL)
      OR (state = 'FAILED' AND finished_at IS NOT NULL AND failure_code IS NOT NULL AND report IS NULL)
    )
);

ALTER TABLE public.scanner_pilot_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scanner_pilot_runs FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE public.scanner_pilot_control (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    stopped boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
INSERT INTO public.scanner_pilot_control (singleton) VALUES (true);
ALTER TABLE public.scanner_pilot_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scanner_pilot_control FROM PUBLIC, anon, authenticated, service_role;
-- The exact login role and grants on the existing scanner tables require
-- independent review. Do not grant broader roles or disable existing RLS.
