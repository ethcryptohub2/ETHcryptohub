-- Grants only the atomic authorization entrypoint to Supabase's server role.
-- The function remains unavailable to PUBLIC, anon, and authenticated clients.
GRANT EXECUTE ON FUNCTION public.authorize_admin_demo_test_action(INTEGER, BIGINT, BIGINT, TEXT)
    TO service_role;
