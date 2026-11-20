import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, isWeakSecret, loadConfig } from '../src/server/config.js';
import { ADMIN_EMAIL, TEST_PREFIX, testEnv, testPasswordHash } from './helpers/app.js';

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
    expect(c.admin.email).toBe(ADMIN_EMAIL);
    expect(c.admin.passwordHash.memory).toBe(19_456);
    expect(c.mainAppUrl).toBeNull();
    expect(loadConfig(testEnv({ MAIN_APP_URL: 'https://app.example.test/' })).mainAppUrl).toBe('https://app.example.test/');
    expect(c.anthropic.adminKey).toBeNull();
    expect(c.limits.dbSizeBytes).toBeNull();
  });

  it.each([
    'PUBLIC_BASE_URL',
    'ADMIN_PATH_PREFIX',
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD_HASH',
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

  it('exige une empreinte argon2id de mot de passe aux paramètres suffisants, jamais un mot de passe en clair', () => {
    const ok = testPasswordHash('peu-importe-ici');
    const weak = ok.replace('m=19456,t=2', 'm=4096,t=1');
    const argon2i = ok.replace('$argon2id$', '$argon2i$');
    const bcrypt = ['$2b$12$', 'a'.repeat(53)].join('');
    for (const value of ['mot-de-passe-en-clair', weak, argon2i, bcrypt]) {
      const p = problems(testEnv({ ADMIN_PASSWORD_HASH: value })).join();
      expect(p).toContain('ADMIN_PASSWORD_HASH');
      expect(p).not.toContain(value);
    }
  });

  it('exige une adresse e-mail valide et refuse une adresse d’exemple en production', () => {
    expect(problems(testEnv({ ADMIN_EMAIL: 'pas-une-adresse' })).join()).toContain('ADMIN_EMAIL');
    expect(problems(testEnv({ NODE_ENV: 'production' })).join()).toContain('ADMIN_EMAIL');
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
