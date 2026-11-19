import { useCallback, useEffect, useState } from 'react';
import type { CreditResponse, InfraResponse, TopupView } from '../shared/api.js';
import type { Projection } from '../shared/calc.js';
import { getJson, send } from './api.js';
import { Card, DataTable, HBars, LineChart, Progress, Tile } from './charts.js';
import { fmtBytes, fmtDateTime, fmtDay, fmtDayShort, fmtPct, fmtUsd } from './format.js';

const LEVEL_TEXT = { ok: 'Normal', warn: 'Attention', critical: 'Critique' } as const;

function levelFor(pct: number, warn: number, critical: number): 'ok' | 'warn' | 'critical' {
  return pct >= critical ? 'critical' : pct >= warn ? 'warn' : 'ok';
}

function ProjectionText({ p, unit }: { p: Projection; unit: (n: number) => string }) {
  if (p.status === 'no_data') return <>Aucune mesure.</>;
  if (p.status === 'insufficient') return <>Une seule mesure : tendance inconnue.</>;
  if (p.status === 'stable') return <>Stable (pas de croissance sur 14 jours).</>;
  return (
    <>
      Croissance d’environ {unit(p.growthPerDay ?? 0)} par jour (tendance sur 14 jours).{' '}
      {p.daysLeft !== null ? (
        <>
          Saturation prévue dans <strong>{p.daysLeft} jours</strong> ({fmtDay(p.saturationDay)}).
        </>
      ) : (
        <>Limite non configurée : pas de projection.</>
      )}
    </>
  );
}

function Usage({ title, current, limit, projection, warn, critical }: { title: string; current: number | null; limit: number | null; projection: Projection; warn: number; critical: number }) {
  const pct = limit && current !== null ? (current / limit) * 100 : null;
  const lvl = pct !== null ? levelFor(pct, warn, critical) : null;
  return (
    <Card title={title}>
      <div className="tiles">
        <Tile label="Taille" value={fmtBytes(current)} sub={limit ? `sur ${fmtBytes(limit)}` : 'limite non configurée'} />
        {pct !== null && lvl ? (
          <Tile label="Utilisé" value={fmtPct(pct / 100)} sub={<span className={`status ${lvl}`}>{LEVEL_TEXT[lvl]}</span>} />
        ) : null}
      </div>
      {pct !== null && lvl ? <Progress percent={pct} level={lvl} label={`${title} : ${fmtPct(pct / 100)} utilisé, niveau ${LEVEL_TEXT[lvl]}`} /> : null}
      <p className="note">
        <ProjectionText p={projection} unit={fmtBytes} />
      </p>
    </Card>
  );
}

export function InfraBlock({ onError }: { onError: (e: unknown) => void }) {
  const [infra, setInfra] = useState<InfraResponse | null>(null);
  useEffect(() => {
    getJson<InfraResponse>('api/infra').then(setInfra).catch(onError);
  }, [onError]);
  if (!infra) return null;
  const t = infra.thresholds;
  const storageCurrent = infra.storage.projection.status === 'no_data' ? null : infra.storage.projection.current;
  return (
    <section className="block" aria-labelledby="b-infra">
      <h2 id="b-infra">Infrastructure</h2>
      <p className="lead">
        Tailles logiques mesurées par PostgreSQL : la taille réelle sur disque est plus grande (index, journaux, espace non récupéré). Les
        métriques de l’hébergeur font foi pour le volume réel. Seuils : {t.warn} % (attention), {t.critical} % (critique), saturation à moins de{' '}
        {t.saturationDays} jours.
      </p>
      <div className="grid">
        <Usage title="Base de données (pg_database_size)" current={infra.database.sizeBytes} limit={infra.database.limitBytes} projection={infra.database.projection} warn={t.warn} critical={t.critical} />
        <Usage title="Stockage de fichiers" current={storageCurrent} limit={infra.storage.limitBytes} projection={infra.storage.projection} warn={t.warn} critical={t.critical} />
        <Card title="10 plus grosses tables">
          <HBars title="Plus grosses tables" items={infra.tables.map((x) => ({ label: x.name, value: x.bytes }))} formatValue={fmtBytes} />
          <DataTable caption="Plus grosses tables" columns={[{ label: 'Table' }, { label: 'Taille', numeric: true }]} rows={infra.tables.map((x) => [x.name, fmtBytes(x.bytes)])} />
        </Card>
        <Card title="Croissance quotidienne (30 derniers jours)">
          <LineChart
            title="Taille de la base par jour"
            labels={infra.dailySizes.filter((d) => d.dbSizeBytes !== null).map((d) => d.day)}
            series={[{ key: 'db', label: 'Base', values: infra.dailySizes.filter((d) => d.dbSizeBytes !== null).map((d) => d.dbSizeBytes!) }]}
            formatValue={fmtBytes}
            formatLabel={fmtDayShort}
          />
          <DataTable
            caption="Tailles mesurées par jour"
            columns={[{ label: 'Jour' }, { label: 'Base', numeric: true }, { label: 'Stockage', numeric: true }]}
            rows={infra.dailySizes.map((d) => [fmtDay(d.day), fmtBytes(d.dbSizeBytes), fmtBytes(d.storageBytes)])}
          />
        </Card>
      </div>
    </section>
  );
}

// --- Crédit Anthropic ------------------------------------------------------------------

function TopupForm({ initial, onDone, onCancel }: { initial?: TopupView; onDone: () => void; onCancel?: () => void }) {
  const [date, setDate] = useState(initial?.date ?? new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(initial ? String(initial.amountUsd) : '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = Number(amount.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return setError('Montant invalide.');
    setBusy(true);
    setError(null);
    try {
      const body = { date, amountUsd: Math.round(value * 100) / 100, note: note.trim() || null };
      if (initial) await send('PUT', `api/credit/topups/${initial.id}`, body);
      else await send('POST', 'api/credit/topups', body);
      if (!initial) {
        setAmount('');
        setNote('');
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="topup" onSubmit={(e) => void submit(e)} aria-label={initial ? 'Corriger la recharge' : 'Ajouter une recharge'}>
      <label>
        Date
        <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label>
        Montant (USD)
        <input type="number" required min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label>
        Note (facultative)
        <input type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" disabled={busy}>
          {initial ? 'Enregistrer' : 'Ajouter'}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel}>
            Annuler
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function CreditBlock({ onError }: { onError: (e: unknown) => void }) {
  const [data, setData] = useState<CreditResponse | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const load = useCallback(() => {
    getJson<CreditResponse>('api/credit').then(setData).catch(onError);
  }, [onError]);
  useEffect(load, [load]);

  const remove = async (t: TopupView) => {
    if (!window.confirm(`Supprimer la recharge du ${fmtDay(t.date)} (${fmtUsd(t.amountUsd)}) ?`)) return;
    try {
      await send('DELETE', `api/credit/topups/${t.id}`);
      load();
    } catch (e) {
      onError(e);
    }
  };

  if (!data) return null;
  const s = data.status;
  const r = data.reconciliation;
  return (
    <section className="block" aria-labelledby="b-credit">
      <h2 id="b-credit">Crédit Anthropic utilisé</h2>
      <p className="lead">
        L’API d’Anthropic n’expose pas le solde : les recharges sont saisies ici. Consommé = coûts enregistrés pour le fournisseur Anthropic
        depuis la première recharge. Seuils : {data.thresholds.warn} % et {data.thresholds.critical} %.
      </p>
      {!s.configured ? (
        <p className="banner info">Aucun crédit configuré : ajoutez une première recharge (ou le solde initial).</p>
      ) : (
        <>
          <div className="tiles">
            <Tile label="Total rechargé" value={fmtUsd(s.totalUsd)} sub={`depuis le ${fmtDay(s.since)}`} />
            <Tile label="Consommé" value={fmtUsd(s.consumedUsd)} />
            <Tile label="Restant" value={fmtUsd(s.remainingUsd)} />
            <Tile label="Utilisé" value={fmtPct(s.percentUsed / 100)} sub={<span className={`status ${s.level}`}>{LEVEL_TEXT[s.level]}</span>} />
            <Tile label="Moyenne sur 7 jours" value={`${fmtUsd(s.avgDailyUsd7)} / jour`} />
            <Tile label="Jours restants estimés" value={s.daysLeft === null ? 'stable' : String(s.daysLeft)} sub={s.daysLeft === null ? 'aucune consommation récente' : undefined} />
          </div>
          <Progress percent={s.percentUsed} level={s.level} label={`Crédit utilisé : ${fmtPct(s.percentUsed / 100)}, niveau ${LEVEL_TEXT[s.level]}`} />
        </>
      )}
      <div className="grid">
        <Card title="Recharges">
          <TopupForm onDone={load} />
          {data.topups.length ? (
            <div className="table-wrap">
              <table>
                <caption>Recharges saisies</caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col" className="num">
                      Montant
                    </th>
                    <th scope="col">Note</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topups.map((t) =>
                    editing === t.id ? (
                      <tr key={t.id}>
                        <td colSpan={4}>
                          <TopupForm
                            initial={t}
                            onDone={() => {
                              setEditing(null);
                              load();
                            }}
                            onCancel={() => setEditing(null)}
                          />
                        </td>
                      </tr>
                    ) : (
                      <tr key={t.id}>
                        <td>{fmtDay(t.date)}</td>
                        <td className="num">{fmtUsd(t.amountUsd)}</td>
                        <td>{t.note ?? '—'}</td>
                        <td>
                          <button type="button" className="link" onClick={() => setEditing(t.id)} aria-label={`Corriger la recharge du ${fmtDay(t.date)}`}>
                            Corriger
                          </button>
                          <button type="button" className="link" onClick={() => void remove(t)} aria-label={`Supprimer la recharge du ${fmtDay(t.date)}`}>
                            Supprimer
                          </button>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          ) : null}
        </Card>
        <Card title="Recoupement avec l’API d’administration d’Anthropic">
          {!r.enabled || r.apiUsd === null ? (
            <p className="note">{r.message}</p>
          ) : (
            <>
              <p className="note">
                Du {fmtDay(r.window?.from)} au {fmtDay(r.window?.to)} (jours UTC côté Anthropic, jours locaux côté PoppyTrip ; les données
                d’Anthropic arrivent avec jusqu’à 24 h de retard). Mis à jour : {fmtDateTime(r.fetchedAt)}.
              </p>
              <div className="tiles">
                <Tile label="Enregistré par PoppyTrip" value={fmtUsd(r.localUsd)} />
                <Tile label="Facturé selon Anthropic" value={fmtUsd(r.apiUsd)} />
                <Tile
                  label="Écart"
                  value={fmtPct(r.gap)}
                  sub={<span className={`status ${r.flagged ? 'critical' : 'ok'}`}>{r.flagged ? 'Écart supérieur à 10 %' : 'Écart acceptable (≤ 10 %)'}</span>}
                />
              </div>
            </>
          )}
        </Card>
      </div>
    </section>
  );
}
