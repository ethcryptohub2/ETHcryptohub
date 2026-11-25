-- Read-only verification for migration 202611060004_subscriptions.sql.
SELECT to_regclass('public.subscription_plans') AS subscription_plans,
       to_regclass('public.subscriptions') AS subscriptions;

SELECT plan_key, plan_name, duration_days, price_usd
  FROM public.subscription_plans
 ORDER BY duration_days;
