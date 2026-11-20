import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Mot de passe de l'administrateur : empreinte argon2id au format PHC
 * ($argon2id$v=19$m=…,t=…,p=…$sel$empreinte), soit copiée telle quelle depuis la colonne
 * password_hash du compte PoppyTrip (même format), soit produite par `npm run hash-password`.
 * Calcul confié à node:crypto (argon2 natif de Node), comparaison à temps constant.
 */

const PHC_RE = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;
export const MAX_PASSWORD_LENGTH = 1024;

export interface PasswordHash {
  memory: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  hash: Buffer;
}

/** Lève une erreur si l'empreinte n'est pas un argon2id aux paramètres raisonnables. */
export function parsePasswordHash(phc: string): PasswordHash {
  const m = PHC_RE.exec(phc.trim());
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
  return { memory, passes, parallelism, salt, hash };
}

function derive(password: string, p: Omit<PasswordHash, 'hash'>, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: p.salt,
        parallelism: p.parallelism,
        tagLength: length,
        memory: p.memory,
        passes: p.passes,
      },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function verifyPassword(expected: PasswordHash, password: string): Promise<boolean> {
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  const derived = await derive(password, expected, expected.hash.length);
  return timingSafeEqual(derived, expected.hash);
}

/** Paramètres identiques à ceux de PoppyTrip (bibliothèque argon2, valeurs par défaut). */
export async function hashPassword(password: string): Promise<string> {
  const params = { memory: 65_536, passes: 3, parallelism: 4, salt: randomBytes(16) };
  const hash = await derive(password, params, 32);
  const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(params.salt)}$${b64(hash)}`;
}
