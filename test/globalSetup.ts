import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { devRoleUrl, setupDevDatabase } from '../scripts/dev-db.js';
import { runMigrations } from '../src/server/db/migrate.js';

/**
 * Base de test : recréée à chaque exécution à partir de dev/db (rôles, fausses tables, vues du
 * contrat, fausses données), puis migrations du schéma monitoring_app. Jamais de donnée réelle.
 * TEST_PG_ADMIN_URL : superutilisateur d'une instance PostgreSQL LOCALE (docker-compose…).
 */
export interface DbUrls {
  admin: string;
  readonly: string;
  app: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrls: DbUrls;
  }
}

export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_PG_ADMIN_URL;
  if (!adminUrl) {
    throw new Error(
      'TEST_PG_ADMIN_URL manquante : lancer « docker compose up -d db » puis TEST_PG_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres',
    );
  }
  const database = 'monitoring_test';
  const admin = await setupDevDatabase(adminUrl, database, { recreate: true });
  const urls: DbUrls = {
    admin,
    readonly: devRoleUrl(adminUrl, database, 'monitoring_reader'),
    app: devRoleUrl(adminUrl, database, 'monitoring_app_rw'),
  };
  const pool = new pg.Pool({ connectionString: urls.app });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
  project.provide('dbUrls', urls);
}
