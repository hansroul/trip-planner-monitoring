/**
 * Base de développement : crée (ou recrée) une base, applique dev/db/*.sql (rôles, fausses
 * tables, vues du contrat, droits, fausses données). Jamais utilisé en production.
 *
 *   npm run db:dev:init -- [--recreate] [--database nom]
 *
 * Lit DEV_PG_ADMIN_URL (compte superutilisateur LOCAL, par exemple celui du docker-compose).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DEV_SQL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev', 'db');

export async function devSqlFiles(): Promise<string[]> {
  return (await readdir(DEV_SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();
}

export async function setupDevDatabase(adminUrl: string, database: string, opts: { recreate: boolean; only?: (f: string) => boolean }) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) throw new Error('Nom de base invalide');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (opts.recreate && exists.rowCount) {
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    }
    if (opts.recreate || !exists.rowCount) await admin.query(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }
  const u = new URL(adminUrl);
  u.pathname = `/${database}`;
  const db = new pg.Client({ connectionString: u.toString() });
  await db.connect();
  try {
    for (const file of await devSqlFiles()) {
      if (opts.only && !opts.only(file)) continue;
      await db.query(await readFile(path.join(DEV_SQL_DIR, file), 'utf8'));
    }
  } finally {
    await db.end();
  }
  return u.toString();
}

/** URL d'un rôle de suivi sur la même instance (mots de passe de développement de dev/db). */
export function devRoleUrl(adminUrl: string, database: string, role: 'monitoring_reader' | 'monitoring_app_rw'): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = role === 'monitoring_reader' ? 'dev-only-reader-pw' : 'dev-only-app-pw';
  u.pathname = `/${database}`;
  u.search = '';
  return u.toString();
}

async function main() {
  const adminUrl = process.env.DEV_PG_ADMIN_URL;
  if (!adminUrl) {
    console.error('DEV_PG_ADMIN_URL manquante (superutilisateur de la base LOCALE de développement).');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf('--database');
  const database = dbIndex >= 0 ? (args[dbIndex + 1] ?? '') : 'poppytrip_dev';
  await setupDevDatabase(adminUrl, database, { recreate: args.includes('--recreate') });
  console.log(`Base « ${database} » prête.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
