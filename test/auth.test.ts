import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/server/app.js';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../src/server/auth/sessions.js';
import { BASE, cookieHeader, createTestApp, login, TEST_ORIGIN, type TestApp } from './helpers/app.js';
import { startMockOidc, type MockOidc } from './helpers/mockOidc.js';

let mock: MockOidc;
let t: TestApp;
let clock = Date.now();
const now = () => new Date(clock);

beforeAll(async () => {
  mock = await startMockOidc();
});
afterAll(async () => {
  await mock.close();
});
afterEach(async () => {
  await t?.close();
  clock = Date.now();
});

async function lastAudit(app: TestApp) {
  const { rows } = await app.pools.app.query<{ event: string; outcome: string; details: Record<string, unknown> }>(
    'SELECT event, outcome, details FROM monitoring_app.audit_log ORDER BY id DESC LIMIT 1',
  );
  return rows[0];
}

describe('connexion OIDC', () => {
  it('accepte l’adresse autorisée (casse ignorée) et affiche UNE fois le sub à configurer', async () => {
    t = await createTestApp(mock, { now });
    const r = await login(t, mock, { claims: { email: 'Admin@Example.COM' } });
    expect(r.statusCode).toBe(200);
    expect(r.sessionCookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const first = await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(r.sessionCookie!) });
    expect(first.statusCode).toBe(200);
    expect(first.json().subNotice).toBe('sub-admin-0001');
    const second = await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(r.sessionCookie!) });
    expect(second.json().subNotice).toBeNull();
    expect(await lastAudit(t)).toMatchObject({ event: 'login', outcome: 'success' });
  });

  it('refuse une mauvaise adresse et l’audite sans l’adresse complète', async () => {
    t = await createTestApp(mock, { now });
    const r = await login(t, mock, { claims: { email: 'intrus@example.org' } });
    expect(r.statusCode).toBe(403);
    expect(r.sessionCookie).toBeUndefined();
    const audit = await lastAudit(t);
    expect(audit).toMatchObject({ event: 'login', outcome: 'refused', details: { reason: 'email_mismatch' } });
    expect(JSON.stringify(audit)).not.toContain('intrus@example.org');
    expect(audit!.details.email).toBe('i***@e***.org');
  });

  it('refuse un jeton sans adresse', async () => {
    t = await createTestApp(mock, { now });
    const r = await login(t, mock, { claims: { email: undefined, preferred_username: undefined } });
    expect(r.statusCode).toBe(403);
  });

  it('refuse un mauvais identifiant stable quand ADMIN_OIDC_SUB est défini, même avec la bonne adresse', async () => {
    t = await createTestApp(mock, { now, env: { ADMIN_OIDC_SUB: 'sub-admin-0001' } });
    expect((await login(t, mock, { claims: { sub: 'sub-autre' } })).statusCode).toBe(403);
    expect((await lastAudit(t))?.details.reason).toBe('sub_mismatch');
    const ok = await login(t, mock);
    expect(ok.statusCode).toBe(200);
    const s = await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(ok.sessionCookie!) });
    expect(s.json().subNotice).toBeNull();
  });

  it.each([
    ['state invalide', { state: 'state-falsifie' }],
    ['nonce invalide', { nonce: 'nonce-falsifie' }],
    ['vérificateur PKCE incorrect', { codeChallenge: 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FyYWdl' }],
    ['jeton expiré', { claims: { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 } }],
    ['autre émetteur', { claims: { iss: 'https://autre-emetteur.example.test' } }],
    ['autre audience', { claims: { aud: 'autre-client' } }],
    ['signature invalide', { wrongKey: true }],
    ['cookie de flux absent', { dropFlowCookie: true }],
  ])('refuse : %s', async (_label, tamper) => {
    t = await createTestApp(mock, { now });
    const r = await login(t, mock, tamper);
    expect(r.statusCode).toBe(403);
    expect(r.body).toBe('Connexion refusée.');
    expect(r.sessionCookie).toBeUndefined();
    expect((await lastAudit(t))?.outcome).toBe('refused');
  });

  it('un flux de connexion ne sert qu’une fois', async () => {
    t = await createTestApp(mock, { now });
    const start = await t.app.inject({ url: `${BASE}/auth/login` });
    const flowCookie = String((start.headers['set-cookie'] as string).split(';')[0]);
    const auth = new URL(String(start.headers.location));
    const code = mock.issueCode({
      codeChallenge: auth.searchParams.get('code_challenge')!,
      nonce: auth.searchParams.get('nonce')!,
    });
    const url = `${BASE}/auth/callback?code=${code}&state=${auth.searchParams.get('state')}`;
    expect((await t.app.inject({ url, headers: { cookie: flowCookie } })).statusCode).toBe(200);
    expect((await t.app.inject({ url, headers: { cookie: flowCookie } })).statusCode).toBe(403);
  });

  it('régénère l’identifiant de session à chaque connexion', async () => {
    t = await createTestApp(mock, { now });
    const a = await login(t, mock);
    const start = await t.app.inject({ url: `${BASE}/auth/login` });
    const flowCookie = String((start.headers['set-cookie'] as string).split(';')[0]);
    const auth = new URL(String(start.headers.location));
    const code = mock.issueCode({
      codeChallenge: auth.searchParams.get('code_challenge')!,
      nonce: auth.searchParams.get('nonce')!,
    });
    const b = await t.app.inject({
      url: `${BASE}/auth/callback?code=${code}&state=${auth.searchParams.get('state')}`,
      headers: { cookie: `${flowCookie}; ${SESSION_COOKIE}=${a.sessionCookie}` },
    });
    expect(b.statusCode).toBe(200);
    const newSid = String(b.headers['set-cookie']).match(/__Host-mon_sid=([^;]+)/)?.[1];
    expect(newSid).toBeDefined();
    expect(newSid).not.toBe(a.sessionCookie);
    // L'ancienne session est détruite.
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(a.sessionCookie!) })).statusCode).toBe(404);
  });
});

describe('sessions', () => {
  it('expire après 30 minutes d’inactivité', async () => {
    t = await createTestApp(mock, { now });
    const { sessionCookie } = await login(t, mock);
    clock += SESSION_IDLE_MS - 60_000;
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) })).statusCode).toBe(200);
    clock += SESSION_IDLE_MS + 1_000;
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) })).statusCode).toBe(404);
  });

  it('les actualisations automatiques ne prolongent pas l’inactivité', async () => {
    t = await createTestApp(mock, { now });
    const { sessionCookie } = await login(t, mock);
    const bg = { ...cookieHeader(sessionCookie!), 'x-background-refresh': '1' };
    // Actualisations automatiques à 10 et 20 min : la session reste valide mais l'inactivité
    // court toujours depuis la connexion.
    for (let i = 0; i < 2; i++) {
      clock += 10 * 60_000;
      expect((await t.app.inject({ url: `${BASE}/api/session`, headers: bg })).statusCode).toBe(200);
    }
    clock += 11 * 60_000;
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: bg })).statusCode).toBe(404);
    // À l'inverse, une activité réelle prolonge la session.
    const fresh = await login(t, mock);
    clock += 20 * 60_000;
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(fresh.sessionCookie!) })).statusCode).toBe(200);
    clock += 20 * 60_000;
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(fresh.sessionCookie!) })).statusCode).toBe(200);
  });

  it('expire après 8 heures même avec de l’activité', async () => {
    t = await createTestApp(mock, { now });
    const { sessionCookie } = await login(t, mock);
    const start = clock;
    while (clock - start < SESSION_ABSOLUTE_MS - 20 * 60_000) {
      clock += 20 * 60_000;
      expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) })).statusCode).toBe(
        200,
      );
    }
    clock = start + SESSION_ABSOLUTE_MS + 1;
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) })).statusCode).toBe(404);
  });

  it('la déconnexion invalide la session (avec CSRF et origine)', async () => {
    t = await createTestApp(mock, { now });
    const { sessionCookie } = await login(t, mock);
    const s = await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) });
    const csrf = s.json().csrfToken as string;
    const out = await t.app.inject({
      method: 'POST',
      url: `${BASE}/auth/logout`,
      headers: { ...cookieHeader(sessionCookie!), origin: TEST_ORIGIN, 'x-csrf-token': csrf },
    });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/__Host-mon_sid=;/);
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) })).statusCode).toBe(404);
    const { rows } = await t.pools.app.query(
      "SELECT 1 FROM monitoring_app.audit_log WHERE event = 'logout' AND outcome = 'success'",
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
