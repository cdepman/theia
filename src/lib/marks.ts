import type { OriginKind, SignalsPayload } from '../../shared/types';

/** One mark beside a press entry: a kind of outside source that also lists it, and which ones. */
export interface EntryMark {
  kind: OriginKind;
  /** The origins of this kind that list the entry, by display name, in their configured order. */
  names: string[];
}

/** Left to right, the order marks are always drawn in, so the same kind sits in the same place. */
export const MARK_ORDER: readonly OriginKind[] = ['search', 'social', 'reference', 'community', 'aggregator'];

export const KIND_TEXT: Record<OriginKind, string> = {
  press: 'Monitored press',
  search: 'Search trends',
  social: 'Platform trends',
  reference: 'Reference pages',
  community: 'Community front pages',
  aggregator: 'News aggregators',
};

/**
 * Which outside sources also list each press entry. Keyed by story id, or thread id when the
 * view shows threads. One mark per kind of source, however many origins of that kind list it.
 * Only origins that are enabled and visible count: a hidden origin leaves no mark.
 */
export function entryMarks(signals: SignalsPayload | undefined, unit: 'story' | 'thread'): Map<string, EntryMark[]> {
  const out = new Map<string, EntryMark[]>();
  if (!signals) return out;
  const origins = new Map(signals.origins.filter((o) => o.lane === 'attention' && o.enabled && o.visible).map((o) => [o.key, o]));
  const found = new Map<string, Map<OriginKind, Set<string>>>();
  for (const e of signals.items) {
    const id = unit === 'thread' ? e.threadId : e.storyId;
    const origin = origins.get(e.origin);
    if (!id || !origin || origin.kind === 'press') continue;
    let kinds = found.get(id);
    if (!kinds) found.set(id, (kinds = new Map()));
    let keys = kinds.get(origin.kind);
    if (!keys) kinds.set(origin.kind, (keys = new Set()));
    keys.add(origin.key);
  }
  for (const [id, kinds] of found) {
    const marks: EntryMark[] = [];
    for (const kind of MARK_ORDER) {
      const keys = kinds.get(kind);
      if (!keys) continue;
      const names = [...keys].map((k) => origins.get(k)!).sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name)).map((o) => o.name);
      marks.push({ kind, names });
    }
    if (marks.length > 0) out.set(id, marks);
  }
  return out;
}

/** "Google Trending Now and Hacker News", for labels and tooltips. */
export function marksText(marks: EntryMark[]): string {
  const names = marks.flatMap((m) => m.names);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
