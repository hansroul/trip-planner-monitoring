-- DÉVELOPPEMENT UNIQUEMENT : FAUSSES données réalistes sur 120 jours (aucune donnée réelle).
-- Déterministe (setseed). Relancer ce fichier remplace toutes les fausses données.

TRUNCATE dev_fake.daily_counters, dev_fake.subscription_events, dev_fake.subscriptions, dev_fake.ai_costs,
  dev_fake.credit_purchases, dev_fake.funnel, dev_fake.settings, dev_fake.clients,
  dev_fake.presence_instances, dev_fake.presence_hourly RESTART IDENTITY;

SELECT setseed(0.42);

-- Mise en service de l'instrumentation il y a 90 jours : les 30 premiers jours viennent du
-- « rattrapage » (seuls signups, trips_created, assistant_requests et credits_consumed).
INSERT INTO dev_fake.settings (id, instrumented_since) VALUES (1, current_date - 90);

-- --- Compteurs journaliers ---------------------------------------------------------------
INSERT INTO dev_fake.daily_counters
SELECT
  d::date,
  round((6 + 10 * g + we * 4) * (0.7 + random() * 0.6))::int,
  CASE WHEN backfill THEN 0 ELSE floor(random() * 3)::int END,
  CASE WHEN backfill THEN 0 ELSE au END,
  round(au * 0.12 * (0.8 + random() * 0.4))::int,
  0, -- complété plus bas
  round(au * 0.35 * (0.8 + random() * 0.4))::int,
  0, -- complété plus bas
  0,
  CASE WHEN backfill THEN 0 ELSE floor(random() * 6)::int END,
  CASE WHEN backfill THEN 0 ELSE floor(random() * 9)::int END,
  CASE WHEN backfill OR d::date = current_date THEN NULL ELSE (180000000::bigint + i * 1600000 + random() * 200000)::bigint END,
  CASE WHEN backfill OR d::date = current_date THEN NULL ELSE (2100000000::bigint + i * 12000000 + random() * 3000000)::bigint END
FROM (
  SELECT d, i, 1 + i / 120.0 AS g,
         CASE WHEN extract(isodow FROM d) IN (6, 7) THEN 1 ELSE 0 END AS we,
         d::date < current_date - 90 AS backfill,
         round((60 + 140 * (1 + i / 120.0) + CASE WHEN extract(isodow FROM d) IN (6, 7) THEN 30 ELSE 0 END)
               * (0.85 + random() * 0.3))::int AS au
  FROM generate_series(current_date - 119, current_date, interval '1 day') WITH ORDINALITY AS s(d, n)
  CROSS JOIN LATERAL (SELECT (n - 1)::int AS i) x
) days;

UPDATE dev_fake.daily_counters SET
  trips_from_template = CASE WHEN day < current_date - 90 THEN 0 ELSE round(trips_created * (0.1 + random() * 0.15))::int END,
  credits_consumed = assistant_requests * 3 + floor(random() * 20)::int,
  voice_transcriptions = CASE WHEN day < current_date - 90 THEN 0 ELSE round(assistant_requests * 0.08 * random())::int END;

-- --- Abonnements : événements et état actuel ------------------------------------------
DO $$
DECLARE
  k int;
  key text;
  plan text;
  intv text;
  price int;
  created timestamptz;
  cancel_req timestamptz;
  cancel_eff timestamptz;
  reactivated boolean;
  failed boolean;
  step interval;
  t timestamptz;
  final_status text;
BEGIN
  FOR k IN 1..170 LOOP
    key := md5('fake-subscription-' || k);
    plan := CASE WHEN random() < 0.65 THEN 'voyageur' ELSE 'aventurier' END;
    intv := CASE WHEN random() < 0.2 THEN 'year' ELSE 'month' END;
    price := CASE plan WHEN 'voyageur' THEN CASE intv WHEN 'month' THEN 499 ELSE 4990 END
                       ELSE CASE intv WHEN 'month' THEN 999 ELSE 9990 END END;
    created := now() - (random() * 240) * interval '1 day';
    step := CASE intv WHEN 'month' THEN interval '1 month' ELSE interval '1 year' END;
    cancel_req := NULL; cancel_eff := NULL; reactivated := false;
    failed := random() < 0.08;

    INSERT INTO dev_fake.subscription_events (occurred_at, event_type, plan, billing_interval, amount_cents, currency, subscription_key)
    VALUES (created, 'created', plan, intv, price, 'eur', key);

    IF random() < 0.32 THEN
      cancel_req := created + (5 + random() * 150) * interval '1 day';
      IF cancel_req < now() THEN
        INSERT INTO dev_fake.subscription_events VALUES (DEFAULT, cancel_req, 'cancel_requested', plan, intv, price, 'eur', key);
        IF random() < 0.15 THEN
          reactivated := true;
          INSERT INTO dev_fake.subscription_events VALUES (DEFAULT, cancel_req + (1 + random() * 10) * interval '1 day', 'reactivated', plan, intv, price, 'eur', key);
        ELSE
          cancel_eff := cancel_req + (1 + random() * 29) * interval '1 day';
          IF cancel_eff < now() THEN
            INSERT INTO dev_fake.subscription_events VALUES (DEFAULT, cancel_eff, 'canceled', plan, intv, NULL, NULL, key);
          ELSE
            cancel_eff := NULL;
          END IF;
        END IF;
      ELSE
        cancel_req := NULL;
      END IF;
    END IF;

    t := created + step;
    WHILE t < now() AND (cancel_eff IS NULL OR t < cancel_eff) LOOP
      INSERT INTO dev_fake.subscription_events VALUES (DEFAULT, t, 'renewed', plan, intv, price, 'eur', key);
      t := t + step;
    END LOOP;

    IF failed THEN
      INSERT INTO dev_fake.subscription_events VALUES (DEFAULT, greatest(created, now() - interval '20 days') + random() * interval '15 days', 'payment_failed', plan, intv, price, 'eur', key);
    END IF;

    IF k % 23 = 0 AND cancel_eff IS NULL THEN
      INSERT INTO dev_fake.subscription_events VALUES (DEFAULT, created + interval '40 days', 'plan_changed', 'aventurier', intv,
        CASE intv WHEN 'month' THEN 999 ELSE 9990 END, 'eur', key);
      plan := 'aventurier';
    END IF;

    final_status := CASE
      WHEN cancel_eff IS NOT NULL THEN 'canceled'
      WHEN failed THEN 'past_due'
      WHEN created > now() - interval '7 days' AND random() < 0.4 THEN 'trialing'
      ELSE 'active' END;
    INSERT INTO dev_fake.subscriptions VALUES (key, plan, intv, final_status);
  END LOOP;
END
$$;

-- --- Coûts de l'IA ---------------------------------------------------------------------
INSERT INTO dev_fake.ai_costs
SELECT day, 'anthropic', 'claude-opus-5-5', r, r * 6000, r * 900, round((r * 6000 / 1e6 * 4 + r * 900 / 1e6 * 20)::numeric, 6)
FROM (SELECT day, round(assistant_requests * 1.2)::bigint AS r FROM dev_fake.daily_counters) x
WHERE r > 0;
INSERT INTO dev_fake.ai_costs
SELECT day, 'anthropic', 'claude-haiku-5-5', r, r * 3000, r * 400, round((r * 3000 / 1e6 * 0.1 + r * 400 / 1e6 * 0.5)::numeric, 6)
FROM (SELECT day, round(assistant_requests * 0.9)::bigint AS r FROM dev_fake.daily_counters) x
WHERE r > 0;
INSERT INTO dev_fake.ai_costs
SELECT day, 'other', 'transcription-vocale', voice_transcriptions, 0, 0, round((voice_transcriptions * 0.006)::numeric, 6)
FROM dev_fake.daily_counters WHERE voice_transcriptions > 0;

-- --- Achats de packs de crédits ----------------------------------------------------------
INSERT INTO dev_fake.credit_purchases
SELECT day, packs, packs * 299, 'eur'
FROM (
  SELECT day, floor(random() * 5 * (1 + (day - (current_date - 119)) / 120.0))::bigint AS packs
  FROM dev_fake.daily_counters
) x
WHERE packs > 0;

-- --- Entonnoir par cohorte ---------------------------------------------------------------
INSERT INTO dev_fake.funnel
SELECT signup_day, s, wft, least(wft, round(wft * (0.5 + random() * 0.2) * maturity)::bigint),
       round(s * (0.15 + random() * 0.1) * maturity)::bigint,
       round(s * (0.04 + random() * 0.05) * maturity)::bigint
FROM (
  SELECT day AS signup_day, signups::bigint AS s,
         least(1.0, (current_date - day + 1) / 30.0) AS maturity,
         round(signups * (0.5 + random() * 0.2))::bigint AS wft
  FROM dev_fake.daily_counters
) x;

-- --- Appareils et navigateurs (sessions authentifiées) ----------------------------------
INSERT INTO dev_fake.clients
SELECT c.day, v.device, v.os, v.browser, v.major, s
FROM (SELECT day, round(active_users * 1.3) AS total FROM dev_fake.daily_counters WHERE day >= current_date - 90) c
CROSS JOIN (VALUES
  ('mobile', 'ios', 'safari', '26', 0.20), ('mobile', 'ios', 'safari', '18', 0.08), ('mobile', 'ios', 'safari', '17', 0.02),
  ('mobile', 'ios', 'chrome', '142', 0.03),
  ('mobile', 'android', 'chrome', '142', 0.14), ('mobile', 'android', 'chrome', '141', 0.05), ('mobile', 'android', 'chrome', '138', 0.01),
  ('mobile', 'android', 'samsung_internet', '29', 0.04), ('mobile', 'android', 'samsung_internet', '28', 0.01),
  ('mobile', 'ios', 'instagram', '410', 0.03), ('mobile', 'android', 'facebook', '520', 0.02),
  ('mobile', 'ios', 'tiktok', '42', 0.01), ('mobile', 'android', 'firefox', '145', 0.01),
  ('tablet', 'ios', 'safari', '26', 0.04), ('tablet', 'android', 'chrome', '142', 0.01),
  ('desktop', 'windows', 'chrome', '142', 0.10), ('desktop', 'windows', 'chrome', '141', 0.02),
  ('desktop', 'windows', 'edge', '142', 0.05), ('desktop', 'windows', 'firefox', '145', 0.02),
  ('desktop', 'macos', 'safari', '26', 0.04), ('desktop', 'macos', 'safari', '18', 0.01),
  ('desktop', 'macos', 'chrome', '142', 0.03), ('desktop', 'linux', 'firefox', '145', 0.01),
  ('other', 'other', 'other', 'other', 0.01)
) AS v(device, os, browser, major, w)
CROSS JOIN LATERAL (SELECT round(c.total * v.w * (0.8 + random() * 0.4))::int AS s) x
WHERE s > 0;

-- --- Présence : creux la nuit, pics en soirée et le week-end ------------------------------
INSERT INTO dev_fake.presence_hourly
SELECT h, 60, round(a * 60)::bigint, ceil(a * (1.3 + random() * 0.5))::int
FROM (
  SELECT h,
         (CASE
            WHEN lh BETWEEN 0 AND 6 THEN 1 + random() * 2
            WHEN lh BETWEEN 7 AND 11 THEN 6 + random() * 4
            WHEN lh BETWEEN 12 AND 17 THEN 8 + random() * 4
            WHEN lh BETWEEN 18 AND 22 THEN 14 + random() * 8
            ELSE 5 + random() * 2
          END)
         * CASE WHEN ldow IN (6, 7) THEN 1.35 ELSE 1 END
         * (1 + extract(epoch FROM h - (current_date - 119)::timestamptz) / 86400 / 120.0) AS a
  FROM generate_series((current_date - 119)::timestamptz, date_trunc('hour', now()), interval '1 hour') AS h
  CROSS JOIN LATERAL (
    SELECT extract(hour FROM h AT TIME ZONE 'Europe/Brussels') AS lh,
           extract(isodow FROM h AT TIME ZONE 'Europe/Brussels') AS ldow
  ) l
) x;

INSERT INTO dev_fake.presence_instances VALUES ('dev-instance-1', 7, now()), ('dev-instance-2', 4, now());
