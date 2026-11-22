import { describe, expect, it } from 'vitest';
import { scoreLabeledPairs } from '../../pipeline/group/evaluate';

describe('model comparison scoring', () => {
  it('uses the labeled publisher when identical titles occur at multiple outlets', () => {
    const articles = [
      { id: '1', publisher: 'a', headline: 'Same title' },
      { id: '2', publisher: 'b', headline: 'Same title' },
      { id: '3', publisher: 'c', headline: 'Other title' },
    ];
    const events = new Map([['1', 'event-1'], ['2', 'event-2'], ['3', 'event-1']]);
    const result = scoreLabeledPairs(events, articles, [
      { language: 'en', publisherA: 'a', publisherB: 'c', a: 'Same title', b: 'Other title', label: 'same' },
      { language: 'en', publisherA: 'b', publisherB: 'c', a: 'Same title', b: 'Other title', label: 'different' },
    ]);
    expect(result).toMatchObject({ sameTotal: 1, sameHit: 1, diffTotal: 1, diffHit: 1, unavailable: 0 });
  });

  it('does not score ambiguous titles or stale articles outside the tested corpus', () => {
    const articles = [
      { id: '1', publisher: 'a', headline: 'Repeated' },
      { id: '2', publisher: 'a', headline: 'Repeated' },
      { id: '3', publisher: 'b', headline: 'Stale' },
    ];
    const events = new Map([['1', 'event-1'], ['2', 'event-2']]);
    expect(scoreLabeledPairs(events, articles, [
      { language: 'en', a: 'Repeated', b: 'Stale', label: 'same' },
      { language: 'en', a: 'Repeated', b: 'Repeated', label: 'unsure' },
    ])).toMatchObject({ sameTotal: 0, diffTotal: 0, unavailable: 1 });
  });
});
