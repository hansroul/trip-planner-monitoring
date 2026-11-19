import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDACTED, redactObject, safeError, stripUrl } from '../src/server/logger.js';
import { BASE, cookieHeader, createTestApp, login, TEST_PREFIX } from './helpers/app.js';
import { startMockOidc, type MockOidc } from './helpers/mockOidc.js';

let mock: MockOidc;
beforeAll(async () => {
  mock = await startMockOidc();
});
afterAll(async () => {
  await mock.close();
});

describe('journaux', () => {
  it('ne contiennent ni cookie, ni code, ni state, ni jeton CSRF, ni préfixe', async () => {
    const lines: string[] = [];
    const t = await createTestApp(mock, {
      env: { LOG_LEVEL: 'trace' },
      logStream: { write: (l: string) => void lines.push(l) },
    });
    try {
      const { sessionCookie } = await login(t, mock);
      const s = await t.app.inject({ url: `${BASE}/api/session`, headers: cookieHeader(sessionCookie!) });
      const csrf = s.json().csrfToken as string;
      await t.app.inject({ url: `${BASE}/auth/callback?code=CODE-SECRET-123&state=STATE-SECRET-456` });
      const log = lines.join('\n');
      expect(log.length).toBeGreaterThan(0);
      expect(log).not.toContain(sessionCookie!);
      expect(log).not.toContain(csrf);
      expect(log).not.toContain('CODE-SECRET-123');
      expect(log).not.toContain('STATE-SECRET-456');
      expect(log).not.toContain(TEST_PREFIX);
      expect(log).not.toContain(t.config.sessionSecret);
      expect(log).not.toContain(t.config.oidc.clientSecret);
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
