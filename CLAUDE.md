# CLAUDE.md — site de suivi privé de PoppyTrip

Site de suivi (monitoring) privé, un seul utilisateur autorisé, déployé sur Railway comme service
séparé de PoppyTrip. TypeScript, Fastify (sert aussi le front React/Vite construit), pg + SQL
paramétré, Zod, Vitest. Interface en français uniquement.

## Règles de sécurité À NE JAMAIS ENFREINDRE

1. **Aucune donnée personnelle.** Ni lue, ni affichée, ni journalisée, ni renvoyée par l'API :
   pas d'e-mail, pas de nom, aucune liste de personnes. Seulement des comptages et des montants.
   L'adresse autorisée (ADMIN_EMAIL) n'apparaît dans aucun fichier versionné ni aucune réponse.
2. **Aucun secret versionné.** Ni clé, ni mot de passe, ni URL de base, ni adresse réelle dans le
   dépôt (y compris tests, exemples et messages de commit). Les tests utilisent des valeurs
   fictives (`admin@example.com`, domaines `.test`/`example.*`). Le hook de pré-commit et
   `test/secrets.test.ts` doivent rester verts ; ne jamais les contourner (`--no-verify`).
3. **Tout en variables d'environnement**, validées par Zod dans `src/server/config.ts` ; le serveur
   refuse de démarrer si une variable manque ou est faible. Aucune URL, aucun chemin
   d'administration, aucun secret en dur. Le préfixe d'administration est injecté à l'exécution
   (le build du front n'en contient aucun).
4. **Lecture seule sur les vues de PoppyTrip.** Le rôle `monitoring_reader` ne lit que les 12 vues
   `public.monitoring_*` du contrat (`sql/contract.sql`, `src/server/data/contract.ts`). Toute
   requête passe par le registre `src/server/data/queries.ts` (SQL paramétré, vues qualifiées
   `public.`), vérifié par `test/data.test.ts`.
5. **Jamais de lecture des tables de PoppyTrip**, jamais la `DATABASE_URL` de PoppyTrip. Les
   écritures propres au site vont uniquement dans le schéma `monitoring_app` (rôle
   `monitoring_app_rw`, migrations SQL dans `sql/migrations/`). Ce site ne crée aucun rôle.
6. **Jamais de journalisation de jetons ou de cookies** (ni code OIDC, state, nonce, jeton CSRF,
   identifiant de session, clé Anthropic, mot de passe). Utiliser `safeError()` / `redactObject()`
   de `src/server/logger.ts` ; les URL sont journalisées sans chaîne de requête et avec le
   préfixe masqué.

## Autres invariants

- Visiteur sans session : 404 strictement identique partout, sauf `/healthz`, `/robots.txt`,
  `<préfixe>/auth/login` et `<préfixe>/auth/callback`.
- Toute modification (POST/PUT/PATCH/DELETE) exige l'origine exacte ET le jeton CSRF.
- Politique de contenu stricte : aucun script ni style en ligne, aucune ressource externe (pas de
  CDN, pas de police distante, aucun traceur). Graphiques SVG avec attributs de présentation
  uniquement, jamais d'attribut `style`.
- OIDC uniquement via `openid-client` (PKCE, state, nonce, signature vérifiée avec
  `enableNonRepudiationChecks`) ; pas de cryptographie maison.
- Pas de dépendance inutile ; versions exactes, figées par `package-lock.json`.

## Commandes

- `npm run typecheck` · `npm test` (exige `TEST_PG_ADMIN_URL`, base locale du docker-compose) ·
  `npm run build` · `npm run dev` · `npm run check:secrets`
- Chaque modification se termine par : typecheck, tests, commit.
