-- Connexion par e-mail + mot de passe vérifiés par ce site : le flux de connexion ne garde que
-- le jeton anti-falsification du formulaire (colonne state), plus de nonce.
ALTER TABLE monitoring_app.login_flows DROP COLUMN nonce;
