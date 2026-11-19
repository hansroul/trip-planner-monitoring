import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CreditResponse, InfraResponse, Reconciliation } from '../../shared/api.js';
import { todayIn } from '../../shared/calc.js';
import type { AppContext } from '../app.js';
import type { ReadRepository } from '../data/repository.js';
import { reconcile, type FetchLike } from '../services/anthropicAdmin.js';
import { TtlCache } from '../services/cache.js';
import { computeCredit, TopupStore, topupSchema } from '../services/credit.js';
import { buildInfra } from '../services/infra.js';

export const RECONCILIATION_TTL_MS = 10 * 60_000; // au moins 5 minutes
const idParam = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();

let fetchForAdminApi: FetchLike = (url, init) => fetch(url, init);
/** Pour les tests : remplace l'appel réseau à l'API d'administration. */
export function setAdminFetch(f: FetchLike): void {
  fetchForAdminApi = f;
}

/** Infrastructure et crédit Anthropic (session obligatoire ; modifications avec CSRF). */
export async function registerInfraAndCredit(app: FastifyInstance, ctx: AppContext, repo: ReadRepository): Promise<void> {
  const { config } = ctx;
  const store = new TopupStore(ctx.pools.app);
  const infraCache = new TtlCache<InfraResponse>(60_000, 2);
  const reconCache = new TtlCache<Reconciliation>(RECONCILIATION_TTL_MS, 1);
  const thresholds = { warn: config.thresholds.creditWarn, critical: config.thresholds.creditCritical };
  const today = () => todayIn(config.timezone, ctx.now());

  app.get('/infra', async () => {
    const d = today();
    return infraCache.get(d, () => buildInfra(repo, config, d));
  });

  app.get('/credit', async (): Promise<CreditResponse> => {
    const topups = await store.list();
    const [status, reconciliation] = await Promise.all([
      computeCredit(repo, topups, config.anthropic.providerLabel, today(), thresholds),
      reconCache.get('r', () =>
        reconcile(
          {
            adminKey: config.anthropic.adminKey,
            apiBaseUrl: config.anthropic.apiBaseUrl,
            apiVersion: config.anthropic.apiVersion,
            providerLabel: config.anthropic.providerLabel,
          },
          repo,
          ctx.now(),
          fetchForAdminApi,
        ),
      ),
    ]);
    return { status, thresholds, topups, reconciliation, level: status.configured ? status.level : null };
  });

  const invalid = (msg: string) => ({ error: msg });

  app.post('/credit/topups', async (req, reply) => {
    const parsed = topupSchema(today()).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues[0]?.message ?? 'Saisie invalide'));
    return reply.code(201).send(await store.create(parsed.data, req.ip));
  });

  app.put('/credit/topups/:id', async (req, reply) => {
    const id = idParam.safeParse(req.params);
    const parsed = topupSchema(today()).safeParse(req.body);
    if (!id.success) return reply.code(400).send(invalid('Identifiant invalide'));
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues[0]?.message ?? 'Saisie invalide'));
    const v = await store.update(id.data.id, parsed.data, req.ip);
    if (!v) return reply.code(400).send(invalid('Recharge introuvable'));
    return v;
  });

  app.delete('/credit/topups/:id', async (req, reply) => {
    const id = idParam.safeParse(req.params);
    if (!id.success) return reply.code(400).send(invalid('Identifiant invalide'));
    if (!(await store.delete(id.data.id, req.ip))) return reply.code(400).send(invalid('Recharge introuvable'));
    return reply.code(204).send();
  });
}
