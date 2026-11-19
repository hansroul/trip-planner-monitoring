import { describe, expect, it } from 'vitest';
import {
  activeSubscriptionsSeries,
  addDays,
  churnRate,
  computeMrr,
  conversionRate,
  creditStatus,
  daysBetween,
  eachDay,
  fillDaily,
  groupBrowserVersions,
  isDay,
  isHistoryIncomplete,
  isStale,
  localParts,
  OTHER_VERSIONS,
  presenceStats,
  projectSaturation,
  reconciliationGap,
  rollingSum,
  subscribersAtStart,
  todayIn,
} from './calc.js';

const TZ = 'Europe/Brussels';

describe('jours', () => {
  it('arithmétique indépendante des changements d’heure', () => {
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
    expect(eachDay('2026-10-24', '2026-10-27')).toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-02-28')).toBe(true);
  });

  it('changement d’heure à Bruxelles : jours et heures locales', () => {
    // Passage à l'heure d'été le 29 mars 2026 : 02:00 n'existe pas (01:00 UTC = 03:00 locale).
    expect(localParts('2026-03-29T00:30:00Z', TZ)).toMatchObject({ day: '2026-03-29', hour: 1 });
    expect(localParts('2026-03-29T01:30:00Z', TZ)).toMatchObject({ day: '2026-03-29', hour: 3 });
    // Retour à l'heure d'hiver le 25 octobre 2026 : 02:00 locale existe deux fois.
    expect(localParts('2026-10-25T00:30:00Z', TZ).hour).toBe(2);
    expect(localParts('2026-10-25T01:30:00Z', TZ).hour).toBe(2);
    // Minuit local en hiver = 23:00 UTC la veille.
    expect(localParts('2026-12-31T23:30:00Z', TZ)).toMatchObject({ day: '2027-01-01', hour: 0, weekday: 5 });
    expect(todayIn(TZ, new Date('2026-07-14T22:30:00Z'))).toBe('2026-07-15');
  });

  it('complète les séries jour par jour', () => {
    const s = fillDaily([{ day: '2026-01-02', signups: 3 }], '2026-01-01', '2026-01-03', ['signups'] as const);
    expect(s).toEqual([
      { day: '2026-01-01', signups: 0 },
      { day: '2026-01-02', signups: 3 },
      { day: '2026-01-03', signups: 0 },
    ]);
  });

  it('somme glissante (approximation des actifs hebdomadaires et mensuels)', () => {
    const rows = eachDay('2026-01-01', '2026-01-31').map((day, i) => ({ day, value: i + 1 }));
    expect(rollingSum(rows, '2026-01-31', 7)).toBe(25 + 26 + 27 + 28 + 29 + 30 + 31);
    expect(rollingSum(rows, '2026-01-03', 7)).toBe(6);
  });

  it('bandeau d’historique incomplet', () => {
    expect(isHistoryIncomplete('2026-01-01', '2026-02-01')).toBe(true);
    expect(isHistoryIncomplete('2026-02-01', '2026-02-01')).toBe(false);
    expect(isHistoryIncomplete('2026-01-01', null)).toBe(false);
  });
});

describe('abonnements', () => {
  it('MRR avec offres mensuelles et annuelles (annuel ramené au mois), essais exclus', () => {
    const r = computeMrr(
      [
        { plan: 'voyageur', billingInterval: 'month', status: 'active', count: 10 },
        { plan: 'voyageur', billingInterval: 'month', status: 'past_due', count: 2 },
        { plan: 'voyageur', billingInterval: 'month', status: 'trialing', count: 5 },
        { plan: 'voyageur', billingInterval: 'month', status: 'canceled', count: 7 },
        { plan: 'aventurier', billingInterval: 'year', status: 'active', count: 3 },
        { plan: 'mystere', billingInterval: 'month', status: 'active', count: 1 },
      ],
      [
        { plan: 'voyageur', billingInterval: 'month', currency: 'eur', amountCents: 499 },
        { plan: 'aventurier', billingInterval: 'year', currency: 'eur', amountCents: 12000 },
      ],
    );
    expect(r.byCurrency.eur).toBe(12 * 499 + 3 * 1000);
    expect(r.lines.find((l) => l.plan === 'aventurier')?.monthlyCents).toBe(1000);
    expect(r.missingPrices).toEqual([{ plan: 'mystere', billingInterval: 'month', subscribers: 1 }]);
  });

  it('abonnés en début de période et série des abonnements en cours', () => {
    const start = subscribersAtStart([
      { eventType: 'created', count: 10 },
      { eventType: 'renewed', count: 5 },
      { eventType: 'cancel_requested', count: 2 },
      { eventType: 'canceled', count: 4 },
    ]);
    expect(start).toBe(17);
    expect(
      activeSubscriptionsSeries(start, [
        { day: '2026-01-01', created: 2, canceled: 1 },
        { day: '2026-01-02', created: 0, canceled: 3 },
      ]),
    ).toEqual([
      { day: '2026-01-01', active: 18 },
      { day: '2026-01-02', active: 15 },
    ]);
  });

  it('désabonnement et conversion gèrent la division par zéro', () => {
    expect(churnRate(3, 60)).toBe(0.05);
    expect(churnRate(3, 0)).toBeNull();
    expect(conversionRate(5, 100)).toBe(0.05);
    expect(conversionRate(0, 0)).toBeNull();
  });
});

describe('projection de saturation', () => {
  const series = (values: Array<number | null>, start = '2026-01-01') => values.map((value, i) => ({ day: addDays(start, i), value }));

  it('avec croissance', () => {
    const p = projectSaturation(series(Array.from({ length: 20 }, (_, i) => 1000 + i * 100)), 5000);
    expect(p.status).toBe('growing');
    if (p.status !== 'growing') return;
    expect(p.growthPerDay).toBeCloseTo(100);
    expect(p.current).toBe(2900);
    expect(p.daysLeft).toBe(21);
    expect(p.saturationDay).toBe(addDays('2026-01-20', 21));
    expect(p.percentUsed).toBeCloseTo(0.58);
  });

  it('sans croissance', () => {
    const p = projectSaturation(series([1000, 1000, 1000, 990]), 5000);
    expect(p.status).toBe('stable');
    if (p.status === 'no_data') return;
    expect(p.daysLeft).toBeNull();
  });

  it('avec une seule mesure', () => {
    const p = projectSaturation(series([null, null, 1234]), 5000);
    expect(p.status).toBe('insufficient');
  });

  it('sans mesure, et sans limite configurée', () => {
    expect(projectSaturation(series([null, null]), 5000).status).toBe('no_data');
    const p = projectSaturation(series([1000, 1100, 1200]), null);
    expect(p.status).toBe('growing');
    if (p.status !== 'growing') return;
    expect(p.daysLeft).toBeNull();
    expect(p.percentUsed).toBeNull();
  });

  it('ne retient que la tendance des 14 derniers jours', () => {
    const values = [...Array.from({ length: 10 }, (_, i) => i * 1000), ...Array.from({ length: 14 }, () => 50_000)];
    expect(projectSaturation(series(values), 100_000).status).toBe('stable');
  });
});

describe('crédit Anthropic', () => {
  const t = { warn: 70, critical: 90 };

  it('pourcentage et jours restants avec plusieurs recharges', () => {
    const s = creditStatus(
      [
        { date: '2026-02-01', amountUsd: 50 },
        { date: '2026-01-01', amountUsd: 100 },
      ],
      120,
      70,
      t,
    );
    expect(s).toMatchObject({ configured: true, since: '2026-01-01', totalUsd: 150, consumedUsd: 120, remainingUsd: 30, level: 'warn' });
    if (!s.configured) return;
    expect(s.percentUsed).toBeCloseTo(80);
    expect(s.avgDailyUsd7).toBeCloseTo(10);
    expect(s.daysLeft).toBe(3);
  });

  it('sans recharge : aucun crédit configuré ; sans consommation : stable', () => {
    expect(creditStatus([], 10, 1, t)).toEqual({ configured: false });
    const s = creditStatus([{ date: '2026-01-01', amountUsd: 100 }], 0, 0, t);
    expect(s).toMatchObject({ configured: true, daysLeft: null, level: 'ok' });
  });

  it('seuil critique', () => {
    expect(creditStatus([{ date: '2026-01-01', amountUsd: 100 }], 95, 7, t)).toMatchObject({ level: 'critical' });
  });

  it('écart de recoupement au-dessus et en dessous de 10 %', () => {
    expect(reconciliationGap(105, 100)).toEqual({ gap: 0.05, flagged: false });
    expect(reconciliationGap(80, 100).flagged).toBe(true);
    expect(reconciliationGap(0, 0)).toEqual({ gap: 0, flagged: false });
    expect(reconciliationGap(5, 0).flagged).toBe(true);
  });
});

describe('navigateurs', () => {
  it('regroupe les versions de moins de 5 % sous « autres versions »', () => {
    const g = groupBrowserVersions([
      { browser: 'chrome', major: '142', sessions: 900 },
      { browser: 'chrome', major: '141', sessions: 70 },
      { browser: 'chrome', major: '120', sessions: 20 },
      { browser: 'chrome', major: '109', sessions: 10 },
      { browser: 'safari', major: '26', sessions: 500 },
    ]);
    expect(g.map((b) => b.browser)).toEqual(['chrome', 'safari']);
    const chrome = g[0]!;
    expect(chrome.sessions).toBe(1000);
    expect(chrome.share).toBeCloseTo(1000 / 1500);
    expect(chrome.versions).toEqual([
      { major: '142', sessions: 900, share: 0.9 },
      { major: '141', sessions: 70, share: 0.07 },
      { major: OTHER_VERSIONS, sessions: 30, share: 0.03 },
    ]);
  });
});

describe('présence', () => {
  it('moyenne et pic avec l’heure du pic (la première en cas d’égalité)', () => {
    expect(
      presenceStats([
        { hour: '2026-01-01T10:00:00Z', avgUsers: 4, peakUsers: 9 },
        { hour: '2026-01-01T08:00:00Z', avgUsers: 2, peakUsers: 9 },
        { hour: '2026-01-01T09:00:00Z', avgUsers: 3, peakUsers: 5 },
      ]),
    ).toEqual({ avg: 3, peak: 9, peakHour: '2026-01-01T08:00:00Z' });
    expect(presenceStats([])).toEqual({ avg: null, peak: null, peakHour: null });
  });

  it('données non actualisées au-delà de 3 minutes', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    expect(isStale('2026-01-01T11:58:00Z', now)).toBe(false);
    expect(isStale('2026-01-01T11:56:59Z', now)).toBe(true);
    expect(isStale(null, now)).toBe(true);
  });
});
