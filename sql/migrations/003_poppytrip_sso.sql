-- Connexion avec le compte PoppyTrip : plus de vérificateur PKCE (le jeton est lié au nonce du
-- flux) ni de message « renseigne ADMIN_OIDC_SUB » (l'identifiant du compte est configuré).
ALTER TABLE monitoring_app.login_flows DROP COLUMN code_verifier;
ALTER TABLE monitoring_app.sessions DROP COLUMN sub_notice;
