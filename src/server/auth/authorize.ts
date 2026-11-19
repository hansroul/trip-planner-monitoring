import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Autorisation stricte d'un seul compte :
 * - l'adresse du jeton doit correspondre EXACTEMENT (insensible à la casse) à ADMIN_EMAIL ;
 * - si ADMIN_OIDC_SUB est configuré, l'identifiant stable (sub) doit aussi correspondre :
 *   on ne se fie jamais à l'adresse seule dès que l'identifiant stable est connu.
 */

export type AuthorizationResult =
  | { ok: true; sub: string; subConfigured: boolean }
  | { ok: false; reason: 'email_missing' | 'email_mismatch' | 'sub_missing' | 'sub_mismatch'; email: string | null };

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function tokenEmail(claims: Record<string, unknown>): string | null {
  // Comptes Microsoft personnels : « email » (portée email). À défaut, preferred_username, qui
  // est l'adresse de connexion du compte. Jamais suffisant seul quand ADMIN_OIDC_SUB est défini.
  const v = typeof claims.email === 'string' ? claims.email : claims.preferred_username;
  return typeof v === 'string' && v.includes('@') ? v.trim().toLowerCase() : null;
}

export function authorizeClaims(
  claims: Record<string, unknown>,
  admin: { email: string; sub?: string | undefined },
): AuthorizationResult {
  const email = tokenEmail(claims);
  if (!email) return { ok: false, reason: 'email_missing', email: null };
  if (!safeEqual(email, admin.email.trim().toLowerCase())) return { ok: false, reason: 'email_mismatch', email };
  const sub = typeof claims.sub === 'string' && claims.sub.length > 0 ? claims.sub : null;
  if (!sub) return { ok: false, reason: 'sub_missing', email };
  if (admin.sub !== undefined) {
    if (!safeEqual(sub, admin.sub)) return { ok: false, reason: 'sub_mismatch', email };
    return { ok: true, sub, subConfigured: true };
  }
  return { ok: true, sub, subConfigured: false };
}
