import type { SeriesPoint } from '../../../shared/types';
import { formatDay, plural } from '../../lib/format';

/**
 * Daily distinct publishers, one bar per UTC day. A day with no coverage is an empty
 * slot on the baseline. A day we know nothing about (before collection or during an outage) is drawn
 * as a dotted gap, never as a zero. Partial days are drawn lighter.
 */
export function CoverageSparkline({ series, countryName }: { series: SeriesPoint[]; countryName: string }) {
  const top = Math.max(0, ...series.map((p) => p.count ?? 0));
  const max = Math.max(1, top);
  const W = 360;
  const H = 72;
  const slot = W / Math.max(series.length, 1);
  const bar = Math.max(2, slot - 3);
  const known = series.filter((p) => p.known);
  const unknown = series.length - known.length;
  const active = known.filter((p) => (p.count ?? 0) > 0).length;
  const peak = known.reduce<SeriesPoint | null>((best, p) => ((p.count ?? 0) > (best?.count ?? 0) ? p : best), null);
  const label =
    known.length === 0
      ? `No daily coverage is known yet for ${countryName}.`
      : `Daily coverage in ${countryName}: covered on ${plural(active, 'day')}` +
        (peak ? `, peaking at ${plural(peak.count ?? 0, 'publisher')} on ${formatDay(peak.day)}` : '') +
        (unknown > 0 ? `. ${plural(unknown, 'day')} before collection or during recorded gaps are unknown.` : '.');

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H + 4}`} width="100%" role="img" aria-label={label} className="block overflow-visible">
        <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} stroke="var(--shore)" strokeWidth={1} />
        {series.map((p, i) => {
          const x = i * slot + (slot - bar) / 2;
          if (!p.known) {
            return <line key={p.day} x1={x} x2={x + bar} y1={H - 3} y2={H - 3} stroke="var(--ink-faint)" strokeWidth={1.5} strokeDasharray="1.5 2.5" />;
          }
          const count = p.count ?? 0;
          if (count === 0) return null;
          const h = Math.max(3, (count / max) * (H - 6));
          return (
            <rect key={p.day} x={x} y={H - h} width={bar} height={h} rx={1} fill="var(--cobalt)" opacity={p.partial ? 0.5 : 1}>
              <title>{`${formatDay(p.day)}: ${plural(count, 'publisher')}${p.partial ? ' (partial day)' : ''}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="mt-1.5 flex justify-between text-[0.8rem] text-ink-soft tabular">
        <span>{formatDay(series[0]?.day)}</span>
        <span>
          {known.length === 0 ? 'no known days yet' : top === 0 ? 'no coverage on known days' : `peak ${top} ${top === 1 ? 'publisher' : 'publishers'} in a day`}
        </span>
        <span>{formatDay(series[series.length - 1]?.day)}</span>
      </figcaption>
      {unknown > 0 && (
        <p className="mt-1 text-[0.8rem] text-ink-faint">Dotted days are unknown, from before collection began or during recorded gaps. Lighter bars are partial days and may undercount.</p>
      )}
    </figure>
  );
}
