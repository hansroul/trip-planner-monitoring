# Suivi PoppyTrip

Site de suivi (monitoring) **privé** de PoppyTrip, séparé de l’application principale, avec un
**seul utilisateur autorisé** : ton compte PoppyTrip. Il lit la base PostgreSQL de PoppyTrip
**uniquement** à travers 12 vues SQL en lecture seule (`public.monitoring_*`, voir
`sql/contract.sql`) et n’affiche aucune donnée personnelle.

- TypeScript partout ; serveur Fastify qui sert aussi le front React (Vite) construit.
- PostgreSQL avec `pg` et du SQL paramétré (pas d’ORM) ; validation Zod ; tests Vitest.
- Aucune ressource externe : pas de CDN, polices système, aucun traceur ni mesure d’audience.
- Règles de sécurité permanentes : voir [CLAUDE.md](CLAUDE.md).

## Sommaire

1. [Fonctionnement et sécurité](#1-fonctionnement-et-sécurité)
2. [Installation locale](#2-installation-locale)
3. [Connexion avec le compte PoppyTrip](#3-connexion-avec-le-compte-poppytrip)
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
- Connexion avec **ton compte PoppyTrip** : PoppyTrip redemande l’e-mail et le mot de passe sur une
  page dédiée, vérifie qu’il s’agit du compte autorisé, puis renvoie ici avec un jeton signé Ed25519
  valable 60 s et lié à la tentative (`state` + `nonce`). Ce site vérifie la signature, l’émetteur,
  l’audience, le type, l’expiration et l’identifiant du compte (`ADMIN_ACCOUNT_ID`) avec la
  bibliothèque `jose`. Il ne lit jamais la table `users` et ne reçoit aucune donnée personnelle.
- Session côté serveur (table `monitoring_app.sessions`, seul un HMAC de l’identifiant est stocké),
  cookie `__Host-` `Secure` `HttpOnly` `SameSite=Strict`, 8 h maximum, 30 min d’inactivité.
- Modifications (recharges de crédit, déconnexion) : vérification d’origine **et** jeton CSRF.
- En-têtes : CSP stricte (aucun script ni style en ligne), HSTS, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy` restrictive, `noindex`, `nosniff`,
  `Cache-Control: no-store`, aucun CORS.
- Limitation de débit stricte sur la connexion (10 par 15 min et par adresse IP, et 5 essais de mot
  de passe par 15 min côté PoppyTrip) et générale sur le reste ; journal d’audit (connexions,
  déconnexions, recharges, alertes) sans secret.
- Deux connexions PostgreSQL : `monitoring_reader` (lecture seule forcée à chaque connexion, TLS
  vérifié hors réseau privé, délai de 5 s) et `monitoring_app_rw` (schéma `monitoring_app` :
  sessions, recharges, alertes, audit ; migrations SQL appliquées au démarrage).

## 2. Installation locale

Prérequis : Node.js 24 (`.nvmrc`), Docker (pour la base de développement).

```sh
npm install                      # installe aussi le hook de pré-commit (.githooks)
docker compose up -d db          # PostgreSQL local : 12 vues du contrat, 2 rôles, FAUSSES données sur 120 jours
cp .env.example .env             # puis compléter .env (sections 3 à 5)
npm run dev                      # build du front en continu + serveur relancé à chaque modification
```

Ouvrir ensuite `http://localhost:3000/<ADMIN_PATH_PREFIX>/auth/login`. La connexion passe par une
instance **locale** de PoppyTrip configurée comme en section 3, avec
`MONITORING_SSO_CALLBACK_URL=http://localhost:3000/<ADMIN_PATH_PREFIX>/auth/callback`. Les cookies
`Secure` fonctionnent sur `http://localhost` dans les navigateurs récents.

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

Les tests recréent une base `monitoring_test` (et `monitoring_test_empty`) sur l’instance locale et
simulent PoppyTrip (clés Ed25519 générées pour le test).

## 3. Connexion avec le compte PoppyTrip

1. Générer la paire de clés (une fois, sur ton poste ; ne jamais versionner la clé privée) :

   ```sh
   openssl genpkey -algorithm ed25519 -out suivi-sso.key        # clé PRIVÉE : PoppyTrip uniquement
   openssl pkey -in suivi-sso.key -pubout -out suivi-sso.pub    # clé PUBLIQUE : site de suivi
   ```

   Dans Railway, coller le contenu PEM tel quel (ou sur une ligne avec `\n`), puis supprimer les
   fichiers locaux ou les ranger dans le gestionnaire de secrets.
2. Trouver l’identifiant de ton compte PoppyTrip (avec le compte principal de la base) :
   `SELECT id FROM users WHERE email = '<ton adresse>';`
3. **Variables de PoppyTrip** (service principal) :
   - `MONITORING_SSO_PRIVATE_KEY` : contenu de `suivi-sso.key` ;
   - `MONITORING_SSO_CALLBACK_URL` : `https://<domaine du suivi>/<ADMIN_PATH_PREFIX>/auth/callback` ;
   - `MONITORING_ADMIN_USER_ID` : l’identifiant de l’étape 2.
4. **Variables du site de suivi** :
   - `POPPYTRIP_SSO_URL` : `https://<domaine de PoppyTrip>/api/monitoring/sso` ;
   - `POPPYTRIP_SSO_PUBLIC_KEY` : contenu de `suivi-sso.pub` (une clé privée est refusée) ;
   - `ADMIN_ACCOUNT_ID` : le même identifiant.

Déroulement : `/<préfixe>/auth/login` → page « Connexion au suivi » de PoppyTrip (e-mail + mot de
passe, même si tu es déjà connecté à PoppyTrip) → retour automatique sur le suivi. Un autre compte ou
un mauvais mot de passe reçoit le même « Identifiants refusés ».

Sécurité : l’accès au suivi vaut celui de ton mot de passe PoppyTrip (PoppyTrip n’a pas de double
authentification) ; choisis un mot de passe long et unique. Pour changer de clés : générer une
nouvelle paire et mettre à jour les deux services en même temps.

## 4. Génération des secrets

```sh
openssl rand -base64 48     # SESSION_SECRET (≥ 32 octets)
openssl rand -hex 24        # ADMIN_PATH_PREFIX (segment non devinable)
openssl genpkey -algorithm ed25519 -out suivi-sso.key   # clés de connexion (section 3)
```

Ne jamais réutiliser une valeur entre environnements ; ne jamais la coller dans un fichier versionné,
un ticket ou un message.

## 5. Variables d’environnement

Toutes sont lues au démarrage et validées ; le serveur **refuse de démarrer** si une variable
obligatoire manque ou est faible. `.env.example` ne contient que des valeurs fictives.

**Obligatoires (8)**

| Variable | Description |
|---|---|
| `PUBLIC_BASE_URL` | Origine publique, sans chemin (HTTPS en production). |
| `ADMIN_PATH_PREFIX` | Segment aléatoire (24 à 128 car. `[A-Za-z0-9_-]`) sous lequel tout est monté. |
| `POPPYTRIP_SSO_URL` | Page de connexion du suivi dans PoppyTrip ; son origine est l’émetteur attendu du jeton et le lien « Application principale ». |
| `POPPYTRIP_SSO_PUBLIC_KEY` | Clé publique Ed25519 (PEM) de PoppyTrip. |
| `ADMIN_ACCOUNT_ID` | Identifiant (`users.id`) de ton compte PoppyTrip, le seul autorisé. |
| `SESSION_SECRET` | ≥ 32 octets aléatoires. |
| `DATABASE_URL_READONLY` | Rôle `monitoring_reader` (jamais la `DATABASE_URL` de PoppyTrip). |
| `DATABASE_URL_APP` | Rôle `monitoring_app_rw`. |

**Facultatives**

| Variable | Défaut | Description |
|---|---|---|
| `NODE_ENV` | `production` | `production`, `development` ou `test`. En production : HTTPS exigé. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Écoute du serveur (Railway fournit `PORT`). |
| `LOG_LEVEL` | `info` | Niveau de journalisation. |
| `TRUST_PROXY_HOPS` | `0` | Mandataires de confiance devant le service (**Railway : 1**). |
| `TIMEZONE` | `Europe/Brussels` | Fuseau d’affichage des heures. |
| `DB_SSL_CA` | — | Certificat d’autorité PEM si la base est jointe hors réseau privé. |
| `DB_SIZE_LIMIT_BYTES` | — | Limite de la base ; sans valeur : « limite non configurée ». |
| `STORAGE_LIMIT_BYTES` | — | Limite du stockage de fichiers. |
| `USD_TO_EUR_RATE` | — | Taux pour la marge estimée (coûts IA en USD, revenus en EUR). |
| `CREDIT_WARN_PERCENT` / `CREDIT_CRITICAL_PERCENT` | `70` / `90` | Seuils du crédit Anthropic. |
| `STORAGE_WARN_PERCENT` / `STORAGE_CRITICAL_PERCENT` | `80` / `90` | Seuils d’occupation base et stockage. |
| `SATURATION_ALERT_DAYS` | `30` | Alerte si la saturation est prévue dans moins de N jours. |
| `ANTHROPIC_PROVIDER_LABEL` | `anthropic` | Valeur de `provider` qui désigne Anthropic. |
| `ANTHROPIC_ADMIN_KEY` | — | Clé d’administration (`sk-ant-admin…`) pour le recoupement ; jamais envoyée au navigateur. |
| `ANTHROPIC_API_BASE_URL` | — | `https://api.anthropic.com` (obligatoire avec la clé). |
| `ANTHROPIC_API_VERSION` | `2026-10-21` | En-tête `anthropic-version`. |
| `ALERTS_ENABLED` | `false` | Active les alertes e-mail. |
| `ALERT_EMAIL_TO` | — | Destinataire des alertes (obligatoire si alertes). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | `587`, `false` | Envoi SMTP (TLS exigé). |

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
3. **Settings → Networking** : générer un domaine (ou un domaine personnalisé), le reporter dans
   `PUBLIC_BASE_URL` et dans `MONITORING_SSO_CALLBACK_URL` de PoppyTrip.
4. Un seul réplica (limitation de débit et cache en mémoire).

## 7. Ordre de mise en service

1. **Application principale d’abord** : déployer la migration des vues `monitoring_*` et la page de
   connexion du suivi (branche `monitoring-sso` de PoppyTrip).
2. Lancer **à la main** `ops/monitoring-roles.sql` de PoppyTrip avec le compte principal (crée
   `monitoring_reader`, `monitoring_app_rw` et le schéma `monitoring_app`) ; ranger les deux mots
   de passe générés dans le gestionnaire de secrets.
3. Générer la paire de clés et relever l’identifiant de ton compte (section 3) ; ajouter
   `MONITORING_SSO_PRIVATE_KEY`, `MONITORING_SSO_CALLBACK_URL` et `MONITORING_ADMIN_USER_ID` à
   PoppyTrip et le redéployer.
4. Créer le service Railway du suivi et ses variables (sections 5 et 6).
5. Ouvrir `https://<domaine>/<ADMIN_PATH_PREFIX>/auth/login` et se connecter avec ton compte PoppyTrip.
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

Pour une protection supplémentaire, notamment une double authentification que PoppyTrip n’a pas
(configuration, pas de code) : placer le domaine derrière Cloudflare (proxy activé), créer une
application **Cloudflare Zero Trust → Access → Self-hosted** sur
`https://<domaine>/<ADMIN_PATH_PREFIX>/*`, politique **Allow** limitée à ta seule adresse e-mail
(code à usage unique ou fournisseur d’identité), et laisser `/healthz` hors de l’application pour le
contrôle de santé de Railway. Compter alors le mandataire Cloudflare dans `TRUST_PROXY_HOPS` (2).

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
