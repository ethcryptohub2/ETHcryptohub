-- Read-only verification for the news platform RLS migration.
SELECT expected.table_name,
       c.oid IS NOT NULL AS table_exists,
       COALESCE(c.relrowsecurity, FALSE) AS row_level_security_enabled,
       COALESCE(c.relforcerowsecurity, FALSE) AS row_level_security_forced
  FROM (VALUES
      ('news_categories'),
      ('news_sources'),
      ('news_articles'),
      ('news_processing_logs'),
      ('news_user_preferences'),
      ('news_notifications'),
      ('platform_settings')
  ) AS expected(table_name)
  LEFT JOIN pg_class AS c
    ON c.oid = to_regclass('public.' || expected.table_name)
 ORDER BY expected.table_name;

SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN (
       'news_categories',
       'news_sources',
       'news_articles',
       'news_processing_logs',
       'news_user_preferences',
       'news_notifications',
       'platform_settings'
   )
 ORDER BY tablename, policyname;

SELECT expected.table_name,
       expected.role_name,
       has_table_privilege(expected.role_name, c.oid, 'SELECT') AS can_select,
       has_table_privilege(expected.role_name, c.oid, 'INSERT') AS can_insert,
       has_table_privilege(expected.role_name, c.oid, 'UPDATE') AS can_update,
       has_table_privilege(expected.role_name, c.oid, 'DELETE') AS can_delete
  FROM (VALUES
      ('news_categories', 'anon'),
      ('news_categories', 'authenticated'),
      ('news_sources', 'anon'),
      ('news_sources', 'authenticated'),
      ('news_articles', 'anon'),
      ('news_articles', 'authenticated'),
      ('news_processing_logs', 'anon'),
      ('news_processing_logs', 'authenticated'),
      ('news_user_preferences', 'anon'),
      ('news_user_preferences', 'authenticated'),
      ('news_notifications', 'anon'),
      ('news_notifications', 'authenticated'),
      ('platform_settings', 'anon'),
      ('platform_settings', 'authenticated')
  ) AS expected(table_name, role_name)
  LEFT JOIN pg_class AS c
    ON c.oid = to_regclass('public.' || expected.table_name)
 ORDER BY expected.table_name, expected.role_name;

SELECT sequence_name,
       has_sequence_privilege('anon', to_regclass('public.' || sequence_name), 'USAGE') AS anon_can_use,
       has_sequence_privilege('authenticated', to_regclass('public.' || sequence_name), 'USAGE') AS authenticated_can_use
  FROM (VALUES
      ('news_categories_id_seq'),
      ('news_sources_id_seq'),
      ('news_articles_id_seq'),
      ('news_processing_logs_id_seq'),
      ('news_notifications_id_seq')
  ) AS expected(sequence_name)
 ORDER BY sequence_name;
