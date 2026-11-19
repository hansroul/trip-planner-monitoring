import type { LiveResponse, OverviewResponse, Period } from '../../shared/api.js';
import {
  activeSubscriptionsSeries,
  churnRate,
  computeMrr,
  conversionRate,
  eachDay,
  fillDaily,
  groupBrowserVersions,
  isHistoryIncomplete,
  isStale,
  presenceStats,
  ratio,
  rollingSum,
  subscribersAtStart,
} from '../../shared/calc.js';
import type { DailyMetricRow, ReadRepository } from '../data/repository.js';

/**
 * Assemblage du tableau de bord à partir de requêtes agrégées (registre READ_QUERIES).
 * Aucune donnée personnelle : uniquement des comptages et des montants.
 */
export interface OverviewSettings {
  anthropicLabel: string;
  usdToEurRate: number | null;
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function buildOverview(repo: ReadRepository, period: Period, settings: OverviewSettings): Promise<OverviewResponse> {
  const { from, to, timezone: tz } = period;
  const [
    meta,
    daily,
    totals,
    current,
    subDaily,
    atStart,
    prices,
    billed,
    packsDaily,
    aiDaily,
    aiByModel,
    funnel,
    devices,
    os,
    browsers,
    deviceDaily,
    presenceDaily,
    heat,
    monthRows,
  ] = await Promise.all([
    repo.one<{ instrumented_since: string | null }>('meta'),
    repo.rows<DailyMetricRow>('dailyMetrics', [from, to]),
    repo.one<{ signups: number; deletions: number; first_day: string | null }>('userTotals', [to]),
    repo.rows<{ plan: string; billing_interval: string; status: string; count: number }>('subscriptionsCurrent'),
    repo.rows<{ day: string; event_type: string; count: number }>('subscriptionEventsDaily', [from, to, tz]),
    repo.rows<{ event_type: string; count: number }>('subscriptionsAtStart', [from, tz]),
    repo.rows<{ plan: string; billing_interval: string; currency: string; amount_cents: number }>('latestPrices'),
    repo.rows<{ currency: string; amount_cents: number }>('subscriptionRevenue', [from, to, tz]),
    repo.rows<{ day: string; currency: string; packs: number; amount_cents: number }>('creditPurchasesDaily', [from, to]),
    repo.rows<{ day: string; cost_usd: number }>('aiCostsDaily', [from, to, settings.anthropicLabel]),
    repo.rows<{ provider: string; model: string; requests: number; input_tokens: number; output_tokens: number; cost_usd: number }>(
      'aiCostsByModel',
      [from, to],
    ),
    repo.one<{ signups: number; with_first_trip: number; activated: number; hit_paywall: number; subscribed: number }>('funnel', [
      from,
      to,
    ]),
    repo.rows<{ device_type: string; sessions: number }>('clientsByDevice', [from, to]),
    repo.rows<{ os_family: string; sessions: number }>('clientsByOs', [from, to]),
    repo.rows<{ browser_name: string; browser_major: string; sessions: number }>('clientsByBrowser', [from, to]),
    repo.rows<{ day: string; device_type: string; sessions: number }>('clientsDeviceDaily', [from, to]),
    repo.rows<{ day: string; peak_users: number; peak_hour: Date | null; avg_users: number }>('presenceDaily', [from, to]),
    repo.rows<{ weekday: number; hour_of_day: number; avg_users: number }>('presenceHeatmap', [from, to, tz]),
    // Actifs : 30 jours avant la fin de période, pour les sommes glissantes.
    repo.rows<DailyMetricRow>('dailyMetrics', [addDaysSafe(to, -29), to]),
  ]);

  const instrumentedSince = meta?.instrumented_since ?? null;

  // --- Utilisateurs ----------------------------------------------------------------------
  const usersDaily = fillDaily(
    daily.map((r) => ({ day: r.day, signups: n(r.signups), deletions: n(r.account_deletions), active: n(r.active_users) })),
    from,
    to,
    ['signups', 'deletions', 'active'] as const,
  );
  const activeRows = monthRows.map((r) => ({ day: r.day, value: n(r.active_users) }));
  const toRow = usersDaily[usersDaily.length - 1];

  // --- Abonnements -----------------------------------------------------------------------
  const subByDay = new Map<string, Record<string, number>>();
  for (const r of subDaily) {
    const m = subByDay.get(r.day) ?? {};
    m[r.event_type] = n(r.count);
    subByDay.set(r.day, m);
  }
  const subsDaily = eachDay(from, to).map((day) => {
    const m = subByDay.get(day) ?? {};
    return {
      day,
      created: m.created ?? 0,
      cancelRequested: m.cancel_requested ?? 0,
      canceled: m.canceled ?? 0,
      reactivated: m.reactivated ?? 0,
      paymentFailed: m.payment_failed ?? 0,
    };
  });
  const sum = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);
  const subTotals = {
    created: sum(subsDaily, (d) => d.created),
    cancelRequested: sum(subsDaily, (d) => d.cancelRequested),
    canceled: sum(subsDaily, (d) => d.canceled),
    reactivated: sum(subsDaily, (d) => d.reactivated),
    paymentFailed: sum(subsDaily, (d) => d.paymentFailed),
    net: 0,
  };
  subTotals.net = subTotals.created - subTotals.canceled;
  const startCount = subscribersAtStart(atStart.map((r) => ({ eventType: r.event_type, count: n(r.count) })));
  const currentRows = current.map((r) => ({ plan: r.plan, billingInterval: r.billing_interval, status: r.status, count: n(r.count) }));

  // --- Revenus ---------------------------------------------------------------------------
  const mrr = computeMrr(
    currentRows,
    prices.map((p) => ({ plan: p.plan, billingInterval: p.billing_interval, currency: p.currency, amountCents: n(p.amount_cents) })),
  );
  const subscriptionBilledCents: Record<string, number> = {};
  for (const b of billed) subscriptionBilledCents[b.currency] = n(b.amount_cents);
  const packsByCurrency: Record<string, { packs: number; amountCents: number }> = {};
  const packsPerDay = new Map<string, number>();
  for (const p of packsDaily) {
    const e = (packsByCurrency[p.currency] ??= { packs: 0, amountCents: 0 });
    e.packs += n(p.packs);
    e.amountCents += n(p.amount_cents);
    packsPerDay.set(p.day, (packsPerDay.get(p.day) ?? 0) + n(p.amount_cents));
  }
  const funnelTotals = {
    signups: n(funnel?.signups),
    withFirstTrip: n(funnel?.with_first_trip),
    activated: n(funnel?.activated),
    hitPaywall: n(funnel?.hit_paywall),
    subscribed: n(funnel?.subscribed),
  };

  // --- Usage -----------------------------------------------------------------------------
  const usageDaily = fillDaily(
    daily.map((r) => ({
      day: r.day,
      tripsCreated: n(r.trips_created),
      tripsFromTemplate: n(r.trips_from_template),
      assistantRequests: n(r.assistant_requests),
      creditsConsumed: n(r.credits_consumed),
      voiceTranscriptions: n(r.voice_transcriptions),
    })),
    from,
    to,
    ['tripsCreated', 'tripsFromTemplate', 'assistantRequests', 'creditsConsumed', 'voiceTranscriptions'] as const,
  );
  const usageTotals = {
    tripsCreated: sum(usageDaily, (d) => d.tripsCreated),
    tripsFromTemplate: sum(usageDaily, (d) => d.tripsFromTemplate),
    assistantRequests: sum(usageDaily, (d) => d.assistantRequests),
    creditsConsumed: sum(usageDaily, (d) => d.creditsConsumed),
    voiceTranscriptions: sum(usageDaily, (d) => d.voiceTranscriptions),
  };

  // --- Coûts et marge (estimation) -------------------------------------------------------
  const costDaily = fillDaily(
    aiDaily.map((r) => ({ day: r.day, costUsd: n(r.cost_usd) })),
    from,
    to,
    ['costUsd'] as const,
  );
  const totalUsd = sum(costDaily, (d) => d.costUsd);
  const revenueEurCents = (subscriptionBilledCents.eur ?? 0) + (packsByCurrency.eur?.amountCents ?? 0);
  const rate = settings.usdToEurRate;
  const costEurCents = rate !== null ? Math.round(totalUsd * rate * 100) : null;
  const grossMarginEurCents = costEurCents !== null ? revenueEurCents - costEurCents : null;

  // --- Appareils et navigateurs --------------------------------------------------------
  const totalSessions = sum(devices, (d) => n(d.sessions));
  const share = (v: number) => (totalSessions > 0 ? v / totalSessions : 0);
  const devByDay = new Map<string, Record<string, number>>();
  for (const r of deviceDaily) {
    const m = devByDay.get(r.day) ?? {};
    m[r.device_type] = (m[r.device_type] ?? 0) + n(r.sessions);
    devByDay.set(r.day, m);
  }

  // --- Présence --------------------------------------------------------------------------
  const heatmap: Array<Array<number | null>> = Array.from({ length: 7 }, () => Array<number | null>(24).fill(null));
  for (const h of heat) {
    const row = heatmap[h.weekday - 1];
    if (row && h.hour_of_day >= 0 && h.hour_of_day < 24) row[h.hour_of_day] = n(h.avg_users);
  }

  return {
    period,
    meta: { instrumentedSince, historyIncomplete: isHistoryIncomplete(from, instrumentedSince) },
    users: {
      total: n(totals?.signups) - n(totals?.deletions),
      totalSince: totals?.first_day ?? null,
      signupsToday: toRow?.day === period.today ? toRow.signups : 0,
      signupsPeriod: sum(usersDaily, (d) => d.signups),
      deletionsPeriod: sum(usersDaily, (d) => d.deletions),
      activeToday: toRow?.active ?? 0,
      activeWeekSum: rollingSum(activeRows, to, 7),
      activeMonthSum: rollingSum(activeRows, to, 30),
      daily: usersDaily,
    },
    subscriptions: {
      current: currentRows,
      startCount,
      activeSeries: activeSubscriptionsSeries(startCount, subsDaily),
      daily: subsDaily,
      totals: subTotals,
    },
    revenue: {
      mrr,
      subscriptionBilledCents,
      packs: { byCurrency: packsByCurrency, daily: eachDay(from, to).map((day) => ({ day, amountCents: packsPerDay.get(day) ?? 0 })) },
      churnRate: churnRate(subTotals.canceled, startCount),
      conversionRate: conversionRate(funnelTotals.subscribed, funnelTotals.signups),
    },
    usage: { daily: usageDaily, totals: usageTotals, templateShare: ratio(usageTotals.tripsFromTemplate, usageTotals.tripsCreated) },
    costs: {
      daily: costDaily,
      totalUsd,
      byModel: aiByModel.map((m) => ({
        provider: m.provider,
        model: m.model,
        requests: n(m.requests),
        inputTokens: n(m.input_tokens),
        outputTokens: n(m.output_tokens),
        costUsd: n(m.cost_usd),
      })),
      revenueEurCents,
      usdToEurRate: rate,
      costEurCents,
      grossMarginEurCents,
      marginRate: grossMarginEurCents !== null ? ratio(grossMarginEurCents, revenueEurCents) : null,
    },
    funnel: funnelTotals,
    clients: {
      devices: devices
        .map((d) => ({ device: d.device_type, sessions: n(d.sessions), share: share(n(d.sessions)) }))
        .sort((a, b) => b.sessions - a.sessions),
      os: os.map((o) => ({ os: o.os_family, sessions: n(o.sessions), share: share(n(o.sessions)) })),
      browsers: groupBrowserVersions(browsers.map((b) => ({ browser: b.browser_name, major: b.browser_major, sessions: n(b.sessions) }))),
      deviceDaily: eachDay(from, to).map((day) => {
        const m = devByDay.get(day) ?? {};
        return { day, mobile: m.mobile ?? 0, tablet: m.tablet ?? 0, desktop: m.desktop ?? 0, other: m.other ?? 0 };
      }),
    },
    presence: {
      daily: presenceDaily.map((p) => ({
        day: p.day,
        peakUsers: n(p.peak_users),
        peakHour: p.peak_hour ? new Date(p.peak_hour).toISOString() : null,
        avgUsers: n(p.avg_users),
      })),
      heatmap,
    },
  };
}

function addDaysSafe(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

export async function buildLive(repo: ReadRepository, now: Date): Promise<LiveResponse> {
  const [cur, hours] = await Promise.all([
    repo.one<{ connected_users: number; as_of: Date | null }>('presenceCurrent'),
    repo.rows<{ hour: Date; avg_users: number; peak_users: number }>('presenceLast24h'),
  ]);
  const asOf = cur?.as_of ? new Date(cur.as_of).toISOString() : null;
  const last24h = hours.map((h) => ({ hour: new Date(h.hour).toISOString(), avgUsers: n(h.avg_users), peakUsers: n(h.peak_users) }));
  return {
    connectedUsers: n(cur?.connected_users),
    asOf,
    stale: isStale(asOf, now),
    last24h,
    stats: presenceStats(last24h),
  };
}
