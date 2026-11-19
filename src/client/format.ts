/** Formats français (Intl). Les heures sont affichées dans le fuseau configuré. */
const LOCALE = 'fr-BE';

let timeZone = 'Europe/Brussels';
export function setTimeZone(tz: string): void {
  timeZone = tz;
}

const intFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const dec1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const pctFmt = new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 1 });

export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : intFmt.format(n));
export const fmtDec = (n: number | null | undefined) => (n === null || n === undefined ? '—' : dec1.format(n));
export const fmtPct = (r: number | null | undefined) => (r === null || r === undefined ? '—' : pctFmt.format(r));

export function fmtMoney(amount: number | null | undefined, currency: string, fractionDigits = 2): string {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}
export const fmtCents = (cents: number | null | undefined, currency: string) =>
  cents === null || cents === undefined ? '—' : fmtMoney(cents / 100, currency);
export const fmtUsd = (usd: number | null | undefined) => fmtMoney(usd, 'USD');

const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'];
export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  let v = bytes;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: v < 10 && i > 0 ? 2 : 1 }).format(v)} ${UNITS[i]}`;
}

/** Jour « AAAA-MM-JJ » (jour civil fourni par les vues) : formaté sans conversion de fuseau. */
export function fmtDay(day: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  if (!day) return '—';
  return new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}
export const fmtDayShort = (day: string) => fmtDay(day, { day: 'numeric', month: 'short' });

/** Instant ISO affiché dans le fuseau configuré. */
export function fmtDateTime(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' }): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone }).format(new Date(iso));
}
export const fmtHour = (iso: string) => fmtDateTime(iso, { hour: '2-digit', minute: '2-digit' });

export const WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

const LABELS: Record<string, string> = {
  mobile: 'Mobile',
  tablet: 'Tablette',
  desktop: 'Ordinateur',
  other: 'Autre',
  ios: 'iOS',
  android: 'Android',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  chromeos: 'ChromeOS',
  harmonyos: 'HarmonyOS',
  chrome: 'Chrome',
  safari: 'Safari',
  firefox: 'Firefox',
  edge: 'Edge',
  samsung_internet: 'Samsung Internet',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
  yandex: 'Yandex',
  uc_browser: 'UC Browser',
  brave: 'Brave',
  duckduckgo: 'DuckDuckGo',
  android_browser: 'Navigateur Android',
  internet_explorer: 'Internet Explorer',
  instagram: 'Instagram (intégré)',
  facebook: 'Facebook (intégré)',
  messenger: 'Messenger (intégré)',
  tiktok: 'TikTok (intégré)',
  snapchat: 'Snapchat (intégré)',
  linkedin: 'LinkedIn (intégré)',
  pinterest: 'Pinterest (intégré)',
  twitter: 'X / Twitter (intégré)',
  line: 'LINE (intégré)',
  wechat: 'WeChat (intégré)',
  active: 'Actif',
  trialing: 'Essai',
  past_due: 'Paiement en échec',
  canceled: 'Résilié',
  month: 'mensuel',
  year: 'annuel',
};
export const label = (key: string) => LABELS[key] ?? key;
