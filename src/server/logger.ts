import type { FastifyServerOptions } from 'fastify';
export interface LogStream {
  write(msg: string): void;
}

/**
 * Journalisation : jamais de jeton, de cookie, de code d'autorisation, de state, ni de clé.
 * - Les en-têtes sensibles sont masqués (redact).
 * - L'URL est journalisée SANS sa chaîne de requête (le retour de PoppyTrip y porte le jeton et le state) et
 *   le préfixe d'administration est remplacé par « /[admin] ».
 */
export const REDACTED = '[masqué]';

const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|passwd|api[-_]?key|admin[-_]?key|code[-_]?verifier|nonce|state|^code$|session)/i;

export function stripUrl(url: string, basePath: string): string {
  const path = url.split('?')[0] ?? '';
  return basePath && path.startsWith(basePath) ? `/[admin]${path.slice(basePath.length)}` : path;
}

/** Copie d'un objet où toute clé sensible est masquée (utile pour les détails d'erreur). */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactObject(v, depth + 1);
  }
  return out;
}

/** Résumé d'erreur sûr : nom, code et message (tronqué), jamais la réponse brute d'un tiers. */
export function safeError(err: unknown): { name: string; code?: string; message: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: err.name,
      ...(typeof code === 'string' ? { code } : {}),
      message: err.message.replace(/(sk-ant-[A-Za-z0-9_-]+)/g, REDACTED).slice(0, 300),
    };
  }
  return { name: 'UnknownError', message: 'erreur inconnue' };
}

export function loggerOptions(level: string, basePath: string, stream?: LogStream): FastifyServerOptions['logger'] {
  return {
    level,
    ...(stream ? { stream } : {}),
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        'headers.cookie',
        'headers.authorization',
      ],
      censor: REDACTED,
    },
    serializers: {
      req(req: { method?: string; url?: string; ip?: string }) {
        return { method: req.method, url: stripUrl(req.url ?? '', basePath) };
      },
      res(res: { statusCode?: number }) {
        return { statusCode: res.statusCode };
      },
    },
  };
}
