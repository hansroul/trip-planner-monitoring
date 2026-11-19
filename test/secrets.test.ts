import { describe, expect, it } from 'vitest';
import { listFiles, scanFiles, scanText } from '../scripts/check-secrets.mjs';

type Finding = { file: string; line: number; rule: string };

describe('détection de secrets', () => {
  it('aucun fichier versionné ne ressemble à un secret ni ne contient d’adresse réelle', () => {
    const files = listFiles(false) as string[];
    expect(files.length).toBeGreaterThan(0);
    const findings = scanFiles(files) as Finding[];
    expect(findings).toEqual([]);
  });

  it('détecte les secrets typiques', () => {
    const samples: Array<[string, string]> = [
      ['private-key', ['-----BEGIN', 'PRIVATE KEY-----'].join(' RSA ')],
      ['anthropic-key', `${['sk', 'ant', 'admin01'].join('-')}-${'Ab3'.repeat(10)}`],
      ['jwt', ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXZhbHVl'].join('.')],
      ['url-credentials', `postgres://user:${'Xk9'.repeat(4)}@db.internal:5432/app`],
      ['secret-assignment', `SESSION_SECRET=${'q8Z'.repeat(8)}`],
      ['email-address', ['quelquun', 'hotmail.com'].join('@')],
    ];
    for (const [rule, text] of samples) {
      expect((scanText(text, 'x') as Finding[]).map((f) => f.rule), rule).toContain(rule);
    }
  });

  it('accepte les valeurs fictives et les adresses d’exemple', () => {
    for (const text of [
      'SESSION_SECRET=fictif-a-remplacer',
      'DATABASE_URL_APP=postgres://monitoring_app_rw:dev-only-app-pw@localhost:5432/poppytrip_dev',
      'ADMIN_EMAIL=admin@example.com',
      'const x = process.env.SESSION_SECRET;',
    ]) {
      expect(scanText(text, 'x'), text).toEqual([]);
    }
  });

  it('refuse un fichier .env versionné', () => {
    const findings = scanFiles(['.env', '.env.production', '.env.example'], () => '') as Finding[];
    expect(findings.map((f) => f.file)).toEqual(['.env', '.env.production']);
  });
});
