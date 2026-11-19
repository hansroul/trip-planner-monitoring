import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { devRoleUrl, setupDevDatabase } from '../scripts/dev-db.js';
import { loadConfig } from '../src/server/config.js';
import { CONTRACT_VIEW_NAMES, CONTRACT_VIEWS } from '../src/server/data/contract.js';
import { READ_QUERIES, type ReadQueryName } from '../src/server/data/queries.js';
import { ReadRepository } from '../src/server/data/repository.js';
import { createPool, poolConfig, sslFor } from '../src/server/db/pools.js';
import { testEnv } from './helpers/app.js';

/** Paramètres d'exemple pour exécuter chaque requête du registre. */
const SAMPLE_PARAMS: Record<ReadQueryName, Array<string | number>> = {
  meta: [],
  dailyMetrics: ['DAY_FROM', 'DAY_TO'],
  userTotals: ['DAY_TO'],
  sizeHistory: ['DAY_TO'],
  subscriptionsCurrent: [],
  subscriptionEventsDaily: ['DAY_FROM', 'DAY_TO', 'Europe/Brussels'],
  subscriptionsAtStart: ['DAY_FROM', 'Europe/Brussels'],
  latestPrices: [],
  subscriptionRevenue: ['DAY_FROM', 'DAY_TO', 'Europe/Brussels'],
  creditPurchasesDaily: ['DAY_FROM', 'DAY_TO'],
  aiCostsDaily: ['DAY_FROM', 'DAY_TO', 'anthropic'],
  aiCostsByModel: ['DAY_FROM', 'DAY_TO'],
  funnel: ['DAY_FROM', 'DAY_TO'],
  tableSizesTop10: [],
  databaseSize: [],
  clientsByDevice: ['DAY_FROM', 'DAY_TO'],
  clientsByOs: ['DAY_FROM', 'DAY_TO'],
  clientsByBrowser: ['DAY_FROM', 'DAY_TO'],
  clientsDeviceDaily: ['DAY_FROM', 'DAY_TO'],
  presenceCurrent: [],
  presenceLast24h: [],
  presenceDaily: ['DAY_FROM', 'DAY_TO'],
  presenceHeatmap: ['DAY_FROM', 'DAY_TO', 'Europe/Brussels'],
  anthropicConsumedSince: ['anthropic', 'DAY_FROM'],
  anthropicLast7Days: ['anthropic', 'DAY_TO'],
  anthropicBetween: ['anthropic', 'DAY_FROM', 'DAY_TO'],
};

const today = new Date().toISOString().slice(0, 10);
const from = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
const params = (name: ReadQueryName) =>
  SAMPLE_PARAMS[name].map((p) => (p === 'DAY_FROM' ? from : p === 'DAY_TO' ? today : p));

/** Identifiants de relation lus par une requête (après FROM / JOIN). */
function relationsOf(sql: string): string[] {
  const cleaned = sql.replace(/extract\s*\([^()]*\([^()]*\)[^()]*\)|extract\s*\([^()]*\)/gi, 'x');
  return [...cleaned.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z0-9_."]+)/gi)].map((m) => m[1]!);
}

describe('contrat : le site ne lit que les 12 vues', () => {
  it('chaque requête ne référence que public.monitoring_* du contrat, sans écriture', () => {
    const allowed = new Set(CONTRACT_VIEW_NAMES.map((v) => `public.${v}`));
    for (const [name, sql] of Object.entries(READ_QUERIES)) {
      const rels = relationsOf(sql).filter((r) => r !== 'last_events'); // sous-requête nommée
      for (const r of rels) {
        // Sous-requête : « FROM ( » ne capture rien d'autre que la parenthèse.
        expect(allowed.has(r), `${name} lit ${r}`).toBe(true);
      }
      expect(sql, name).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE|DROP|GRANT|COPY|CALL)\b/i);
      expect(sql, name).not.toMatch(/\bpg_(?!database_size)\w+/);
    }
  });

  it('chaque requête n’utilise que des colonnes du contrat', () => {
    const known = new Set<string>(Object.values(CONTRACT_VIEWS).flat());
    const sqlWords = new Set(
      'select from where and or as on by group order limit desc asc between coalesce sum count min max avg round distinct filter in is not null text date int float8 float timestamp time zone at extract isodow hour interval now date_trunc current_database pg_database_size last_events last_event event_type x day bytes public anthropic_usd'.split(
        ' ',
      ),
    );
    for (const [name, sql] of Object.entries(READ_QUERIES)) {
      const body = sql
        .replace(/'[^']*'/g, ' ')
        .replace(/\$\d+/g, ' ')
        .replace(/public\.monitoring_\w+/g, ' ');
      for (const w of body.match(/\b[a-z_][a-z0-9_]*\b/g) ?? []) {
        if (sqlWords.has(w) || known.has(w)) continue;
        // Alias de sortie déclarés par « AS alias ».
        if (new RegExp(`\\bAS\\s+${w}\\b`, 'i').test(sql)) continue;
        expect.fail(`${name} : identifiant hors contrat « ${w} »`);
      }
    }
  });

  it('chaque requête est une chaîne fixe paramétrée, et chaque paramètre est utilisé', () => {
    for (const [name, sql] of Object.entries(READ_QUERIES) as Array<[ReadQueryName, string]>) {
      expect(sql).not.toContain('${');
      const max = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      expect(SAMPLE_PARAMS[name].length, name).toBe(max);
    }
  });
});

describe('connexions', () => {
  it('TLS exigé et vérifié hors réseau privé', () => {
    expect(sslFor({ host: 'postgres.railway.internal', privateNetwork: true })).toBe(false);
    expect(sslFor({ host: 'db.example.test', privateNetwork: false })).toEqual({
      rejectUnauthorized: true,
      servername: 'db.example.test',
    });
    const c = loadConfig(testEnv('https://login.example.test/v2.0'));
    const cfg = poolConfig(
      { ...c.db.readonly, url: 'postgres://monitoring_reader:x@db.example.test:5432/app?sslmode=disable', host: 'db.example.test', privateNetwork: false },
      { readonly: true, statementTimeoutMs: 5000, max: 2, applicationName: 't' },
    );
    expect(cfg.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(cfg.options).toContain('default_transaction_read_only=on');
    expect(cfg.options).toContain('statement_timeout=5000');
  });
});

describe('base de développement du contrat', () => {
  let pool: pg.Pool;
  let repo: ReadRepository;
  beforeAll(() => {
    const c = loadConfig(testEnv('https://login.example.test/v2.0'));
    pool = createPool(c.db.readonly, { readonly: true, statementTimeoutMs: 5000, max: 2, applicationName: 'test' });
    repo = new ReadRepository(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('la connexion de lecture est en lecture seule : une écriture échoue', async () => {
    const ro = await pool.query<{ default_transaction_read_only: string }>('SHOW default_transaction_read_only');
    expect(ro.rows[0]!.default_transaction_read_only).toBe('on');
    await expect(pool.query("CREATE TEMP TABLE t_test (x int)")).rejects.toThrow(/read-only/);
    await expect(pool.query("INSERT INTO public.monitoring_meta VALUES (current_date)")).rejects.toThrow();
    // Même en forçant une transaction en écriture, le rôle n'a aucun droit d'écriture.
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ WRITE');
      await expect(client.query('INSERT INTO public.monitoring_meta VALUES (current_date)')).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('le rôle de lecture ne peut lire aucune table de PoppyTrip', async () => {
    await expect(pool.query('SELECT * FROM public.users')).rejects.toThrow(/permission denied/);
    await expect(pool.query('SELECT * FROM dev_fake.daily_counters')).rejects.toThrow(/permission denied/);
  });

  it.each(Object.keys(READ_QUERIES) as ReadQueryName[])('la requête %s fonctionne', async (name) => {
    const rows = await repo.rows(name, params(name));
    expect(Array.isArray(rows)).toBe(true);
  });

  it('les vues exposent exactement les colonnes du contrat', async () => {
    for (const view of CONTRACT_VIEW_NAMES) {
      const res = await pool.query(`SELECT * FROM public.${view} LIMIT 0`);
      expect(res.fields.map((f) => f.name), view).toEqual([...CONTRACT_VIEWS[view]]);
    }
  });

  it('les fausses données couvrent 120 jours', async () => {
    const rows = await repo.rows<{ day: string }>('dailyMetrics', [
      new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10),
      today,
    ]);
    expect(rows.length).toBeGreaterThanOrEqual(119);
    const devices = await repo.rows<{ device_type: string; sessions: number }>('clientsByDevice', [from, today]);
    const mobile = devices.find((d) => d.device_type === 'mobile')!.sessions;
    const total = devices.reduce((s, d) => s + d.sessions, 0);
    expect(mobile / total).toBeGreaterThan(0.5);
  });
});

describe('base vide', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    const admin = inject('dbUrls').admin;
    const adminRoot = new URL(admin);
    adminRoot.pathname = '/postgres';
    await setupDevDatabase(adminRoot.toString(), 'monitoring_test_empty', {
      recreate: true,
      only: (f) => !f.includes('seed'),
    });
    pool = new pg.Pool({ connectionString: devRoleUrl(adminRoot.toString(), 'monitoring_test_empty', 'monitoring_reader') });
  });
  afterAll(async () => {
    await pool.end();
  });

  it.each(Object.keys(READ_QUERIES) as ReadQueryName[])('%s ne lève aucune erreur sans données', async (name) => {
    const repo = new ReadRepository(pool);
    await expect(repo.rows(name, params(name))).resolves.toBeDefined();
  });
});
