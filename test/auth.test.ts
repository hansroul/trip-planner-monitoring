import { afterEach, describe, expect, it } from 'vitest';
import { FLOW_COOKIE, SESSION_COOKIE } from '../src/server/app.js';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../src/server/auth/sessions.js';
import { BASE, cookieHeader, createTestApp, login, setCookieValue, TEST_ORIGIN, type TestApp } from './helpers/app.js';
import { signHs256WithPublicKey, signSsoToken } from './helpers/mockSso.js';

let t: TestApp;
let clock = Date.now();
const now = () => new Date(clock);

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

describe('connexion avec le compte PoppyTrip', () => {
  it('accepte le jeton signé de PoppyTrip pour le compte autorisé', async () => {
    t = await createTestApp({ now });
    const r = await login(t);
    expect(r.statusCode).toBe(200);
    expect(r.sessionCookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(r.sessionCookie!) })).statusCode).toBe(200);
    expect(await lastAudit(t)).toMatchObject({ event: 'login', outcome: 'success' });
  });

  it.each([
    ['state invalide', { state: 'S'.repeat(43) }, 'state_invalid'],
    ['jeton absent', { omitToken: true }, 'token_missing'],
    ['jeton mal formé', { token: () => 'pas-un-jeton' }, 'token_invalid'],
    ['nonce d’une autre tentative', { sign: { nonce: 'N'.repeat(43) } }, 'token_invalid'],
    ['nonce absent', { sign: { omit: ['nonce' as const] } }, 'token_invalid'],
    ['jeton expiré', { sign: { ageSeconds: 600 } }, 'token_invalid'],
    ['jeton trop ancien (durée de vie longue)', { sign: { ageSeconds: 300, ttlSeconds: 3600 } }, 'token_invalid'],
    ['autre émetteur', { sign: { issuer: 'https://autre.example.test' } }, 'token_invalid'],
    ['autre audience', { sign: { audience: 'https://autre-site.example.test' } }, 'token_invalid'],
    ['autre type de jeton', { sign: { typ: 'JWT' } }, 'token_invalid'],
    ['signature d’une autre clé', { sign: { wrongKey: true } }, 'token_invalid'],
    ['sans identifiant de jeton (jti)', { sign: { omit: ['jti' as const] } }, 'token_invalid'],
    ['HS256 avec la clé publique (confusion d’algorithme)', { token: ({ nonce, audience }: { nonce: string; audience: string }) => signHs256WithPublicKey(nonce, audience) }, 'token_invalid'],
    ['autre compte PoppyTrip', { sign: { sub: '00000000-0000-4000-8000-000000000000' } }, 'account_mismatch'],
    ['cookie de flux absent', { dropFlowCookie: true }, 'flow_invalid'],
  ])('refuse : %s', async (_label, tamper, reason) => {
    t = await createTestApp({ now });
    const r = await login(t, tamper);
    expect(r.statusCode).toBe(403);
    expect(r.body).toBe('Connexion refusée.');
    expect(r.sessionCookie).toBeUndefined();
    expect(await lastAudit(t)).toMatchObject({ event: 'login', outcome: 'refused', details: { reason } });
  });

  it('un flux de connexion ne sert qu’une fois (rejeu refusé)', async () => {
    t = await createTestApp({ now });
    const start = await t.app.inject({ url: `${BASE}/auth/login` });
    const flow = setCookieValue(start.headers, FLOW_COOKIE)!;
    const sso = new URL(String(start.headers.location));
    const token = await signSsoToken({ nonce: sso.searchParams.get('nonce')!, audience: t.config.publicOrigin });
    const url = `${BASE}/auth/callback?state=${sso.searchParams.get('state')}&token=${token}`;
    expect((await t.app.inject({ url, headers: { cookie: `${FLOW_COOKIE}=${flow}` } })).statusCode).toBe(200);
    expect((await t.app.inject({ url, headers: { cookie: `${FLOW_COOKIE}=${flow}` } })).statusCode).toBe(403);
  });

  it('un jeton volé est inutile sans le cookie de flux de la même tentative', async () => {
    t = await createTestApp({ now });
    // Tentative de la victime : l'attaquant récupère son adresse de retour.
    const victim = await t.app.inject({ url: `${BASE}/auth/login` });
    const sso = new URL(String(victim.headers.location));
    const token = await signSsoToken({ nonce: sso.searchParams.get('nonce')!, audience: t.config.publicOrigin });
    // L'attaquant ouvre sa propre tentative et rejoue le jeton avec son cookie.
    const attacker = await t.app.inject({ url: `${BASE}/auth/login` });
    const attackerFlow = setCookieValue(attacker.headers, FLOW_COOKIE)!;
    const res = await t.app.inject({
      url: `${BASE}/auth/callback?state=${sso.searchParams.get('state')}&token=${token}`,
      headers: { cookie: `${FLOW_COOKIE}=${attackerFlow}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('régénère l’identifiant de session à chaque connexion', async () => {
    t = await createTestApp({ now });
    const a = await login(t);
    const b = await login(t, { extraCookie: `${SESSION_COOKIE}=${a.sessionCookie}` });
    expect(b.statusCode).toBe(200);
    expect(b.sessionCookie).toBeDefined();
    expect(b.sessionCookie).not.toBe(a.sessionCookie);
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(a.sessionCookie!) })).statusCode).toBe(404);
  });
});

describe('sessions', () => {
  it('expire après 30 minutes d’inactivité', async () => {
    t = await createTestApp({ now });
    const { sessionCookie } = await login(t);
    clock += SESSION_IDLE_MS - 60_000;
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) })).statusCode).toBe(200);
    clock += SESSION_IDLE_MS + 1_000;
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) })).statusCode).toBe(404);
  });

  it('les actualisations automatiques ne prolongent pas l’inactivité', async () => {
    t = await createTestApp({ now });
    const { sessionCookie } = await login(t);
    const bg = { ...cookieHeader(sessionCookie!), 'x-background-refresh': '1' };
    for (let i = 0; i < 2; i++) {
      clock += 10 * 60_000;
      expect((await t.app.inject({ url: `${BASE}/api/session`, headers: bg })).statusCode).toBe(200);
    }
    clock += 11 * 60_000;
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: bg })).statusCode).toBe(404);
    const fresh = await login(t);
    clock += 20 * 60_000;
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(fresh.sessionCookie!) })).statusCode).toBe(200);
    clock += 20 * 60_000;
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(fresh.sessionCookie!) })).statusCode).toBe(200);
  });

  it('expire après 8 heures même avec de l’activité', async () => {
    t = await createTestApp({ now });
    const { sessionCookie } = await login(t);
    const start = clock;
    while (clock - start < SESSION_ABSOLUTE_MS - 20 * 60_000) {
      clock += 20 * 60_000;
      expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) })).statusCode).toBe(200);
    }
    clock = start + SESSION_ABSOLUTE_MS + 1;
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) })).statusCode).toBe(404);
  });

  it('la déconnexion invalide la session (avec CSRF et origine)', async () => {
    t = await createTestApp({ now });
    const { sessionCookie } = await login(t);
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
  });
});
