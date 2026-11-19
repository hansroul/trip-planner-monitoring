import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, isWeakSecret, loadConfig } from '../src/server/config.js';
import { TEST_ORIGIN, TEST_PREFIX, testEnv } from './helpers/app.js';

const ISSUER = 'https://login.example.test/tenant/v2.0';
const strongSecret = () => randomBytes(48).toString('base64');

function problems(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).problems;
  }
}

describe('configuration', () => {
  it('accepte une configuration complète', () => {
    const c = loadConfig(testEnv(ISSUER));
    expect(c.basePath).toBe(`/${TEST_PREFIX}`);
    expect(c.admin.email).toBe('admin@example.com');
    expect(c.anthropic.adminKey).toBeNull();
    expect(c.limits.dbSizeBytes).toBeNull();
  });

  it.each([
    'PUBLIC_BASE_URL',
    'ADMIN_PATH_PREFIX',
    'OIDC_ISSUER',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_REDIRECT_URI',
    'ADMIN_EMAIL',
    'SESSION_SECRET',
    'DATABASE_URL_READONLY',
    'DATABASE_URL_APP',
    'MAIN_APP_URL',
  ])('refuse de démarrer sans %s', (name) => {
    const env = testEnv(ISSUER);
    delete env[name];
    expect(problems(env).join('\n')).toContain(name);
  });

  it('refuse un secret de session de moins de 32 octets', () => {
    const short = randomBytes(16).toString('hex').slice(0, 31); // 31 octets aléatoires
    expect(problems(testEnv(ISSUER, { SESSION_SECRET: short })).join()).toContain('SESSION_SECRET');
    expect(problems(testEnv(ISSUER, { SESSION_SECRET: 'changeme-changeme-changeme-changeme-1234' })).join()).toContain(
      'SESSION_SECRET',
    );
    expect(problems(testEnv(ISSUER, { SESSION_SECRET: 'a'.repeat(64) })).join()).toContain('SESSION_SECRET');
    expect(isWeakSecret(strongSecret())).toBeNull();
  });

  it('exige HTTPS pour l’URL publique en production', () => {
    const env = testEnv(ISSUER, {
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'http://monitoring.example.test',
      OIDC_REDIRECT_URI: `http://monitoring.example.test/${TEST_PREFIX}/auth/callback`,
      OIDC_CLIENT_SECRET: strongSecret(),
    });
    expect(problems(env).join()).toContain('HTTPS');
  });

  it('refuse un préfixe d’administration devinable', () => {
    for (const prefix of ['admin', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'exemple-a-generer-0123456789abcdef', 'with/slash-0123456789abcdefgh']) {
      const env = testEnv(ISSUER, {
        ADMIN_PATH_PREFIX: prefix,
        OIDC_REDIRECT_URI: `${TEST_ORIGIN}/${prefix}/auth/callback`,
      });
      expect(problems(env).join()).toContain('ADMIN_PATH_PREFIX');
    }
  });

  it('exige une URI de redirection cohérente avec le préfixe', () => {
    expect(problems(testEnv(ISSUER, { OIDC_REDIRECT_URI: `${TEST_ORIGIN}/autre/auth/callback` })).join()).toContain(
      'OIDC_REDIRECT_URI',
    );
  });

  it('refuse les rôles de base inattendus et la DATABASE_URL de PoppyTrip', () => {
    const main = 'postgres://poppytrip:fictif-motdepasse@db.example.test:5432/app';
    expect(problems(testEnv(ISSUER, { DATABASE_URL_READONLY: main })).join()).toContain('monitoring_reader');
    const env = testEnv(ISSUER);
    env.DATABASE_URL = env.DATABASE_URL_READONLY;
    expect(problems(env).join()).toContain('DATABASE_URL');
  });

  it('exige la configuration SMTP quand les alertes sont activées', () => {
    expect(problems(testEnv(ISSUER, { ALERTS_ENABLED: 'true' })).join()).toContain('SMTP_HOST');
  });

  it('refuse une clé Anthropic qui n’est pas une clé d’administration', () => {
    const p = problems(testEnv(ISSUER, { ANTHROPIC_ADMIN_KEY: 'pas-une-cle-admin' })).join();
    expect(p).toContain('ANTHROPIC_ADMIN_KEY');
    expect(p).toContain('ANTHROPIC_API_BASE_URL');
  });

  it('ne recopie jamais la valeur d’une variable dans le message d’erreur', () => {
    const secret = 'court-mais-tres-secret';
    const msg = problems(testEnv(ISSUER, { SESSION_SECRET: secret })).join();
    expect(msg).not.toContain(secret);
  });
});
