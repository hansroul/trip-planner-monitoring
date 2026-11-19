import type pg from 'pg';
import { READ_QUERIES, type ReadQueryName } from './queries.js';

/**
 * Accès en lecture seule aux vues du contrat. Seules les requêtes du registre READ_QUERIES
 * peuvent être exécutées, toujours avec des paramètres liés.
 */
export type Param = string | number | null;

export class ReadRepository {
  constructor(private readonly pool: pg.Pool) {}

  async rows<T extends pg.QueryResultRow>(name: ReadQueryName, params: Param[] = []): Promise<T[]> {
    const sql = READ_QUERIES[name];
    const res = await this.pool.query<T>({ text: sql, values: params });
    return res.rows;
  }

  async one<T extends pg.QueryResultRow>(name: ReadQueryName, params: Param[] = []): Promise<T | null> {
    return (await this.rows<T>(name, params))[0] ?? null;
  }
}

export interface DailyMetricRow {
  day: string;
  signups: number;
  account_deletions: number;
  active_users: number;
  trips_created: number;
  trips_from_template: number;
  assistant_requests: number;
  credits_consumed: number;
  voice_transcriptions: number;
  paywall_trip_limit: number;
  paywall_credits: number;
  db_size_bytes: number | null;
  storage_bytes: number | null;
}
