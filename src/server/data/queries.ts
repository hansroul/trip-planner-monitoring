/**
 * TOUTES les requêtes exécutées avec le rôle de lecture (monitoring_reader). Règles :
 * - uniquement les 12 vues du contrat, toujours qualifiées « public.monitoring_… » ;
 * - SQL paramétré uniquement ($1, $2…) : aucune valeur n'est jamais concaténée ;
 * - requêtes agrégées : le volume renvoyé est borné (au plus quelques milliers de lignes pour
 *   la plage maximale de 2 ans).
 * Paramètres communs : $1 = premier jour, $2 = dernier jour (inclus), $3 = fuseau.
 * Un test vérifie ces règles en parcourant ce registre.
 */

/** Début et fin (exclue) de la période, en instants, à partir des jours locaux. */
const PERIOD_START = `(($1::date)::timestamp AT TIME ZONE $3)`;
const PERIOD_END = `((($2::date) + 1)::timestamp AT TIME ZONE $3)`;

export const READ_QUERIES = {
  meta: `SELECT instrumented_since::text AS instrumented_since FROM public.monitoring_meta LIMIT 1`,

  dailyMetrics: `
    SELECT day::text AS day, signups, account_deletions, active_users, trips_created, trips_from_template,
           assistant_requests, credits_consumed, voice_transcriptions, paywall_trip_limit, paywall_credits,
           db_size_bytes::float8 AS db_size_bytes, storage_bytes::float8 AS storage_bytes
    FROM public.monitoring_daily_metrics
    WHERE day BETWEEN $1::date AND $2::date
    ORDER BY day`,

  /** $1 = dernier jour. Cumul des inscriptions moins les suppressions depuis le début des données. */
  userTotals: `
    SELECT COALESCE(sum(signups), 0)::float8 AS signups,
           COALESCE(sum(account_deletions), 0)::float8 AS deletions,
           min(day)::text AS first_day
    FROM public.monitoring_daily_metrics
    WHERE day <= $1::date`,

  /** $1 = dernier jour. Mesures de taille des 30 derniers jours (tendance). */
  sizeHistory: `
    SELECT day::text AS day, db_size_bytes::float8 AS db_size_bytes, storage_bytes::float8 AS storage_bytes
    FROM public.monitoring_daily_metrics
    WHERE day BETWEEN ($1::date - 29) AND $1::date
    ORDER BY day`,

  subscriptionsCurrent: `
    SELECT plan, billing_interval, status, count::float8 AS count
    FROM public.monitoring_subscriptions_current`,

  subscriptionEventsDaily: `
    SELECT ((occurred_at AT TIME ZONE $3)::date)::text AS day, event_type, count(*)::float8 AS count
    FROM public.monitoring_subscription_events
    WHERE occurred_at >= ${PERIOD_START} AND occurred_at < ${PERIOD_END}
    GROUP BY 1, 2
    ORDER BY 1`,

  /** $1 = premier jour, $2 = fuseau. Dernier événement de chaque abonnement avant la période. */
  subscriptionsAtStart: `
    SELECT last_event AS event_type, count(*)::float8 AS count
    FROM (
      SELECT DISTINCT ON (subscription_key) event_type AS last_event
      FROM public.monitoring_subscription_events
      WHERE occurred_at < (($1::date)::timestamp AT TIME ZONE $2)
      ORDER BY subscription_key, occurred_at DESC
    ) AS last_events
    GROUP BY last_event`,

  /** Prix de chaque offre : montant de ses événements les plus récents. */
  latestPrices: `
    SELECT DISTINCT ON (plan, billing_interval) plan, billing_interval, currency, amount_cents
    FROM public.monitoring_subscription_events
    WHERE amount_cents IS NOT NULL AND currency IS NOT NULL
      AND event_type IN ('created', 'renewed', 'plan_changed', 'reactivated')
    ORDER BY plan, billing_interval, occurred_at DESC`,

  /** Montants facturés pendant la période (créations et renouvellements). */
  subscriptionRevenue: `
    SELECT currency, COALESCE(sum(amount_cents), 0)::float8 AS amount_cents
    FROM public.monitoring_subscription_events
    WHERE event_type IN ('created', 'renewed') AND amount_cents IS NOT NULL AND currency IS NOT NULL
      AND occurred_at >= ${PERIOD_START} AND occurred_at < ${PERIOD_END}
    GROUP BY currency`,

  creditPurchasesDaily: `
    SELECT day::text AS day, currency, sum(packs)::float8 AS packs, sum(amount_cents)::float8 AS amount_cents
    FROM public.monitoring_credit_purchases_daily
    WHERE day BETWEEN $1::date AND $2::date
    GROUP BY day, currency
    ORDER BY day`,

  /** $3 = libellé du fournisseur Anthropic. */
  aiCostsDaily: `
    SELECT day::text AS day,
           sum(cost_usd)::float8 AS cost_usd,
           COALESCE(sum(cost_usd) FILTER (WHERE provider = $3), 0)::float8 AS anthropic_usd,
           sum(requests)::float8 AS requests
    FROM public.monitoring_ai_costs_daily
    WHERE day BETWEEN $1::date AND $2::date
    GROUP BY day
    ORDER BY day`,

  aiCostsByModel: `
    SELECT provider, model, sum(requests)::float8 AS requests, sum(input_tokens)::float8 AS input_tokens,
           sum(output_tokens)::float8 AS output_tokens, sum(cost_usd)::float8 AS cost_usd
    FROM public.monitoring_ai_costs_daily
    WHERE day BETWEEN $1::date AND $2::date
    GROUP BY provider, model
    ORDER BY 6 DESC
    LIMIT 50`,

  funnel: `
    SELECT COALESCE(sum(signups), 0)::float8 AS signups,
           COALESCE(sum(with_first_trip), 0)::float8 AS with_first_trip,
           COALESCE(sum(activated), 0)::float8 AS activated,
           COALESCE(sum(hit_paywall), 0)::float8 AS hit_paywall,
           COALESCE(sum(subscribed), 0)::float8 AS subscribed
    FROM public.monitoring_funnel_cohort_daily
    WHERE signup_day BETWEEN $1::date AND $2::date`,

  tableSizesTop10: `
    SELECT table_name, total_bytes::float8 AS total_bytes
    FROM public.monitoring_table_sizes
    ORDER BY total_bytes DESC
    LIMIT 10`,

  databaseSize: `SELECT pg_database_size(current_database())::float8 AS bytes`,

  clientsByDevice: `
    SELECT device_type, sum(sessions)::float8 AS sessions
    FROM public.monitoring_clients_daily
    WHERE day BETWEEN $1::date AND $2::date
    GROUP BY device_type`,

  clientsByOs: `
    SELECT os_family, sum(sessions)::float8 AS sessions
    FROM public.monitoring_clients_daily
    WHERE day BETWEEN $1::date AND $2::date
    GROUP BY os_family
    ORDER BY 2 DESC`,

  clientsByBrowser: `
    SELECT browser_name, browser_major, sum(sessions)::float8 AS sessions
    FROM public.monitoring_clients_daily
    WHERE day BETWEEN $1::date AND $2::date
    GROUP BY browser_name, browser_major
    ORDER BY 3 DESC
    LIMIT 500`,

  clientsDeviceDaily: `
    SELECT day::text AS day, device_type, sum(sessions)::float8 AS sessions
    FROM public.monitoring_clients_daily
    WHERE day BETWEEN $1::date AND $2::date
    GROUP BY day, device_type
    ORDER BY day`,

  presenceCurrent: `
    SELECT connected_users::float8 AS connected_users, as_of
    FROM public.monitoring_presence_current
    LIMIT 1`,

  /** Dernières 24 heures (aucun paramètre). */
  presenceLast24h: `
    SELECT hour, avg_users::float8 AS avg_users, peak_users::float8 AS peak_users
    FROM public.monitoring_presence_hourly_v
    WHERE hour >= date_trunc('hour', now()) - interval '23 hours'
    ORDER BY hour`,

  presenceDaily: `
    SELECT day::text AS day, peak_users::float8 AS peak_users, peak_hour, avg_users::float8 AS avg_users
    FROM public.monitoring_presence_daily
    WHERE day BETWEEN $1::date AND $2::date
    ORDER BY day`,

  /** Heures de pointe : moyenne par jour de semaine et heure locale. */
  presenceHeatmap: `
    SELECT extract(isodow FROM (hour AT TIME ZONE $3))::int AS weekday,
           extract(hour FROM (hour AT TIME ZONE $3))::int AS hour_of_day,
           round(avg(avg_users), 2)::float8 AS avg_users
    FROM public.monitoring_presence_hourly_v
    WHERE hour >= ${PERIOD_START} AND hour < ${PERIOD_END}
    GROUP BY 1, 2`,

  /** $1 = libellé Anthropic, $2 = premier jour (date de la première recharge). */
  anthropicConsumedSince: `
    SELECT COALESCE(sum(cost_usd), 0)::float8 AS cost_usd
    FROM public.monitoring_ai_costs_daily
    WHERE provider = $1 AND day >= $2::date`,

  /** $1 = libellé Anthropic, $2 = dernier jour : consommation des 7 jours qui précèdent (inclus). */
  anthropicLast7Days: `
    SELECT COALESCE(sum(cost_usd), 0)::float8 AS cost_usd
    FROM public.monitoring_ai_costs_daily
    WHERE provider = $1 AND day BETWEEN ($2::date - 6) AND $2::date`,

  /** $1 = libellé Anthropic, $2 et $3 = jours (inclus) : pour le recoupement. */
  anthropicBetween: `
    SELECT COALESCE(sum(cost_usd), 0)::float8 AS cost_usd
    FROM public.monitoring_ai_costs_daily
    WHERE provider = $1 AND day BETWEEN $2::date AND $3::date`,
} as const;

export type ReadQueryName = keyof typeof READ_QUERIES;
