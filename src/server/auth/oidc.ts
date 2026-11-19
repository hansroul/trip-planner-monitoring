import * as client from 'openid-client';

/**
 * OpenID Connect (bibliothèque openid-client, aucune cryptographie maison) :
 * flux « authorization code » avec PKCE (S256), state et nonce vérifiés, signature et
 * revendications du jeton d'identité vérifiées (émetteur, audience, expiration…).
 *
 * Comptes Microsoft personnels : OIDC_ISSUER est l'émetteur publié par l'autorité « consumers »
 * (voir README). La découverte se fait sur l'émetteur lui-même, qui doit correspondre exactement.
 */

export interface StartedLogin {
  url: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcProvider {
  start(): Promise<StartedLogin>;
  /** Échange le code et renvoie les revendications validées du jeton d'identité. */
  finish(callbackUrl: URL, checks: { state: string; nonce: string; codeVerifier: string }): Promise<Record<string, unknown>>;
}

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function createOidcProvider(settings: OidcSettings, opts: { allowInsecureForTests?: boolean } = {}): OidcProvider {
  let configPromise: Promise<client.Configuration> | null = null;

  const getConfig = () => {
    configPromise ??= client
      .discovery(
        new URL(settings.issuer),
        settings.clientId,
        settings.clientSecret,
        undefined,
        {
          // Vérification de la signature du jeton d'identité (désactivée par défaut dans
          // openid-client pour un jeton reçu directement du point de jeton) : exigée ici.
          execute: opts.allowInsecureForTests
            ? [client.enableNonRepudiationChecks, client.allowInsecureRequests]
            : [client.enableNonRepudiationChecks],
        },
      )
      .catch((err: unknown) => {
        configPromise = null; // nouvel essai au prochain appel
        throw err;
      });
    return configPromise;
  };

  return {
    async start() {
      const config = await getConfig();
      const codeVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const state = client.randomState();
      const nonce = client.randomNonce();
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: settings.redirectUri,
        scope: 'openid email profile',
        response_type: 'code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
        prompt: 'select_account',
      });
      return { url, state, nonce, codeVerifier };
    },

    async finish(callbackUrl, checks) {
      const config = await getConfig();
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('Jeton d’identité absent');
      return { ...claims } as Record<string, unknown>;
    },
  };
}
