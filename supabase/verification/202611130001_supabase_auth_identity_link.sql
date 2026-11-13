SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'users'
   AND column_name IN ('password_hash', 'supabase_user_id')
 ORDER BY column_name;

SELECT conname, contype
  FROM pg_constraint
 WHERE conrelid = 'public.users'::regclass
   AND conname = 'users_supabase_user_id_fkey';

SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename = 'users'
   AND indexname = 'users_supabase_user_id_unique';
