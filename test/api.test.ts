import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveResponse, OverviewResponse } from '../src/shared/api.js';
import { addDays } from '../src/shared/calc.js';
import { registerApi } from '../src/server/routes/api.js';
import { parsePeriod } from '../src/server/services/period.js';
import { TtlCache } from '../src/server/services/cache.js';
import { BASE, cookieHeader, createTestApp, login, TEST_ADMIN_EMAIL, type TestApp } from './helpers/app.js';
import { startMockOidc, type MockOidc } from './helpers/mockOidc.js';

let mock: MockOidc;
let t: TestApp;
let sid: string;

beforeAll(async () => {
  mock = await startMockOidc();
  t = await createTestApp(mock, { registerApi, env: { USD_TO_EUR_RATE: '0.9' } });
  sid = (await login(t, mock)).sessionCookie!;
});
afterAll(async () => {
  await t.close();
  await mock.close();
});

const get = (url: string) => t.app.inject({ url: `${BASE}${url}`, headers: cookieHeader(sid) });
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

describe('période', () => {
  const now = new Date('2026-06-15T10:00:00Z');
  it('30 derniers jours par défaut, préréglages, plage personnalisée', () => {
    expect(parsePeriod({}, 'Europe/Brussels', now)).toMatchObject({ from: '2026-05-17', to: '2026-06-15', days: 30 });
    expect(parsePeriod({ days: '7' }, 'Europe/Brussels', now)).toMatchObject({ from: '2026-06-09', days: 7 });
    expect(parsePeriod({ from: '2026-01-01', to: '2026-12-31' }, 'Europe/Brussels', now)).toMatchObject({ to: '2026-06-15' });
  });
  it('refuse plus de 2 ans, les dates invalides et les paramètres inconnus', () => {
    expect(() => parsePeriod({ from: '2023-01-01', to: '2026-06-15' }, 'Europe/Brussels', now)).toThrow();
    expect(() => parsePeriod({ from: '2026-02-30', to: '2026-03-01' }, 'Europe/Brussels', now)).toThrow();
    expect(() => parsePeriod({ from: '2026-03-02', to: '2026-03-01' }, 'Europe/Brussels', now)).toThrow();
    expect(() => parsePeriod({ days: '1000' }, 'Europe/Brussels', now)).toThrow();
    expect(() => parsePeriod({ days: '7', sql: "1;DROP" }, 'Europe/Brussels', now)).toThrow();
  });
});

describe('API du tableau de bord', () => {
  it('vue d’ensemble sur 90 jours, cohérente avec les fausses données', async () => {
    const res = await get('/api/overview?days=90');
    expect(res.statusCode).toBe(200);
    const o = res.json<OverviewResponse>();
    expect(o.period.days).toBe(90);
    expect(o.users.daily).toHaveLength(90);
    expect(o.users.total).toBeGreaterThan(0);
    expect(o.subscriptions.current.length).toBeGreaterThan(0);
    expect(o.revenue.mrr.byCurrency.eur).toBeGreaterThan(0);
    expect(o.revenue.churnRate).not.toBeNull();
    expect(o.costs.totalUsd).toBeGreaterThan(0);
    expect(o.costs.grossMarginEurCents).not.toBeNull();
    expect(o.funnel.signups).toBeGreaterThanOrEqual(o.funnel.withFirstTrip);
    expect(o.clients.browsers[0]!.versions.length).toBeGreaterThan(0);
    expect(o.presence.heatmap).toHaveLength(7);
    expect(o.presence.heatmap[0]).toHaveLength(24);
    expect(o.meta.historyIncomplete).toBe(false);
  });

  it('bandeau d’historique incomplet quand la période commence avant la mise en service', async () => {
    const o = (await get('/api/overview?days=120')).json<OverviewResponse>();
    expect(o.meta.historyIncomplete).toBe(true);
  });

  it('période sans données : états vides, pas d’erreur', async () => {
    const res = await get('/api/overview?from=2025-01-01&to=2025-01-31');
    expect(res.statusCode).toBe(200);
    const o = res.json<OverviewResponse>();
    expect(o.users.signupsPeriod).toBe(0);
    expect(o.revenue.conversionRate).toBeNull();
    expect(o.clients.devices).toEqual([]);
    expect(o.presence.daily).toEqual([]);
  });

  it('période invalide → 400', async () => {
    expect((await get('/api/overview?days=0')).statusCode).toBe(400);
    expect((await get(`/api/overview?from=2020-01-01&to=${addDays('2020-01-01', 800)}`)).statusCode).toBe(400);
  });

  it('présence en direct', async () => {
    const l = (await get('/api/live')).json<LiveResponse>();
    expect(l.connectedUsers).toBeGreaterThanOrEqual(0);
    expect(l.last24h.length).toBeGreaterThan(0);
    expect(l.stats.peak).not.toBeNull();
  });

  it('aucune réponse de l’API ne contient d’e-mail ni de secret', async () => {
    const bodies = [
      (await get('/api/session')).body,
      (await get('/api/overview?days=90')).body,
      (await get('/api/overview?days=7')).body,
      (await get('/api/live')).body,
    ];
    for (const body of bodies) {
      expect(body).not.toMatch(EMAIL_RE);
      expect(body).not.toContain(TEST_ADMIN_EMAIL);
      expect(body).not.toContain(t.config.sessionSecret);
      expect(body).not.toContain(t.config.oidc.clientSecret);
      expect(body).not.toContain('dev-only-');
      expect(body).not.toMatch(/sk-ant-/);
    }
  });
});

describe('cache', () => {
  it('sert la même valeur pendant sa durée de vie, ne garde pas les erreurs', async () => {
    let clock = 0;
    let calls = 0;
    const c = new TtlCache<number>(60_000, 10, () => clock);
    const load = async () => ++calls;
    expect(await c.get('k', load)).toBe(1);
    clock = 59_000;
    expect(await c.get('k', load)).toBe(1);
    clock = 60_001;
    expect(await c.get('k', load)).toBe(2);
    await expect(c.get('e', () => Promise.reject(new Error('x')))).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(await c.get('e', async () => 7)).toBe(7);
  });
});
