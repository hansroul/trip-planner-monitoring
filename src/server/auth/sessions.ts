import { createHmac, randomBytes } from 'node:crypto';
import type pg from 'pg';

/**
 * Sessions côté serveur (table monitoring_app.sessions).
 * - Identifiant aléatoire de 256 bits dans le cookie ; seule son empreinte HMAC(SESSION_SECRET)
 *   est stockée : une fuite de la table ne donne aucun cookie valide.
 * - Durée absolue de 8 h, expiration après 30 min d'inactivité, invalidation à la déconnexion.
 * - Un nouvel identifiant est créé à chaque connexion (jamais réutilisé).
 */

export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const LOGIN_FLOW_MS = 10 * 60 * 1000;
const TOUCH_EVERY_MS = 30 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface Session {
  idHash: string;
  csrfToken: string;
  createdAt: Date;
  lastSeenAt: Date;
  absoluteExpiresAt: Date;
  subNotice: string | null;
}

export interface LoginFlow {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export const randomToken = () => randomBytes(32).toString('base64url');

interface SessionRow {
  id_hash: string;
  csrf_token: string;
  created_at: Date;
  last_seen_at: Date;
  absolute_expires_at: Date;
  sub_notice: string | null;
}

const toSession = (r: SessionRow): Session => ({
  idHash: r.id_hash,
  csrfToken: r.csrf_token,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  absoluteExpiresAt: r.absolute_expires_at,
  subNotice: r.sub_notice,
});

export class SessionStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  hash(id: string): string {
    return createHmac('sha256', this.secret).update(id).digest('hex');
  }

  async create(opts: { subNotice?: string | null } = {}): Promise<{ id: string; session: Session }> {
    const id = randomToken();
    const now = this.now();
    const { rows } = await this.pool.query<SessionRow>(
      `INSERT INTO monitoring_app.sessions (id_hash, csrf_token, created_at, last_seen_at, absolute_expires_at, sub_notice)
       VALUES ($1, $2, $3, $3, $4, $5) RETURNING *`,
      [this.hash(id), randomToken(), now, new Date(now.getTime() + SESSION_ABSOLUTE_MS), opts.subNotice ?? null],
    );
    return { id, session: toSession(rows[0]!) };
  }

  /**
   * Session valide pour cet identifiant, ou null (inconnue, expirée : elle est alors supprimée).
   * `touch` = activité réelle de l'utilisateur ; les actualisations automatiques ne prolongent pas
   * l'inactivité.
   */
  async validate(id: string | undefined, touch: boolean): Promise<Session | null> {
    if (!id || !TOKEN_RE.test(id)) return null;
    const idHash = this.hash(id);
    const { rows } = await this.pool.query<SessionRow>('SELECT * FROM monitoring_app.sessions WHERE id_hash = $1', [
      idHash,
    ]);
    const row = rows[0];
    if (!row) return null;
    const now = this.now().getTime();
    const s = toSession(row);
    if (now >= s.absoluteExpiresAt.getTime() || now - s.lastSeenAt.getTime() >= SESSION_IDLE_MS) {
      await this.pool.query('DELETE FROM monitoring_app.sessions WHERE id_hash = $1', [idHash]);
      return null;
    }
    if (touch && now - s.lastSeenAt.getTime() >= TOUCH_EVERY_MS) {
      s.lastSeenAt = new Date(now);
      await this.pool.query('UPDATE monitoring_app.sessions SET last_seen_at = $2 WHERE id_hash = $1', [
        idHash,
        s.lastSeenAt,
      ]);
    }
    return s;
  }

  async destroy(id: string | undefined): Promise<void> {
    if (!id || !TOKEN_RE.test(id)) return;
    await this.pool.query('DELETE FROM monitoring_app.sessions WHERE id_hash = $1', [this.hash(id)]);
  }

  /** Lit puis efface le message « renseigne ADMIN_OIDC_SUB » (affiché une seule fois). */
  async takeSubNotice(idHash: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ sub_notice: string | null }>(
      `UPDATE monitoring_app.sessions s SET sub_notice = NULL
       FROM (SELECT id_hash, sub_notice FROM monitoring_app.sessions WHERE id_hash = $1 FOR UPDATE) old
       WHERE s.id_hash = old.id_hash RETURNING old.sub_notice`,
      [idHash],
    );
    return rows[0]?.sub_notice ?? null;
  }

  async createFlow(flow: LoginFlow): Promise<string> {
    const id = randomToken();
    await this.pool.query(
      `INSERT INTO monitoring_app.login_flows (id_hash, state, nonce, code_verifier, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [this.hash(id), flow.state, flow.nonce, flow.codeVerifier, new Date(this.now().getTime() + LOGIN_FLOW_MS)],
    );
    return id;
  }

  /** Usage unique : le flux est supprimé à la lecture, même s'il a expiré. */
  async consumeFlow(id: string | undefined): Promise<LoginFlow | null> {
    if (!id || !TOKEN_RE.test(id)) return null;
    const { rows } = await this.pool.query<{ state: string; nonce: string; code_verifier: string; expires_at: Date }>(
      'DELETE FROM monitoring_app.login_flows WHERE id_hash = $1 RETURNING state, nonce, code_verifier, expires_at',
      [this.hash(id)],
    );
    const r = rows[0];
    if (!r || r.expires_at.getTime() <= this.now().getTime()) return null;
    return { state: r.state, nonce: r.nonce, codeVerifier: r.code_verifier };
  }

  async prune(): Promise<void> {
    const now = this.now();
    await this.pool.query(
      'DELETE FROM monitoring_app.sessions WHERE absolute_expires_at <= $1 OR last_seen_at <= $2',
      [now, new Date(now.getTime() - SESSION_IDLE_MS)],
    );
    await this.pool.query('DELETE FROM monitoring_app.login_flows WHERE expires_at <= $1', [now]);
  }
}
