import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Pools } from '../db/pools.js';

export interface JobDeps {
  config: AppConfig;
  pools: Pools;
  log: FastifyBaseLogger;
}

/** Tâches de fond (alertes). Complété en phase 4. Renvoie une fonction d'arrêt. */
export function startBackgroundJobs(_deps: JobDeps): () => void {
  return () => undefined;
}
