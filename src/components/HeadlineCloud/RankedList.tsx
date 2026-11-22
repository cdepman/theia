import type { ViewItem, ViewPayload } from '../../../shared/types';
import { plural } from '../../lib/format';
import { type EntryMark, KIND_TEXT, marksText } from '../../lib/marks';
import { stepFor } from '../../lib/visualization/layout';
import { OriginMark } from '../OriginMark/OriginMark';
import { STATUS_TEXT, StatusMark } from './StatusMark';

const LIST_SIZES = ['1.02rem', '1.12rem', '1.28rem', '1.5rem', '1.78rem'];

export function itemMeta(item: ViewItem): string {
  if (item.unit === 'thread') {
    return `${plural(item.publisherDays ?? item.metricValue, 'publisher-day')} over ${plural(item.activeDays ?? 0, 'day')}, ${plural(item.publisherCount, 'publisher')}`;
  }
  return `${plural(item.publisherCount, 'publisher')}, ${plural(item.articleCount, 'article')}`;
}

/** The ranked editorial layout: used on narrow screens and whenever the cloud cannot fit without collisions. */
export function RankedList({ view, selectedId, onSelect, marks }: { view: ViewPayload; selectedId: string | null; onSelect: (item: ViewItem) => void; marks?: Map<string, EntryMark[]> }) {
  return (
    <ol className="m-0 list-none p-0">
      {view.stories.map((item) => {
        const step = stepFor(item.metricValue, view.metricRange.min, view.metricRange.max);
        const selected = item.id === selectedId;
        const sources = marks?.get(item.id) ?? [];
        return (
          <li key={item.id} className="border-b border-shore/70 last:border-b-0">
            <button
              type="button"
              onClick={() => onSelect(item)}
              aria-pressed={selected}
              className={`flex w-full cursor-pointer gap-3 px-1 py-3 text-left hover:text-cobalt ${selected ? 'text-cobalt' : 'text-ink'}`}
            >
              <span className="tabular w-6 shrink-0 pt-[0.2em] text-right text-[0.85rem] text-ink-faint">{item.rank}</span>
              <span className="min-w-0">
                <span lang={item.language} className="block font-medium leading-[1.18] tracking-[-0.01em]" style={{ fontSize: LIST_SIZES[step] }}>
                  {item.shortLabel ?? item.headline}
                </span>
                <span className="mt-1 flex items-center gap-1.5 text-[0.85rem] text-ink-soft">
                  {item.unit === 'thread' && item.status && <StatusMark status={item.status} />}
                  <span>
                    {itemMeta(item)}
                    {item.unit === 'thread' && item.status && item.status !== 'unknown' ? `. ${STATUS_TEXT[item.status]}.` : ''}
                  </span>
                  {sources.length > 0 && (
                    <span className="flex shrink-0 items-center gap-1 text-ink-soft" data-testid="list-marks">
                      {sources.map((m) => (
                        <OriginMark key={m.kind} kind={m.kind} size={11} title={`${KIND_TEXT[m.kind]}: ${m.names.join(', ')}`} />
                      ))}
                      <span className="sr-only">Also listed by {marksText(sources)}.</span>
                    </span>
                  )}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
