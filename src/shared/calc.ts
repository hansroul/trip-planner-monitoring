/**
 * Calculs PURS du tableau de bord (aucun accès réseau ni base), testés unitairement.
 * Les jours sont des chaînes « AAAA-MM-JJ » (jours locaux fournis par les vues) ; l'arithmétique
 * se fait en UTC pour ne jamais dépendre du fuseau de la machine ni des changements d'heure.
 */

export type Day = string;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_DAY = 86_400_000;

export function isDay(s: unknown): s is Day {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(day: Day, n: number): Day {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * MS_DAY).toISOString().slice(0, 10);
}

/** Nombre de jours de `from` à `to` (to - from). */
export function daysBetween(from: Day, to: Day): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_DAY);
}

export function eachDay(from: Day, to: Day): Day[] {
  const out: Day[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Jour civil courant dans un fuseau donné. */
export function todayIn(timeZone: string, now: Date = new Date()): Day {
  return localParts(now, timeZone).day;
}

/** Jour, heure et jour de semaine (1 = lundi … 7 = dimanche) d'un instant dans un fuseau. */
export function localParts(instant: Date | string, timeZone: string): { day: Day; hour: number; weekday: number } {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekdays: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    weekday: weekdays[get('weekday')] ?? 0,
  };
}

/** Série complète jour par jour (zéro pour les jours absents). */
export function fillDaily<K extends string>(
  rows: ReadonlyArray<{ day: Day } & Partial<Record<K, number | null>>>,
  from: Day,
  to: Day,
  keys: readonly K[],
): Array<{ day: Day } & Record<K, number>> {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return eachDay(from, to).map((day) => {
    const r = byDay.get(day);
    const out = { day } as { day: Day } & Record<K, number>;
    for (const k of keys) (out as Record<K, number>)[k] = Number(r?.[k] ?? 0);
    return out;
  });
}

/** Somme glissante sur les `days` derniers jours se terminant à `end` (inclus). */
export function rollingSum(rows: ReadonlyArray<{ day: Day; value: number }>, end: Day, days: number): number {
  const start = addDays(end, -(days - 1));
  return rows.filter((r) => r.day >= start && r.day <= end).reduce((s, r) => s + r.value, 0);
}

/** Bandeau « historique incomplet » : la période commence avant la mise en service. */
export function isHistoryIncomplete(from: Day, instrumentedSince: Day | null): boolean {
  return instrumentedSince !== null && from < instrumentedSince;
}

// --- Abonnements et revenus ------------------------------------------------------------

export const PAYING_STATUSES = ['active', 'past_due'] as const;

/**
 * Abonnés en début de période : nombre d'abonnements dont le DERNIER événement avant le début
 * n'est pas une résiliation effective (`canceled`).
 */
export function subscribersAtStart(lastEventCounts: ReadonlyArray<{ eventType: string; count: number }>): number {
  return lastEventCounts.filter((r) => r.eventType !== 'canceled').reduce((s, r) => s + r.count, 0);
}

/** Abonnements en cours jour par jour : départ + créations − résiliations effectives cumulées. */
export function activeSubscriptionsSeries(
  start: number,
  daily: ReadonlyArray<{ day: Day; created: number; canceled: number }>,
): Array<{ day: Day; active: number }> {
  let current = start;
  return daily.map((d) => {
    current += d.created - d.canceled;
    return { day: d.day, active: Math.max(0, current) };
  });
}

export function monthlyCents(amountCents: number, interval: string): number {
  return interval === 'year' ? amountCents / 12 : amountCents;
}

export interface PriceRow {
  plan: string;
  billingInterval: string;
  currency: string;
  amountCents: number;
}

export interface CurrentRow {
  plan: string;
  billingInterval: string;
  status: string;
  count: number;
}

export interface MrrResult {
  /** MRR par devise, en centimes (annuels ramenés au mois). */
  byCurrency: Record<string, number>;
  lines: Array<{ plan: string; billingInterval: string; currency: string; subscribers: number; monthlyCents: number; mrrCents: number }>;
  /** Offres comptant des abonnés mais sans montant connu (exclues du MRR). */
  missingPrices: Array<{ plan: string; billingInterval: string; subscribers: number }>;
}

/**
 * MRR : abonnés payants (actifs ou en retard de paiement) × prix mensuel de leur offre, déduit
 * du montant de ses événements les plus récents (montants facturés, taxes éventuellement
 * incluses). Les abonnements en essai ne comptent pas.
 */
export function computeMrr(current: readonly CurrentRow[], prices: readonly PriceRow[]): MrrResult {
  const paying = new Map<string, { plan: string; billingInterval: string; count: number }>();
  for (const r of current) {
    if (!(PAYING_STATUSES as readonly string[]).includes(r.status)) continue;
    const k = `${r.plan}\u0000${r.billingInterval}`;
    const e = paying.get(k) ?? { plan: r.plan, billingInterval: r.billingInterval, count: 0 };
    e.count += r.count;
    paying.set(k, e);
  }
  const result: MrrResult = { byCurrency: {}, lines: [], missingPrices: [] };
  for (const p of paying.values()) {
    if (p.count <= 0) continue;
    const price = prices.find((x) => x.plan === p.plan && x.billingInterval === p.billingInterval);
    if (!price) {
      result.missingPrices.push({ plan: p.plan, billingInterval: p.billingInterval, subscribers: p.count });
      continue;
    }
    const monthly = monthlyCents(price.amountCents, p.billingInterval);
    const mrr = monthly * p.count;
    result.lines.push({
      plan: p.plan,
      billingInterval: p.billingInterval,
      currency: price.currency,
      subscribers: p.count,
      monthlyCents: monthly,
      mrrCents: mrr,
    });
    result.byCurrency[price.currency] = (result.byCurrency[price.currency] ?? 0) + mrr;
  }
  result.lines.sort((a, b) => b.mrrCents - a.mrrCents);
  return result;
}

/** Taux de désabonnement : résiliations effectives / abonnés en début de période (null si 0). */
export function churnRate(canceled: number, subscribersStart: number): number | null {
  return subscribersStart > 0 ? canceled / subscribersStart : null;
}

/** Conversion gratuit → payant des cohortes : abonnés / inscrits (null si aucun inscrit). */
export function conversionRate(subscribed: number, signups: number): number | null {
  return signups > 0 ? subscribed / signups : null;
}

export function ratio(part: number, total: number): number | null {
  return total > 0 ? part / total : null;
}

// --- Projection de saturation ------------------------------------------------------------

export type Projection =
  | { status: 'no_data' }
  | {
      status: 'insufficient' | 'stable' | 'growing';
      current: number;
      currentDay: Day;
      growthPerDay: number | null;
      limit: number | null;
      percentUsed: number | null;
      daysLeft: number | null;
      saturationDay: Day | null;
    };

/**
 * Projection du nombre de jours avant saturation : tendance (régression linéaire) sur les
 * `windowDays` derniers jours mesurés. Une seule mesure → « insufficient » ; croissance nulle ou
 * négative → « stable » ; sans limite configurée → pas de jours restants.
 */
export function projectSaturation(
  points: ReadonlyArray<{ day: Day; value: number | null }>,
  limit: number | null,
  windowDays = 14,
): Projection {
  const measured = points.filter((p): p is { day: Day; value: number } => p.value !== null && Number.isFinite(p.value));
  if (measured.length === 0) return { status: 'no_data' };
  const sorted = [...measured].sort((a, b) => a.day.localeCompare(b.day));
  const last = sorted[sorted.length - 1]!;
  const windowStart = addDays(last.day, -(windowDays - 1));
  const win = sorted.filter((p) => p.day >= windowStart);
  const percentUsed = limit ? last.value / limit : null;
  const base = { current: last.value, currentDay: last.day, limit, percentUsed };
  if (win.length < 2) return { status: 'insufficient', ...base, growthPerDay: null, daysLeft: null, saturationDay: null };

  const xs = win.map((p) => daysBetween(win[0]!.day, p.day));
  const ys = win.map((p) => p.value);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  // Croissance inférieure à 1 octet par jour : stable.
  if (slope < 1) return { status: 'stable', ...base, growthPerDay: Math.max(0, slope), daysLeft: null, saturationDay: null };
  if (!limit) return { status: 'growing', ...base, growthPerDay: slope, daysLeft: null, saturationDay: null };
  const daysLeft = Math.max(0, Math.floor((limit - last.value) / slope));
  return { status: 'growing', ...base, growthPerDay: slope, daysLeft, saturationDay: addDays(last.day, daysLeft) };
}

// --- Crédit Anthropic --------------------------------------------------------------------

export interface Topup {
  date: Day;
  amountUsd: number;
}

export type CreditLevel = 'ok' | 'warn' | 'critical';

export type CreditStatus =
  | { configured: false }
  | {
      configured: true;
      since: Day;
      totalUsd: number;
      consumedUsd: number;
      remainingUsd: number;
      percentUsed: number;
      avgDailyUsd7: number;
      daysLeft: number | null; // null = « stable » (aucune consommation récente)
      level: CreditLevel;
    };

/**
 * État du crédit : total rechargé, consommé depuis la première recharge, restant, pourcentage,
 * moyenne quotidienne des 7 derniers jours et jours restants estimés.
 */
export function creditStatus(
  topups: readonly Topup[],
  consumedUsd: number,
  last7DaysUsd: number,
  thresholds: { warn: number; critical: number },
): CreditStatus {
  if (topups.length === 0) return { configured: false };
  const since = topups.map((t) => t.date).sort()[0]!;
  const totalUsd = round2(topups.reduce((s, t) => s + t.amountUsd, 0));
  const consumed = round2(consumedUsd);
  const remainingUsd = round2(totalUsd - consumed);
  const percentUsed = totalUsd > 0 ? (consumed / totalUsd) * 100 : 100;
  const avgDailyUsd7 = last7DaysUsd / 7;
  const daysLeft = avgDailyUsd7 > 0 ? Math.max(0, Math.floor(remainingUsd / avgDailyUsd7)) : null;
  return {
    configured: true,
    since,
    totalUsd,
    consumedUsd: consumed,
    remainingUsd,
    percentUsed,
    avgDailyUsd7,
    daysLeft,
    level: levelFor(percentUsed, thresholds),
  };
}

export function levelFor(percent: number, t: { warn: number; critical: number }): CreditLevel {
  if (percent >= t.critical) return 'critical';
  if (percent >= t.warn) return 'warn';
  return 'ok';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Écart relatif du recoupement (|a − b| / b), signalé au-delà de 10 %. */
export function reconciliationGap(localUsd: number, apiUsd: number): { gap: number | null; flagged: boolean } {
  if (apiUsd === 0) return { gap: localUsd === 0 ? 0 : null, flagged: localUsd !== 0 };
  const gap = Math.abs(localUsd - apiUsd) / apiUsd;
  return { gap, flagged: gap > 0.1 };
}

// --- Navigateurs ---------------------------------------------------------------------------

export const OTHER_VERSIONS = 'autres versions';

export interface BrowserGroup {
  browser: string;
  sessions: number;
  share: number;
  versions: Array<{ major: string; sessions: number; share: number }>;
}

/**
 * Navigateurs les plus utilisés avec la répartition de leurs versions majeures ; les versions
 * qui pèsent moins de `threshold` (5 %) des sessions de leur navigateur sont regroupées sous
 * « autres versions ».
 */
export function groupBrowserVersions(
  rows: ReadonlyArray<{ browser: string; major: string; sessions: number }>,
  threshold = 0.05,
): BrowserGroup[] {
  const total = rows.reduce((s, r) => s + r.sessions, 0);
  const byBrowser = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = byBrowser.get(r.browser) ?? new Map<string, number>();
    m.set(r.major, (m.get(r.major) ?? 0) + r.sessions);
    byBrowser.set(r.browser, m);
  }
  const groups: BrowserGroup[] = [];
  for (const [browser, versions] of byBrowser) {
    const bTotal = [...versions.values()].reduce((a, b) => a + b, 0);
    if (bTotal <= 0) continue;
    const kept: BrowserGroup['versions'] = [];
    let others = 0;
    for (const [major, sessions] of versions) {
      if (sessions / bTotal < threshold || major === 'other') others += sessions;
      else kept.push({ major, sessions, share: sessions / bTotal });
    }
    kept.sort((a, b) => b.sessions - a.sessions || compareMajor(b.major, a.major));
    if (others > 0) kept.push({ major: OTHER_VERSIONS, sessions: others, share: others / bTotal });
    groups.push({ browser, sessions: bTotal, share: total > 0 ? bTotal / total : 0, versions: kept });
  }
  return groups.sort((a, b) => b.sessions - a.sessions);
}

function compareMajor(a: string, b: string): number {
  return (Number(a) || 0) - (Number(b) || 0);
}

// --- Présence ----------------------------------------------------------------------------

export interface PresenceHour {
  hour: string; // instant ISO
  avgUsers: number;
  peakUsers: number;
}

/** Moyenne (des moyennes horaires) et pic, avec l'heure du pic (la première en cas d'égalité). */
export function presenceStats(hours: readonly PresenceHour[]): { avg: number | null; peak: number | null; peakHour: string | null } {
  if (hours.length === 0) return { avg: null, peak: null, peakHour: null };
  const sorted = [...hours].sort((a, b) => a.hour.localeCompare(b.hour));
  let peak = sorted[0]!;
  for (const h of sorted) if (h.peakUsers > peak.peakUsers) peak = h;
  const avg = sorted.reduce((s, h) => s + h.avgUsers, 0) / sorted.length;
  return { avg: Math.round(avg * 100) / 100, peak: peak.peakUsers, peakHour: peak.hour };
}

/** Données « non actualisées » : plus de 3 minutes depuis la dernière mesure (ou aucune). */
export function isStale(asOf: string | null, now: Date, maxAgeMs = 3 * 60_000): boolean {
  if (!asOf) return true;
  return now.getTime() - new Date(asOf).getTime() > maxAgeMs;
}
