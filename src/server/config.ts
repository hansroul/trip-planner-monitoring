import { z } from 'zod';

/**
 * Configuration : TOUT vient des variables d'environnement, validées au démarrage.
 * Le serveur refuse de démarrer si une variable manque ou est faible. Aucune valeur sensible
 * (URL, chemin d'administration, secret, adresse) n'est écrite en dur dans le code.
 */

export const DEFAULT_TIMEZONE = 'Europe/Brussels';
const ANTHROPIC_ADMIN_KEY_PREFIX = 'sk-ant-admin';
const RESERVED_PREFIXES = new Set(['healthz', 'robots.txt', 'assets', 'api', 'auth', 'favicon.ico']);
const PRIVATE_DB_HOST_SUFFIX = '.railway.internal';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Configuration invalide :\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());

const boolFromEnv = (def: boolean) =>
  z.preprocess((v) => {
    const s = emptyToUndefined(v);
    if (s === undefined) return def;
    if (typeof s === 'string') {
      const l = s.toLowerCase();
      if (['true', '1', 'yes', 'oui'].includes(l)) return true;
      if (['false', '0', 'no', 'non'].includes(l)) return false;
    }
    return s;
  }, z.boolean());

const positiveBigIntBytes = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^\d+$/, 'doit être un nombre entier d’octets')
    .transform((s) => Number(s))
    .refine((n) => Number.isSafeInteger(n) && n > 0, 'doit être un entier positif')
    .optional(),
);

const percent = (def: number) =>
  z.preprocess(
    (v) => emptyToUndefined(v) ?? String(def),
    z.coerce.number().min(1).max(100),
  );

/** Un secret « faible » : trop court, ou valeur d'exemple évidente. */
export function isWeakSecret(value: string, minBytes = 32): string | null {
  if (Buffer.byteLength(value, 'utf8') < minBytes) return `doit faire au moins ${minBytes} octets`;
  if (/^(.)\1+$/.test(value)) return 'ne doit pas répéter un seul caractère';
  if (/change[-_ ]?me|exemple|example|placeholder|changez|xxxxxxxx|secret-de-dev/i.test(value)) {
    return 'ressemble à une valeur d’exemple';
  }
  if (new Set(value).size < 10) return 'n’est pas assez aléatoire';
  return null;
}

function isPrivateDbHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.endsWith(PRIVATE_DB_HOST_SUFFIX);
}

const rawSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  HOST: z.preprocess(emptyToUndefined, z.string().default('0.0.0.0')),
  PORT: z.preprocess((v) => emptyToUndefined(v) ?? '3000', z.coerce.number().int().min(1).max(65535)),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  TRUST_PROXY_HOPS: z.preprocess((v) => emptyToUndefined(v) ?? '0', z.coerce.number().int().min(0).max(5)),

  PUBLIC_BASE_URL: z.url(),
  ADMIN_PATH_PREFIX: z.string(),
  MAIN_APP_URL: z.url(),

  OIDC_ISSUER: z.url(),
  OIDC_CLIENT_ID: z.string().trim().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  OIDC_REDIRECT_URI: z.url(),
  ADMIN_EMAIL: z.email(),
  ADMIN_OIDC_SUB: optionalString,

  SESSION_SECRET: z.string(),

  DATABASE_URL_READONLY: z.string().min(1),
  DATABASE_URL_APP: z.string().min(1),
  DB_SSL_CA: optionalString,

  TIMEZONE: z.preprocess(emptyToUndefined, z.string().default(DEFAULT_TIMEZONE)),
  DB_SIZE_LIMIT_BYTES: positiveBigIntBytes,
  STORAGE_LIMIT_BYTES: positiveBigIntBytes,
  CREDIT_WARN_PERCENT: percent(70),
  CREDIT_CRITICAL_PERCENT: percent(90),
  STORAGE_WARN_PERCENT: percent(80),
  STORAGE_CRITICAL_PERCENT: percent(90),
  SATURATION_ALERT_DAYS: z.preprocess((v) => emptyToUndefined(v) ?? '30', z.coerce.number().int().min(1).max(3650)),
  USD_TO_EUR_RATE: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(10).optional()),

  ANTHROPIC_PROVIDER_LABEL: z.preprocess(emptyToUndefined, z.string().default('anthropic')),
  ANTHROPIC_ADMIN_KEY: optionalString,
  ANTHROPIC_API_VERSION: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-10-21')),
  ANTHROPIC_API_BASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),

  ALERTS_ENABLED: boolFromEnv(false),
  SMTP_HOST: optionalString,
  SMTP_PORT: z.preprocess((v) => emptyToUndefined(v) ?? '587', z.coerce.number().int().min(1).max(65535)),
  SMTP_SECURE: boolFromEnv(false),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_FROM: z.preprocess(emptyToUndefined, z.email().optional()),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export interface DbTarget {
  url: string;
  user: string;
  host: string;
  privateNetwork: boolean;
}

function parseDbUrl(name: string, value: string, expectedUser: string, problems: string[]): DbTarget | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    problems.push(`${name} : URL PostgreSQL invalide`);
    return null;
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    problems.push(`${name} : doit commencer par postgres:// ou postgresql://`);
    return null;
  }
  const user = decodeURIComponent(u.username);
  if (user !== expectedUser) {
    problems.push(`${name} : doit utiliser le rôle ${expectedUser} (jamais le compte principal de PoppyTrip)`);
  }
  if (!u.password) problems.push(`${name} : mot de passe manquant`);
  const host = u.hostname;
  return { url: value, user, host, privateNetwork: isPrivateDbHost(host) };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    // Jamais la valeur reçue dans le message : seulement le nom de la variable et le problème.
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'configuration'} : ${i.message}`),
    );
  }
  const e = parsed.data;
  const problems: string[] = [];
  const production = e.NODE_ENV === 'production';

  // URL publique : origine seule, HTTPS en production.
  const publicUrl = new URL(e.PUBLIC_BASE_URL);
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    problems.push('PUBLIC_BASE_URL : doit être une origine seule (sans chemin, ni ? ni #)');
  }
  if (production && publicUrl.protocol !== 'https:') problems.push('PUBLIC_BASE_URL : HTTPS obligatoire en production');
  const publicOrigin = publicUrl.origin;

  // Préfixe d'administration : segment aléatoire non devinable.
  const prefix = e.ADMIN_PATH_PREFIX.trim();
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(prefix)) {
    problems.push('ADMIN_PATH_PREFIX : 24 à 128 caractères parmi A-Z a-z 0-9 _ - (segment aléatoire, sans /)');
  } else if (!/[A-Za-z]/.test(prefix) || !/\d/.test(prefix) || new Set(prefix).size < 12) {
    problems.push('ADMIN_PATH_PREFIX : pas assez aléatoire (lettres et chiffres variés exigés)');
  }
  if (RESERVED_PREFIXES.has(prefix.toLowerCase())) problems.push('ADMIN_PATH_PREFIX : valeur réservée');
  if (/exemple|example|changeme|generer|fictif/i.test(prefix)) problems.push('ADMIN_PATH_PREFIX : valeur d’exemple, à générer');

  const basePath = `/${prefix}`;
  const expectedRedirect = `${publicOrigin}${basePath}/auth/callback`;
  if (e.OIDC_REDIRECT_URI !== expectedRedirect) {
    problems.push('OIDC_REDIRECT_URI : doit valoir PUBLIC_BASE_URL + "/" + ADMIN_PATH_PREFIX + "/auth/callback"');
  }

  const issuer = new URL(e.OIDC_ISSUER);
  if (production && issuer.protocol !== 'https:') problems.push('OIDC_ISSUER : HTTPS obligatoire en production');
  const mainApp = new URL(e.MAIN_APP_URL);
  if (production && mainApp.protocol !== 'https:') problems.push('MAIN_APP_URL : HTTPS obligatoire en production');

  if (production) {
    const weakClient = isWeakSecret(e.OIDC_CLIENT_SECRET, 16);
    if (weakClient) problems.push(`OIDC_CLIENT_SECRET : ${weakClient}`);
  }
  const weakSession = isWeakSecret(e.SESSION_SECRET, 32);
  if (weakSession) problems.push(`SESSION_SECRET : ${weakSession}`);

  // Bases : deux rôles dédiés, jamais l'URL principale de PoppyTrip.
  const readonlyDb = parseDbUrl('DATABASE_URL_READONLY', e.DATABASE_URL_READONLY, 'monitoring_reader', problems);
  const appDb = parseDbUrl('DATABASE_URL_APP', e.DATABASE_URL_APP, 'monitoring_app_rw', problems);
  if (env.DATABASE_URL && (env.DATABASE_URL === e.DATABASE_URL_READONLY || env.DATABASE_URL === e.DATABASE_URL_APP)) {
    problems.push('DATABASE_URL de PoppyTrip ne doit jamais être utilisée par ce site');
  }

  try {
    new Intl.DateTimeFormat('fr-BE', { timeZone: e.TIMEZONE });
  } catch {
    problems.push('TIMEZONE : fuseau horaire inconnu');
  }

  if (e.CREDIT_WARN_PERCENT >= e.CREDIT_CRITICAL_PERCENT) {
    problems.push('CREDIT_WARN_PERCENT doit être inférieur à CREDIT_CRITICAL_PERCENT');
  }
  if (e.STORAGE_WARN_PERCENT >= e.STORAGE_CRITICAL_PERCENT) {
    problems.push('STORAGE_WARN_PERCENT doit être inférieur à STORAGE_CRITICAL_PERCENT');
  }

  if (e.ANTHROPIC_ADMIN_KEY !== undefined && !e.ANTHROPIC_ADMIN_KEY.startsWith(ANTHROPIC_ADMIN_KEY_PREFIX)) {
    problems.push('ANTHROPIC_ADMIN_KEY : doit être une clé d’administration Anthropic (sk-ant-admin…)');
  }
  if (e.ANTHROPIC_ADMIN_KEY !== undefined && !e.ANTHROPIC_API_BASE_URL) {
    problems.push('ANTHROPIC_API_BASE_URL : obligatoire quand ANTHROPIC_ADMIN_KEY est définie');
  }
  if (production && e.ANTHROPIC_API_BASE_URL && new URL(e.ANTHROPIC_API_BASE_URL).protocol !== 'https:') {
    problems.push('ANTHROPIC_API_BASE_URL : HTTPS obligatoire en production');
  }

  if (e.ALERTS_ENABLED) {
    if (!e.SMTP_HOST || !e.SMTP_FROM) problems.push('ALERTS_ENABLED=true exige SMTP_HOST et SMTP_FROM');
    if ((e.SMTP_USER && !e.SMTP_PASSWORD) || (!e.SMTP_USER && e.SMTP_PASSWORD)) {
      problems.push('SMTP_USER et SMTP_PASSWORD vont ensemble');
    }
  }

  if (problems.length > 0 || !readonlyDb || !appDb) throw new ConfigError(problems);

  return {
    nodeEnv: e.NODE_ENV,
    production,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    publicOrigin,
    publicHost: publicUrl.host,
    prefix,
    basePath,
    mainAppUrl: mainApp.toString(),
    oidc: {
      issuer: e.OIDC_ISSUER,
      clientId: e.OIDC_CLIENT_ID,
      clientSecret: e.OIDC_CLIENT_SECRET,
      redirectUri: e.OIDC_REDIRECT_URI,
    },
    admin: {
      email: e.ADMIN_EMAIL.trim().toLowerCase(),
      sub: e.ADMIN_OIDC_SUB,
    },
    sessionSecret: e.SESSION_SECRET,
    db: {
      readonly: readonlyDb,
      app: appDb,
      sslCa: e.DB_SSL_CA?.replace(/\\n/g, '\n'),
    },
    timezone: e.TIMEZONE,
    limits: {
      dbSizeBytes: e.DB_SIZE_LIMIT_BYTES ?? null,
      storageBytes: e.STORAGE_LIMIT_BYTES ?? null,
    },
    thresholds: {
      creditWarn: e.CREDIT_WARN_PERCENT,
      creditCritical: e.CREDIT_CRITICAL_PERCENT,
      storageWarn: e.STORAGE_WARN_PERCENT,
      storageCritical: e.STORAGE_CRITICAL_PERCENT,
      saturationDays: e.SATURATION_ALERT_DAYS,
    },
    usdToEurRate: e.USD_TO_EUR_RATE ?? null,
    anthropic: {
      providerLabel: e.ANTHROPIC_PROVIDER_LABEL,
      adminKey: e.ANTHROPIC_ADMIN_KEY ?? null,
      apiVersion: e.ANTHROPIC_API_VERSION,
      apiBaseUrl: e.ANTHROPIC_API_BASE_URL ? e.ANTHROPIC_API_BASE_URL.replace(/\/$/, '') : null,
    },
    alerts: {
      enabled: e.ALERTS_ENABLED,
      smtp: e.SMTP_HOST
        ? {
            host: e.SMTP_HOST,
            port: e.SMTP_PORT,
            secure: e.SMTP_SECURE,
            user: e.SMTP_USER ?? null,
            password: e.SMTP_PASSWORD ?? null,
            from: e.SMTP_FROM ?? null,
          }
        : null,
    },
  };
}
