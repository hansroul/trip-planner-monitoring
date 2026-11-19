import pg from 'pg';
import type { DbTarget } from '../config.js';

/**
 * Deux connexions distinctes :
 * - lecture : rôle monitoring_reader, LECTURE SEULE forcée à l'ouverture de chaque connexion
 *   (paramètre de démarrage default_transaction_read_only, en plus du réglage du rôle) ;
 * - application : rôle monitoring_app_rw, limité au schéma monitoring_app.
 *
 * TLS : exigé et vérifié (certificat + nom d'hôte) dès que l'hôte n'est pas sur le réseau privé
 * (Railway *.railway.internal, ou boucle locale en développement).
 */

export interface PoolOptions {
  readonly: boolean;
  statementTimeoutMs: number;
  max: number;
  sslCa?: string | undefined;
  applicationName: string;
}

export function sslFor(target: Pick<DbTarget, 'host' | 'privateNetwork'>, sslCa?: string): pg.PoolConfig['ssl'] {
  if (target.privateNetwork) return false;
  return {
    rejectUnauthorized: true,
    servername: target.host,
    ...(sslCa ? { ca: sslCa } : {}),
  };
}

export function poolConfig(target: DbTarget, opts: PoolOptions): pg.PoolConfig {
  // URL analysée ici (et non passée telle quelle) : un « sslmode » dans l'URL ne peut pas
  // affaiblir la politique TLS.
  const u = new URL(target.url);
  const startup = [
    `-c statement_timeout=${opts.statementTimeoutMs}`,
    '-c idle_in_transaction_session_timeout=30000',
    '-c lock_timeout=5000',
  ];
  if (opts.readonly) startup.push('-c default_transaction_read_only=on');
  else startup.push('-c search_path=monitoring_app');
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
    ssl: sslFor(target, opts.sslCa),
    options: startup.join(' '),
    application_name: opts.applicationName,
    max: opts.max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: opts.statementTimeoutMs + 2_000,
    allowExitOnIdle: false,
  };
}

export function createPool(target: DbTarget, opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool(poolConfig(target, opts));
  // Une erreur sur une connexion inactive ne doit pas arrêter le processus.
  pool.on('error', () => undefined);
  return pool;
}

export interface Pools {
  read: pg.Pool;
  app: pg.Pool;
}

export function createPools(db: { readonly: DbTarget; app: DbTarget; sslCa?: string | undefined }): Pools {
  return {
    read: createPool(db.readonly, {
      readonly: true,
      statementTimeoutMs: 5_000,
      max: 2,
      sslCa: db.sslCa,
      applicationName: 'poppytrip-monitoring-read',
    }),
    app: createPool(db.app, {
      readonly: false,
      statementTimeoutMs: 10_000,
      max: 4,
      sslCa: db.sslCa,
      applicationName: 'poppytrip-monitoring-app',
    }),
  };
}
