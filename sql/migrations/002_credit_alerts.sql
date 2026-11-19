-- Recharges du crédit Anthropic (saisie manuelle : l'API d'Anthropic n'expose pas le solde).
-- La première entrée peut être un solde initial.
CREATE TABLE monitoring_app.credit_topups (
  id bigserial PRIMARY KEY,
  topup_date date NOT NULL,
  amount_usd numeric(12, 2) NOT NULL CHECK (amount_usd > 0 AND amount_usd <= 1000000),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_topups_date_idx ON monitoring_app.credit_topups (topup_date);

-- État des alertes : une alerte n'est envoyée qu'une fois par seuil franchi.
-- arm_token : pour le crédit, empreinte des recharges (une nouvelle recharge réarme l'alerte).
CREATE TABLE monitoring_app.alert_state (
  alert_key text PRIMARY KEY,
  fired_at timestamptz NOT NULL,
  arm_token text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb
);
