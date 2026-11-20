import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';

/**
 * Faux PoppyTrip pour les tests : paire de clés Ed25519 propre au processus de test et
 * signature de jetons aux revendications réglables (émetteur, audience, expiration, nonce…).
 */
export const SSO_URL = 'https://app.example.test/api/monitoring/sso';
export const SSO_ISSUER = 'https://app.example.test';
export const ADMIN_ACCOUNT_ID = '7d4f3a2b-1c0e-4b5a-9f8e-6d7c5b4a3f21';

const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
export const SSO_PUBLIC_KEY_PEM = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

export interface SignOptions {
  nonce: string;
  audience: string;
  sub?: string;
  issuer?: string;
  typ?: string;
  /** Décalage (secondes) appliqué à iat et exp. */
  ageSeconds?: number;
  ttlSeconds?: number;
  wrongKey?: boolean;
  omit?: Array<'jti' | 'nonce' | 'sub'>;
}

export async function signSsoToken(o: SignOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000) - (o.ageSeconds ?? 0);
  const payload: Record<string, unknown> = { nonce: o.nonce };
  if (o.omit?.includes('nonce')) delete payload.nonce;
  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', typ: o.typ ?? 'poppytrip-monitoring+jwt' })
    .setIssuer(o.issuer ?? SSO_ISSUER)
    .setAudience(o.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + (o.ttlSeconds ?? 60));
  if (!o.omit?.includes('sub')) jwt = jwt.setSubject(o.sub ?? ADMIN_ACCOUNT_ID);
  if (!o.omit?.includes('jti')) jwt = jwt.setJti(randomBytes(16).toString('base64url'));
  return jwt.sign((o.wrongKey ? otherKeys : keys).privateKey);
}

/** Jeton HS256 « signé » avec la clé publique comme secret (attaque par confusion d'algorithme). */
export async function signHs256WithPublicKey(nonce: string, audience: string): Promise<string> {
  return new SignJWT({ nonce })
    .setProtectedHeader({ alg: 'HS256', typ: 'poppytrip-monitoring+jwt' })
    .setIssuer(SSO_ISSUER)
    .setAudience(audience)
    .setSubject(ADMIN_ACCOUNT_ID)
    .setJti('x')
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(new TextEncoder().encode(SSO_PUBLIC_KEY_PEM));
}
