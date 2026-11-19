import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FLOW_COOKIE, NOT_FOUND_BODY, SESSION_COOKIE } from '../src/server/app.js';
import { renderIndex } from '../src/server/http/static.js';
import {
  BASE,
  cookieHeader,
  createTestApp,
  login,
  setCookieHeader,
  TEST_ORIGIN,
  TEST_PREFIX,
  type TestApp,
} from './helpers/app.js';
import { startMockOidc, type MockOidc } from './helpers/mockOidc.js';

let mock: MockOidc;
let t: TestApp;

beforeAll(async () => {
  mock = await startMockOidc();
});
afterAll(async () => {
  await mock.close();
});
afterEach(async () => {
  await t?.close();
});

const VOLATILE = new Set(['date', 'connection', 'keep-alive']);
const stable = (h: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(h).filter(([k]) => !VOLATILE.has(k)).sort(([a], [b]) => a.localeCompare(b)));

describe('visiteur non connecté', () => {
  it('reçoit une 404 strictement identique partout sauf connexion, retour et santé', async () => {
    t = await createTestApp(mock);
    const requests: Array<{ method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS' | 'HEAD'; url: string; headers?: Record<string, string> }> = [
      { method: 'GET', url: '/' },
      { method: 'GET', url: '/inconnu' },
      { method: 'GET', url: BASE },
      { method: 'GET', url: `${BASE}/` },
      { method: 'GET', url: `${BASE}/index.html` },
      { method: 'GET', url: `${BASE}/assets/app.js` },
      { method: 'GET', url: `${BASE}/api/session` },
      { method: 'GET', url: `${BASE}/api/overview?from=2026-01-01&to=2026-01-31` },
      { method: 'POST', url: `${BASE}/auth/logout`, headers: { origin: TEST_ORIGIN } },
      { method: 'POST', url: `${BASE}/api/credit/topups`, headers: { 'content-type': 'application/json' } },
      { method: 'DELETE', url: `${BASE}/api/credit/topups/1` },
      { method: 'OPTIONS', url: `${BASE}/api/session`, headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } },
      { method: 'GET', url: `${BASE}/api/session`, headers: { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` } },
      { method: 'GET', url: `${BASE}/api/session`, headers: { cookie: `${SESSION_COOKIE}=nimporte-quoi` } },
      { method: 'GET', url: '/healthz/x' },
      { method: 'GET', url: '/%E0%A4%A' },
    ];
    const responses = [];
    for (const r of requests) {
      const res = await t.app.inject({ method: r.method, url: r.url, headers: r.headers ?? {}, ...(r.method === 'POST' ? { payload: '{}' } : {}) });
      responses.push(res);
    }
    const reference = responses[0]!;
    expect(reference.statusCode).toBe(404);
    expect(reference.body).toBe(NOT_FOUND_BODY);
    for (const [i, res] of responses.entries()) {
      expect(res.statusCode, requests[i]!.url).toBe(404);
      expect(res.body, requests[i]!.url).toBe(NOT_FOUND_BODY);
      expect(stable(res.headers), requests[i]!.url).toEqual(stable(reference.headers));
    }
  });

  it('/healthz répond « ok » sans aucune information', async () => {
    t = await createTestApp(mock);
    const res = await t.app.inject({ url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok');
  });

  it('robots.txt interdit tout', async () => {
    t = await createTestApp(mock);
    const res = await t.app.inject({ url: '/robots.txt' });
    expect(res.body).toBe('User-agent: *\nDisallow: /\n');
  });

  it('le démarrage de connexion redirige vers le fournisseur avec PKCE S256, state et nonce', async () => {
    t = await createTestApp(mock);
    const res = await t.app.inject({ url: `${BASE}/auth/login` });
    expect(res.statusCode).toBe(302);
    const loc = new URL(String(res.headers.location));
    expect(loc.origin).toBe(mock.issuer);
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.get('state')).toBeTruthy();
    expect(loc.searchParams.get('nonce')).toBeTruthy();
    expect(loc.searchParams.get('redirect_uri')).toBe(`${TEST_ORIGIN}${BASE}/auth/callback`);
    const flow = setCookieHeader(res.headers, FLOW_COOKIE)!;
    expect(flow).toMatch(/; Max-Age=600/);
    expect(flow).toMatch(/; Path=\//);
    expect(flow).toMatch(/; HttpOnly/);
    expect(flow).toMatch(/; Secure/);
    expect(flow).toMatch(/; SameSite=Lax/);
    expect(flow).not.toMatch(/Domain=/i);
  });
});

describe('en-têtes et cookies', () => {
  it('pose les en-têtes de sécurité sur toutes les réponses', async () => {
    t = await createTestApp(mock);
    const { sessionCookie } = await login(t, mock);
    for (const res of [
      await t.app.inject({ url: '/healthz' }),
      await t.app.inject({ url: '/nope' }),
      await t.app.inject({ url: `${BASE}/`, headers: cookieHeader(sessionCookie!) }),
      await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) }),
    ]) {
      const h = res.headers;
      const csp = String(h['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
      expect(csp).toContain("frame-ancestors 'none'");
      expect(h['strict-transport-security']).toMatch(/max-age=\d+; includeSubDomains/);
      expect(h['x-frame-options']).toBe('DENY');
      expect(h['referrer-policy']).toBe('no-referrer');
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['x-robots-tag']).toContain('noindex');
      expect(h['permissions-policy']).toContain('camera=()');
      expect(h['cache-control']).toContain('no-store');
      expect(h['access-control-allow-origin']).toBeUndefined();
      expect(h['x-powered-by']).toBeUndefined();
    }
  });

  it('cookie de session : __Host-, Secure, HttpOnly, SameSite=Strict, Path=/', async () => {
    t = await createTestApp(mock);
    const r = await login(t, mock);
    const c = setCookieHeader(r.headers, SESSION_COOKIE)!;
    expect(c).toMatch(/^__Host-mon_sid=[A-Za-z0-9_-]{43};/);
    expect(c).toMatch(/; Path=\//);
    expect(c).toMatch(/; HttpOnly/);
    expect(c).toMatch(/; Secure/);
    expect(c).toMatch(/; SameSite=Strict/);
    expect(c).not.toMatch(/Domain=/i);
    // Le cookie temporaire du flux est supprimé après usage.
    expect(setCookieHeader(r.headers, FLOW_COOKIE)).toMatch(/__Host-mon_flow=;.*Expires=Thu, 01 Jan 1970/);
  });

  it('pas de CORS : aucune autorisation d’origine tierce', async () => {
    t = await createTestApp(mock);
    const { sessionCookie } = await login(t, mock);
    const res = await t.app.inject({
      url: `${BASE}/api/session`,
      headers: { ...cookieHeader(sessionCookie!), origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('CSRF', () => {
  it('exige le jeton CSRF ET la bonne origine pour toute modification', async () => {
    t = await createTestApp(mock);
    const { sessionCookie } = await login(t, mock);
    const csrf = (await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) })).json()
      .csrfToken as string;
    const base = { method: 'POST' as const, url: `${BASE}/auth/logout` };
    const attempts = [
      { ...cookieHeader(sessionCookie!), origin: TEST_ORIGIN },
      { ...cookieHeader(sessionCookie!), origin: TEST_ORIGIN, 'x-csrf-token': 'x'.repeat(43) },
      { ...cookieHeader(sessionCookie!), origin: 'https://evil.example', 'x-csrf-token': csrf },
      { ...cookieHeader(sessionCookie!), 'x-csrf-token': csrf },
      { ...cookieHeader(sessionCookie!), origin: TEST_ORIGIN, 'x-csrf-token': csrf, 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of attempts) {
      expect((await t.app.inject({ ...base, headers })).statusCode).toBe(403);
    }
    const ok = await t.app.inject({
      ...base,
      headers: { ...cookieHeader(sessionCookie!), origin: TEST_ORIGIN, 'x-csrf-token': csrf, 'sec-fetch-site': 'same-origin' },
    });
    expect(ok.statusCode).toBe(204);
  });
});

describe('limitation de débit', () => {
  it('limite strictement la connexion et son retour', async () => {
    t = await createTestApp(mock, { rateLimits: { globalMax: 1000, authMax: 3, windowMs: 60_000 } });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await t.app.inject({ url: `${BASE}/auth/login` })).statusCode);
    expect(codes).toEqual([302, 302, 302, 429, 429]);
    const cbCodes = [];
    for (let i = 0; i < 4; i++) cbCodes.push((await t.app.inject({ url: `${BASE}/auth/callback?code=x&state=y` })).statusCode);
    expect(cbCodes.at(-1)).toBe(429);
  });

  it('limite le reste du site', async () => {
    t = await createTestApp(mock, { rateLimits: { globalMax: 5, authMax: 5, windowMs: 60_000 } });
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await t.app.inject({ url: `/x${i}` })).statusCode);
    expect(codes.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });
});

describe('préfixe d’administration', () => {
  it('est injecté à l’exécution dans la page servie (absent du build)', async () => {
    t = await createTestApp(mock);
    const { sessionCookie } = await login(t, mock);
    const res = await t.app.inject({ url: `${BASE}/`, headers: cookieHeader(sessionCookie!) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`<base href="/${TEST_PREFIX}/">`);
    expect(res.body).toContain(`<meta name="app-base" content="/${TEST_PREFIX}/">`);
    expect(res.body).not.toContain('<!--app-base-->');
    const asset = await t.app.inject({ url: `${BASE}/assets/app.js`, headers: cookieHeader(sessionCookie!) });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(renderIndex('<head><!--app-base--></head>', '/abc')).toBe(
      '<head><base href="/abc/"><meta name="app-base" content="/abc/"></head>',
    );
  });

  it('le site n’existe pas hors du préfixe, même connecté', async () => {
    t = await createTestApp(mock);
    const { sessionCookie } = await login(t, mock);
    for (const url of ['/', '/api/session', '/assets/app.js', `${BASE}x/`]) {
      const res = await t.app.inject({ url, headers: cookieHeader(sessionCookie!) });
      expect(res.statusCode).toBe(404);
    }
    const traversal = await t.app.inject({ url: `${BASE}/../../package.json`, headers: cookieHeader(sessionCookie!) });
    expect(traversal.statusCode).toBe(404);
  });
});
