/** Types des réponses de l'API, partagés entre le serveur et le front. Aucune donnée personnelle. */
import type { BrowserGroup, CreditLevel, CreditStatus, Day, MrrResult, Projection } from './calc.js';

export const MAX_PERIOD_DAYS = 731; // 2 ans
export const PRESET_PERIODS = [7, 30, 90] as const;

export interface SessionInfo {
  csrfToken: string;
  absoluteExpiresAt: string;
  idleTimeoutSeconds: number;
  mainAppUrl: string | null;
  timezone: string;
}

export interface Period {
  from: Day;
  to: Day;
  days: number;
  today: Day;
  timezone: string;
}

export interface OverviewResponse {
  period: Period;
  meta: { instrumentedSince: Day | null; historyIncomplete: boolean };
  users: {
    total: number;
    totalSince: Day | null;
    signupsToday: number;
    signupsPeriod: number;
    deletionsPeriod: number;
    activeToday: number;
    activeWeekSum: number;
    activeMonthSum: number;
    daily: Array<{ day: Day; signups: number; deletions: number; active: number }>;
  };
  subscriptions: {
    current: Array<{ plan: string; billingInterval: string; status: string; count: number }>;
    startCount: number;
    activeSeries: Array<{ day: Day; active: number }>;
    daily: Array<{ day: Day; created: number; cancelRequested: number; canceled: number; reactivated: number; paymentFailed: number }>;
    totals: { created: number; cancelRequested: number; canceled: number; reactivated: number; paymentFailed: number; net: number };
  };
  revenue: {
    mrr: MrrResult;
    subscriptionBilledCents: Record<string, number>;
    packs: { byCurrency: Record<string, { packs: number; amountCents: number }>; daily: Array<{ day: Day; amountCents: number }> };
    churnRate: number | null;
    conversionRate: number | null;
  };
  usage: {
    daily: Array<{
      day: Day;
      tripsCreated: number;
      tripsFromTemplate: number;
      assistantRequests: number;
      creditsConsumed: number;
      voiceTranscriptions: number;
    }>;
    totals: { tripsCreated: number; tripsFromTemplate: number; assistantRequests: number; creditsConsumed: number; voiceTranscriptions: number };
    templateShare: number | null;
  };
  costs: {
    daily: Array<{ day: Day; costUsd: number }>;
    totalUsd: number;
    byModel: Array<{ provider: string; model: string; requests: number; inputTokens: number; outputTokens: number; costUsd: number }>;
    revenueEurCents: number;
    usdToEurRate: number | null;
    costEurCents: number | null;
    grossMarginEurCents: number | null;
    marginRate: number | null;
  };
  funnel: { signups: number; withFirstTrip: number; activated: number; hitPaywall: number; subscribed: number };
  clients: {
    devices: Array<{ device: string; sessions: number; share: number }>;
    os: Array<{ os: string; sessions: number; share: number }>;
    browsers: BrowserGroup[];
    deviceDaily: Array<{ day: Day; mobile: number; tablet: number; desktop: number; other: number }>;
  };
  presence: {
    daily: Array<{ day: Day; peakUsers: number; peakHour: string | null; avgUsers: number }>;
    /** 7 lignes (lundi → dimanche) × 24 heures locales ; null = aucune mesure. */
    heatmap: Array<Array<number | null>>;
  };
}

export interface LiveResponse {
  connectedUsers: number;
  asOf: string | null;
  stale: boolean;
  last24h: Array<{ hour: string; avgUsers: number; peakUsers: number }>;
  stats: { avg: number | null; peak: number | null; peakHour: string | null };
}

export interface InfraResponse {
  database: { sizeBytes: number; limitBytes: number | null; projection: Projection };
  storage: { limitBytes: number | null; projection: Projection };
  tables: Array<{ name: string; bytes: number }>;
  dailySizes: Array<{ day: Day; dbSizeBytes: number | null; storageBytes: number | null }>;
  thresholds: { warn: number; critical: number; saturationDays: number };
}

export interface TopupView {
  id: number;
  date: Day;
  amountUsd: number;
  note: string | null;
  updatedAt: string;
}

export interface Reconciliation {
  enabled: boolean;
  /** Raison de l'absence de recoupement (clé absente, erreur…). */
  message: string | null;
  window: { from: Day; to: Day } | null;
  localUsd: number | null;
  apiUsd: number | null;
  gap: number | null;
  flagged: boolean;
  fetchedAt: string | null;
}

export interface CreditResponse {
  status: CreditStatus;
  thresholds: { warn: number; critical: number };
  topups: TopupView[];
  reconciliation: Reconciliation;
  level: CreditLevel | null;
}
