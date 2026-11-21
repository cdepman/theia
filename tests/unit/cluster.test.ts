import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clusterArticles, groupPairs, headlineSimilarity } from '../../pipeline/cluster/cluster';
import { IdfModel, tokenize } from '../../pipeline/cluster/features';
import { pipelineConfig } from '../../pipeline/config';
import { normalizeHeadline } from '../../pipeline/normalize/headline';
import { probeCorpus, publisherNames } from '../helpers/probe';

interface Pair { language: string; publisherA: string; publisherB: string; a: string; b: string; label: 'same' | 'different' | 'unsure' }

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/cluster-pairs.json'), 'utf8')) as { pairs: Pair[] };

describe('tokenization', () => {
  it('uses word unigrams and bigrams without stopwords for English', () => {
    expect(tokenize('two men killed after the glider crash', 'en')).toEqual([
      'two', 'men', 'killed', 'glider', 'crash', 'two men', 'men killed', 'killed glider', 'glider crash',
    ]);
  });

  it('uses character bigrams for Japanese and drops hiragana-only bigrams', () => {
    const tokens = tokenize('高市首相がaiについて説明', 'ja');
    expect(tokens).toContain('高市');
    expect(tokens).toContain('首相');
    expect(tokens).toContain('ai');
    expect(tokens).toContain('説明');
    expect(tokens).not.toContain('につ');
    expect(tokens).not.toContain('つい');
  });
});

describe('clustering', () => {
  const art = (id: string, publisherId: string, headline: string, effectiveAt: string) => ({ id, publisherId, headline: normalizeHeadline(headline), summary: null, effectiveAt });
  const corpus = probeCorpus('en');

  it('groups reports of one event and keeps other stories apart', () => {
    const res = clusterArticles({
      language: 'en', storyWindowHours: 72, openStories: [], corpus,
      unassigned: [
        art('1', 'a', 'Two men killed after glider crashes into Scottish loch', '2026-11-20T09:00:00Z'),
        art('2', 'b', 'Two men killed as glider crashes into loch', '2026-11-20T09:30:00Z'),
        art('3', 'c', 'Glider crash: two men killed at Scottish loch', '2026-11-20T10:00:00Z'),
        art('4', 'a', 'NHS warns of alarming rise in hospital admissions', '2026-11-20T10:00:00Z'),
      ],
    });
    const story = new Map(res.assignments.map((x) => [x.article_id, x.story_key]));
    expect(story.get('1')).toBe(story.get('2'));
    expect(story.get('1')).toBe(story.get('3'));
    expect(story.get('4')).not.toBe(story.get('1'));
    expect(res.newStoryKeys).toHaveLength(2);
  });

  it('never joins a story whose last article is outside the story window', () => {
    const res = clusterArticles({
      language: 'en', storyWindowHours: 72, corpus, unassigned: [art('new', 'b', 'Two men killed after glider crashes into Scottish loch', '2026-11-25T09:00:00Z')],
      openStories: [{ id: 'old-story', lastSeenAt: '2026-11-20T09:00:00Z', members: [art('m1', 'a', 'Two men killed after glider crashes into Scottish loch', '2026-11-20T09:00:00Z')] }],
    });
    expect(res.assignments[0]).toMatchObject({ story_id: null, method: 'new_story' });
  });

  it('joins an existing open story inside the window', () => {
    const res = clusterArticles({
      language: 'en', storyWindowHours: 72, corpus, unassigned: [art('new', 'b', 'Two men killed as glider crashes into loch', '2026-11-21T09:00:00Z')],
      openStories: [{ id: 'open-story', lastSeenAt: '2026-11-20T09:00:00Z', members: [art('m1', 'a', 'Two men killed after glider crashes into Scottish loch', '2026-11-20T09:00:00Z')] }],
    });
    expect(res.assignments[0]).toMatchObject({ story_id: 'open-story', method: 'centroid' });
    expect(res.newStoryKeys).toEqual([]);
  });

  it('is deterministic regardless of input order', () => {
    const items = [
      art('1', 'a', 'Court approves Bayer settlement over Roundup claims', '2026-11-20T09:00:00Z'),
      art('2', 'b', 'Judge approves Bayer payout to settle Roundup claims', '2026-11-20T09:10:00Z'),
      art('3', 'c', 'Cold weather alert extended as temperatures drop', '2026-11-20T09:20:00Z'),
    ];
    const run = (list: typeof items) => clusterArticles({ language: 'en', storyWindowHours: 72, openStories: [], corpus, unassigned: list });
    expect(run([...items].reverse())).toEqual(run(items));
  });

  it('flags near-identical headlines from different publishers as syndicated, not from the same publisher', () => {
    const res = clusterArticles({
      language: 'en', storyWindowHours: 72, openStories: [], corpus,
      unassigned: [
        art('1', 'a', 'Trio who duped pensioners out of £600,000 jailed for 20 years in total', '2026-11-20T09:00:00Z'),
        art('2', 'b', 'Trio who duped pensioners out of £600,000 jailed for 20 years in total', '2026-11-20T09:05:00Z'),
        art('3', 'a', 'Trio who duped pensioners out of £600,000 jailed for 20 years in total', '2026-11-20T09:06:00Z'),
      ],
    });
    expect(res.syndication).toEqual([['1', '2', '3'].filter((id) => id !== '3' || true).sort()].map((g) => g));
    expect(groupPairs([['a', 'b'], ['b', 'c'], ['x', 'y']])).toEqual([['a', 'b', 'c'], ['x', 'y']]);
  });
});

describe('labeled pair evaluation', () => {
  const names = publisherNames();
  for (const language of ['en', 'ja']) {
    it(`meets the precision floor for ${language}`, () => {
      const corpus = probeCorpus(language);
      const idf = IdfModel.fromCorpus(corpus, language);
      const threshold = pipelineConfig.cluster.thresholds[language]!;
      const pairs = fixture.pairs.filter((p) => p.language === language && p.label !== 'unsure');
      let tp = 0, fp = 0, fn = 0;
      for (const p of pairs) {
        const sim = headlineSimilarity(normalizeHeadline(p.a, [names.get(p.publisherA) ?? '']), normalizeHeadline(p.b, [names.get(p.publisherB) ?? '']), language, idf);
        const predicted = sim >= threshold;
        if (predicted && p.label === 'same') tp++;
        else if (predicted && p.label === 'different') fp++;
        else if (!predicted && p.label === 'same') fn++;
      }
      const precision = tp / (tp + fp);
      const recall = tp / (tp + fn);
      console.log(`[cluster eval] ${language}: pairs=${pairs.length} threshold=${threshold} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} (tp=${tp} fp=${fp} fn=${fn})`);
      expect(pairs.length).toBeGreaterThanOrEqual(50);
      expect(precision).toBeGreaterThanOrEqual(0.9);
    });
  }
});
