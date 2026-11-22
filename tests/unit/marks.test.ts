import { describe, expect, it } from 'vitest';
import type { Origin, OriginKind, SignalEntry, SignalsPayload } from '../../shared/types';
import { entryMarks, marksText } from '../../src/lib/marks';

function origin(key: string, name: string, kind: OriginKind, displayOrder: number, over: Partial<Origin> = {}): Origin {
  return {
    key, name, kind, lane: kind === 'press' ? 'press' : 'attention', weight: 1, displayOrder, visible: true, enabled: true,
    attribution: null, termsUrl: null, tags: [], sources: [], lastSuccessAt: null, ...over,
  };
}

function entry(originKey: string, kind: OriginKind, storyId: string | null, threadId: string | null = null): SignalEntry {
  return {
    id: `${originKey}-${storyId}-${threadId}`, origin: originKey, originKind: kind, scope: 'US', title: 't', url: null, language: 'en', summary: null,
    entityId: null, related: [], rank: 1, bestRank: 1, originRank: 1, daysSeen: 1, metricKind: null, metricValue: null, score: 1,
    firstSeenAt: '2026-11-20T00:00:00Z', lastSeenAt: '2026-11-20T00:00:00Z', storyId, threadId,
  };
}

function payload(origins: Origin[], items: SignalEntry[]): SignalsPayload {
  return { schemaVersion: 1, country: 'US', window: '24h', windowStart: '2026-11-19T00:00:00Z', observationCutoff: '2026-11-20T00:00:00Z', origins, items };
}

const ORIGINS = [
  origin('press', 'Monitored press', 'press', 0),
  origin('google_trending_now', 'Google Trending Now', 'search', 10),
  origin('x_trends', 'X trends', 'social', 20),
  origin('wikipedia_pageviews', 'Wikipedia most viewed', 'reference', 40),
  origin('wikipedia_in_the_news', 'Wikipedia: In the news', 'reference', 50),
  origin('wikipedia_most_read', 'Wikipedia most read, by language', 'reference', 60, { visible: false }),
  origin('hackernews', 'Hacker News', 'community', 70),
  origin('techmeme', 'Techmeme', 'aggregator', 80),
];

describe('source marks beside press entries', () => {
  it('gives one mark per kind of source, in a fixed order, naming every origin of that kind', () => {
    const marks = entryMarks(payload(ORIGINS, [
      entry('techmeme', 'aggregator', 'a'),
      entry('wikipedia_in_the_news', 'reference', 'a'),
      entry('wikipedia_pageviews', 'reference', 'a'),
      entry('google_trending_now', 'search', 'a'),
      entry('google_trending_now', 'search', 'a'),
      entry('hackernews', 'community', 'b'),
    ]), 'story');
    expect(marks.get('a')).toEqual([
      { kind: 'search', names: ['Google Trending Now'] },
      { kind: 'reference', names: ['Wikipedia most viewed', 'Wikipedia: In the news'] },
      { kind: 'aggregator', names: ['Techmeme'] },
    ]);
    expect(marks.get('b')).toEqual([{ kind: 'community', names: ['Hacker News'] }]);
    expect(marksText(marks.get('a')!)).toBe('Google Trending Now, Wikipedia most viewed, Wikipedia: In the news and Techmeme');
    expect(marksText(marks.get('b')!)).toBe('Hacker News');
  });

  it('ignores entries with no press match, and origins that are hidden or switched off', () => {
    const origins = ORIGINS.map((o) => (o.key === 'hackernews' ? { ...o, enabled: false } : o));
    const marks = entryMarks(payload(origins, [
      entry('x_trends', 'social', null),
      entry('wikipedia_most_read', 'reference', 'a'),
      entry('hackernews', 'community', 'a'),
    ]), 'story');
    expect(marks.size).toBe(0);
    expect(entryMarks(undefined, 'story').size).toBe(0);
  });

  it('keys by thread when the view shows threads', () => {
    const items = [entry('x_trends', 'social', 's1', 't1'), entry('google_trending_now', 'search', 's2', 't1'), entry('techmeme', 'aggregator', 's3', null)];
    const marks = entryMarks(payload(ORIGINS, items), 'thread');
    expect([...marks.keys()]).toEqual(['t1']);
    expect(marks.get('t1')!.map((m) => m.kind)).toEqual(['search', 'social']);
    expect([...entryMarks(payload(ORIGINS, items), 'story').keys()].sort()).toEqual(['s1', 's2', 's3']);
  });
});
