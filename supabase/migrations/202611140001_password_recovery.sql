CREATE TABLE IF NOT EXISTS public.auth_password_reset_codes (
    user_id INTEGER PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    code_hash CHAR(64) NOT NULL,
    expires_at BIGINT NOT NULL,
    attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    locked_until BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.auth_password_reset_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auth_password_reset_codes FROM anon, authenticated;
