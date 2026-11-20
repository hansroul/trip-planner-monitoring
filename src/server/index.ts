import path from 'node:path';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { createPools } from './db/pools.js';
import { loadClientBundle } from './http/static.js';
import { safeError } from './logger.js';
import { registerApi } from './routes/api.js';
import { startBackgroundJobs } from './services/jobs.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Le message ne contient que les noms des variables en cause, jamais leurs valeurs.
    console.error(err instanceof ConfigError ? err.message : 'Configuration invalide');
    process.exit(1);
  }

  const pools = createPools(config.db);
  await runMigrations(pools.app);
  const client = await loadClientBundle(path.resolve('dist/client'));
  const app = await buildApp({ config, pools, client, registerApi });

  app.log.info('Connexion : PUBLIC_BASE_URL/<préfixe>/auth/login');

  const stopJobs = startBackgroundJobs({ config, pools, log: app.log });

  const shutdown = async () => {
    stopJobs();
    await app.close().catch(() => undefined);
    await Promise.allSettled([pools.read.end(), pools.app.end()]);
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error('Arrêt : ', safeError(err));
  process.exit(1);
});
