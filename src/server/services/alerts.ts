import type pg from 'pg';
import type { Projection, CreditStatus } from '../../shared/calc.js';
import { writeAudit } from '../db/audit.js';

/**
 * Alertes par e-mail à ADMIN_EMAIL (désactivables avec ALERTS_ENABLED) :
 * - crédit Anthropic : une seule fois par seuil franchi (70 %, 90 % par défaut) ; une nouvelle
 *   recharge (empreinte des recharges différente) réarme l'alerte ;
 * - base et stockage : seuil d'occupation franchi ou saturation prévue à moins de N jours, une
 *   seule fois tant que la condition dure (réarmée quand elle disparaît).
 * L'état est mémorisé dans monitoring_app.alert_state.
 */
export interface Mailer {
  send(subject: string, text: string): Promise<void>;
}

export interface Candidate {
  key: string;
  active: boolean;
  /** Pour le crédit : empreinte des recharges. Une valeur différente réarme l'alerte. */
  armToken: string | null;
  subject: string;
  text: string;
}

export function creditCandidates(status: CreditStatus, thresholds: { warn: number; critical: number }, armToken: string): Candidate[] {
  if (!status.configured) return [];
  const pct = status.percentUsed;
  const desc = `Crédit Anthropic : ${pct.toFixed(1)} % utilisé (consommé ${status.consumedUsd.toFixed(2)} USD sur ${status.totalUsd.toFixed(2)} USD, restant ${status.remainingUsd.toFixed(2)} USD${status.daysLeft !== null ? `, environ ${status.daysLeft} jours restants` : ''}).`;
  return [
    { key: 'credit_warn', active: pct >= thresholds.warn, armToken, subject: `[Suivi PoppyTrip] Crédit Anthropic au-delà de ${thresholds.warn} %`, text: desc },
    {
      key: 'credit_critical',
      active: pct >= thresholds.critical,
      armToken,
      subject: `[Suivi PoppyTrip] Crédit Anthropic au-delà de ${thresholds.critical} % (critique)`,
      text: desc,
    },
  ];
}

export function storageCandidates(
  name: 'db' | 'storage',
  projection: Projection,
  t: { warn: number; critical: number; saturationDays: number },
): Candidate[] {
  if (projection.status === 'no_data') return [];
  const what = name === 'db' ? 'Base de données' : 'Stockage de fichiers';
  const pct = projection.percentUsed !== null ? projection.percentUsed * 100 : null;
  const text = `${what} : ${projection.current} octets${pct !== null ? ` (${pct.toFixed(1)} % de la limite)` : ''}${
    projection.daysLeft !== null ? `, saturation prévue dans environ ${projection.daysLeft} jours (${projection.saturationDay})` : ''
  }.`;
  return [
    { key: `${name}_warn`, active: pct !== null && pct >= t.warn, armToken: null, subject: `[Suivi PoppyTrip] ${what} au-delà de ${t.warn} %`, text },
    {
      key: `${name}_critical`,
      active: pct !== null && pct >= t.critical,
      armToken: null,
      subject: `[Suivi PoppyTrip] ${what} au-delà de ${t.critical} % (critique)`,
      text,
    },
    {
      key: `${name}_saturation`,
      active: projection.daysLeft !== null && projection.daysLeft <= t.saturationDays,
      armToken: null,
      subject: `[Suivi PoppyTrip] ${what} : saturation prévue dans moins de ${t.saturationDays} jours`,
      text,
    },
  ];
}

/** Applique les règles : renvoie les clés effectivement envoyées. */
export async function processAlerts(pool: pg.Pool, mailer: Mailer, candidates: Candidate[], now: Date): Promise<string[]> {
  const sent: string[] = [];
  const { rows } = await pool.query<{ alert_key: string; arm_token: string | null }>('SELECT alert_key, arm_token FROM monitoring_app.alert_state');
  const state = new Map(rows.map((r) => [r.alert_key, r.arm_token]));
  for (const c of candidates) {
    const known = state.has(c.key);
    if (!c.active) {
      // Condition disparue : l'alerte est réarmée (sauf crédit, réarmé par une recharge).
      if (known && c.armToken === null) await pool.query('DELETE FROM monitoring_app.alert_state WHERE alert_key = $1', [c.key]);
      continue;
    }
    if (known && state.get(c.key) === c.armToken) continue; // déjà envoyée pour ce seuil
    await mailer.send(c.subject, c.text);
    await pool.query(
      `INSERT INTO monitoring_app.alert_state (alert_key, fired_at, arm_token, context) VALUES ($1, $2, $3, $4)
       ON CONFLICT (alert_key) DO UPDATE SET fired_at = EXCLUDED.fired_at, arm_token = EXCLUDED.arm_token, context = EXCLUDED.context`,
      [c.key, now, c.armToken, JSON.stringify({ subject: c.subject })],
    );
    await writeAudit(pool, { event: 'alert_sent', outcome: 'success', details: { alert: c.key } });
    sent.push(c.key);
  }
  return sent;
}
