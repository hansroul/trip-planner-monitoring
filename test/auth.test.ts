import { afterEach, describe, expect, it } from 'vitest';
import { FLOW_COOKIE, SESSION_COOKIE } from '../src/server/app.js';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../src/server/auth/sessions.js';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  BASE,
  cookieHeader,
  createTestApp,
  login,
  openLoginForm,
  setCookieHeader,
  setCookieValue,
  TEST_ORIGIN,
  testPasswordHash,
  type TestApp,
} from './helpers/app.js';

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

const postLogin = (cookie: string | undefined, fields: Record<string, string>) =>
  t.app.inject({
    method: 'POST',
    url: `${BASE}/auth/login`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: t.config.publicOrigin,
      ...(cookie ? { cookie } : {}),
    },
    payload: new URLSearchParams(fields).toString(),
  });

describe('connexion par e-mail et mot de passe', () => {
  it('affiche un formulaire sans script, avec jeton et cookie de flux stricts', async () => {
    t = await createTestApp({ now });
    const page = await t.app.inject({ url: `${BASE}/auth/login` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('name="form_token"');
    expect(page.body).toContain('autocomplete="current-password"');
    expect(page.body).not.toMatch(/<script|style=/i);
    expect(setCookieHeader(page.headers, FLOW_COOKIE)).toMatch(/HttpOnly/i);
    expect(setCookieHeader(page.headers, FLOW_COOKIE)).toMatch(/SameSite=Strict/i);
    const css = await t.app.inject({ url: `${BASE}/auth/login.css` });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toMatch(/text\/css/);
  });

  it('accepte le bon e-mail et le bon mot de passe (casse et espaces de l’e-mail ignorés)', async () => {
    t = await createTestApp({ now });
    const r = await login(t, { email: `  ${ADMIN_EMAIL.toUpperCase()} ` });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`${BASE}/`);
    expect(r.sessionCookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookieHeader(r.headers, SESSION_COOKIE)).toMatch(/SameSite=Strict/i);
    expect((await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(r.sessionCookie!) })).statusCode).toBe(200);
    expect(await lastAudit(t)).toMatchObject({ event: 'login', outcome: 'success' });
  });

  it('accepte une empreinte aux paramètres de PoppyTrip (m=65536, t=3, p=4)', async () => {
    const hash = await testPasswordHash('autre-mot-de-passe-poppytrip', { m: 65_536, t: 3, p: 4 });
    t = await createTestApp({ now, env: { ADMIN_PASSWORD_HASH: hash } });
    expect((await login(t, { password: 'autre-mot-de-passe-poppytrip' })).statusCode).toBe(303);
  });

  it.each([
    ['mauvais mot de passe', { password: 'mot-de-passe-de-test-faux' }, 401, 'credentials'],
    ['autre e-mail', { email: 'intrus@example.com' }, 401, 'credentials'],
    ['mot de passe vide', { password: '' }, 401, 'credentials'],
    ['mot de passe démesuré', { password: 'a'.repeat(2000) }, 401, 'credentials'],
    ['jeton de formulaire faux', { formToken: 'F'.repeat(43) }, 403, 'form_expired'],
    ['jeton de formulaire absent', { omitFormToken: true }, 403, 'form_expired'],
    ['cookie de flux absent', { dropFlowCookie: true }, 403, 'form_expired'],
    ['origine absente', { origin: null }, 403, 'origin_invalid'],
    ['autre origine', { origin: 'https://attaquant.example.test' }, 403, 'origin_invalid'],
    ['requête inter-sites', { secFetchSite: 'cross-site' }, 403, 'origin_invalid'],
  ])('refuse : %s', async (_label, tamper, status, reason) => {
    t = await createTestApp({ now });
    const r = await login(t, tamper);
    expect(r.statusCode).toBe(status);
    expect(r.sessionCookie).toBeUndefined();
    // Formulaire réaffiché avec un nouveau jeton ; rien n'indique quel champ était faux.
    expect(r.body).toContain('name="form_token"');
    expect(r.body).not.toContain(ADMIN_EMAIL);
    if (reason === 'credentials') expect(r.body).toContain('Identifiants refusés.');
    expect(await lastAudit(t)).toMatchObject({ event: 'login', outcome: 'refused', details: { reason } });
  });

  it('mauvais e-mail ou mauvais mot de passe : réponse identique', async () => {
    t = await createTestApp({ now });
    const strip = (b: string) => b.replace(/value="[^"]+"/, '');
    const a = await login(t, { email: 'intrus@example.com' });
    const b = await login(t, { password: 'mot-de-passe-de-test-faux' });
    expect(a.statusCode).toBe(b.statusCode);
    expect(strip(a.body)).toBe(strip(b.body));
  });

  it('un jeton de formulaire ne sert qu’une fois (rejeu refusé)', async () => {
    t = await createTestApp({ now });
    const { formToken, flow } = await openLoginForm(t);
    const fields = { form_token: formToken, email: ADMIN_EMAIL, password: ADMIN_PASSWORD };
    expect((await postLogin(`${FLOW_COOKIE}=${flow}`, fields)).statusCode).toBe(303);
    expect((await postLogin(`${FLOW_COOKIE}=${flow}`, fields)).statusCode).toBe(403);
  });

  it('le jeton d’un formulaire ne vaut qu’avec le cookie de flux de la même page', async () => {
    t = await createTestApp({ now });
    const victim = await openLoginForm(t);
    const attacker = await openLoginForm(t);
    const fields = { form_token: victim.formToken, email: ADMIN_EMAIL, password: ADMIN_PASSWORD };
    expect((await postLogin(`${FLOW_COOKIE}=${attacker.flow}`, fields)).statusCode).toBe(403);
  });

  it('corps JSON : refusé, sans session', async () => {
    t = await createTestApp({ now });
    const r = await t.app.inject({
      method: 'POST',
      url: `${BASE}/auth/login`,
      headers: { 'content-type': 'application/json', origin: t.config.publicOrigin },
      payload: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(r.statusCode).toBe(403);
    expect(setCookieValue(r.headers, SESSION_COOKIE)).toBeUndefined();
  });

  it('déjà connecté : la page de connexion renvoie au tableau de bord', async () => {
    t = await createTestApp({ now });
    const { sessionCookie } = await login(t);
    const r = await t.app.inject({ url: `${BASE}/auth/login`, headers: cookieHeader(sessionCookie!) });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`${BASE}/`);
  });

  it('régénère l’identifiant de session à chaque connexion', async () => {
    t = await createTestApp({ now });
    const a = await login(t);
    const b = await login(t, { extraCookie: `${SESSION_COOKIE}=${a.sessionCookie}` });
    expect(b.statusCode).toBe(303);
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
