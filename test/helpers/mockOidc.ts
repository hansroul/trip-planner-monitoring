import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

/**
 * Fournisseur OpenID Connect simulé pour les tests : découverte, JWKS et point de jeton qui
 * vérifie l'authentification du client et le vérificateur PKCE (S256), puis émet un jeton
 * d'identité RS256 dont les revendications sont réglables (émetteur, expiration, nonce…).
 */

export interface IssueOptions {
  codeChallenge: string;
  nonce: string;
  claims?: Record<string, unknown>;
  /** Signer avec une autre clé (signature invalide). */
  wrongKey?: boolean;
}

export interface MockOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  issueCode(opts: IssueOptions): string;
  close(): Promise<void>;
  tokenRequests: number;
}

export async function startMockOidc(clientId = 'test-client-id', clientSecret = 'test-client-secret-value'): Promise<MockOidc> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const other = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, IssueOptions>();
  let issuer = '';
  const state = { tokenRequests: 0 };

  const sign = async (opts: IssueOptions) => {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: issuer,
      aud: clientId,
      sub: 'sub-admin-0001',
      email: 'admin@example.com',
      iat: now,
      exp: now + 600,
      nonce: opts.nonce,
      ...opts.claims,
    };
    const key: CryptoKey = opts.wrongKey ? other.privateKey : privateKey;
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(key);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['pairwise'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      state.tokenRequests++;
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        void (async () => {
          const p = new URLSearchParams(body);
          let id = p.get('client_id');
          let secret = p.get('client_secret');
          const auth = req.headers.authorization;
          if (auth?.startsWith('Basic ')) {
            const [u, s] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
            id = decodeURIComponent(u ?? '');
            secret = decodeURIComponent(s ?? '');
          }
          if (id !== clientId || secret !== clientSecret) return json(401, { error: 'invalid_client' });
          const code = p.get('code') ?? '';
          const issued = codes.get(code);
          codes.delete(code);
          if (!issued || p.get('grant_type') !== 'authorization_code') return json(400, { error: 'invalid_grant' });
          const verifier = p.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (challenge !== issued.codeChallenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
          return json(200, {
            access_token: randomBytes(16).toString('hex'),
            token_type: 'Bearer',
            expires_in: 3600,
            id_token: await sign(issued),
          });
        })();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    issueCode(opts) {
      const code = randomBytes(16).toString('hex');
      codes.set(code, opts);
      return code;
    },
    get tokenRequests() {
      return state.tokenRequests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
