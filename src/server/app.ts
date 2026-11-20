import { createHash, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { LOGIN_CSS, loginPage } from './auth/loginPage.js';
import { verifyPassword } from './auth/password.js';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, SessionStore, randomToken, type Session } from './auth/sessions.js';
import type { AppConfig } from './config.js';
import { writeAudit } from './db/audit.js';
import type { Pools } from './db/pools.js';
import { registerSecurityHeaders } from './http/security.js';
import { renderIndex, type ClientBundle } from './http/static.js';
import { loggerOptions, safeError, type LogStream } from './logger.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
  }
}

export const SESSION_COOKIE = '__Host-mon_sid';
export const FLOW_COOKIE = '__Host-mon_flow';
export const NOT_FOUND_BODY = 'Not Found';
const TEXT = 'text/plain; charset=utf-8';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface RateLimitSettings {
  globalMax: number;
  authMax: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitSettings = { globalMax: 240, authMax: 10, windowMs: 15 * 60 * 1000 };

export interface AppDeps {
  config: AppConfig;
  pools: Pools;
  client: ClientBundle;
  now?: () => Date;
  logStream?: LogStream;
  rateLimits?: RateLimitSettings;
  /** Routes de l'API (montées sous le préfixe, session obligatoire). */
  registerApi?: (app: FastifyInstance, ctx: AppContext) => Promise<void> | void;
}

export interface AppContext {
  config: AppConfig;
  pools: Pools;
  sessions: SessionStore;
  now: () => Date;
}

/** Réponse 404 strictement identique pour toute route inconnue ou non autorisée. */
export function sendNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).type(TEXT).send(NOT_FOUND_BODY);
}

const sessionCookieOptions = {
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'strict' as const,
  maxAge: SESSION_ABSOLUTE_MS / 1000,
};
const flowCookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'strict' as const, maxAge: 600 };
const HTML = 'text/html; charset=utf-8';

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, pools } = deps;
  const now = deps.now ?? (() => new Date());
  const limits = deps.rateLimits ?? DEFAULT_RATE_LIMITS;
  const base = config.basePath;
  const loginPath = `${base}/auth/login`;
  const loginCssPath = `${base}/auth/login.css`;
  const publicPaths = new Set(['/healthz', '/robots.txt', loginPath, loginCssPath]);
  const sessions = new SessionStore(pools.app, config.sessionSecret, now);
  const indexHtml = renderIndex(deps.client.index, base);

  const app = Fastify({
    logger: loggerOptions(config.logLevel, base, deps.logStream),
    // Nombre exact de mandataires de confiance (Railway : 1) : l'adresse du client sert à la
    // limitation de débit et au préfixe réseau de l'audit.
    trustProxy: config.trustProxyHops > 0 ? (_addr: string, hop: number) => hop < config.trustProxyHops : false,
    bodyLimit: 16 * 1024,
    return503OnClosing: true,
    // URL mal formée, etc. : même 404 que partout (rien ne doit trahir le contenu du site).
    // URL indécodable : réécrite vers un chemin inconnu pour passer par les mêmes crochets
    // (en-têtes de sécurité compris) et recevoir la même 404.
    rewriteUrl: (req) => {
      const url = req.url ?? '/';
      try {
        decodeURIComponent(url.split('?')[0] ?? '');
        return url;
      } catch {
        return '/__invalid__';
      }
    },
    frameworkErrors: (_err, _req, reply) => {
      sendNotFound(reply);
    },
  });
  app.decorateRequest('session', null);

  await registerSecurityHeaders(app, config.production);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({ statusCode: 429, error: 'Too Many Requests', message: 'Too Many Requests' }),
    addHeadersOnExceeding: { 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false, 'x-ratelimit-reset': false },
    addHeaders: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
      'retry-after': true,
    },
  });
  await app.register(cookie);

  // Limitation de débit AVANT le contrôle d'accès (elle couvre donc aussi les 404) : plafond
  // strict pour la page de connexion (affichage et envoi), plafond général pour le reste.
  const isAuthPath = (req: FastifyRequest) => req.url.split('?')[0] === loginPath;
  app.addHook(
    'onRequest',
    app.rateLimit({
      timeWindow: limits.windowMs,
      keyGenerator: (req: FastifyRequest) => (isAuthPath(req) ? `auth:${req.ip}` : `all:${req.ip}`),
      max: (_req: FastifyRequest, key: string) => (key.startsWith('auth:') ? limits.authMax : limits.globalMax),
    }),
  );

  // Contrôle d'accès global : sans session valide, TOUT répond 404 (sauf santé, robots,
  // page de connexion et sa feuille de style).
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (publicPaths.has(path)) return;
    const background = req.headers['x-background-refresh'] === '1';
    const session = await sessions.validate(req.cookies[SESSION_COOKIE], !background);
    if (!session) {
      sendNotFound(reply);
      return reply;
    }
    req.session = session;
    if (MUTATING.has(req.method) && !csrfOk(req, session, config.publicOrigin)) {
      reply.code(403).type(TEXT).send('Forbidden');
      return reply;
    }
  });

  app.setNotFoundHandler((_req, reply) => sendNotFound(reply));

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err.statusCode === 429) return reply.code(429).type(TEXT).send('Too Many Requests');
    if (!req.session) return sendNotFound(reply);
    if (err.validation || err.statusCode === 400 || err.statusCode === 415 || err.statusCode === 413) {
      return reply.code(400).send({ error: 'Requête invalide' });
    }
    req.log.error({ err: safeError(err) }, 'erreur interne');
    return reply.code(500).send({ error: 'Erreur interne' });
  });

  // --- Routes publiques -------------------------------------------------------------------
  app.get('/healthz', async (_req, reply) => reply.type(TEXT).send('ok'));
  app.get('/robots.txt', async (_req, reply) => reply.type(TEXT).send('User-agent: *\nDisallow: /\n'));

  app.get(loginCssPath, async (_req, reply) => reply.type('text/css; charset=utf-8').send(LOGIN_CSS));

  // Affiche le formulaire avec un nouveau jeton anti-falsification (usage unique, 10 min).
  const showLoginForm = async (reply: FastifyReply, status: number, error?: string) => {
    const formToken = randomToken();
    const flowId = await sessions.createFlow({ state: formToken });
    reply.setCookie(FLOW_COOKIE, flowId, flowCookieOptions);
    return reply.code(status).type(HTML).send(loginPage({ action: loginPath, cssHref: loginCssPath, formToken, error }));
  };

  app.get(loginPath, async (req, reply) => {
    try {
      await sessions.prune();
      // Déjà connecté : directement au tableau de bord.
      if (await sessions.validate(req.cookies[SESSION_COOKIE], false)) return reply.redirect(`${base}/`, 303);
      return await showLoginForm(reply, 200);
    } catch (err) {
      req.log.error({ err: safeError(err) }, 'page de connexion indisponible');
      return reply.code(503).type(TEXT).send('Service indisponible');
    }
  });

  // Envoi du formulaire : e-mail + mot de passe vérifiés ici (empreinte argon2id configurée).
  await app.register(async (scoped) => {
    scoped.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 4096 },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );

    scoped.post(loginPath, async (req, reply) => {
      const refuse = async (reason: string, status: number, message: string) => {
        req.log.warn({ reason }, 'connexion refusée');
        await writeAudit(pools.app, { event: 'login', outcome: 'refused', ip: req.ip, details: { reason } }).catch(
          (e: unknown) => req.log.error({ err: safeError(e) }, 'audit impossible'),
        );
        return showLoginForm(reply, status, message);
      };

      const flow = await sessions.consumeFlow(req.cookies[FLOW_COOKIE]);
      reply.clearCookie(FLOW_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'strict' });
      const site = req.headers['sec-fetch-site'];
      if (req.headers.origin !== config.publicOrigin || (site !== undefined && site !== 'same-origin')) {
        return refuse('origin_invalid', 403, 'Requête refusée. Recharge la page et réessaie.');
      }
      const form = (req.body ?? {}) as Record<string, unknown>;
      if (!flow || typeof form.form_token !== 'string' || !safeEqual(form.form_token, flow.state)) {
        return refuse('form_expired', 403, 'La page de connexion a expiré. Réessaie.');
      }

      const email = typeof form.email === 'string' ? form.email.trim().toLowerCase() : '';
      const password = typeof form.password === 'string' ? form.password : '';
      // Le mot de passe est toujours vérifié, même si l'e-mail est faux : même durée de réponse.
      const passwordOk = await verifyPassword(config.admin.passwordHash, password);
      const emailOk = safeEqual(email, config.admin.email);
      if (!(emailOk && passwordOk)) return refuse('credentials', 401, 'Identifiants refusés.');

      // Nouvel identifiant de session à chaque connexion : l'éventuelle ancienne est détruite.
      await sessions.destroy(req.cookies[SESSION_COOKIE]);
      const { id } = await sessions.create();
      reply.setCookie(SESSION_COOKIE, id, sessionCookieOptions);
      await writeAudit(pools.app, { event: 'login', outcome: 'success', ip: req.ip });
      return reply.redirect(`${base}/`, 303);
    });
  });

  // --- Routes protégées (session déjà vérifiée par le crochet) ----------------------------
  app.post(`${base}/auth/logout`, async (req, reply) => {
    await sessions.destroy(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'strict' });
    await writeAudit(pools.app, { event: 'logout', outcome: 'success', ip: req.ip });
    return reply.code(204).send();
  });

  app.get(`${base}/api/session`, async (req) => {
    const s = req.session!;
    return {
      csrfToken: s.csrfToken,
      absoluteExpiresAt: s.absoluteExpiresAt.toISOString(),
      idleTimeoutSeconds: SESSION_IDLE_MS / 1000,
      mainAppUrl: config.mainAppUrl,
      timezone: config.timezone,
    };
  });

  if (deps.registerApi) {
    await app.register(
      async (scoped) => {
        await deps.registerApi!(scoped, { config, pools, sessions, now });
      },
      { prefix: `${base}/api` },
    );
  }

  app.get(base, async (_req, reply) => reply.redirect(`${base}/`, 302));
  app.get(`${base}/`, async (_req, reply) => reply.type('text/html; charset=utf-8').send(indexHtml));
  app.get(`${base}/*`, async (req: FastifyRequest<{ Params: { '*': string } }>, reply) => {
    const rel = req.params['*'];
    if (rel === 'index.html') return reply.type('text/html; charset=utf-8').send(indexHtml);
    const file = deps.client.files.get(rel);
    if (!file) return sendNotFound(reply);
    return reply.type(file.type).send(file.body);
  });

  return app;
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function csrfOk(req: FastifyRequest, session: Session, publicOrigin: string): boolean {
  // Vérification d'origine ET jeton CSRF (en plus du cookie SameSite=Strict).
  if (req.headers.origin !== publicOrigin) return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return false;
  const token = req.headers['x-csrf-token'];
  if (typeof token !== 'string' || token.length !== session.csrfToken.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ session.csrfToken.charCodeAt(i);
  return diff === 0;
}
