import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { buildApp, FLOW_COOKIE, SESSION_COOKIE, type AppDeps, type RateLimitSettings } from '../../src/server/app.js';
import { createSsoProvider } from '../../src/server/auth/sso.js';
import { loadConfig, type AppConfig } from '../../src/server/config.js';
import { createPools, type Pools } from '../../src/server/db/pools.js';
import { loadClientBundle } from '../../src/server/http/static.js';
import type { LogStream } from '../../src/server/logger.js';
import { ADMIN_ACCOUNT_ID, SSO_PUBLIC_KEY_PEM, SSO_URL, signSsoToken, type SignOptions } from './mockSso.js';

export const TEST_PREFIX = 'k3J9xQ2mZ7pL4vR8tY1wB6nC';
export const TEST_ORIGIN = 'https://monitoring.example.test';
export const BASE = `/${TEST_PREFIX}`;

export function testEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const urls = inject('dbUrls');
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_BASE_URL: TEST_ORIGIN,
    ADMIN_PATH_PREFIX: TEST_PREFIX,
    POPPYTRIP_SSO_URL: SSO_URL,
    // Forme d'une variable d'environnement : retours à la ligne écrits « \n ».
    POPPYTRIP_SSO_PUBLIC_KEY: SSO_PUBLIC_KEY_PEM.replace(/\n/g, '\\n'),
    ADMIN_ACCOUNT_ID,
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
  const idp = createSsoProvider(config.sso);
  const client = await loadClientBundle(path.resolve('test/fixtures/client'));
  const app = await buildApp({
    config,
    pools,
    idp,
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
  /** Options de signature à modifier (le nonce et l'audience corrects sont fournis). */
  sign?: Partial<SignOptions>;
  /** Jeton complet à la place du jeton signé. */
  token?: (ctx: { nonce: string; audience: string }) => Promise<string> | string;
  state?: string;
  omitToken?: boolean;
  dropFlowCookie?: boolean;
  extraCookie?: string;
}

/** Connexion complète, PoppyTrip étant simulé ; `tamper` fausse une étape. */
export async function login(t: TestApp, tamper: Tamper = {}): Promise<LoginAttempt> {
  const start = await t.app.inject({ method: 'GET', url: `${BASE}/auth/login` });
  if (start.statusCode !== 302) throw new Error(`login: ${start.statusCode}`);
  const flow = setCookieValue(start.headers, FLOW_COOKIE);
  const ssoUrl = new URL(String(start.headers.location));
  const state = ssoUrl.searchParams.get('state') ?? '';
  const nonce = ssoUrl.searchParams.get('nonce') ?? '';
  const audience = t.config.publicOrigin;
  const token = tamper.token
    ? await tamper.token({ nonce, audience })
    : await signSsoToken({ nonce, audience, ...tamper.sign });
  const query = new URLSearchParams({ state: tamper.state ?? state });
  if (!tamper.omitToken) query.set('token', token);
  const cookies = [tamper.dropFlowCookie || !flow ? null : `${FLOW_COOKIE}=${flow}`, tamper.extraCookie ?? null].filter(Boolean);
  const cb = await t.app.inject({
    method: 'GET',
    url: `${BASE}/auth/callback?${query.toString()}`,
    headers: cookies.length ? { cookie: cookies.join('; ') } : {},
  });
  return {
    statusCode: cb.statusCode,
    sessionCookie: setCookieValue(cb.headers, SESSION_COOKIE),
    body: cb.body,
    headers: cb.headers,
  };
}

export const cookieHeader = (sid: string) => ({ cookie: `${SESSION_COOKIE}=${sid}` });
