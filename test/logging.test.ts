import { describe, expect, it } from 'vitest';
import { REDACTED, redactObject, safeError, stripUrl } from '../src/server/logger.js';
import { BASE, cookieHeader, createTestApp, login, TEST_PREFIX } from './helpers/app.js';

describe('journaux', () => {
  it('ne contiennent ni cookie, ni jeton, ni state, ni jeton CSRF, ni préfixe', async () => {
    const lines: string[] = [];
    const t = await createTestApp({
      env: { LOG_LEVEL: 'trace' },
      logStream: { write: (l: string) => void lines.push(l) },
    });
    try {
      const { sessionCookie } = await login(t);
      const s = await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) });
      const csrf = s.json().csrfToken as string;
      await t.app.inject({ url: `${BASE}/auth/callback?token=TOKEN-SECRET-123&state=STATE-SECRET-456` });
      const log = lines.join('\n');
      expect(log.length).toBeGreaterThan(0);
      expect(log).not.toContain(sessionCookie!);
      expect(log).not.toContain(csrf);
      expect(log).not.toContain('TOKEN-SECRET-123');
      expect(log).not.toContain('STATE-SECRET-456');
      expect(log).not.toContain(TEST_PREFIX);
      expect(log).not.toContain(t.config.sessionSecret);
      expect(log).toContain('/[admin]/auth/callback');
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
