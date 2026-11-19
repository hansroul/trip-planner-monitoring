-- DÉVELOPPEMENT UNIQUEMENT : rôles du site de suivi sur la base locale, avec des mots de passe
-- de développement publics (jamais utilisés ailleurs). En production, les rôles sont créés à la
-- main par le script ops/monitoring-roles.sql de l'application principale.
-- Idempotent : peut être relancé.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitoring_reader') THEN
    CREATE ROLE monitoring_reader LOGIN PASSWORD 'dev-only-reader-pw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitoring_app_rw') THEN
    CREATE ROLE monitoring_app_rw LOGIN PASSWORD 'dev-only-app-pw';
  END IF;
END
$$;

ALTER ROLE monitoring_reader NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10;
ALTER ROLE monitoring_reader SET default_transaction_read_only = on;
ALTER ROLE monitoring_reader SET statement_timeout = '5s';
ALTER ROLE monitoring_reader SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE monitoring_reader SET search_path = public;

ALTER ROLE monitoring_app_rw NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20;
ALTER ROLE monitoring_app_rw SET search_path = monitoring_app;
ALTER ROLE monitoring_app_rw SET statement_timeout = '30s';

-- Base courante : connexion autorisée aux deux rôles.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO monitoring_reader, monitoring_app_rw', current_database());
END
$$;

-- Schéma propre au site de suivi, propriété de monitoring_app_rw.
CREATE SCHEMA IF NOT EXISTS monitoring_app AUTHORIZATION monitoring_app_rw;
ALTER SCHEMA monitoring_app OWNER TO monitoring_app_rw;
REVOKE ALL ON SCHEMA monitoring_app FROM PUBLIC;

-- Schéma public : plus d'accès implicite ; monitoring_reader reçoit un USAGE explicite
-- (et SELECT sur les seules vues du contrat, voir 30-grants.sql). monitoring_app_rw : rien.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO monitoring_reader;
REVOKE ALL ON SCHEMA public FROM monitoring_app_rw;
