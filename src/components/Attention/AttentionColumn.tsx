import { useMemo, useState } from 'react';
import { COUNTRY_NAMES, type CountryCode, WINDOW_LABELS, type WindowCode } from '../../../shared/constants';
import type { Origin, SignalEntry, SignalsPayload } from '../../../shared/types';
import { useSignals } from '../../lib/api/client';
import { languageName, plural, relativeTime } from '../../lib/format';
import { KIND_TEXT } from '../../lib/marks';
import { OriginMark } from '../OriginMark/OriginMark';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const GROUP_LIMIT = 6;

export function metricText(e: Pick<SignalEntry, 'metricKind' | 'metricValue'>): string | null {
  if (e.metricValue === null || e.metricValue === undefined) return null;
  const n = Number(e.metricValue);
  switch (e.metricKind) {
    case 'approx_searches':
      return `${compact.format(n)}+ searches`;
    case 'post_count':
      return `${compact.format(n)} posts`;
    case 'views_ceil':
      return `up to ${n.toLocaleString('en')} views`;
    case 'views':
      return `${n.toLocaleString('en')} views`;
    case 'points':
      return plural(n, 'point');
    case 'bookmarks':
      return plural(n, 'bookmark');
    default:
      return null;
  }
}

export function scopeText(scope: string, country: CountryCode): string | null {
  if (scope === country) return null;
  if (scope === 'global') return 'worldwide';
  if (scope === 'us-politics') return 'US politics';
  return /^[a-z]{2}$/.test(scope) ? `${languageName(scope)} edition` : scope;
}

function entryMeta(e: SignalEntry, country: CountryCode, window: WindowCode): string {
  const parts = [metricText(e), scopeText(e.scope, country), window !== '24h' && e.daysSeen > 1 ? `listed on ${e.daysSeen} days` : null];
  return parts.filter(Boolean).join(', ');
}

/** Why an origin has nothing to show, in terms the owner can act on. */
function originNote(o: Origin): string {
  if (!o.enabled) return 'Collection is switched off in config/signal-sources.json.';
  const failing = o.sources.find((s) => s.state === 'needs_attention' || s.state === 'retrying');
  if (failing) return `Not updating: ${failing.lastError ?? 'the last check failed'}.`;
  if (!o.lastSuccessAt) return o.key.startsWith('x_') ? 'Not collected yet. Set X_BEARER_TOKEN, then run the pipeline.' : 'Not collected yet. Run the pipeline.';
  return 'Nothing listed in this window.';
}

function Entry({ e, n, country, window, showOrigin, originName, onStory }: {
  e: SignalEntry; n: number; country: CountryCode; window: WindowCode; showOrigin: boolean; originName: string; onStory: (storyId: string) => void;
}) {
  const meta = entryMeta(e, country, window);
  return (
    <li className="flex gap-2.5 border-b border-shore/60 py-2 last:border-b-0">
      <span className="tabular w-5 shrink-0 pt-[0.15em] text-right text-[0.8rem] text-ink-faint">{n}</span>
      <div className="min-w-0">
        {e.url ? (
          <a href={e.url} target="_blank" rel="noreferrer noopener" lang={e.language ?? undefined} className="font-medium leading-[1.22] text-ink underline-offset-[3px] hover:text-cobalt hover:underline">
            {e.title}
          </a>
        ) : (
          <span lang={e.language ?? undefined} className="font-medium leading-[1.22]">{e.title}</span>
        )}
        {e.summary && <p className="m-0 mt-0.5 line-clamp-2 text-[0.85rem] leading-snug text-ink-soft">{e.summary}</p>}
        <p className="m-0 mt-0.5 text-[0.8rem] leading-snug text-ink-soft">
          {showOrigin && <span className="mr-1 rounded-sm bg-sea-deep px-1 py-px text-ink">{originName}</span>}
          {meta}
          {e.storyId && (
            <>
              {meta ? '. ' : ''}
              <button type="button" className="cursor-pointer text-cobalt underline underline-offset-[3px]" onClick={() => onStory(e.storyId!)}>
                Also in the monitored press
              </button>
            </>
          )}
        </p>
      </div>
    </li>
  );
}

function Group({ origin, items, country, window, onStory }: { origin: Origin; items: SignalEntry[]; country: CountryCode; window: WindowCode; onStory: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, GROUP_LIMIT);
  return (
    <section className="pt-3" aria-label={origin.name}>
      <h3 className="m-0 flex items-baseline justify-between gap-3 text-[1rem] font-semibold leading-tight">
        {/* The same mark that sits beside press entries this source also lists, so the lane doubles as the key. */}
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="text-ink-soft">
            <OriginMark kind={origin.kind} size={12} title={KIND_TEXT[origin.kind]} />
          </span>
          <span>{origin.name}</span>
        </span>
        <span className="tabular shrink-0 text-[0.78rem] font-normal text-ink-faint">{origin.lastSuccessAt ? `checked ${relativeTime(origin.lastSuccessAt)}` : ''}</span>
      </h3>
      {items.length === 0 ? (
        <p className="m-0 mt-1 text-[0.85rem] text-ink-soft">{originNote(origin)}</p>
      ) : (
        <>
          <ol className="m-0 list-none p-0">
            {shown.map((e, i) => (
              <Entry key={e.id} e={e} n={i + 1} country={country} window={window} showOrigin={false} originName={origin.name} onStory={onStory} />
            ))}
          </ol>
          {items.length > GROUP_LIMIT && (
            <button type="button" className="cursor-pointer pt-1 text-[0.82rem] text-ink-soft underline underline-offset-[3px] hover:text-ink" onClick={() => setOpen(!open)}>
              {open ? 'Show fewer' : `Show all ${items.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** True when at least one non-press origin is configured, so the lane has something to say. */
export function hasAttention(data: SignalsPayload | undefined): boolean {
  return Boolean(data?.origins.some((o) => o.lane === 'attention' && o.sources.length > 0));
}

/**
 * The attention lane: entries from searches, platforms, reference sites and aggregators,
 * each attributed to its origin. Grouped by origin, or blended by weighted score.
 */
export function AttentionColumn({ country, window, onStory }: { country: CountryCode; window: WindowCode; onStory: (storyId: string) => void }) {
  const query = useSignals(country, window);
  const data = query.data;
  const [blended, setBlended] = useState(false);
  // Per-origin overrides of the configured default visibility, for this session.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const origins = useMemo(() => (data?.origins ?? []).filter((o) => o.lane === 'attention' && o.sources.length > 0), [data]);
  const isOn = (o: Origin) => toggled[o.key] ?? o.visible;
  const names = useMemo(() => new Map(origins.map((o) => [o.key, o.name])), [origins]);
  const visibleKeys = new Set(origins.filter(isOn).map((o) => o.key));
  const items = (data?.items ?? []).filter((e) => visibleKeys.has(e.origin));

  if (query.isPending) return <p className="p-4 text-[0.9rem] text-ink-soft">Loading public attention.</p>;
  if (query.isError && !data) {
    return (
      <p className="m-4 rounded-sm bg-alert-wash px-3 py-2 text-[0.9rem] text-alert" role="alert">
        Public attention could not be loaded: {query.error.message}.
      </p>
    );
  }
  if (!data || origins.length === 0) return null;

  return (
    <div className="px-4 pb-6 pt-3 md:px-5">
      <h2 className="m-0 text-[1.15rem] font-semibold leading-tight tracking-[-0.01em]">Public attention</h2>
      <p className="m-0 mt-0.5 text-[0.82rem] leading-snug text-ink-soft">
        Trending searches, platform trends and most-read pages for {COUNTRY_NAMES[country]}, last {WINDOW_LABELS[window]}. These lists come from other
        services and are not the monitored press.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Sources shown">
        {origins.map((o) => (
          <button
            key={o.key}
            type="button"
            aria-pressed={isOn(o)}
            onClick={() => setToggled({ ...toggled, [o.key]: !isOn(o) })}
            className={`cursor-pointer rounded-sm border px-1.5 py-0.5 text-[0.8rem] leading-tight ${isOn(o) ? 'border-ink bg-ink text-paper' : 'border-shore bg-transparent text-ink-soft hover:text-ink'}`}
          >
            {o.name}
          </button>
        ))}
      </div>
      <p className="m-0 mt-2 text-[0.82rem] text-ink-soft">
        <button type="button" className="cursor-pointer underline underline-offset-[3px] hover:text-ink" onClick={() => setBlended(!blended)}>
          {blended ? 'Group by source' : 'Blend into one list by weight'}
        </button>
      </p>

      {blended ? (
        items.length === 0 ? (
          <p className="mt-3 text-[0.9rem] text-ink-soft">Nothing listed in this window for the sources shown.</p>
        ) : (
          <ol className="m-0 mt-2 list-none p-0">
            {items.slice(0, 60).map((e, i) => (
              <Entry key={e.id} e={e} n={i + 1} country={country} window={window} showOrigin originName={names.get(e.origin) ?? e.origin} onStory={onStory} />
            ))}
          </ol>
        )
      ) : (
        origins.filter(isOn).map((o) => <Group key={o.key} origin={o} items={items.filter((e) => e.origin === o.key)} country={country} window={window} onStory={onStory} />)
      )}
    </div>
  );
}
