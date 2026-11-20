import { createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import { jwtVerify } from 'jose';

/**
 * Connexion avec le compte PoppyTrip (contrat : docs/monitoring-contract.md de PoppyTrip,
 * « Connexion au site de suivi »). PoppyTrip redemande l'e-mail et le mot de passe, vérifie
 * qu'il s'agit du compte autorisé, puis renvoie ici avec un jeton signé Ed25519 :
 *   en-tête  : alg EdDSA, typ « poppytrip-monitoring+jwt »
 *   iss      : origine de PoppyTrip (celle de POPPYTRIP_SSO_URL)
 *   aud      : origine de ce site (PUBLIC_BASE_URL)
 *   sub      : identifiant du compte (comparé à ADMIN_ACCOUNT_ID)
 *   nonce    : celui de la tentative de connexion (lié au cookie de flux, usage unique)
 *   iat, exp : 60 secondes
 * La signature et les revendications sont vérifiées par la bibliothèque jose ; ce site ne lit
 * jamais la table users de PoppyTrip et ne reçoit aucune donnée personnelle.
 */
export const SSO_TOKEN_TYPE = 'poppytrip-monitoring+jwt';
const MAX_TOKEN_AGE = '2m';
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface StartedLogin {
  url: URL;
  state: string;
  nonce: string;
}

export interface IdentityProvider {
  start(): StartedLogin;
  /** Vérifie le jeton et renvoie l'identifiant du compte (sub). Lève une erreur sinon. */
  finish(token: string, expectedNonce: string): Promise<string>;
}

export interface SsoSettings {
  loginUrl: string;
  issuer: string;
  audience: string;
  publicKeyPem: string;
}

export function parseEd25519PublicKey(pem: string): KeyObject {
  // createPublicKey accepte aussi une clé PRIVÉE (et en déduit la publique) : refusée ici, la clé
  // privée de PoppyTrip ne doit jamais se trouver dans la configuration de ce site.
  if (!/^-----BEGIN PUBLIC KEY-----/.test(pem.trim())) throw new Error('Clé publique PEM attendue');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Clé publique Ed25519 attendue');
  return key;
}

export function createSsoProvider(settings: SsoSettings): IdentityProvider {
  const key = parseEd25519PublicKey(settings.publicKeyPem);
  return {
    start() {
      const state = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      const url = new URL(settings.loginUrl);
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      return { url, state, nonce };
    },

    async finish(token, expectedNonce) {
      if (token.length > 4096 || !TOKEN_RE.test(token)) throw new Error('Jeton mal formé');
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['EdDSA'],
        typ: SSO_TOKEN_TYPE,
        issuer: settings.issuer,
        audience: settings.audience,
        maxTokenAge: MAX_TOKEN_AGE,
        clockTolerance: 30,
        requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti', 'nonce'],
      });
      if (payload.nonce !== expectedNonce) throw new Error('nonce invalide');
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('sub manquant');
      return payload.sub;
    },
  };
}
