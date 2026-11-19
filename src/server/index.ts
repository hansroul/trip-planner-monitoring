import path from 'node:path';
import { buildApp } from './app.js';
import { createOidcProvider } from './auth/oidc.js';
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
  const oidc = createOidcProvider(config.oidc);
  const app = await buildApp({ config, pools, oidc, client, registerApi });

  if (!config.admin.sub) {
    app.log.warn(
      'ADMIN_OIDC_SUB n’est pas défini : la connexion n’est vérifiée que par l’adresse. Connecte-toi une fois puis renseigne ADMIN_OIDC_SUB.',
    );
  }

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
