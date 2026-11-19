import type { Reconciliation } from '../../shared/api.js';
import { addDays, reconciliationGap, type Day } from '../../shared/calc.js';
import type { ReadRepository } from '../data/repository.js';
import { safeError } from '../logger.js';

/**
 * Recoupement FACULTATIF avec l'API « Usage and Cost Analytics » d'Anthropic (Admin API),
 * actif seulement si ANTHROPIC_ADMIN_KEY est définie. La clé n'est jamais envoyée au navigateur
 * ni journalisée.
 *
 * D'après la documentation lue le 2026-11-19 (Usage and Cost Analytics API, bêta) :
 *   GET /v1/organizations/analytics/cost
 *   en-têtes : x-api-key (clé d'administration), anthropic-version, anthropic-beta: analytics-usage-cost-2026-08-24
 *   starting_at (requis, au plus 31 jours par requête, pas avant le 2026-01-01, 365 jours au plus),
 *   ending_at ; sans group_by ni time_bucket_width : une seule ligne totale par page ;
 *   réponse { data: [{ cost: { amount, currency: "USD", … } }], has_more, next_page, data_refreshed_at } ;
 *   amount = chaîne décimale EN CENTIMES (après remises, avant crédits).
 * Les données arrivent avec 4 à 24 heures de retard : la fenêtre s'arrête au minuit UTC d'avant-hier.
 */
export const ANALYTICS_BETA = 'analytics-usage-cost-2026-08-24';
export const RECONCILIATION_DAYS = 30;
const EARLIEST = '2026-01-01';

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface AdminSettings {
  adminKey: string | null;
  apiBaseUrl: string | null;
  apiVersion: string;
  providerLabel: string;
}

interface CostPage {
  data?: Array<{ cost?: { amount?: string; currency?: string } }>;
  has_more?: boolean;
  next_page?: string | null;
}

/** Fenêtre de recoupement : 30 jours UTC complets, se terminant au minuit UTC d'avant-hier. */
export function reconciliationWindow(now: Date): { from: Day; to: Day } {
  const todayUtc = now.toISOString().slice(0, 10);
  const to = addDays(todayUtc, -2); // dernier jour inclus
  let from = addDays(to, -(RECONCILIATION_DAYS - 1));
  if (from < EARLIEST) from = EARLIEST;
  return { from, to };
}

export async function fetchAnthropicCostUsd(s: AdminSettings, from: Day, to: Day, fetchImpl: FetchLike): Promise<number> {
  let total = 0;
  let page: string | null = null;
  for (let i = 0; i < 20; i++) {
    const u = new URL(`${s.apiBaseUrl}/v1/organizations/analytics/cost`);
    u.searchParams.set('starting_at', `${from}T00:00:00Z`);
    u.searchParams.set('ending_at', `${addDays(to, 1)}T00:00:00Z`);
    if (page) u.searchParams.set('page', page);
    const res = await fetchImpl(u.toString(), {
      headers: {
        'x-api-key': s.adminKey!,
        'anthropic-version': s.apiVersion,
        'anthropic-beta': ANALYTICS_BETA,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`API d’administration Anthropic : HTTP ${res.status}`);
    const body = (await res.json()) as CostPage;
    for (const row of body.data ?? []) {
      const amount = Number(row.cost?.amount ?? 0);
      if (row.cost?.currency && row.cost.currency !== 'USD') throw new Error('Devise inattendue');
      if (Number.isFinite(amount)) total += amount / 100;
    }
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  return total;
}

export async function reconcile(
  s: AdminSettings,
  repo: ReadRepository,
  now: Date,
  fetchImpl: FetchLike,
): Promise<Reconciliation> {
  const disabled = (message: string): Reconciliation => ({
    enabled: false,
    message,
    window: null,
    localUsd: null,
    apiUsd: null,
    gap: null,
    flagged: false,
    fetchedAt: null,
  });
  if (!s.adminKey || !s.apiBaseUrl) return disabled('Recoupement désactivé : ANTHROPIC_ADMIN_KEY non définie.');
  const window = reconciliationWindow(now);
  if (window.to < window.from) return disabled('Recoupement indisponible avant le 3 janvier 2026.');
  try {
    const [apiUsd, local] = await Promise.all([
      fetchAnthropicCostUsd(s, window.from, window.to, fetchImpl),
      repo.one<{ cost_usd: number }>('anthropicBetween', [s.providerLabel, window.from, window.to]),
    ]);
    const localUsd = Number(local?.cost_usd ?? 0);
    const { gap, flagged } = reconciliationGap(localUsd, apiUsd);
    return { enabled: true, message: null, window, localUsd, apiUsd, gap, flagged, fetchedAt: now.toISOString() };
  } catch (err) {
    const e = safeError(err);
    return { ...disabled(`Recoupement impossible (${e.message}).`), enabled: true, window };
  }
}
