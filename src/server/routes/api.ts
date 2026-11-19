import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { ReadRepository } from '../data/repository.js';
import { registerInfraAndCredit } from './credit.js';
import { TtlCache } from '../services/cache.js';
import { buildLive, buildOverview } from '../services/overview.js';
import { parsePeriod, PeriodError } from '../services/period.js';
import type { LiveResponse, OverviewResponse } from '../../shared/api.js';

/** Durées du cache serveur : ~60 s pour l'historique, 15 s pour la présence en direct. */
export const HISTORY_TTL_MS = 60_000;
export const LIVE_TTL_MS = 15_000;

/** Routes de l'API du tableau de bord (montées sous le préfixe + /api, session obligatoire). */
export async function registerApi(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const repo = new ReadRepository(ctx.pools.read);
  const historyCache = new TtlCache<OverviewResponse>(HISTORY_TTL_MS);
  const liveCache = new TtlCache<LiveResponse>(LIVE_TTL_MS, 1);
  const settings = { anthropicLabel: ctx.config.anthropic.providerLabel, usdToEurRate: ctx.config.usdToEurRate };

  app.get('/overview', async (req, reply) => {
    let period;
    try {
      period = parsePeriod(req.query, ctx.config.timezone, ctx.now());
    } catch (err) {
      if (err instanceof PeriodError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    return historyCache.get(`${period.from}|${period.to}|${period.today}`, () => buildOverview(repo, period, settings));
  });

  app.get('/live', async () => liveCache.get('live', () => buildLive(repo, ctx.now())));

  await registerInfraAndCredit(app, ctx, repo);
}
