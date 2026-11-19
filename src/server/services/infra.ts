import type { InfraResponse } from '../../shared/api.js';
import { projectSaturation, type Day } from '../../shared/calc.js';
import type { AppConfig } from '../config.js';
import type { ReadRepository } from '../data/repository.js';

/**
 * Taille de la base (pg_database_size, mesure actuelle) et des 10 plus grosses tables ;
 * projection de saturation sur la tendance des 14 derniers jours (db_size_bytes, storage_bytes).
 */
export async function buildInfra(repo: ReadRepository, config: AppConfig, today: Day): Promise<InfraResponse> {
  const [size, tables, history] = await Promise.all([
    repo.one<{ bytes: number }>('databaseSize'),
    repo.rows<{ table_name: string; total_bytes: number }>('tableSizesTop10'),
    repo.rows<{ day: string; db_size_bytes: number | null; storage_bytes: number | null }>('sizeHistory', [today]),
  ]);
  const sizeBytes = Number(size?.bytes ?? 0);
  const dbPoints = history.filter((h) => h.day !== today).map((h) => ({ day: h.day, value: h.db_size_bytes }));
  dbPoints.push({ day: today, value: sizeBytes });
  const storagePoints = history.map((h) => ({ day: h.day, value: h.storage_bytes }));
  return {
    database: { sizeBytes, limitBytes: config.limits.dbSizeBytes, projection: projectSaturation(dbPoints, config.limits.dbSizeBytes) },
    storage: { limitBytes: config.limits.storageBytes, projection: projectSaturation(storagePoints, config.limits.storageBytes) },
    tables: tables.map((t) => ({ name: t.table_name, bytes: Number(t.total_bytes) })),
    dailySizes: history.map((h) => ({
      day: h.day,
      dbSizeBytes: h.db_size_bytes === null ? null : Number(h.db_size_bytes),
      storageBytes: h.storage_bytes === null ? null : Number(h.storage_bytes),
    })),
    thresholds: {
      warn: config.thresholds.storageWarn,
      critical: config.thresholds.storageCritical,
      saturationDays: config.thresholds.saturationDays,
    },
  };
}
