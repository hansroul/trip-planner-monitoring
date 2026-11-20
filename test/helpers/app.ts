import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { buildApp, FLOW_COOKIE, SESSION_COOKIE, type AppDeps, type RateLimitSettings } from '../../src/server/app.js';
import { loadConfig, type AppConfig } from '../../src/server/config.js';
import { createPools, type Pools } from '../../src/server/db/pools.js';
import { loadClientBundle } from '../../src/server/http/static.js';
import type { LogStream } from '../../src/server/logger.js';

export const TEST_PREFIX = 'k3J9xQ2mZ7pL4vR8tY1wB6nC';
export const TEST_ORIGIN = 'https://monitoring.example.test';
export const BASE = `/${TEST_PREFIX}`;
export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'mot-de-passe-de-test-correct';

/** Empreinte argon2id (format PHC) d'un mot de passe, paramètres minimaux admis (tests rapides). */
export function testPasswordHash(password: string, params = { m: 19_456, t: 2, p: 1 }): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: params.m, timeCost: params.t, parallelism: params.p });
}
const ADMIN_PASSWORD_HASH = await testPasswordHash(ADMIN_PASSWORD);

export function testEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const urls = inject('dbUrls');
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_BASE_URL: TEST_ORIGIN,
    ADMIN_PATH_PREFIX: TEST_PREFIX,
    ADMIN_EMAIL,
    ADMIN_PASSWORD_HASH,
    SESSION_SECRET: randomBytes(48).toString('base64'),
    DATABASE_URL_READONLY: urls.readonly,
    DATABASE_URL_APP: urls.app,
    TIMEZONE: 'Europe/Brussels',
    ...overrides,
  };
}

export interface TestApp {
  app: FastifyInstance;
  config: AppConfig;
  pools: Pools;
  close(): Promise<void>;
}

export async function createTestApp(
  opts: {
    env?: Record<string, string | undefined>;
    now?: () => Date;
    rateLimits?: RateLimitSettings;
    logStream?: LogStream;
    registerApi?: AppDeps['registerApi'];
  } = {},
): Promise<TestApp> {
  const config = loadConfig(testEnv(opts.env));
  const pools = createPools(config.db);
  const client = await loadClientBundle(path.resolve('test/fixtures/client'));
  const app = await buildApp({
    config,
    pools,
    client,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.rateLimits ? { rateLimits: opts.rateLimits } : {}),
    ...(opts.logStream ? { logStream: opts.logStream } : {}),
    ...(opts.registerApi ? { registerApi: opts.registerApi } : {}),
  });
  await app.ready();
  return {
    app,
    config,
    pools,
    async close() {
      await app.close();
      await Promise.allSettled([pools.read.end(), pools.app.end()]);
    },
  };
}

/** Valeur d'un cookie dans les en-têtes Set-Cookie d'une réponse. */
export function setCookieValue(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const c of list as string[]) {
    const [pair] = c.split(';');
    const [k, ...v] = (pair ?? '').split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

export function setCookieHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers['set-cookie'];
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as string[];
  return list.find((c) => c.startsWith(`${name}=`));
}

export interface LoginAttempt {
  statusCode: number;
  sessionCookie: string | undefined;
  body: string;
  headers: Record<string, unknown>;
}

export interface Tamper {
  email?: string;
  password?: string;
  formToken?: string;
  omitFormToken?: boolean;
  dropFlowCookie?: boolean;
  origin?: string | null;
  secFetchSite?: string;
  extraCookie?: string;
}

/** Affiche le formulaire de connexion : jeton du formulaire et cookie de flux. */
export async function openLoginForm(t: TestApp): Promise<{ formToken: string; flow: string | undefined; body: string }> {
  const page = await t.app.inject({ method: 'GET', url: `${BASE}/auth/login` });
  if (page.statusCode !== 200) throw new Error(`login: ${page.statusCode}`);
  const formToken = /name="form_token" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
  return { formToken, flow: setCookieValue(page.headers, FLOW_COOKIE), body: page.body };
}

/** Connexion complète par le formulaire ; `tamper` fausse une étape. */
export async function login(t: TestApp, tamper: Tamper = {}): Promise<LoginAttempt> {
  const { formToken, flow } = await openLoginForm(t);
  const form = new URLSearchParams({ email: tamper.email ?? ADMIN_EMAIL, password: tamper.password ?? ADMIN_PASSWORD });
  if (!tamper.omitFormToken) form.set('form_token', tamper.formToken ?? formToken);
  const cookies = [tamper.dropFlowCookie || !flow ? null : `${FLOW_COOKIE}=${flow}`, tamper.extraCookie ?? null].filter(Boolean);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const origin = tamper.origin === undefined ? t.config.publicOrigin : tamper.origin;
  if (origin !== null) headers.origin = origin;
  if (tamper.secFetchSite) headers['sec-fetch-site'] = tamper.secFetchSite;
  if (cookies.length) headers.cookie = cookies.join('; ');
  const res = await t.app.inject({ method: 'POST', url: `${BASE}/auth/login`, headers, payload: form.toString() });
  return {
    statusCode: res.statusCode,
    sessionCookie: setCookieValue(res.headers, SESSION_COOKIE),
    body: res.body,
    headers: res.headers,
  };
}

export const cookieHeader = (sid: string) => ({ cookie: `${SESSION_COOKIE}=${sid}` });
