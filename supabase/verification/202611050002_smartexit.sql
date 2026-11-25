-- Read-only verification for migration 202611050002_smartexit.sql.
SELECT to_regclass('public.paper_users') AS paper_users,
       to_regclass('public.paper_sessions') AS paper_sessions,
       to_regclass('public.auth_challenges') AS auth_challenges,
       to_regclass('public.trades') AS trades;
