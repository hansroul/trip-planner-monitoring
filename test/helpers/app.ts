import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { buildApp, FLOW_COOKIE, SESSION_COOKIE, type AppDeps, type RateLimitSettings } from '../../src/server/app.js';
import { createOidcProvider } from '../../src/server/auth/oidc.js';
import { loadConfig, type AppConfig } from '../../src/server/config.js';
import { createPools, type Pools } from '../../src/server/db/pools.js';
import { loadClientBundle } from '../../src/server/http/static.js';
import type { LogStream } from '../../src/server/logger.js';
import type { MockOidc } from './mockOidc.js';

export const TEST_PREFIX = 'k3J9xQ2mZ7pL4vR8tY1wB6nC';
export const TEST_ORIGIN = 'https://monitoring.example.test';
export const TEST_ADMIN_EMAIL = 'admin@example.com';
export const BASE = `/${TEST_PREFIX}`;

export function testEnv(issuer: string, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const urls = inject('dbUrls');
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_BASE_URL: TEST_ORIGIN,
    ADMIN_PATH_PREFIX: TEST_PREFIX,
    MAIN_APP_URL: 'https://app.example.test',
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: 'test-client-id',
    OIDC_CLIENT_SECRET: 'test-client-secret-value',
    OIDC_REDIRECT_URI: `${TEST_ORIGIN}/${TEST_PREFIX}/auth/callback`,
    ADMIN_EMAIL: TEST_ADMIN_EMAIL,
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
  mock: MockOidc,
  opts: {
    env?: Record<string, string | undefined>;
    now?: () => Date;
    rateLimits?: RateLimitSettings;
    logStream?: LogStream;
    registerApi?: AppDeps['registerApi'];
  } = {},
): Promise<TestApp> {
  const config = loadConfig(testEnv(mock.issuer, opts.env));
  const pools = createPools(config.db);
  const oidc = createOidcProvider(config.oidc, { allowInsecureForTests: true });
  const client = await loadClientBundle(path.resolve('test/fixtures/client'));
  const app = await buildApp({
    config,
    pools,
    oidc,
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

/**
 * Connexion complète contre le fournisseur simulé. `tamper` permet de fausser une étape
 * (state, vérificateur PKCE, nonce, revendications, signature).
 */
export async function login(
  t: TestApp,
  mock: MockOidc,
  tamper: {
    claims?: Record<string, unknown>;
    state?: string;
    nonce?: string;
    codeChallenge?: string;
    wrongKey?: boolean;
    dropFlowCookie?: boolean;
  } = {},
): Promise<LoginAttempt> {
  const start = await t.app.inject({ method: 'GET', url: `${BASE}/auth/login` });
  if (start.statusCode !== 302) throw new Error(`login: ${start.statusCode}`);
  const flow = setCookieValue(start.headers, FLOW_COOKIE);
  const authUrl = new URL(String(start.headers.location));
  const state = authUrl.searchParams.get('state') ?? '';
  const nonce = authUrl.searchParams.get('nonce') ?? '';
  const challenge = authUrl.searchParams.get('code_challenge') ?? '';
  const code = mock.issueCode({
    codeChallenge: tamper.codeChallenge ?? challenge,
    nonce: tamper.nonce ?? nonce,
    ...(tamper.claims ? { claims: tamper.claims } : {}),
    ...(tamper.wrongKey ? { wrongKey: true } : {}),
  });
  const cb = await t.app.inject({
    method: 'GET',
    url: `${BASE}/auth/callback?code=${code}&state=${encodeURIComponent(tamper.state ?? state)}`,
    headers: tamper.dropFlowCookie || !flow ? {} : { cookie: `${FLOW_COOKIE}=${flow}` },
  });
  return {
    statusCode: cb.statusCode,
    sessionCookie: setCookieValue(cb.headers, SESSION_COOKIE),
    body: cb.body,
    headers: cb.headers,
  };
}

export const cookieHeader = (sid: string) => ({ cookie: `${SESSION_COOKIE}=${sid}` });
