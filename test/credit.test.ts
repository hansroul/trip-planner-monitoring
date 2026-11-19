import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CreditResponse, InfraResponse } from '../src/shared/api.js';
import { addDays, todayIn } from '../src/shared/calc.js';
import { registerApi } from '../src/server/routes/api.js';
import { setAdminFetch } from '../src/server/routes/credit.js';
import { ANALYTICS_BETA, reconcile, reconciliationWindow, type FetchLike } from '../src/server/services/anthropicAdmin.js';
import { creditCandidates, processAlerts, storageCandidates, type Mailer } from '../src/server/services/alerts.js';
import { runAlertCheck } from '../src/server/services/jobs.js';
import { ReadRepository } from '../src/server/data/repository.js';
import { BASE, cookieHeader, createTestApp, login, TEST_ORIGIN, type TestApp } from './helpers/app.js';
import { startMockOidc, type MockOidc } from './helpers/mockOidc.js';

const FAKE_ADMIN_KEY = ['sk', 'ant', 'admin01', 'TestOnlyNotARealKey0123456789'].join('-');
let mock: MockOidc;
let t: TestApp;
let sid: string;
let csrf: string;
let apiCalls: Array<{ url: string; headers: Record<string, string> }> = [];
let apiAmountCents = '12345.000000';

beforeAll(async () => {
  mock = await startMockOidc();
  setAdminFetch(async (url, init) => {
    apiCalls.push({ url, headers: init.headers });
    return { ok: true, status: 200, json: async () => ({ data: [{ cost: { amount: apiAmountCents, currency: 'USD' } }], has_more: false, next_page: null }) };
  });
  t = await createTestApp(mock, {
    registerApi,
    env: { ANTHROPIC_ADMIN_KEY: FAKE_ADMIN_KEY, ANTHROPIC_API_BASE_URL: 'https://api.example.test', DB_SIZE_LIMIT_BYTES: '20000000' },
  });
  sid = (await login(t, mock)).sessionCookie!;
  csrf = (await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sid) })).json().csrfToken;
});
afterAll(async () => {
  await t.close();
  await mock.close();
});
beforeEach(async () => {
  await t.pools.app.query('DELETE FROM monitoring_app.credit_topups');
  await t.pools.app.query('DELETE FROM monitoring_app.alert_state');
});

const today = todayIn('Europe/Brussels');
const write = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, withCsrf = true) =>
  t.app.inject({
    method,
    url: `${BASE}${url}`,
    headers: { ...cookieHeader(sid), origin: TEST_ORIGIN, ...(withCsrf ? { 'x-csrf-token': csrf } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const getCredit = async () => (await t.app.inject({ url: `${BASE}/api/credit`, headers: cookieHeader(sid) })).json<CreditResponse>();

describe('recharges de crédit', () => {
  it('sans recharge : aucun crédit configuré', async () => {
    const c = await getCredit();
    expect(c.status).toEqual({ configured: false });
    expect(c.level).toBeNull();
  });

  it('formulaire validé', async () => {
    const bad = [
      { date: addDays(today, 1), amountUsd: 10 },
      { date: '2026-02-30', amountUsd: 10 },
      { date: today, amountUsd: -5 },
      { date: today, amountUsd: 0 },
      { date: today, amountUsd: 10.123 },
      { date: today, amountUsd: '10' },
      { date: today, amountUsd: 10, note: 'x'.repeat(501) },
      { date: today, amountUsd: 10, admin: true },
    ];
    for (const body of bad) expect((await write('POST', '/api/credit/topups', body)).statusCode, JSON.stringify(body).slice(0, 60)).toBe(400);
  });

  it('exige le jeton CSRF', async () => {
    expect((await write('POST', '/api/credit/topups', { date: today, amountUsd: 10 }, false)).statusCode).toBe(403);
  });

  it('création, correction, suppression, avec journal d’audit', async () => {
    const created = await write('POST', '/api/credit/topups', { date: addDays(today, -40), amountUsd: 100, note: 'Solde initial' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as number;
    await write('POST', '/api/credit/topups', { date: addDays(today, -10), amountUsd: 50.5 });
    let c = await getCredit();
    expect(c.topups).toHaveLength(2);
    expect(c.status.configured && c.status.totalUsd).toBe(150.5);
    expect(c.status.configured && c.status.since).toBe(addDays(today, -40));

    const upd = await write('PUT', `/api/credit/topups/${id}`, { date: addDays(today, -40), amountUsd: 120, note: 'Corrigé' });
    expect(upd.statusCode).toBe(200);
    c = await getCredit();
    expect(c.status.configured && c.status.totalUsd).toBe(170.5);

    expect((await write('DELETE', `/api/credit/topups/${id}`)).statusCode).toBe(204);
    expect((await write('DELETE', `/api/credit/topups/${id}`)).statusCode).toBe(400);
    const { rows } = await t.pools.app.query<{ event: string; details: Record<string, unknown> }>(
      "SELECT event, details FROM monitoring_app.audit_log WHERE event LIKE 'credit_topup_%' ORDER BY id DESC LIMIT 4",
    );
    expect(rows.map((r) => r.event)).toEqual(['credit_topup_delete', 'credit_topup_update', 'credit_topup_create', 'credit_topup_create']);
    expect(rows[1]!.details).toMatchObject({ before: { amount_usd: 100 }, after: { amount_usd: 120 } });
  });

  it('consommation = coûts du fournisseur Anthropic depuis la première recharge', async () => {
    await write('POST', '/api/credit/topups', { date: addDays(today, -30), amountUsd: 1000 });
    const repo = new ReadRepository(t.pools.read);
    const expected = await repo.one<{ cost_usd: number }>('anthropicConsumedSince', ['anthropic', addDays(today, -30)]);
    const c = await getCredit();
    if (!c.status.configured) throw new Error('non configuré');
    expect(c.status.consumedUsd).toBeCloseTo(Number(expected!.cost_usd), 2);
    expect(c.status.remainingUsd).toBeCloseTo(1000 - Number(expected!.cost_usd), 2);
    expect(c.status.avgDailyUsd7).toBeGreaterThan(0);
  });
});

describe('recoupement avec l’API d’administration', () => {
  it('désactivé sans clé d’administration', async () => {
    const repo = new ReadRepository(t.pools.read);
    const r = await reconcile({ adminKey: null, apiBaseUrl: null, apiVersion: '2026-10-21', providerLabel: 'anthropic' }, repo, new Date(), async () => {
      throw new Error('ne doit pas être appelé');
    });
    expect(r.enabled).toBe(false);
    expect(r.message).toContain('ANTHROPIC_ADMIN_KEY');
  });

  it('signale un écart au-delà de 10 %, pas en dessous, et n’expose jamais la clé', async () => {
    const repo = new ReadRepository(t.pools.read);
    const now = new Date();
    const w = reconciliationWindow(now);
    const local = Number((await repo.one<{ cost_usd: number }>('anthropicBetween', ['anthropic', w.from, w.to]))!.cost_usd);
    const s = { adminKey: FAKE_ADMIN_KEY, apiBaseUrl: 'https://api.example.test', apiVersion: '2026-10-21', providerLabel: 'anthropic' };
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fake = (usd: number): FetchLike => async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ data: [{ cost: { amount: (usd * 100).toFixed(6), currency: 'USD' } }], has_more: false }) };
    };
    const near = await reconcile(s, repo, now, fake(local * 1.05));
    expect(near).toMatchObject({ enabled: true, flagged: false });
    const far = await reconcile(s, repo, now, fake(local * 1.3));
    expect(far.flagged).toBe(true);
    expect(far.gap).toBeGreaterThan(0.1);
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/v1/organizations/analytics/cost');
    expect(u.searchParams.get('starting_at')).toBe(`${w.from}T00:00:00Z`);
    expect(calls[0]!.headers).toMatchObject({ 'x-api-key': FAKE_ADMIN_KEY, 'anthropic-version': '2026-10-21', 'anthropic-beta': ANALYTICS_BETA });
  });

  it('via l’API : résultat mis en cache, clé jamais renvoyée au navigateur', async () => {
    apiCalls = [];
    const a = await t.app.inject({ url: `${BASE}/api/credit`, headers: cookieHeader(sid) });
    const b = await t.app.inject({ url: `${BASE}/api/credit`, headers: cookieHeader(sid) });
    expect(a.json<CreditResponse>().reconciliation.apiUsd).toBeCloseTo(123.45);
    expect(apiCalls).toHaveLength(0); // déjà en cache (10 minutes) depuis les appels précédents
    for (const body of [a.body, b.body]) {
      expect(body).not.toContain(FAKE_ADMIN_KEY);
      expect(body).not.toMatch(/sk-ant-/);
    }
  });

  it('une erreur de l’API est signalée sans planter', async () => {
    const repo = new ReadRepository(t.pools.read);
    const r = await reconcile(
      { adminKey: FAKE_ADMIN_KEY, apiBaseUrl: 'https://api.example.test', apiVersion: '2026-10-21', providerLabel: 'anthropic' },
      repo,
      new Date(),
      async () => ({ ok: false, status: 401, json: async () => ({}) }),
    );
    expect(r.apiUsd).toBeNull();
    expect(r.message).toContain('401');
    expect(r.message).not.toContain(FAKE_ADMIN_KEY);
  });
});

describe('infrastructure', () => {
  it('taille de la base, tables, projection avec limite configurée', async () => {
    const res = await t.app.inject({ url: `${BASE}/api/infra`, headers: cookieHeader(sid) });
    expect(res.statusCode).toBe(200);
    const i = res.json<InfraResponse>();
    expect(i.database.sizeBytes).toBeGreaterThan(0);
    expect(i.database.limitBytes).toBe(20_000_000);
    expect(i.tables.length).toBeGreaterThan(0);
    expect(i.tables.length).toBeLessThanOrEqual(10);
    expect(['growing', 'stable', 'insufficient']).toContain(i.storage.projection.status);
    expect(i.storage.limitBytes).toBeNull();
  });
});

describe('alertes', () => {
  const sent: string[] = [];
  const mailer: Mailer = { send: async (subject) => void sent.push(subject) };
  const th = { warn: 70, critical: 90 };
  const status = (pct: number) =>
    ({ configured: true, since: '2026-01-01', totalUsd: 100, consumedUsd: pct, remainingUsd: 100 - pct, percentUsed: pct, avgDailyUsd7: 1, daysLeft: 10, level: 'ok' }) as const;

  beforeEach(() => {
    sent.length = 0;
  });

  it('une seule alerte par seuil franchi, réarmée après une recharge', async () => {
    const now = new Date();
    expect(await processAlerts(t.pools.app, mailer, creditCandidates(status(50), th, 'tok-1'), now)).toEqual([]);
    expect(await processAlerts(t.pools.app, mailer, creditCandidates(status(75), th, 'tok-1'), now)).toEqual(['credit_warn']);
    expect(await processAlerts(t.pools.app, mailer, creditCandidates(status(80), th, 'tok-1'), now)).toEqual([]);
    expect(await processAlerts(t.pools.app, mailer, creditCandidates(status(92), th, 'tok-1'), now)).toEqual(['credit_critical']);
    expect(await processAlerts(t.pools.app, mailer, creditCandidates(status(95), th, 'tok-1'), now)).toEqual([]);
    // Nouvelle recharge (empreinte différente) : réarmées.
    expect(await processAlerts(t.pools.app, mailer, creditCandidates(status(40), th, 'tok-2'), now)).toEqual([]);
    expect(await processAlerts(t.pools.app, mailer, creditCandidates(status(72), th, 'tok-2'), now)).toEqual(['credit_warn']);
    expect(sent).toHaveLength(3);
    const { rows } = await t.pools.app.query("SELECT 1 FROM monitoring_app.audit_log WHERE event = 'alert_sent'");
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('saturation prévue de la base : une seule fois, réarmée quand la condition disparaît', async () => {
    const now = new Date();
    const growing = { status: 'growing', current: 900, currentDay: today, growthPerDay: 10, limit: 1000, percentUsed: 0.9, daysLeft: 10, saturationDay: addDays(today, 10) } as const;
    const fine = { ...growing, current: 100, percentUsed: 0.1, daysLeft: 90, saturationDay: addDays(today, 90) };
    const t3 = { warn: 80, critical: 95, saturationDays: 30 };
    expect(await processAlerts(t.pools.app, mailer, storageCandidates('db', growing, t3), now)).toEqual(['db_warn', 'db_saturation']);
    expect(await processAlerts(t.pools.app, mailer, storageCandidates('db', growing, t3), now)).toEqual([]);
    expect(await processAlerts(t.pools.app, mailer, storageCandidates('db', fine, t3), now)).toEqual([]);
    expect(await processAlerts(t.pools.app, mailer, storageCandidates('db', growing, t3), now)).toEqual(['db_warn', 'db_saturation']);
  });

  it('vérification complète : alerte de crédit envoyée une fois, à ADMIN_EMAIL via le Mailer', async () => {
    await write('POST', '/api/credit/topups', { date: addDays(today, -30), amountUsd: 1 }); // crédit dépassé
    const log = { info: () => undefined, error: () => undefined } as never;
    const first = await runAlertCheck({ config: t.config, pools: t.pools, log, mailer });
    expect(first).toContain('credit_warn');
    expect(first).toContain('credit_critical');
    expect(await runAlertCheck({ config: t.config, pools: t.pools, log, mailer })).toEqual([]);
  });
});
