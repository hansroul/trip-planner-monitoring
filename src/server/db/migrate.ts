import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

/**
 * Petit exécuteur de migrations SQL pour le schéma monitoring_app (fichiers sql/migrations/NNN_nom.sql).
 * Chaque migration s'exécute dans une transaction, sous verrou consultatif, une seule fois ;
 * un fichier déjà appliqué puis modifié bloque le démarrage (somme de contrôle).
 */
const LOCK_KEY = 72_310_451; // constante arbitraire propre à ce site

export async function runMigrations(pool: pg.Pool, dir = path.resolve('sql/migrations')): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS monitoring_app.schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM monitoring_app.schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) throw new Error(`Migration ${file} modifiée après application`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO monitoring_app.schema_migrations (name, checksum) VALUES ($1, $2)', [
        file,
        checksum,
      ]);
      applied.push(file);
    }
    await client.query('COMMIT');
    return applied;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
