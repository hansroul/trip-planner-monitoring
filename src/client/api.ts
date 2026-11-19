/**
 * Appels à l'API. Les URL sont RELATIVES : la page sert une balise <base> injectée par le
 * serveur avec le préfixe d'administration ; le front n'en contient aucun.
 */
let csrfToken: string | null = null;

export class SessionExpiredError extends Error {}

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

async function handle<T>(res: Response): Promise<T> {
  // Session expirée ou invalidée : tout répond 404.
  if (res.status === 404) throw new SessionExpiredError('Session expirée');
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // corps non JSON
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function getJson<T>(path: string, opts: { background?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: opts.background ? { 'x-background-refresh': '1' } : {},
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return handle<T>(res);
}

export async function send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-csrf-token': csrfToken ?? '' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return handle<T>(res);
}
