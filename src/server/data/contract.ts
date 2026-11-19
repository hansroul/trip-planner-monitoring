/**
 * Les 12 vues du contrat (sql/contract.sql) avec leurs colonnes EXACTES. Ce site ne lit rien
 * d'autre ; un test parcourt toutes les requêtes pour le vérifier.
 */
export const CONTRACT_VIEWS = {
  monitoring_daily_metrics: [
    'day',
    'signups',
    'account_deletions',
    'active_users',
    'trips_created',
    'trips_from_template',
    'assistant_requests',
    'credits_consumed',
    'voice_transcriptions',
    'paywall_trip_limit',
    'paywall_credits',
    'db_size_bytes',
    'storage_bytes',
  ],
  monitoring_subscription_events: [
    'occurred_at',
    'event_type',
    'plan',
    'billing_interval',
    'amount_cents',
    'currency',
    'subscription_key',
  ],
  monitoring_subscriptions_current: ['plan', 'billing_interval', 'status', 'count'],
  monitoring_ai_costs_daily: ['day', 'provider', 'model', 'requests', 'input_tokens', 'output_tokens', 'cost_usd'],
  monitoring_credit_purchases_daily: ['day', 'packs', 'amount_cents', 'currency'],
  monitoring_funnel_cohort_daily: ['signup_day', 'signups', 'with_first_trip', 'activated', 'hit_paywall', 'subscribed'],
  monitoring_table_sizes: ['table_name', 'total_bytes'],
  monitoring_meta: ['instrumented_since'],
  monitoring_clients_daily: ['day', 'device_type', 'os_family', 'browser_name', 'browser_major', 'sessions'],
  monitoring_presence_current: ['connected_users', 'as_of'],
  monitoring_presence_hourly_v: ['hour', 'avg_users', 'peak_users'],
  monitoring_presence_daily: ['day', 'peak_users', 'peak_hour', 'avg_users'],
} as const;

export type ContractView = keyof typeof CONTRACT_VIEWS;
export const CONTRACT_VIEW_NAMES = Object.keys(CONTRACT_VIEWS) as ContractView[];
