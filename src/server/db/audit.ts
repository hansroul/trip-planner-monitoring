import type pg from 'pg';
import { redactObject } from '../logger.js';

export type AuditEvent =
  | 'login'
  | 'logout'
  | 'credit_topup_create'
  | 'credit_topup_update'
  | 'credit_topup_delete'
  | 'alert_sent';

export type AuditOutcome = 'success' | 'refused' | 'error';

/** Préfixe réseau seulement (/24 en IPv4, /48 en IPv6) : jamais l'adresse complète. */
export function ipPrefix(ip: string | undefined): string | null {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
    const p = v4.split('.');
    return `${p[0]}.${p[1]}.${p[2]}.0/24`;
  }
  if (ip.includes(':')) {
    const groups = ip.split(':').filter((g) => g !== '').slice(0, 3);
    return `${groups.join(':')}::/48`;
  }
  return null;
}

/** Adresse masquée (« j***@o***.com ») : jamais l'adresse complète d'un tiers dans l'audit. */
export function maskEmail(email: unknown): string | null {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const [local, domain] = email.trim().toLowerCase().split('@') as [string, string];
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***${tld}`;
}

export interface AuditEntry {
  event: AuditEvent;
  outcome: AuditOutcome;
  ip?: string | undefined;
  details?: Record<string, unknown>;
}

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export async function writeAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.query('INSERT INTO monitoring_app.audit_log (event, outcome, ip_prefix, details) VALUES ($1, $2, $3, $4)', [
    entry.event,
    entry.outcome,
    ipPrefix(entry.ip),
    JSON.stringify(redactObject(entry.details ?? {})),
  ]);
}
