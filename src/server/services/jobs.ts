import type { FastifyBaseLogger } from 'fastify';
import { todayIn } from '../../shared/calc.js';
import type { AppConfig } from '../config.js';
import { ReadRepository } from '../data/repository.js';
import type { Pools } from '../db/pools.js';
import { safeError } from '../logger.js';
import { creditCandidates, processAlerts, storageCandidates, type Mailer } from './alerts.js';
import { computeCredit, TopupStore, topupsToken } from './credit.js';
import { buildInfra } from './infra.js';
import { createMailer } from './mailer.js';

export interface JobDeps {
  config: AppConfig;
  pools: Pools;
  log: FastifyBaseLogger;
  mailer?: Mailer | null;
  now?: () => Date;
}

const ALERT_LOCK = 72_310_452;
export const ALERT_INTERVAL_MS = 15 * 60 * 1000;

/** Une évaluation complète des alertes ; renvoie les alertes envoyées. */
export async function runAlertCheck(deps: JobDeps & { mailer: Mailer }): Promise<string[]> {
  const { config, pools } = deps;
  const now = deps.now?.() ?? new Date();
  const lock = await pools.app.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [ALERT_LOCK]);
  if (!lock.rows[0]?.ok) return [];
  try {
    const repo = new ReadRepository(pools.read);
    const today = todayIn(config.timezone, now);
    const topups = await new TopupStore(pools.app).list();
    const credit = await computeCredit(repo, topups, config.anthropic.providerLabel, today, {
      warn: config.thresholds.creditWarn,
      critical: config.thresholds.creditCritical,
    });
    const infra = await buildInfra(repo, config, today);
    const t = { warn: config.thresholds.storageWarn, critical: config.thresholds.storageCritical, saturationDays: config.thresholds.saturationDays };
    const candidates = [
      ...creditCandidates(credit, { warn: config.thresholds.creditWarn, critical: config.thresholds.creditCritical }, topupsToken(topups)),
      ...storageCandidates('db', infra.database.projection, t),
      ...storageCandidates('storage', infra.storage.projection, t),
    ];
    return await processAlerts(pools.app, deps.mailer, candidates, now);
  } finally {
    await pools.app.query('SELECT pg_advisory_unlock($1)', [ALERT_LOCK]);
  }
}

/** Tâches de fond (alertes toutes les 15 minutes). Renvoie une fonction d'arrêt. */
export function startBackgroundJobs(deps: JobDeps): () => void {
  const mailer = deps.mailer ?? createMailer(deps.config);
  if (!mailer) {
    deps.log.info('Alertes par e-mail désactivées (ALERTS_ENABLED=false ou SMTP absent).');
    return () => undefined;
  }
  const tick = () => {
    runAlertCheck({ ...deps, mailer })
      .then((sent) => {
        if (sent.length) deps.log.info({ alerts: sent }, 'alertes envoyées');
      })
      .catch((err: unknown) => deps.log.error({ err: safeError(err) }, 'vérification des alertes impossible'));
  };
  const first = setTimeout(tick, 30_000);
  const timer = setInterval(tick, ALERT_INTERVAL_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
