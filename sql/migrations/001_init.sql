-- Schéma propre au site de suivi (monitoring_app), créé par l'application principale
-- (ops/monitoring-roles.sql) et appartenant au rôle monitoring_app_rw. Aucune donnée personnelle.

-- Sessions côté serveur. L'identifiant du cookie n'est jamais stocké : seulement son HMAC.
CREATE TABLE monitoring_app.sessions (
  id_hash text PRIMARY KEY,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  -- Identifiant stable à afficher UNE fois tant que ADMIN_OIDC_SUB n'est pas configuré.
  sub_notice text
);
CREATE INDEX sessions_expiry_idx ON monitoring_app.sessions (absolute_expires_at);

-- Flux de connexion OIDC en cours (state, nonce, vérificateur PKCE), courte durée, usage unique.
CREATE TABLE monitoring_app.login_flows (
  id_hash text PRIMARY KEY,
  state text NOT NULL,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX login_flows_expiry_idx ON monitoring_app.login_flows (expires_at);

-- Journal d'audit : jamais de secret, de jeton, ni d'adresse complète d'un tiers.
CREATE TABLE monitoring_app.audit_log (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL,
  outcome text NOT NULL,
  ip_prefix text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_occurred_idx ON monitoring_app.audit_log (occurred_at DESC);
