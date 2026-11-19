-- DÉVELOPPEMENT UNIQUEMENT : même politique que ops/monitoring-roles.sql de PoppyTrip.
-- monitoring_reader : SELECT sur les 12 vues du contrat, une par une, et rien d'autre.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM monitoring_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA dev_fake FROM monitoring_reader, monitoring_app_rw;
REVOKE ALL ON SCHEMA dev_fake FROM monitoring_reader, monitoring_app_rw;

GRANT SELECT ON public.monitoring_daily_metrics TO monitoring_reader;
GRANT SELECT ON public.monitoring_subscription_events TO monitoring_reader;
GRANT SELECT ON public.monitoring_subscriptions_current TO monitoring_reader;
GRANT SELECT ON public.monitoring_ai_costs_daily TO monitoring_reader;
GRANT SELECT ON public.monitoring_credit_purchases_daily TO monitoring_reader;
GRANT SELECT ON public.monitoring_funnel_cohort_daily TO monitoring_reader;
GRANT SELECT ON public.monitoring_table_sizes TO monitoring_reader;
GRANT SELECT ON public.monitoring_meta TO monitoring_reader;
GRANT SELECT ON public.monitoring_clients_daily TO monitoring_reader;
GRANT SELECT ON public.monitoring_presence_current TO monitoring_reader;
GRANT SELECT ON public.monitoring_presence_hourly_v TO monitoring_reader;
GRANT SELECT ON public.monitoring_presence_daily TO monitoring_reader;

-- Une table « de PoppyTrip » factice dans public, que le rôle de lecture NE DOIT PAS pouvoir lire
-- (vérifié par les tests).
CREATE TABLE IF NOT EXISTS public.users (id bigserial PRIMARY KEY, email text NOT NULL);
REVOKE ALL ON public.users FROM monitoring_reader, monitoring_app_rw;
