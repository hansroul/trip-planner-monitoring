import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, isWeakSecret, loadConfig } from '../src/server/config.js';
import { generateKeyPairSync } from 'node:crypto';
import { TEST_ORIGIN, TEST_PREFIX, testEnv } from './helpers/app.js';
import { ADMIN_ACCOUNT_ID } from './helpers/mockSso.js';

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
    const c = loadConfig(testEnv());
    expect(c.basePath).toBe(`/${TEST_PREFIX}`);
    expect(c.admin.accountId).toBe(ADMIN_ACCOUNT_ID);
    expect(c.sso.issuer).toBe('https://app.example.test');
    expect(c.sso.audience).toBe(TEST_ORIGIN);
    expect(c.sso.callbackUrl).toBe(`${TEST_ORIGIN}/${TEST_PREFIX}/auth/callback`);
    expect(c.mainAppUrl).toBe('https://app.example.test/');
    expect(c.anthropic.adminKey).toBeNull();
    expect(c.limits.dbSizeBytes).toBeNull();
  });

  it.each([
    'PUBLIC_BASE_URL',
    'ADMIN_PATH_PREFIX',
    'POPPYTRIP_SSO_URL',
    'POPPYTRIP_SSO_PUBLIC_KEY',
    'ADMIN_ACCOUNT_ID',
    'SESSION_SECRET',
    'DATABASE_URL_READONLY',
    'DATABASE_URL_APP',
  ])('refuse de démarrer sans %s', (name) => {
    const env = testEnv();
    delete env[name];
    expect(problems(env).join('\n')).toContain(name);
  });

  it('refuse un secret de session de moins de 32 octets', () => {
    const short = randomBytes(16).toString('hex').slice(0, 31); // 31 octets aléatoires
    expect(problems(testEnv({ SESSION_SECRET: short })).join()).toContain('SESSION_SECRET');
    expect(problems(testEnv({ SESSION_SECRET: 'changeme-changeme-changeme-changeme-1234' })).join()).toContain(
      'SESSION_SECRET',
    );
    expect(problems(testEnv({ SESSION_SECRET: 'a'.repeat(64) })).join()).toContain('SESSION_SECRET');
    expect(isWeakSecret(strongSecret())).toBeNull();
  });

  it('exige HTTPS pour l’URL publique en production', () => {
    const env = testEnv({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'http://monitoring.example.test',
    });
    expect(problems(env).join()).toContain('HTTPS');
  });

  it('refuse un préfixe d’administration devinable', () => {
    for (const prefix of ['admin', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'exemple-a-generer-0123456789abcdef', 'with/slash-0123456789abcdefgh']) {
      const env = testEnv({
        ADMIN_PATH_PREFIX: prefix,
      });
      expect(problems(env).join()).toContain('ADMIN_PATH_PREFIX');
    }
  });

  it('exige une vraie clé publique Ed25519 de PoppyTrip et un identifiant de compte', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    for (const key of ['pas-une-cle', rsa, ed]) {
      expect(problems(testEnv({ POPPYTRIP_SSO_PUBLIC_KEY: key })).join()).toContain('POPPYTRIP_SSO_PUBLIC_KEY');
    }
    expect(problems(testEnv({ ADMIN_ACCOUNT_ID: 'admin@example.com' })).join()).toContain('ADMIN_ACCOUNT_ID');
  });

  it('exige HTTPS pour PoppyTrip en production', () => {
    const env = testEnv({ NODE_ENV: 'production', POPPYTRIP_SSO_URL: 'http://app.example.test/api/monitoring/sso' });
    expect(problems(env).join()).toContain('POPPYTRIP_SSO_URL');
  });

  it('refuse les rôles de base inattendus et la DATABASE_URL de PoppyTrip', () => {
    const main = 'postgres://poppytrip:fictif-motdepasse@db.example.test:5432/app';
    expect(problems(testEnv({ DATABASE_URL_READONLY: main })).join()).toContain('monitoring_reader');
    const env = testEnv();
    env.DATABASE_URL = env.DATABASE_URL_READONLY;
    expect(problems(env).join()).toContain('DATABASE_URL');
  });

  it('exige la configuration SMTP quand les alertes sont activées', () => {
    const p = problems(testEnv({ ALERTS_ENABLED: 'true' })).join();
    expect(p).toContain('SMTP_HOST');
    expect(p).toContain('ALERT_EMAIL_TO');
  });

  it('refuse une clé Anthropic qui n’est pas une clé d’administration', () => {
    const p = problems(testEnv({ ANTHROPIC_ADMIN_KEY: 'pas-une-cle-admin' })).join();
    expect(p).toContain('ANTHROPIC_ADMIN_KEY');
    expect(p).toContain('ANTHROPIC_API_BASE_URL');
  });

  it('ne recopie jamais la valeur d’une variable dans le message d’erreur', () => {
    const secret = 'court-mais-tres-secret';
    const msg = problems(testEnv({ SESSION_SECRET: secret })).join();
    expect(msg).not.toContain(secret);
  });
});
