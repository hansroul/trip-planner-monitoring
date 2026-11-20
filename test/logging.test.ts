import { describe, expect, it } from 'vitest';
import { REDACTED, redactObject, safeError, stripUrl } from '../src/server/logger.js';
import { ADMIN_EMAIL, BASE, cookieHeader, createTestApp, login, TEST_PREFIX } from './helpers/app.js';

describe('journaux', () => {
  it('ne contiennent ni cookie, ni mot de passe, ni e-mail, ni jeton de formulaire ou CSRF, ni préfixe', async () => {
    const lines: string[] = [];
    const t = await createTestApp({
      env: { LOG_LEVEL: 'trace' },
      logStream: { write: (l: string) => void lines.push(l) },
    });
    try {
      const { sessionCookie } = await login(t);
      const s = await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) });
      const csrf = s.json().csrfToken as string;
      const refused = await login(t, { password: 'mot-de-passe-journal-alpha', formToken: 'jeton-formulaire-journal' });
      expect(refused.statusCode).toBe(403);
      await login(t, { password: 'mot-de-passe-journal-beta' });
      const log = lines.join('\n');
      expect(log.length).toBeGreaterThan(0);
      expect(log).not.toContain(sessionCookie!);
      expect(log).not.toContain(csrf);
      expect(log).not.toContain('mot-de-passe-journal-beta');
      expect(log).not.toContain('mot-de-passe-journal-alpha');
      expect(log).not.toContain('jeton-formulaire-journal');
      expect(log).not.toContain(ADMIN_EMAIL);
      expect(log).not.toContain(TEST_PREFIX);
      expect(log).not.toContain(t.config.sessionSecret);
      expect(log).toContain('/[admin]/auth/login');
    } finally {
      await t.close();
    }
  });

  it('masque les clés sensibles et les clés Anthropic dans les erreurs', () => {
    expect(redactObject({ token: 'a', nested: { password: 'b', ok: 1 }, list: [{ apiKey: 'c' }] })).toEqual({
      token: REDACTED,
      nested: { password: REDACTED, ok: 1 },
      list: [{ apiKey: REDACTED }],
    });
    const fakeKey = ['sk', 'ant', 'admin01', 'AbCdEfGhIjKlMnOpQrStUv'].join('-');
    expect(safeError(new Error(`refusé pour ${fakeKey}`)).message).not.toContain(fakeKey);
    expect(stripUrl('/abc/auth/callback?code=1', '/abc')).toBe('/[admin]/auth/callback');
  });
});
