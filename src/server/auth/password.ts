import argon2 from 'argon2';

/**
 * Mot de passe de l'administrateur : empreinte argon2id au format PHC
 * ($argon2id$v=19$m=…,t=…,p=…$sel$empreinte), soit copiée telle quelle depuis la colonne
 * password_hash du compte PoppyTrip (même format), soit produite par `npm run hash-password`.
 * Calcul et comparaison confiés à la bibliothèque argon2, la même que PoppyTrip.
 */

const PHC_RE = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;
export const MAX_PASSWORD_LENGTH = 1024;

export interface PasswordHash {
  phc: string;
  memory: number;
  passes: number;
  parallelism: number;
}

/** Lève une erreur si l'empreinte n'est pas un argon2id aux paramètres raisonnables. */
export function parsePasswordHash(value: string): PasswordHash {
  const phc = value.trim();
  const m = PHC_RE.exec(phc);
  if (!m) throw new Error('empreinte argon2id (format PHC) attendue');
  const [memory, passes, parallelism] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const salt = Buffer.from(m[4]!, 'base64');
  const hash = Buffer.from(m[5]!, 'base64');
  // Minimums OWASP pour argon2id (19 Mio, 2 passes) ; plafonds pour éviter qu'une erreur de
  // configuration ne rende chaque tentative de connexion ruineuse.
  if (memory < 19_456 || memory > 1_048_576) throw new Error('paramètre m hors limites');
  if (passes < 2 || passes > 10) throw new Error('paramètre t hors limites');
  if (parallelism < 1 || parallelism > 16) throw new Error('paramètre p hors limites');
  if (salt.length < 8 || hash.length < 16) throw new Error('sel ou empreinte trop courts');
  return { phc, memory, passes, parallelism };
}

export async function verifyPassword(expected: PasswordHash, password: string): Promise<boolean> {
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await argon2.verify(expected.phc, password);
  } catch {
    return false;
  }
}

/** Paramètres par défaut de la bibliothèque, identiques à PoppyTrip (m=65536, t=3, p=4). */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}
