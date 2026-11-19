-- DÉVELOPPEMENT UNIQUEMENT : fausses tables (schéma dev_fake) et les 12 vues du contrat
-- (schéma public), avec EXACTEMENT les noms et types de colonnes de sql/contract.sql.
-- Comme dans PoppyTrip, les vues s'exécutent avec les droits de leur propriétaire : le rôle de
-- lecture n'a aucun droit sur les tables sources.

CREATE SCHEMA IF NOT EXISTS dev_fake;
REVOKE ALL ON SCHEMA dev_fake FROM PUBLIC;

CREATE TABLE IF NOT EXISTS dev_fake.daily_counters (
  day date PRIMARY KEY,
  signups integer NOT NULL DEFAULT 0,
  account_deletions integer NOT NULL DEFAULT 0,
  active_users integer NOT NULL DEFAULT 0,
  trips_created integer NOT NULL DEFAULT 0,
  trips_from_template integer NOT NULL DEFAULT 0,
  assistant_requests integer NOT NULL DEFAULT 0,
  credits_consumed integer NOT NULL DEFAULT 0,
  voice_transcriptions integer NOT NULL DEFAULT 0,
  paywall_trip_limit integer NOT NULL DEFAULT 0,
  paywall_credits integer NOT NULL DEFAULT 0,
  db_size_bytes bigint,
  storage_bytes bigint
);

CREATE TABLE IF NOT EXISTS dev_fake.subscription_events (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  event_type text NOT NULL,
  plan text NOT NULL,
  billing_interval text NOT NULL,
  amount_cents integer,
  currency text,
  subscription_key text NOT NULL
);

CREATE TABLE IF NOT EXISTS dev_fake.subscriptions (
  subscription_key text PRIMARY KEY,
  plan text NOT NULL,
  billing_interval text NOT NULL,
  status text NOT NULL
);

CREATE TABLE IF NOT EXISTS dev_fake.ai_costs (
  day date NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  requests bigint NOT NULL,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cost_usd numeric(14, 6) NOT NULL,
  PRIMARY KEY (day, provider, model)
);

CREATE TABLE IF NOT EXISTS dev_fake.credit_purchases (
  day date PRIMARY KEY,
  packs bigint NOT NULL,
  amount_cents bigint NOT NULL,
  currency text NOT NULL
);

CREATE TABLE IF NOT EXISTS dev_fake.funnel (
  signup_day date PRIMARY KEY,
  signups bigint NOT NULL,
  with_first_trip bigint NOT NULL,
  activated bigint NOT NULL,
  hit_paywall bigint NOT NULL,
  subscribed bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS dev_fake.settings (
  id integer PRIMARY KEY CHECK (id = 1),
  instrumented_since date NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Brussels'
);

CREATE TABLE IF NOT EXISTS dev_fake.clients (
  day date NOT NULL,
  device_type text NOT NULL,
  os_family text NOT NULL,
  browser_name text NOT NULL,
  browser_major text NOT NULL,
  sessions integer NOT NULL,
  PRIMARY KEY (day, device_type, os_family, browser_name, browser_major)
);

CREATE TABLE IF NOT EXISTS dev_fake.presence_instances (
  instance_id text PRIMARY KEY,
  connected_users integer NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS dev_fake.presence_hourly (
  hour timestamptz PRIMARY KEY,
  samples integer NOT NULL,
  sum_users bigint NOT NULL,
  peak_users integer NOT NULL
);

-- --- Les 12 vues du contrat ------------------------------------------------------------

CREATE OR REPLACE VIEW public.monitoring_daily_metrics AS
SELECT day, signups, account_deletions, active_users, trips_created, trips_from_template,
       assistant_requests, credits_consumed, voice_transcriptions, paywall_trip_limit,
       paywall_credits, db_size_bytes, storage_bytes
FROM dev_fake.daily_counters;

CREATE OR REPLACE VIEW public.monitoring_subscription_events AS
SELECT occurred_at, event_type, plan, billing_interval, amount_cents, currency, subscription_key
FROM dev_fake.subscription_events;

CREATE OR REPLACE VIEW public.monitoring_subscriptions_current AS
SELECT plan, billing_interval, status, count(*)::bigint AS count
FROM dev_fake.subscriptions
WHERE status IN ('active', 'trialing', 'past_due', 'canceled')
GROUP BY plan, billing_interval, status;

CREATE OR REPLACE VIEW public.monitoring_ai_costs_daily AS
SELECT day, provider, model, requests, input_tokens, output_tokens, cost_usd
FROM dev_fake.ai_costs;

CREATE OR REPLACE VIEW public.monitoring_credit_purchases_daily AS
SELECT day, packs, amount_cents, currency
FROM dev_fake.credit_purchases;

CREATE OR REPLACE VIEW public.monitoring_funnel_cohort_daily AS
SELECT signup_day, signups, with_first_trip, activated, hit_paywall, subscribed
FROM dev_fake.funnel;

CREATE OR REPLACE VIEW public.monitoring_table_sizes AS
SELECT c.relname::text AS table_name, pg_total_relation_size(c.oid)::bigint AS total_bytes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'dev_fake' AND c.relkind IN ('r', 'p')
ORDER BY 2 DESC
LIMIT 50;

CREATE OR REPLACE VIEW public.monitoring_meta AS
SELECT instrumented_since FROM dev_fake.settings WHERE id = 1;

CREATE OR REPLACE VIEW public.monitoring_clients_daily AS
SELECT day, device_type, os_family, browser_name, browser_major, sessions
FROM dev_fake.clients;

CREATE OR REPLACE VIEW public.monitoring_presence_current AS
SELECT
  COALESCE(sum(connected_users) FILTER (WHERE updated_at > now() - interval '2 minutes'), 0)::integer AS connected_users,
  max(updated_at) AS as_of
FROM dev_fake.presence_instances;

CREATE OR REPLACE VIEW public.monitoring_presence_hourly_v AS
SELECT
  hour,
  CASE WHEN samples > 0 THEN round(sum_users::numeric / samples, 2) ELSE 0 END::numeric(12, 2) AS avg_users,
  peak_users
FROM dev_fake.presence_hourly;

CREATE OR REPLACE VIEW public.monitoring_presence_daily AS
WITH cfg AS (SELECT timezone FROM dev_fake.settings WHERE id = 1),
hours AS (
  SELECT (h.hour AT TIME ZONE cfg.timezone)::date AS day, h.hour, h.peak_users,
         CASE WHEN h.samples > 0 THEN h.sum_users::numeric / h.samples ELSE 0 END AS avg_users
  FROM dev_fake.presence_hourly h CROSS JOIN cfg
)
SELECT day,
       max(peak_users)::integer AS peak_users,
       (array_agg(hour ORDER BY peak_users DESC, hour ASC))[1] AS peak_hour,
       round(avg(avg_users), 2)::numeric(12, 2) AS avg_users
FROM hours
GROUP BY day;
