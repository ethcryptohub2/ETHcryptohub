BEGIN;

ALTER TABLE public.users
    ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS supabase_user_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'users_supabase_user_id_fkey'
           AND conrelid = 'public.users'::regclass
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT users_supabase_user_id_fkey
            FOREIGN KEY (supabase_user_id)
            REFERENCES auth.users (id)
            ON DELETE RESTRICT;
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS users_supabase_user_id_unique
    ON public.users (supabase_user_id)
    WHERE supabase_user_id IS NOT NULL;

COMMENT ON COLUMN public.users.supabase_user_id IS
    'Verified Supabase Auth identity linked to this preserved application profile.';
COMMENT ON COLUMN public.users.password_hash IS
    'Legacy password hash; Supabase Auth is the login authority.';

COMMIT;
