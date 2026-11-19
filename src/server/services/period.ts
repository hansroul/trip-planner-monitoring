import { z } from 'zod';
import { addDays, daysBetween, isDay, todayIn, type Day } from '../../shared/calc.js';
import { MAX_PERIOD_DAYS, type Period } from '../../shared/api.js';

const querySchema = z
  .object({
    from: z.string().refine(isDay).optional(),
    to: z.string().refine(isDay).optional(),
    days: z.coerce.number().int().min(1).max(MAX_PERIOD_DAYS).optional(),
  })
  .strict();

export class PeriodError extends Error {}

/**
 * Période demandée : `days` (7, 30, 90…) jusqu'à aujourd'hui, ou plage `from`–`to`.
 * Plage maximale de 2 ans, jamais dans le futur. Par défaut : 30 derniers jours.
 */
export function parsePeriod(query: unknown, timezone: string, now: Date = new Date()): Period {
  const parsed = querySchema.safeParse(query ?? {});
  if (!parsed.success) throw new PeriodError('Période invalide');
  const q = parsed.data;
  const today = todayIn(timezone, now);
  let from: Day;
  let to: Day;
  if (q.from || q.to) {
    if (!q.from || !q.to || q.days !== undefined) throw new PeriodError('Période invalide');
    from = q.from;
    to = q.to > today ? today : q.to;
  } else {
    to = today;
    from = addDays(today, -((q.days ?? 30) - 1));
  }
  if (from > to) throw new PeriodError('Début après la fin');
  const days = daysBetween(from, to) + 1;
  if (days > MAX_PERIOD_DAYS) throw new PeriodError('Période limitée à 2 ans');
  return { from, to, days, today, timezone };
}
