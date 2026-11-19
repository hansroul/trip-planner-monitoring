-- =====================================================================================
-- CONTRAT DE DONNÉES entre PoppyTrip et le site de suivi (documentation, NON exécuté).
-- =====================================================================================
-- Les 12 vues ci-dessous sont créées par l'application principale dans le schéma public.
-- Le site de suivi les lit avec le rôle monitoring_reader (SELECT sur ces vues uniquement,
-- lecture seule). Il n'accède JAMAIS aux tables de PoppyTrip. Aucune vue ne contient de
-- donnée personnelle : comptages, montants et une clé d'abonnement opaque.
--
-- Les requêtes du site (src/server/data/queries.ts) n'utilisent que ces vues et ces colonnes ;
-- un test le vérifie. La taille actuelle de la base se lit avec pg_database_size().
-- Jours : jour local dans le fuseau de PoppyTrip (Europe/Brussels) ; timestamptz : instants.

-- 1. Une ligne par jour.
-- public.monitoring_daily_metrics (
--   day                  date,
--   signups              integer,
--   account_deletions    integer,
--   active_users         integer,
--   trips_created        integer,
--   trips_from_template  integer,
--   assistant_requests   integer,
--   credits_consumed     integer,
--   voice_transcriptions integer,
--   paywall_trip_limit   integer,
--   paywall_credits      integer,
--   db_size_bytes        bigint,   -- NULL tant que non mesuré
--   storage_bytes        bigint    -- NULL tant que non mesuré
-- )

-- 2. Un événement d'abonnement par ligne (trier par occurred_at).
-- public.monitoring_subscription_events (
--   occurred_at      timestamptz,
--   event_type       text,     -- created | cancel_requested | canceled | reactivated | renewed | payment_failed | plan_changed
--   plan             text,
--   billing_interval text,     -- month | year
--   amount_cents     integer,  -- peut être NULL
--   currency         text,     -- peut être NULL
--   subscription_key text      -- identifiant opaque (HMAC), stable par abonnement
-- )

-- 3. Abonnements actuels par offre et statut.
-- public.monitoring_subscriptions_current (
--   plan             text,
--   billing_interval text,
--   status           text,     -- active | trialing | past_due | canceled
--   count            bigint
-- )

-- 4. Coûts de l'IA par jour, fournisseur et modèle.
-- public.monitoring_ai_costs_daily (
--   day           date,
--   provider      text,      -- valeur Anthropic : ANTHROPIC_PROVIDER_LABEL (« anthropic »)
--   model         text,
--   requests      bigint,
--   input_tokens  bigint,
--   output_tokens bigint,
--   cost_usd      numeric
-- )

-- 5. Achats de packs de crédits par jour.
-- public.monitoring_credit_purchases_daily (
--   day          date,
--   packs        bigint,
--   amount_cents bigint,
--   currency     text
-- )

-- 6. Entonnoir par cohorte d'inscription.
-- public.monitoring_funnel_cohort_daily (
--   signup_day      date,
--   signups         bigint,
--   with_first_trip bigint,
--   activated       bigint,   -- au moins 3 activités
--   hit_paywall     bigint,
--   subscribed      bigint
-- )

-- 7. Plus grosses tables.
-- public.monitoring_table_sizes (
--   table_name  text,
--   total_bytes bigint
-- )

-- 8. Une seule ligne.
-- public.monitoring_meta (
--   instrumented_since date   -- avant cette date, l'historique est incomplet
-- )

-- 9. Appareils et navigateurs des sessions authentifiées, par jour.
-- public.monitoring_clients_daily (
--   day           date,
--   device_type   text,   -- mobile | tablet | desktop | other
--   os_family     text,
--   browser_name  text,
--   browser_major text,
--   sessions      integer
-- )

-- 10. Connectés maintenant (une ligne).
-- public.monitoring_presence_current (
--   connected_users integer,
--   as_of           timestamptz   -- NULL si aucune mesure
-- )

-- 11. Présence par heure.
-- public.monitoring_presence_hourly_v (
--   hour       timestamptz,
--   avg_users  numeric,
--   peak_users integer
-- )

-- 12. Présence par jour local.
-- public.monitoring_presence_daily (
--   day        date,
--   peak_users integer,
--   peak_hour  timestamptz,
--   avg_users  numeric
-- )
