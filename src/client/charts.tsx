/**
 * Graphiques SVG maison, compatibles avec une politique de contenu stricte : uniquement des
 * attributs de présentation (x, width, class…), jamais d'attribut style. Chaque graphique a :
 * un titre accessible, une légende textuelle (la couleur ne porte jamais seule le sens : motifs
 * de trait différents), une alternative en tableau et un état « aucune donnée ».
 */
import { useId, useState, type ReactNode } from 'react';

export const NO_DATA = 'Aucune donnée pour cette période.';
// Largeur de référence proche de la largeur réelle d'une carte : le texte reste lisible.
const W = 440;

export interface Series {
  key: string;
  label: string;
  values: number[];
}

/** Maximum de l'axe = 4 × un pas « rond » (1, 2, 2,5 ou 5 × 10^k) ; pas entier pour des comptages. */
function niceMax(v: number, integer: boolean): number {
  if (v <= 0) return integer ? 4 : 1;
  const raw = v / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  let step = 10 * p;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * p >= raw) {
      step = m * p;
      break;
    }
  }
  if (integer) step = Math.max(1, Math.ceil(step));
  return step * 4;
}

function xTicks(count: number, max = 6): number[] {
  if (count <= 1) return [0];
  const step = Math.max(1, Math.ceil((count - 1) / (max - 1)));
  const out: number[] = [];
  for (let i = 0; i < count; i += step) out.push(i);
  if (out[out.length - 1] !== count - 1) out.push(count - 1);
  return out;
}

export function Legend({ items }: { items: Array<{ label: string; index: number }> }) {
  return (
    <ul className="legend">
      {items.map((it) => (
        <li key={it.label}>
          <svg width="22" height="10" aria-hidden="true">
            <line x1="1" y1="5" x2="21" y2="5" className={`line s${(it.index % 5) + 1} dash-${it.index % 4}`} />
          </svg>
          {it.label}
        </li>
      ))}
    </ul>
  );
}

export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: Array<{ label: string; numeric?: boolean }>;
  rows: Array<Array<ReactNode>>;
}) {
  return (
    <details className="table-alt">
      <summary>Voir le tableau</summary>
      <div className="table-wrap">
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.label} scope="col" className={c.numeric ? 'num' : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((cell, j) => (
                  <td key={j} className={columns[j]?.numeric ? 'num' : undefined}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function Card({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <article className="card" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {note ? <p className="note">{note}</p> : null}
      {children}
    </article>
  );
}

/** Courbes (une ou plusieurs séries, même unité : un seul axe), avec réticule au survol. */
export function LineChart({
  title,
  labels,
  series,
  formatValue,
  formatLabel,
  height = 220,
  bars = false,
}: {
  title: string;
  labels: string[];
  series: Series[];
  formatValue: (n: number) => string;
  formatLabel: (l: string) => string;
  height?: number;
  bars?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = series.reduce((s, x) => s + x.values.reduce((a, b) => a + Math.abs(b), 0), 0);
  if (labels.length === 0 || total === 0) return <p className="empty">{NO_DATA}</p>;

  const m = { top: 10, right: 12, bottom: 24, left: 56 };
  const iw = W - m.left - m.right;
  const ih = height - m.top - m.bottom;
  const allInt = series.every((s) => s.values.every((v) => Number.isInteger(v)));
  const maxV = niceMax(Math.max(...(bars ? sumStack(series, labels.length) : series.flatMap((s) => s.values))), allInt);
  const x = (i: number) => m.left + (labels.length === 1 ? iw / 2 : (i * iw) / (labels.length - 1));
  const y = (v: number) => m.top + ih - (v / maxV) * ih;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxV);
  const band = iw / labels.length;
  const xb = (i: number) => m.left + i * band;

  const summary = `${title} : ${series
    .map((s) => `${s.label}, total ${formatValue(s.values.reduce((a, b) => a + b, 0))}`)
    .join(' ; ')}, du ${formatLabel(labels[0]!)} au ${formatLabel(labels[labels.length - 1]!)}.`;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * iw;
    const i = bars ? Math.floor(px / band) : Math.round((px / iw) * (labels.length - 1));
    setHover(Math.max(0, Math.min(labels.length - 1, i)));
  };

  return (
    <>
      {series.length > 1 ? <Legend items={series.map((s, i) => ({ label: s.label, index: i }))} /> : null}
      <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={summary}>
        {yTicks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={m.left} x2={W - m.right} y1={y(t)} y2={y(t)} />
            <text x={m.left - 6} y={y(t) + 4} textAnchor="end">
              {formatValue(t)}
            </text>
          </g>
        ))}
        <line className="axis-line" x1={m.left} x2={W - m.right} y1={m.top + ih} y2={m.top + ih} />
        {xTicks(labels.length).map((i) => (
          <text key={i} x={bars ? xb(i) + band / 2 : x(i)} y={height - 6} textAnchor="middle">
            {formatLabel(labels[i]!)}
          </text>
        ))}
        {bars
          ? labels.map((_, i) => {
              let acc = 0;
              return series.map((s, si) => {
                const v = s.values[i] ?? 0;
                const y0 = y(acc);
                acc += v;
                const h = Math.max(0, y0 - y(acc));
                return h > 0 ? (
                  <rect
                    key={`${si}-${i}`}
                    className={`bar s${(si % 5) + 1}`}
                    x={xb(i) + Math.min(1, band * 0.1)}
                    width={Math.max(0.5, band - Math.min(2, band * 0.2))}
                    y={y0 - h}
                    height={h}
                    rx={band > 8 ? 2 : 0}
                  />
                ) : null;
              });
            })
          : series.map((s, si) => (
              <polyline
                key={s.key}
                className={`line s${(si % 5) + 1} dash-${si % 4}`}
                points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
              />
            ))}
        {hover !== null ? (
          <g aria-hidden="true">
            <line className="crosshair" x1={bars ? xb(hover) + band / 2 : x(hover)} x2={bars ? xb(hover) + band / 2 : x(hover)} y1={m.top} y2={m.top + ih} />
            <Tooltip
              x={bars ? xb(hover) + band / 2 : x(hover)}
              y={m.top + 4}
              lines={[formatLabel(labels[hover]!), ...series.map((s) => `${s.label} : ${formatValue(s.values[hover] ?? 0)}`)]}
              chartWidth={W}
            />
          </g>
        ) : null}
        <rect className="hit" x={m.left} y={m.top} width={iw} height={ih} onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
    </>
  );
}

function sumStack(series: Series[], len: number): number[] {
  return Array.from({ length: len }, (_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
}

function Tooltip({ x, y, lines, chartWidth }: { x: number; y: number; lines: string[]; chartWidth: number }) {
  const width = Math.max(...lines.map((l) => l.length)) * 6.6 + 16;
  const height = lines.length * 16 + 8;
  const left = x + 10 + width > chartWidth ? x - 10 - width : x + 10;
  return (
    <g>
      <rect className="tooltip-bg" x={left} y={y} width={width} height={height} rx={4} />
      {lines.map((l, i) => (
        <text key={i} className="tooltip-text" x={left + 8} y={y + 16 + i * 16}>
          {l}
        </text>
      ))}
    </g>
  );
}

/**
 * Barres horizontales étiquetées (catégories, entonnoir, parts) : libellés et valeurs en HTML
 * (taille de texte réelle), seule la barre est en SVG.
 */
export function HBars({
  title,
  items,
  formatValue,
  max,
}: {
  title: string;
  items: Array<{ label: string; value: number; detail?: string }>;
  formatValue: (n: number) => string;
  max?: number;
}) {
  if (items.length === 0 || items.every((i) => i.value === 0)) return <p className="empty">{NO_DATA}</p>;
  const top = max ?? Math.max(...items.map((i) => i.value));
  return (
    <ul className="hbars" aria-label={title}>
      {items.map((it) => {
        const w = top > 0 ? Math.max(it.value > 0 ? 0.5 : 0, (it.value / top) * 100) : 0;
        return (
          <li key={it.label}>
            <span className="hb-label">{it.label}</span>
            <svg className="hb-bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
              <rect className="track" x={0} y={0} width={100} height={10} rx={1.5} />
              <rect className="bar s1" x={0} y={0} width={w} height={10} rx={1.5} />
            </svg>
            <span className="hb-value">
              {formatValue(it.value)}
              {it.detail ? ` · ${it.detail}` : ''}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Carte thermique 7 × 24, échelle séquentielle à une teinte, valeurs dans l'info-bulle et le tableau. */
export function Heatmap({
  title,
  rows,
  rowLabels,
  formatValue,
}: {
  title: string;
  rows: Array<Array<number | null>>;
  rowLabels: string[];
  formatValue: (n: number) => string;
}) {
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const values = rows.flat().filter((v): v is number => v !== null);
  if (values.length === 0) return <p className="empty">{NO_DATA}</p>;
  const max = Math.max(...values);
  const left = 70;
  const cell = (W - left) / 24;
  const ch = 22;
  const height = rows.length * ch + 22;
  const bin = (v: number | null) => (v === null ? 0 : max === 0 ? 1 : Math.min(7, 1 + Math.floor((v / max) * 6.999)));
  return (
    <>
      <svg className="chart" viewBox={`0 0 ${W} ${height + 40}`} role="img" aria-label={`${title} (détail dans le tableau)`}>
        {rows.map((row, r) => (
          <g key={r}>
            <text x={0} y={r * ch + 15}>
              {rowLabels[r]}
            </text>
            {row.map((v, c) => (
              <rect
                key={c}
                className={`q${bin(v)}`}
                x={left + c * cell + 1}
                y={r * ch + 1}
                width={cell - 2}
                height={ch - 2}
                rx={2}
                onPointerEnter={() => setHover({ r, c })}
                onPointerLeave={() => setHover(null)}
              />
            ))}
          </g>
        ))}
        {[0, 6, 12, 18, 23].map((hh) => (
          <text key={hh} x={left + hh * cell + cell / 2} y={rows.length * ch + 14} textAnchor="middle">
            {hh} h
          </text>
        ))}
        <g transform={`translate(${left}, ${height + 4})`} aria-hidden="true">
          <text x={0} y={12}>
            faible
          </text>
          {[1, 2, 3, 4, 5, 6, 7].map((q) => (
            <rect key={q} className={`q${q}`} x={44 + (q - 1) * 22} y={2} width={20} height={12} rx={2} />
          ))}
          <text x={44 + 7 * 22 + 6} y={12}>
            élevé (max {formatValue(max)})
          </text>
        </g>
        {hover ? (
          <Tooltip
            x={left + hover.c * cell + cell / 2}
            y={hover.r * ch + ch}
            lines={[`${rowLabels[hover.r]} ${hover.c} h`, rows[hover.r]![hover.c] === null ? 'aucune mesure' : formatValue(rows[hover.r]![hover.c]!)]}
            chartWidth={W}
          />
        ) : null}
      </svg>
    </>
  );
}

/** Barre de progression : couleur ET texte du niveau (jamais la couleur seule). */
export function Progress({ percent, level, label }: { percent: number; level: 'ok' | 'warn' | 'critical'; label: string }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <svg className="chart" viewBox={`0 0 ${W} 22`} role="img" aria-label={label}>
      <rect className="track" x={0} y={3} width={W} height={16} rx={4} />
      <rect className={`lvl-${level}`} x={0} y={3} width={(p / 100) * W} height={16} rx={4} />
    </svg>
  );
}

export function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}
