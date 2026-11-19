# Suivi PoppyTrip

Site de suivi (monitoring) **privé** de PoppyTrip, séparé de l’application principale, avec un
**seul utilisateur autorisé**. Il lit la base PostgreSQL de PoppyTrip **uniquement** à travers
12 vues SQL en lecture seule (`public.monitoring_*`, voir `sql/contract.sql`) et n’affiche aucune
donnée personnelle.

- TypeScript partout ; serveur Fastify qui sert aussi le front React (Vite) construit.
- PostgreSQL avec `pg` et du SQL paramétré (pas d’ORM) ; validation Zod ; tests Vitest.
- Aucune ressource externe : pas de CDN, polices système, aucun traceur ni mesure d’audience.
- Règles de sécurité permanentes : voir [CLAUDE.md](CLAUDE.md).

## Sommaire

1. [Fonctionnement et sécurité](#1-fonctionnement-et-sécurité)
2. [Installation locale](#2-installation-locale)
3. [Application Microsoft Entra (comptes personnels)](#3-application-microsoft-entra-comptes-personnels)
4. [Génération des secrets](#4-génération-des-secrets)
5. [Variables d’environnement](#5-variables-denvironnement)
6. [Déploiement sur Railway](#6-déploiement-sur-railway)
7. [Ordre de mise en service](#7-ordre-de-mise-en-service)
8. [Sécurité du dépôt GitHub](#8-sécurité-du-dépôt-github)
9. [Option : Cloudflare Access](#9-option--cloudflare-access)
10. [Notes et limites](#10-notes-et-limites)

## 1. Fonctionnement et sécurité

- Tout le site est monté sous un **préfixe aléatoire** (`ADMIN_PATH_PREFIX`). Pour se connecter :
  `https://<domaine>/<ADMIN_PATH_PREFIX>/auth/login` (à garder en favori).
- **Sans session, toutes les routes répondent par la même 404**, sauf `/healthz` (« ok »),
  `/robots.txt` (tout interdit), le démarrage de la connexion et son retour.
- Connexion **OpenID Connect** avec un compte Microsoft personnel : code d’autorisation + PKCE,
  `state` et `nonce` vérifiés, signature et revendications du jeton vérifiées (`openid-client`).
  Accès accordé seulement si l’adresse du jeton est exactement `ADMIN_EMAIL` **et**, une fois
  renseigné, si l’identifiant stable (`sub`) vaut `ADMIN_OIDC_SUB`.
- Session côté serveur (table `monitoring_app.sessions`, seul un HMAC de l’identifiant est stocké),
  cookie `__Host-` `Secure` `HttpOnly` `SameSite=Strict`, 8 h maximum, 30 min d’inactivité.
- Modifications (recharges de crédit, déconnexion) : vérification d’origine **et** jeton CSRF.
- En-têtes : CSP stricte (aucun script ni style en ligne), HSTS, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy` restrictive, `noindex`, `nosniff`,
  `Cache-Control: no-store`, aucun CORS.
- Limitation de débit stricte sur la connexion (10 par 15 min et par adresse IP) et générale sur le
  reste ; journal d’audit (connexions, déconnexions, recharges, alertes) sans secret ni adresse
  complète d’un tiers.
- Deux connexions PostgreSQL : `monitoring_reader` (lecture seule forcée à chaque connexion, TLS
  vérifié hors réseau privé, délai de 5 s) et `monitoring_app_rw` (schéma `monitoring_app` :
  sessions, recharges, alertes, audit ; migrations SQL appliquées au démarrage).

## 2. Installation locale

Prérequis : Node.js 24 (`.nvmrc`), Docker (pour la base de développement).

```sh
npm install                      # installe aussi le hook de pré-commit (.githooks)
docker compose up -d db          # PostgreSQL local : 12 vues du contrat, 2 rôles, FAUSSES données sur 120 jours
cp .env.example .env             # puis compléter .env (voir sections 3 à 5)
npm run dev                      # build du front en continu + serveur relancé à chaque modification
```

Ouvrir ensuite `http://localhost:3000/<ADMIN_PATH_PREFIX>/auth/login`. En local, ajouter
`http://localhost:3000/<ADMIN_PATH_PREFIX>/auth/callback` comme URI de redirection dans
l’application Entra (Microsoft accepte `http://localhost`). Les cookies `Secure` fonctionnent sur
`http://localhost` dans les navigateurs récents.

- Les fausses données sont recréées avec `docker compose down -v && docker compose up -d db`, ou
  sur une autre instance locale avec `DEV_PG_ADMIN_URL=postgres://… npm run db:dev:init -- --recreate`.
- **Aucune donnée réelle dans le dépôt** ; le développement et les tests se font uniquement contre
  cette base.

Tests et vérifications :

```sh
TEST_PG_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
npm run typecheck
npm run check:secrets
```

Les tests recréent une base `monitoring_test` (et `monitoring_test_empty`) sur l’instance locale.

## 3. Application Microsoft Entra (comptes personnels)

1. Portail <https://entra.microsoft.com> → **Identité** → **Applications** → **Inscriptions
   d’applications** → **Nouvelle inscription**.
2. Nom : par exemple « Suivi PoppyTrip ». Types de comptes : **Comptes Microsoft personnels
   uniquement**.
3. URI de redirection : plateforme **Web**, valeur **exactement** égale à `OIDC_REDIRECT_URI`
   (`https://<domaine>/<ADMIN_PATH_PREFIX>/auth/callback`). Ajouter aussi l’URI locale si besoin.
4. Ne **pas** cocher « Jetons d’ID » ni « Jetons d’accès » (flux implicite inutile : le site utilise
   le flux par code avec PKCE).
5. **Certificats et secrets** → **Nouveau secret client** → copier la **valeur** dans
   `OIDC_CLIENT_SECRET` (noter la date d’expiration et prévoir son renouvellement).
6. **Vue d’ensemble** → copier l’**ID d’application (client)** dans `OIDC_CLIENT_ID`.
7. **Autorisations d’API** : `openid`, `email`, `profile` (Microsoft Graph, déléguées) suffisent.
8. `OIDC_ISSUER` : émetteur publié par l’autorité « consumers » (vérifié le 19/11/2026 dans le
   document de découverte `https://login.microsoftonline.com/consumers/v2.0/.well-known/openid-configuration`) :
   `https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0`.

## 4. Génération des secrets

```sh
openssl rand -base64 48     # SESSION_SECRET (≥ 32 octets)
openssl rand -hex 24        # ADMIN_PATH_PREFIX (segment non devinable)
```

Ne jamais réutiliser une valeur entre environnements ; ne jamais la coller dans un fichier versionné,
un ticket ou un message.

## 5. Variables d’environnement

Toutes sont lues au démarrage et validées ; le serveur **refuse de démarrer** si une variable
obligatoire manque ou est faible. `.env.example` ne contient que des valeurs fictives.

| Variable | Obligatoire | Description |
|---|---|---|
| `NODE_ENV` | non (`production`) | `production`, `development` ou `test`. En production : HTTPS exigé. |
| `PORT` / `HOST` | non (`3000` / `0.0.0.0`) | Écoute du serveur (Railway fournit `PORT`). |
| `LOG_LEVEL` | non (`info`) | Niveau de journalisation. |
| `TRUST_PROXY_HOPS` | non (`0`) | Mandataires de confiance devant le service (**Railway : 1**). |
| `PUBLIC_BASE_URL` | oui | Origine publique, sans chemin (HTTPS en production). |
| `ADMIN_PATH_PREFIX` | oui | Segment aléatoire (24 à 128 car. `[A-Za-z0-9_-]`) sous lequel tout est monté. |
| `MAIN_APP_URL` | oui | Lien vers PoppyTrip (en-tête). |
| `OIDC_ISSUER` | oui | Émetteur OIDC (voir section 3). |
| `OIDC_CLIENT_ID` | oui | ID d’application Entra. |
| `OIDC_CLIENT_SECRET` | oui | Secret client Entra. |
| `OIDC_REDIRECT_URI` | oui | `PUBLIC_BASE_URL` + `/` + `ADMIN_PATH_PREFIX` + `/auth/callback` (vérifié). |
| `ADMIN_EMAIL` | oui | L’unique adresse autorisée (compte Microsoft personnel). |
| `ADMIN_OIDC_SUB` | après la 1re connexion | Identifiant stable du compte (affiché une fois à l’écran et dans les journaux). |
| `SESSION_SECRET` | oui | ≥ 32 octets aléatoires. |
| `DATABASE_URL_READONLY` | oui | Rôle `monitoring_reader` (jamais la `DATABASE_URL` de PoppyTrip). |
| `DATABASE_URL_APP` | oui | Rôle `monitoring_app_rw`. |
| `DB_SSL_CA` | non | Certificat d’autorité PEM si la base est jointe hors réseau privé. |
| `TIMEZONE` | non (`Europe/Brussels`) | Fuseau d’affichage des heures. |
| `DB_SIZE_LIMIT_BYTES` | non | Limite de la base ; sans valeur : « limite non configurée ». |
| `STORAGE_LIMIT_BYTES` | non | Limite du stockage de fichiers. |
| `USD_TO_EUR_RATE` | non | Taux pour la marge estimée (coûts IA en USD, revenus en EUR). |
| `CREDIT_WARN_PERCENT` / `CREDIT_CRITICAL_PERCENT` | non (`70` / `90`) | Seuils du crédit Anthropic. |
| `STORAGE_WARN_PERCENT` / `STORAGE_CRITICAL_PERCENT` | non (`80` / `90`) | Seuils d’occupation base et stockage. |
| `SATURATION_ALERT_DAYS` | non (`30`) | Alerte si la saturation est prévue dans moins de N jours. |
| `ANTHROPIC_PROVIDER_LABEL` | non (`anthropic`) | Valeur de `provider` qui désigne Anthropic. |
| `ANTHROPIC_ADMIN_KEY` | non | Clé d’administration (`sk-ant-admin…`) pour le recoupement ; jamais envoyée au navigateur. |
| `ANTHROPIC_API_BASE_URL` | si clé | `https://api.anthropic.com`. |
| `ANTHROPIC_API_VERSION` | non (`2026-10-21`) | En-tête `anthropic-version`. |
| `ALERTS_ENABLED` | non (`false`) | Active les alertes e-mail vers `ADMIN_EMAIL`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | si alertes | Envoi SMTP (TLS exigé). |

## 6. Déploiement sur Railway

1. Dans le **projet Railway de PoppyTrip** : **New** → **GitHub Repo** → ce dépôt (privé), branche
   principale. Le fichier `railway.json` impose le `Dockerfile` et le contrôle de santé `/healthz`.
2. **Variables** du service (section 5) saisies dans Railway, jamais dans le dépôt :
   - `NODE_ENV=production`, `TRUST_PROXY_HOPS=1` ;
   - `DATABASE_URL_READONLY=postgres://monitoring_reader:<mot de passe>@<hôte interne>:5432/<base>`
     et `DATABASE_URL_APP=postgres://monitoring_app_rw:<mot de passe>@<hôte interne>:5432/<base>`,
     avec l’**adresse interne** du service Postgres (réseau privé, `*.railway.internal`, par exemple
     via `${{Postgres.RAILWAY_PRIVATE_DOMAIN}}`) ;
   - **ne jamais** référencer `${{Postgres.DATABASE_URL}}` ni la `DATABASE_URL` de PoppyTrip
     (compte principal, tous droits) : le serveur refuse de démarrer si l’utilisateur n’est pas le
     rôle attendu.
3. **Settings → Networking** : générer un domaine (ou un domaine personnalisé) et reporter l’origine
   dans `PUBLIC_BASE_URL` / `OIDC_REDIRECT_URI` (et dans Entra).
4. Un seul réplica (limitation de débit et cache en mémoire).

## 7. Ordre de mise en service

1. **Application principale d’abord** : déployer la migration des vues `monitoring_*`
   (`prisma migrate deploy`).
2. Lancer **à la main** `ops/monitoring-roles.sql` de PoppyTrip avec le compte principal (crée
   `monitoring_reader`, `monitoring_app_rw` et le schéma `monitoring_app`) ; ranger les deux mots
   de passe générés dans le gestionnaire de secrets.
3. Créer l’application Entra (section 3) avec l’URI de redirection définitive.
4. Créer le service Railway et ses variables (sections 5 et 6), **sans** `ADMIN_OIDC_SUB`.
5. Ouvrir `https://<domaine>/<ADMIN_PATH_PREFIX>/auth/login`, se connecter : le site affiche une fois
   `renseigne ADMIN_OIDC_SUB=…` (également dans les journaux). Reporter cette valeur dans Railway et
   redéployer. Le message d’avertissement au démarrage disparaît.
6. Saisir la première recharge (ou le solde initial) du crédit Anthropic, puis éventuellement
   `ANTHROPIC_ADMIN_KEY` et les alertes e-mail.

## 8. Sécurité du dépôt GitHub

- [ ] Dépôt **privé**.
- [ ] **2FA** obligatoire sur le compte (clé de sécurité ou application).
- [ ] **Protection de la branche principale** : pull request et CI verte obligatoires, pas de push
      forcé, pas de suppression.
- [ ] **Secret scanning** et **push protection** (blocage des envois contenant des secrets) activés.
- [ ] **Dependabot alerts** et mises à jour de sécurité activées (`.github/dependabot.yml`).
- [ ] Actions GitHub : permissions du jeton en lecture seule par défaut, actions épinglées par SHA.
- [ ] Hook local : `npm install` active `.githooks/pre-commit` ; installer aussi
      [gitleaks](https://github.com/gitleaks/gitleaks) pour une détection plus complète.

## 9. Option : Cloudflare Access

Pour une protection supplémentaire (configuration, pas de code) : placer le domaine derrière
Cloudflare (proxy activé), créer une application **Cloudflare Zero Trust → Access → Self-hosted**
sur `https://<domaine>/<ADMIN_PATH_PREFIX>/*`, politique **Allow** limitée à la même adresse e-mail
(code à usage unique ou fournisseur d’identité), et laisser `/healthz` hors de l’application pour
le contrôle de santé de Railway. Dans ce cas, compter le mandataire Cloudflare dans
`TRUST_PROXY_HOPS` (2 au lieu de 1).

## 10. Notes et limites

- **Utilisateurs actifs sur 7 et 30 jours** : somme des actifs quotidiens (approximation, pas un
  décompte distinct).
- **MRR** : abonnés actifs ou en retard de paiement × prix mensuel de leur offre (annuels ramenés
  au mois) ; prix déduit des événements les plus récents ; montants facturés, taxes éventuellement
  incluses ; essais exclus.
- **Marge brute** : estimation (coûts IA convertis avec `USD_TO_EUR_RATE`), hors hébergement et
  frais de paiement.
- **Tailles** : tailles logiques ; la taille réelle sur disque est plus grande, les métriques de
  l’hébergeur font foi.
- **Crédit Anthropic** : l’API n’expose pas le solde ; les recharges sont saisies à la main. Le
  recoupement facultatif utilise l’API « Usage and Cost Analytics » (bêta,
  `GET /v1/organizations/analytics/cost`, en-tête `anthropic-beta: analytics-usage-cost-2026-08-24`),
  sur 30 jours UTC s’arrêtant avant-hier (données en retard de 4 à 24 h) ; les jours côté PoppyTrip
  sont des jours locaux : un léger écart est normal, il est signalé au-delà de 10 %.
- **Appareils** : portables et fixes regroupés dans « ordinateur » ; un iPad en mode ordinateur
  peut apparaître comme un ordinateur.
- **Alertes e-mail** : l’envoi SMTP sortant peut être bloqué selon l’offre Railway (à vérifier) ;
  utiliser alors un fournisseur SMTP sur le port 587 avec TLS, ou laisser `ALERTS_ENABLED=false`.
