import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_PERIOD_DAYS, PRESET_PERIODS, type LiveResponse, type OverviewResponse, type SessionInfo } from '../shared/api.js';
import { addDays, daysBetween, isDay } from '../shared/calc.js';
import { getJson, send, SessionExpiredError, setCsrfToken } from './api.js';
import { CreditBlock, InfraBlock } from './ops.js';
import { fmtDay, setTimeZone } from './format.js';
import { ClientsBlock, CostsBlock, FunnelBlock, LiveBlock, RevenueBlock, SubscriptionsBlock, UsageBlock, UsersBlock } from './sections.js';

const LIVE_REFRESH_MS = 30_000;

type PeriodChoice = { kind: 'preset'; days: number } | { kind: 'custom'; from: string; to: string };

function periodQuery(p: PeriodChoice): string {
  return p.kind === 'preset' ? `days=${p.days}` : `from=${p.from}&to=${p.to}`;
}

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [expired, setExpired] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const [period, setPeriod] = useState<PeriodChoice>({ kind: 'preset', days: 30 });
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveResponse | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);

  const onError = useCallback((err: unknown, set: (m: string) => void) => {
    if (err instanceof SessionExpiredError) setExpired(true);
    else set(err instanceof Error ? err.message : 'Erreur inattendue');
  }, []);

  useEffect(() => {
    getJson<SessionInfo>('api/session')
      .then((s) => {
        setCsrfToken(s.csrfToken);
        setTimeZone(s.timezone);
        setSession(s);
      })
      .catch((e: unknown) => onError(e, setError));
  }, [onError]);

  useEffect(() => {
    if (!session) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    getJson<OverviewResponse>(`api/overview?${periodQuery(period)}`, { signal: ctrl.signal })
      .then(setOverview)
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) onError(e, setError);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [session, period, onError]);

  // Connectés en direct : toutes les 30 s, suspendu quand l'onglet n'est pas visible.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!session) return;
    const load = () =>
      getJson<LiveResponse>('api/live', { background: true })
        .then((l) => {
          setLive(l);
          setLiveError(null);
        })
        .catch((e: unknown) => onError(e, setLiveError));
    const start = () => {
      if (timer.current !== null) return;
      void load();
      timer.current = window.setInterval(() => void load(), LIVE_REFRESH_MS);
    };
    const stop = () => {
      if (timer.current !== null) window.clearInterval(timer.current);
      timer.current = null;
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [session, onError]);

  const logout = async () => {
    try {
      await send('POST', 'auth/logout');
    } catch {
      // Session déjà invalide : rien à faire.
    }
    setLoggedOut(true);
  };

  if (loggedOut || expired) {
    return (
      <main id="contenu">
        <h1>Suivi PoppyTrip</h1>
        <p className="banner info" role="status">
          {loggedOut ? 'Vous êtes déconnecté.' : 'Votre session a expiré.'} Pour revenir, ouvrez à nouveau l’adresse de connexion.
        </p>
      </main>
    );
  }

  return (
    <>
      <a className="skip-link" href="#contenu">
        Aller au contenu
      </a>
      <header className="top">
        <h1>Suivi PoppyTrip</h1>
        <nav aria-label="Liens">
          {session?.mainAppUrl ? (
            <a href={session.mainAppUrl} rel="noreferrer noopener">
              Application principale
            </a>
          ) : null}
          <button type="button" onClick={() => void logout()}>
            Se déconnecter
          </button>
        </nav>
      </header>
      <main id="contenu">
        <LiveBlock live={live} presence={overview?.presence ?? null} error={liveError} />
        <PeriodSelector value={period} onChange={setPeriod} today={overview?.period.today ?? null} />
        {overview ? (
          <p className="period summary" aria-live="polite">
            Période : du {fmtDay(overview.period.from)} au {fmtDay(overview.period.to)} ({overview.period.days} jours, fuseau {overview.period.timezone})
            {loading ? ' — chargement…' : ''}
          </p>
        ) : null}
        {error ? (
          <p className="banner error" role="alert">
            {error}
          </p>
        ) : null}
        {overview?.meta.historyIncomplete ? (
          <p className="banner" role="note">
            Historique incomplet avant le {fmtDay(overview.meta.instrumentedSince)} : les données antérieures viennent d’un rattrapage partiel.
          </p>
        ) : null}
        {overview ? (
          <>
            <UsersBlock o={overview} />
            <SubscriptionsBlock o={overview} />
            <RevenueBlock o={overview} />
            <UsageBlock o={overview} />
            <CostsBlock o={overview} />
            <FunnelBlock o={overview} />
            <ClientsBlock o={overview} />
          </>
        ) : !error ? (
          <p aria-live="polite">Chargement…</p>
        ) : null}
        {session?.mainAppUrl ? (
          <>
            <InfraBlock onError={(e) => onError(e, setError)} />
            <CreditBlock onError={(e) => onError(e, setError)} />
          </>
        ) : null}
      </main>
    </>
  );
}

function PeriodSelector({ value, onChange, today }: { value: PeriodChoice; onChange: (p: PeriodChoice) => void; today: string | null }) {
  const max = today ?? new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(addDays(max, -59));
  const [to, setTo] = useState(max);
  const [msg, setMsg] = useState<string | null>(null);

  const applyCustom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isDay(from) || !isDay(to)) return setMsg('Dates invalides.');
    if (from > to) return setMsg('La date de début doit précéder la date de fin.');
    if (daysBetween(from, to) + 1 > MAX_PERIOD_DAYS) return setMsg('La période est limitée à 2 ans.');
    setMsg(null);
    onChange({ kind: 'custom', from, to });
  };

  return (
    <form className="period" onSubmit={applyCustom} aria-label="Période">
      <fieldset>
        <legend className="sr-only">Période prédéfinie</legend>
        {PRESET_PERIODS.map((d) => (
          <button key={d} type="button" aria-pressed={value.kind === 'preset' && value.days === d} onClick={() => onChange({ kind: 'preset', days: d })}>
            {d} jours
          </button>
        ))}
      </fieldset>
      <fieldset>
        <legend className="sr-only">Plage personnalisée (2 ans maximum)</legend>
        <label>
          Du
          <input type="date" value={from} max={max} min={addDays(max, -(MAX_PERIOD_DAYS - 1))} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Au
          <input type="date" value={to} max={max} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="submit" aria-pressed={value.kind === 'custom'}>
          Appliquer
        </button>
      </fieldset>
      {msg ? (
        <span className="field-error" role="alert">
          {msg}
        </span>
      ) : null}
    </form>
  );
}
