import type { LiveResponse, OverviewResponse } from '../shared/api.js';
import { OTHER_VERSIONS } from '../shared/calc.js';
import { Card, DataTable, HBars, Heatmap, LineChart, Tile } from './charts.js';
import {
  fmtCents,
  fmtDateTime,
  fmtDay,
  fmtDayShort,
  fmtDec,
  fmtHour,
  fmtInt,
  fmtPct,
  fmtUsd,
  label,
  WEEKDAYS,
} from './format.js';

type O = OverviewResponse;

function Block({ id, title, lead, children }: { id: string; title: string; lead?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="block" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {lead ? <p className="lead">{lead}</p> : null}
      {children}
    </section>
  );
}

const days = (rows: Array<{ day: string }>) => rows.map((r) => r.day);

// --- Connectés en direct ----------------------------------------------------------------
export function LiveBlock({ live, presence, error }: { live: LiveResponse | null; presence: O['presence'] | null; error: string | null }) {
  return (
    <Block
      id="b-live"
      title="Connectés en direct"
      lead="Utilisateur authentifié avec une activité dans les 5 dernières minutes ; comptage sans identité. Actualisé toutes les 30 secondes (en pause quand l’onglet est masqué)."
    >
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      <div className="tiles">
        <Tile
          label="Connectés maintenant"
          value={live ? fmtInt(live.connectedUsers) : '…'}
          sub={
            <span aria-live="polite">
              {live?.asOf ? `Mis à jour à ${fmtDateTime(live.asOf, { timeStyle: 'medium' })}` : 'Aucune mesure'}
              {live?.stale ? <span className="stale"> — données non actualisées</span> : null}
            </span>
          }
        />
        <Tile label="Pic des dernières 24 h" value={fmtInt(live?.stats.peak)} sub={live?.stats.peakHour ? `à ${fmtHour(live.stats.peakHour)}` : undefined} />
        <Tile label="Moyenne des dernières 24 h" value={fmtDec(live?.stats.avg)} />
      </div>
      <div className="grid">
        <Card title="Dernières 24 heures (moyenne et pic par heure)">
          <LineChart
            title="Connectés par heure sur 24 heures"
            labels={live?.last24h.map((h) => h.hour) ?? []}
            series={[
              { key: 'avg', label: 'Moyenne', values: live?.last24h.map((h) => h.avgUsers) ?? [] },
              { key: 'peak', label: 'Pic', values: live?.last24h.map((h) => h.peakUsers) ?? [] },
            ]}
            formatValue={fmtDec}
            formatLabel={fmtHour}
          />
          <DataTable
            caption="Connectés par heure"
            columns={[{ label: 'Heure' }, { label: 'Moyenne', numeric: true }, { label: 'Pic', numeric: true }]}
            rows={(live?.last24h ?? []).map((h) => [fmtDateTime(h.hour), fmtDec(h.avgUsers), fmtInt(h.peakUsers)])}
          />
        </Card>
        <Card title="Pic de connectés par jour" note="Période sélectionnée, avec l’heure du pic.">
          <LineChart
            title="Pic de connectés par jour"
            labels={presence ? days(presence.daily) : []}
            series={[{ key: 'peak', label: 'Pic', values: presence?.daily.map((d) => d.peakUsers) ?? [] }]}
            formatValue={fmtInt}
            formatLabel={fmtDayShort}
            bars
          />
          <DataTable
            caption="Pic par jour"
            columns={[{ label: 'Jour' }, { label: 'Pic', numeric: true }, { label: 'Heure du pic' }, { label: 'Moyenne', numeric: true }]}
            rows={(presence?.daily ?? []).map((d) => [fmtDay(d.day), fmtInt(d.peakUsers), d.peakHour ? fmtHour(d.peakHour) : '—', fmtDec(d.avgUsers)])}
          />
        </Card>
        <Card title="Heures de pointe" note="Moyenne des connectés par jour de la semaine et par heure (fuseau configuré), sur la période.">
          <Heatmap title="Heures de pointe" rows={presence?.heatmap ?? []} rowLabels={WEEKDAYS.map((w) => w.slice(0, 3))} formatValue={fmtDec} />
          <DataTable
            caption="Moyenne par jour et heure"
            columns={[{ label: 'Jour' }, ...Array.from({ length: 24 }, (_, h) => ({ label: `${h} h`, numeric: true }))]}
            rows={(presence?.heatmap ?? []).map((row, r) => [WEEKDAYS[r], ...row.map((v) => (v === null ? '—' : fmtDec(v)))])}
          />
        </Card>
      </div>
    </Block>
  );
}

// --- Utilisateurs ------------------------------------------------------------------------
export function UsersBlock({ o }: { o: O }) {
  const u = o.users;
  return (
    <Block id="b-users" title="Utilisateurs">
      <div className="tiles">
        <Tile
          label="Total d’utilisateurs"
          value={fmtInt(u.total)}
          sub={`Inscriptions moins suppressions depuis le ${fmtDay(u.totalSince)}${o.meta.instrumentedSince ? ` (avant le ${fmtDay(o.meta.instrumentedSince)} : comptes encore existants)` : ''}`}
        />
        <Tile label="Inscriptions aujourd’hui" value={fmtInt(u.signupsToday)} />
        <Tile label="Inscriptions sur la période" value={fmtInt(u.signupsPeriod)} sub={`${fmtInt(u.deletionsPeriod)} suppressions`} />
        <Tile label="Actifs ce jour" value={fmtInt(u.activeToday)} sub={`au ${fmtDay(o.period.to)}`} />
        <Tile label="Actifs sur 7 jours" value={fmtInt(u.activeWeekSum)} sub="Somme des actifs quotidiens (approximation, pas un décompte distinct)" />
        <Tile label="Actifs sur 30 jours" value={fmtInt(u.activeMonthSum)} sub="Somme des actifs quotidiens (approximation, pas un décompte distinct)" />
      </div>
      <div className="grid">
        <Card title="Inscriptions par jour">
          <LineChart title="Inscriptions par jour" labels={days(u.daily)} series={[{ key: 's', label: 'Inscriptions', values: u.daily.map((d) => d.signups) }]} formatValue={fmtInt} formatLabel={fmtDayShort} bars />
          <DataTable
            caption="Inscriptions, suppressions et actifs par jour"
            columns={[{ label: 'Jour' }, { label: 'Inscriptions', numeric: true }, { label: 'Suppressions', numeric: true }, { label: 'Actifs', numeric: true }]}
            rows={u.daily.map((d) => [fmtDay(d.day), fmtInt(d.signups), fmtInt(d.deletions), fmtInt(d.active)])}
          />
        </Card>
        <Card title="Utilisateurs actifs par jour">
          <LineChart title="Utilisateurs actifs par jour" labels={days(u.daily)} series={[{ key: 'a', label: 'Actifs', values: u.daily.map((d) => d.active) }]} formatValue={fmtInt} formatLabel={fmtDayShort} />
        </Card>
      </div>
    </Block>
  );
}

// --- Abonnements -------------------------------------------------------------------------
export function SubscriptionsBlock({ o }: { o: O }) {
  const s = o.subscriptions;
  const inProgress = s.current.filter((c) => c.status !== 'canceled');
  const byPlan = new Map<string, number>();
  for (const c of inProgress) byPlan.set(`${c.plan} (${label(c.billingInterval)})`, (byPlan.get(`${c.plan} (${label(c.billingInterval)})`) ?? 0) + c.count);
  const failed = s.current.filter((c) => c.status === 'past_due').reduce((a, c) => a + c.count, 0);
  return (
    <Block id="b-subs" title="Abonnements">
      <div className="tiles">
        <Tile label="En cours" value={fmtInt(inProgress.reduce((a, c) => a + c.count, 0))} sub="actifs, en essai ou en retard de paiement" />
        <Tile label="Paiements en échec" value={fmtInt(failed)} sub={`${fmtInt(s.totals.paymentFailed)} échecs sur la période`} />
        <Tile label="Nouveaux (période)" value={fmtInt(s.totals.created)} />
        <Tile label="Résiliations demandées" value={fmtInt(s.totals.cancelRequested)} sub="cancel_requested" />
        <Tile label="Résiliations effectives" value={fmtInt(s.totals.canceled)} sub="canceled" />
        <Tile label="Reprises" value={fmtInt(s.totals.reactivated)} />
        <Tile label="Solde net de la période" value={`${s.totals.net > 0 ? '+' : ''}${fmtInt(s.totals.net)}`} sub="nouveaux − résiliations effectives" />
      </div>
      <div className="grid">
        <Card title="Abonnements en cours par offre">
          <HBars title="Abonnements en cours par offre" items={[...byPlan].map(([l, v]) => ({ label: l, value: v }))} formatValue={fmtInt} />
          <DataTable
            caption="Abonnements actuels par offre et statut"
            columns={[{ label: 'Offre' }, { label: 'Périodicité' }, { label: 'Statut' }, { label: 'Nombre', numeric: true }]}
            rows={s.current.map((c) => [c.plan, label(c.billingInterval), label(c.status), fmtInt(c.count)])}
          />
        </Card>
        <Card title="Abonnements en cours dans le temps" note={`Départ : ${fmtInt(s.startCount)} abonnés au début de la période (d’après les événements).`}>
          <LineChart title="Abonnements en cours" labels={days(s.activeSeries)} series={[{ key: 'a', label: 'En cours', values: s.activeSeries.map((d) => d.active) }]} formatValue={fmtInt} formatLabel={fmtDayShort} />
        </Card>
        <Card title="Nouveaux, résiliations et reprises par jour">
          <LineChart
            title="Événements d’abonnement par jour"
            labels={days(s.daily)}
            series={[
              { key: 'c', label: 'Nouveaux', values: s.daily.map((d) => d.created) },
              { key: 'r', label: 'Résiliation demandée', values: s.daily.map((d) => d.cancelRequested) },
              { key: 'x', label: 'Résiliation effective', values: s.daily.map((d) => d.canceled) },
              { key: 'p', label: 'Reprises', values: s.daily.map((d) => d.reactivated) },
            ]}
            formatValue={fmtInt}
            formatLabel={fmtDayShort}
          />
          <DataTable
            caption="Événements par jour"
            columns={[
              { label: 'Jour' },
              { label: 'Nouveaux', numeric: true },
              { label: 'Résil. demandées', numeric: true },
              { label: 'Résil. effectives', numeric: true },
              { label: 'Reprises', numeric: true },
              { label: 'Paiements en échec', numeric: true },
            ]}
            rows={s.daily.map((d) => [fmtDay(d.day), fmtInt(d.created), fmtInt(d.cancelRequested), fmtInt(d.canceled), fmtInt(d.reactivated), fmtInt(d.paymentFailed)])}
          />
        </Card>
      </div>
    </Block>
  );
}

// --- Revenus -----------------------------------------------------------------------------
export function RevenueBlock({ o }: { o: O }) {
  const r = o.revenue;
  const mrrEntries = Object.entries(r.mrr.byCurrency);
  const packs = Object.entries(r.packs.byCurrency);
  return (
    <Block
      id="b-revenue"
      title="Revenus"
      lead="Montants facturés (taxes éventuellement incluses). MRR : abonnés actifs ou en retard de paiement × prix mensuel de leur offre (les annuels sont ramenés au mois ; prix déduit des événements les plus récents de chaque offre ; essais exclus)."
    >
      <div className="tiles">
        <Tile label="MRR" value={mrrEntries.length ? mrrEntries.map(([c, v]) => fmtCents(v, c)).join(' + ') : '—'} sub={r.mrr.missingPrices.length ? `${r.mrr.missingPrices.length} offre(s) sans prix connu exclue(s)` : undefined} />
        <Tile label="Packs de crédits (période)" value={packs.length ? packs.map(([c, v]) => fmtCents(v.amountCents, c)).join(' + ') : fmtCents(0, 'eur')} sub={`${fmtInt(packs.reduce((a, [, v]) => a + v.packs, 0))} packs, revenus ponctuels`} />
        <Tile label="Abonnements facturés (période)" value={Object.entries(r.subscriptionBilledCents).map(([c, v]) => fmtCents(v, c)).join(' + ') || '—'} sub="créations et renouvellements" />
        <Tile label="Taux de désabonnement" value={fmtPct(r.churnRate)} sub="résiliations effectives / abonnés en début de période" />
        <Tile label="Conversion gratuit → payant" value={fmtPct(r.conversionRate)} sub="part des inscrits des cohortes de la période ayant souscrit" />
      </div>
      <div className="grid">
        <Card title="MRR par offre">
          <HBars title="MRR par offre" items={r.mrr.lines.map((l) => ({ label: `${l.plan} (${label(l.billingInterval)})`, value: l.mrrCents / 100, detail: `${fmtInt(l.subscribers)} abonnés` }))} formatValue={(v) => fmtCents(v * 100, r.mrr.lines[0]?.currency ?? 'eur')} />
          <DataTable
            caption="MRR par offre"
            columns={[{ label: 'Offre' }, { label: 'Périodicité' }, { label: 'Abonnés', numeric: true }, { label: 'Prix mensuel', numeric: true }, { label: 'MRR', numeric: true }]}
            rows={r.mrr.lines.map((l) => [l.plan, label(l.billingInterval), fmtInt(l.subscribers), fmtCents(l.monthlyCents, l.currency), fmtCents(l.mrrCents, l.currency)])}
          />
        </Card>
        <Card title="Packs de crédits par jour">
          <LineChart title="Revenus des packs par jour" labels={days(r.packs.daily)} series={[{ key: 'p', label: 'Packs', values: r.packs.daily.map((d) => d.amountCents / 100) }]} formatValue={(v) => fmtCents(v * 100, 'eur')} formatLabel={fmtDayShort} bars />
          <DataTable caption="Packs par jour" columns={[{ label: 'Jour' }, { label: 'Montant', numeric: true }]} rows={r.packs.daily.map((d) => [fmtDay(d.day), fmtCents(d.amountCents, 'eur')])} />
        </Card>
      </div>
    </Block>
  );
}

// --- Usage -------------------------------------------------------------------------------
export function UsageBlock({ o }: { o: O }) {
  const u = o.usage;
  return (
    <Block id="b-usage" title="Usage">
      <div className="tiles">
        <Tile label="Voyages créés" value={fmtInt(u.totals.tripsCreated)} sub={`dont ${fmtPct(u.templateShare)} depuis un modèle`} />
        <Tile label="Demandes à l’assistant" value={fmtInt(u.totals.assistantRequests)} />
        <Tile label="Crédits consommés" value={fmtInt(u.totals.creditsConsumed)} />
        <Tile label="Transcriptions vocales" value={fmtInt(u.totals.voiceTranscriptions)} />
      </div>
      <div className="grid">
        <Card title="Voyages créés par jour">
          <LineChart
            title="Voyages créés par jour"
            labels={days(u.daily)}
            series={[
              { key: 't', label: 'Depuis un modèle', values: u.daily.map((d) => d.tripsFromTemplate) },
              { key: 'n', label: 'Autres', values: u.daily.map((d) => d.tripsCreated - d.tripsFromTemplate) },
            ]}
            formatValue={fmtInt}
            formatLabel={fmtDayShort}
            bars
          />
        </Card>
        <Card title="Assistant et transcriptions par jour">
          <LineChart
            title="Demandes à l’assistant et transcriptions par jour"
            labels={days(u.daily)}
            series={[
              { key: 'a', label: 'Demandes à l’assistant', values: u.daily.map((d) => d.assistantRequests) },
              { key: 'v', label: 'Transcriptions vocales', values: u.daily.map((d) => d.voiceTranscriptions) },
            ]}
            formatValue={fmtInt}
            formatLabel={fmtDayShort}
          />
        </Card>
        <Card title="Crédits consommés par jour">
          <LineChart title="Crédits consommés par jour" labels={days(u.daily)} series={[{ key: 'c', label: 'Crédits', values: u.daily.map((d) => d.creditsConsumed) }]} formatValue={fmtInt} formatLabel={fmtDayShort} />
          <DataTable
            caption="Usage par jour"
            columns={[
              { label: 'Jour' },
              { label: 'Voyages', numeric: true },
              { label: 'dont modèles', numeric: true },
              { label: 'Assistant', numeric: true },
              { label: 'Crédits', numeric: true },
              { label: 'Transcriptions', numeric: true },
            ]}
            rows={u.daily.map((d) => [fmtDay(d.day), fmtInt(d.tripsCreated), fmtInt(d.tripsFromTemplate), fmtInt(d.assistantRequests), fmtInt(d.creditsConsumed), fmtInt(d.voiceTranscriptions)])}
          />
        </Card>
      </div>
    </Block>
  );
}

// --- Coûts et marge ----------------------------------------------------------------------
export function CostsBlock({ o }: { o: O }) {
  const c = o.costs;
  return (
    <Block
      id="b-costs"
      title="Coûts et marge (estimation)"
      lead="Estimation : coûts de l’IA enregistrés par PoppyTrip (USD) comparés aux revenus facturés de la période (EUR, abonnements + packs), convertis avec le taux USD_TO_EUR_RATE. Hors hébergement, frais de paiement et taxes."
    >
      <div className="tiles">
        <Tile label="Coût IA (période)" value={fmtUsd(c.totalUsd)} sub={c.costEurCents !== null ? `≈ ${fmtCents(c.costEurCents, 'eur')}` : 'taux de change non configuré'} />
        <Tile label="Revenus (période)" value={fmtCents(c.revenueEurCents, 'eur')} />
        <Tile label="Marge brute estimée" value={c.grossMarginEurCents !== null ? fmtCents(c.grossMarginEurCents, 'eur') : '—'} sub={c.marginRate !== null ? `${fmtPct(c.marginRate)} des revenus` : 'estimation indisponible'} />
      </div>
      <div className="grid">
        <Card title="Coût de l’IA par jour (USD)">
          <LineChart title="Coût de l’IA par jour" labels={days(c.daily)} series={[{ key: 'c', label: 'Coût', values: c.daily.map((d) => d.costUsd) }]} formatValue={fmtUsd} formatLabel={fmtDayShort} bars />
          <DataTable caption="Coût par jour" columns={[{ label: 'Jour' }, { label: 'Coût (USD)', numeric: true }]} rows={c.daily.map((d) => [fmtDay(d.day), fmtUsd(d.costUsd)])} />
        </Card>
        <Card title="Coût par modèle">
          <HBars title="Coût par modèle" items={c.byModel.map((m) => ({ label: `${m.model} (${m.provider})`, value: m.costUsd, detail: `${fmtInt(m.requests)} appels` }))} formatValue={fmtUsd} />
          <DataTable
            caption="Coût par modèle"
            columns={[{ label: 'Fournisseur' }, { label: 'Modèle' }, { label: 'Appels', numeric: true }, { label: 'Jetons entrée', numeric: true }, { label: 'Jetons sortie', numeric: true }, { label: 'Coût', numeric: true }]}
            rows={c.byModel.map((m) => [m.provider, m.model, fmtInt(m.requests), fmtInt(m.inputTokens), fmtInt(m.outputTokens), fmtUsd(m.costUsd)])}
          />
        </Card>
      </div>
    </Block>
  );
}

// --- Entonnoir ---------------------------------------------------------------------------
export function FunnelBlock({ o }: { o: O }) {
  const f = o.funnel;
  const steps = [
    { label: 'Inscrits', value: f.signups },
    { label: 'Premier voyage', value: f.withFirstTrip },
    { label: 'Au moins 3 activités', value: f.activated },
    { label: 'Passage par un paywall', value: f.hitPaywall },
    { label: 'Abonné', value: f.subscribed },
  ];
  const pct = (v: number) => (f.signups > 0 ? fmtPct(v / f.signups) : '—');
  return (
    <Block id="b-funnel" title="Entonnoir d’activation" lead="Cohortes inscrites pendant la période ; pourcentages rapportés aux inscrits. Les cohortes récentes ont eu moins de temps pour progresser.">
      <Card title="Entonnoir des cohortes de la période">
        <HBars title="Entonnoir d’activation" items={steps.map((s) => ({ label: s.label, value: s.value, detail: pct(s.value) }))} formatValue={fmtInt} max={f.signups} />
        <DataTable caption="Entonnoir" columns={[{ label: 'Étape' }, { label: 'Effectif', numeric: true }, { label: 'Part des inscrits', numeric: true }]} rows={steps.map((s) => [s.label, fmtInt(s.value), pct(s.value)])} />
      </Card>
    </Block>
  );
}

// --- Appareils et navigateurs ----------------------------------------------------------
export function ClientsBlock({ o }: { o: O }) {
  const c = o.clients;
  return (
    <Block
      id="b-clients"
      title="Appareils et navigateurs"
      lead="Sessions authentifiées. Portables et fixes sont regroupés dans « ordinateur » ; un iPad en mode ordinateur peut apparaître comme un ordinateur (macOS). Les versions qui pèsent moins de 5 % d’un navigateur sont regroupées sous « autres versions »."
    >
      <div className="grid">
        <Card title="Répartition par appareil">
          <HBars title="Sessions par appareil" items={c.devices.map((d) => ({ label: label(d.device), value: d.sessions, detail: fmtPct(d.share) }))} formatValue={fmtInt} />
          <DataTable caption="Sessions par appareil" columns={[{ label: 'Appareil' }, { label: 'Sessions', numeric: true }, { label: 'Part', numeric: true }]} rows={c.devices.map((d) => [label(d.device), fmtInt(d.sessions), fmtPct(d.share)])} />
        </Card>
        <Card title="Navigateurs les plus utilisés">
          <HBars title="Sessions par navigateur" items={c.browsers.slice(0, 10).map((b) => ({ label: label(b.browser), value: b.sessions, detail: fmtPct(b.share) }))} formatValue={fmtInt} />
          <DataTable
            caption="Versions majeures par navigateur"
            columns={[{ label: 'Navigateur' }, { label: 'Version' }, { label: 'Sessions', numeric: true }, { label: 'Part du navigateur', numeric: true }]}
            rows={c.browsers.flatMap((b) => b.versions.map((v) => [label(b.browser), v.major === OTHER_VERSIONS ? 'autres versions (< 5 %)' : v.major, fmtInt(v.sessions), fmtPct(v.share)]))}
          />
        </Card>
        <Card title="Versions des principaux navigateurs">
          {c.browsers.length === 0 ? (
            <p className="empty">Aucune donnée pour cette période.</p>
          ) : (
            c.browsers.slice(0, 5).map((b) => (
              <div key={b.browser}>
                <strong>{label(b.browser)}</strong>
                <ul className="versions">
                  {b.versions.map((v) => (
                    <li key={v.major}>
                      {v.major === OTHER_VERSIONS ? 'autres versions (anciennes ou rares)' : `version ${v.major}`} : {fmtPct(v.share)} ({fmtInt(v.sessions)})
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </Card>
        <Card title="Systèmes">
          <HBars title="Sessions par système" items={c.os.map((x) => ({ label: label(x.os), value: x.sessions, detail: fmtPct(x.share) }))} formatValue={fmtInt} />
        </Card>
        <Card title="Appareils dans le temps">
          <LineChart
            title="Sessions par appareil et par jour"
            labels={days(c.deviceDaily)}
            series={[
              { key: 'm', label: 'Mobile', values: c.deviceDaily.map((d) => d.mobile) },
              { key: 't', label: 'Tablette', values: c.deviceDaily.map((d) => d.tablet) },
              { key: 'd', label: 'Ordinateur', values: c.deviceDaily.map((d) => d.desktop) },
              { key: 'o', label: 'Autre', values: c.deviceDaily.map((d) => d.other) },
            ]}
            formatValue={fmtInt}
            formatLabel={fmtDayShort}
          />
          <DataTable
            caption="Sessions par appareil et par jour"
            columns={[{ label: 'Jour' }, { label: 'Mobile', numeric: true }, { label: 'Tablette', numeric: true }, { label: 'Ordinateur', numeric: true }, { label: 'Autre', numeric: true }]}
            rows={c.deviceDaily.map((d) => [fmtDay(d.day), fmtInt(d.mobile), fmtInt(d.tablet), fmtInt(d.desktop), fmtInt(d.other)])}
          />
        </Card>
      </div>
    </Block>
  );
}
