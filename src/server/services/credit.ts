import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { TopupView } from '../../shared/api.js';
import { creditStatus, isDay, type CreditStatus, type Day } from '../../shared/calc.js';
import { writeAudit } from '../db/audit.js';
import type { ReadRepository } from '../data/repository.js';

/** Saisie d'une recharge : date (pas dans le futur), montant USD (2 décimales), note facultative. */
export function topupSchema(today: Day) {
  return z
    .object({
      date: z
        .string()
        .refine(isDay, 'Date invalide')
        .refine((d) => d <= today, 'La date ne peut pas être dans le futur')
        .refine((d) => d >= '2000-01-01', 'Date invalide'),
      amountUsd: z
        .number()
        .positive('Le montant doit être positif')
        .max(1_000_000, 'Montant trop élevé')
        .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Deux décimales au plus'),
      note: z
        .string()
        .trim()
        .max(500, 'Note limitée à 500 caractères')
        .optional()
        .nullable()
        .transform((v) => (v ? v : null)),
    })
    .strict();
}
export type TopupInput = z.infer<ReturnType<typeof topupSchema>>;

interface TopupRow {
  id: string;
  topup_date: string;
  amount_usd: string;
  note: string | null;
  updated_at: Date;
}

const toView = (r: TopupRow): TopupView => ({
  id: Number(r.id),
  date: r.topup_date,
  amountUsd: Number(r.amount_usd),
  note: r.note,
  updatedAt: r.updated_at.toISOString(),
});

const COLS = `id, topup_date::text AS topup_date, amount_usd::text AS amount_usd, note, updated_at`;

export class TopupStore {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<TopupView[]> {
    const { rows } = await this.pool.query<TopupRow>(`SELECT ${COLS} FROM monitoring_app.credit_topups ORDER BY topup_date, id`);
    return rows.map(toView);
  }

  /** Chaque modification est écrite avec son entrée d'audit, dans la même transaction. */
  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  create(input: TopupInput, ip: string | undefined): Promise<TopupView> {
    return this.tx(async (c) => {
      const { rows } = await c.query<TopupRow>(
        `INSERT INTO monitoring_app.credit_topups (topup_date, amount_usd, note) VALUES ($1, $2, $3) RETURNING ${COLS}`,
        [input.date, input.amountUsd.toFixed(2), input.note],
      );
      const v = toView(rows[0]!);
      await writeAudit(c, { event: 'credit_topup_create', outcome: 'success', ip, details: { id: v.id, date: v.date, amount_usd: v.amountUsd } });
      return v;
    });
  }

  update(id: number, input: TopupInput, ip: string | undefined): Promise<TopupView | null> {
    return this.tx(async (c) => {
      const before = await c.query<TopupRow>(`SELECT ${COLS} FROM monitoring_app.credit_topups WHERE id = $1 FOR UPDATE`, [id]);
      if (!before.rows[0]) return null;
      const { rows } = await c.query<TopupRow>(
        `UPDATE monitoring_app.credit_topups SET topup_date = $2, amount_usd = $3, note = $4, updated_at = now()
         WHERE id = $1 RETURNING ${COLS}`,
        [id, input.date, input.amountUsd.toFixed(2), input.note],
      );
      const v = toView(rows[0]!);
      const old = toView(before.rows[0]);
      await writeAudit(c, {
        event: 'credit_topup_update',
        outcome: 'success',
        ip,
        details: { id, before: { date: old.date, amount_usd: old.amountUsd }, after: { date: v.date, amount_usd: v.amountUsd } },
      });
      return v;
    });
  }

  delete(id: number, ip: string | undefined): Promise<boolean> {
    return this.tx(async (c) => {
      const { rows } = await c.query<TopupRow>(`DELETE FROM monitoring_app.credit_topups WHERE id = $1 RETURNING ${COLS}`, [id]);
      if (!rows[0]) return false;
      const v = toView(rows[0]);
      await writeAudit(c, { event: 'credit_topup_delete', outcome: 'success', ip, details: { id, date: v.date, amount_usd: v.amountUsd } });
      return true;
    });
  }
}

/** Empreinte de l'ensemble des recharges : change à chaque ajout, correction ou suppression. */
export function topupsToken(topups: readonly TopupView[]): string {
  const h = createHash('sha256');
  for (const t of topups) h.update(`${t.id}|${t.date}|${t.amountUsd}|${t.updatedAt}\n`);
  return h.digest('hex').slice(0, 32);
}

/**
 * État du crédit : consommation = somme de cost_usd des lignes du fournisseur Anthropic depuis
 * la date de la première recharge.
 */
export async function computeCredit(
  repo: ReadRepository,
  topups: readonly TopupView[],
  label: string,
  today: Day,
  thresholds: { warn: number; critical: number },
): Promise<CreditStatus> {
  if (topups.length === 0) return creditStatus([], 0, 0, thresholds);
  const since = topups.map((t) => t.date).sort()[0]!;
  const [consumed, last7] = await Promise.all([
    repo.one<{ cost_usd: number }>('anthropicConsumedSince', [label, since]),
    repo.one<{ cost_usd: number }>('anthropicLast7Days', [label, today]),
  ]);
  return creditStatus(
    topups.map((t) => ({ date: t.date, amountUsd: t.amountUsd })),
    Number(consumed?.cost_usd ?? 0),
    Number(last7?.cost_usd ?? 0),
    thresholds,
  );
}
