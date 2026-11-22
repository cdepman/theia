import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorker } from '../../pipeline/jobs/worker';
import { handleApi } from '../../server/routes';
import { clock, createTestDb, fakeFetch, feedUrl, registryFor, type TestDb } from '../helpers/db';

const T0 = '2026-11-20T12:00:00Z';

describe('grouping as a presentation layer', () => {
  let t: TestDb;
  const c = clock(T0);
  let ids: Record<string, string>;

  beforeEach(async () => {
    t = await createTestDb();
    c.set(T0);
    const pubs = ['alpha', 'bravo', 'charlie'].map((slug) => ({ slug, country: 'US' as const }));
    await t.db.rpc('theia_sync_registry', { p_registry: registryFor(pubs), p_now: c.iso() });
    const at = '2026-11-20T11:00:00Z';
    // Three headlines the keyword method keeps apart: two word the same verdict differently, one is unrelated.
    const press = fakeFetch({
      [feedUrl('alpha')]: { status: 200, items: [{ title: 'Man found guilty of starting deadly Harbour Fire', link: 'https://alpha.example/a', pubDate: at }] },
      [feedUrl('bravo')]: { status: 200, items: [{ title: 'Jury convicts arsonist over blaze that razed the waterfront', link: 'https://bravo.example/b', pubDate: at }] },
      [feedUrl('charlie')]: { status: 200, items: [{ title: 'Council approves new tram line', link: 'https://charlie.example/c', pubDate: at }] },
    });
    await runWorker(t.db, { fetchImpl: press.impl, now: c.now, env: {} });
    ids = Object.fromEntries((await t.sql<{ id: string; normalized_url: string }>('select id, normalized_url from theia.articles')).map((a) => [a.normalized_url.slice(-1), a.id]));
  });
  afterEach(async () => {
    await t.close();
  });

  const decision = (article: string, eventKey: string, eventLabel: string, subjectKey: string, subjectLabel: string) => ({
    articleId: ids[article], eventKey, eventLabel, subjectKey, subjectLabel, category: 'politics', confidence: 'high', model: 'test-model', escalated: false,
  });
  const layout = () => t.sql<{ label: string | null; grouper: string; thread: string | null; n: number }>(
    `select s.label, s.grouper, th.label as thread, count(sa.article_id)::int as n
       from theia.stories s join theia.story_articles sa on sa.story_id = s.id
       left join theia.thread_stories ts on ts.story_id = s.id left join theia.threads th on th.id = ts.thread_id
      group by s.id, th.label order by n desc, s.label`);

  it('projects a grouper\'s judgments, leaves the articles alone, and can be switched to another grouper', async () => {
    expect((await layout()).map((r) => r.n)).toEqual([1, 1, 1]);
    const before = await t.sql('select id, headline_original, normalized_url, updated_at from theia.articles order by id');

    c.advance(60);
    const v1 = [
      decision('a', 'e1', 'Harbour Fire arson verdict', 's1', 'Harbour Fire trial'),
      decision('b', 'e1', 'Harbour Fire arson verdict', 's1', 'Harbour Fire trial'),
      decision('c', 'e2', 'Tram line approved', 's2', 'City tram line'),
    ];
    expect(await t.db.rpc('theia_record_decisions', { p_grouper: 'llm-v1', p_language: 'en', p_decisions: v1, p_now: c.iso() })).toBe(3);
    // Recording a judgment changes nothing on screen until it is applied.
    expect((await layout()).every((r) => r.grouper === 'lexical-v1')).toBe(true);

    const applied = await t.db.rpc<Record<string, number>>('theia_apply_grouping', { p_grouper: 'llm-v1', p_language: 'en', p_now: c.iso() });
    expect(applied).toMatchObject({ events: 2, subjects: 2, articlesPlaced: 3, storiesRemoved: 3 });
    expect(await layout()).toEqual([
      { label: 'Harbour Fire arson verdict', grouper: 'llm-v1', thread: 'Harbour Fire trial', n: 2 },
      { label: 'Tram line approved', grouper: 'llm-v1', thread: 'City tram line', n: 1 },
    ]);
    expect(await t.one(`select category from theia.stories where label = 'Tram line approved'`)).toBe('politics');
    // Applying again is a no-op, and the articles are exactly as they were.
    expect(await t.db.rpc('theia_apply_grouping', { p_grouper: 'llm-v1', p_language: 'en', p_now: c.iso() })).toMatchObject({ articlesPlaced: 0, storiesRemoved: 0, threadsRemoved: 0 });
    expect(await t.sql('select id, headline_original, normalized_url, updated_at from theia.articles order by id')).toEqual(before);

    // A different grouper judges the same articles its own way. Both sets of judgments are kept.
    c.advance(60);
    const v2 = [
      decision('a', 'x1', 'Harbour Fire conviction', 'y1', 'Harbour Fire'),
      decision('b', 'x1', 'Harbour Fire conviction', 'y1', 'Harbour Fire'),
      decision('c', 'x1', 'Harbour Fire conviction', 'y1', 'Harbour Fire'),
    ];
    await t.db.rpc('theia_record_decisions', { p_grouper: 'llm-v2', p_language: 'en', p_decisions: v2, p_now: c.iso() });
    expect(await t.sql(`select grouper, count(*)::int as n from theia.grouping_decisions group by grouper order by grouper`)).toEqual([{ grouper: 'llm-v1', n: 3 }, { grouper: 'llm-v2', n: 3 }]);
    await t.db.rpc('theia_apply_grouping', { p_grouper: 'llm-v2', p_language: 'en', p_now: c.iso() });
    expect(await layout()).toEqual([{ label: 'Harbour Fire conviction', grouper: 'llm-v2', thread: 'Harbour Fire', n: 3 }]);
    // And back again, from the log alone.
    await t.db.rpc('theia_apply_grouping', { p_grouper: 'llm-v1', p_language: 'en', p_now: c.iso() });
    expect((await layout()).map((r) => [r.label, r.n])).toEqual([['Harbour Fire arson verdict', 2], ['Tram line approved', 1]]);
  });

  it('serves short labels with the view, and counts publishers across the merged story', async () => {
    c.advance(60);
    await t.db.rpc('theia_record_decisions', { p_grouper: 'llm-v1', p_language: 'en', p_now: c.iso(), p_decisions: [
      decision('a', 'e1', 'Harbour Fire arson verdict', 's1', 'Harbour Fire trial'),
      decision('b', 'e1', 'Harbour Fire arson verdict', 's1', 'Harbour Fire trial'),
    ] });
    await t.db.rpc('theia_apply_grouping', { p_grouper: 'llm-v1', p_language: 'en', p_now: c.iso() });
    await t.db.rpc('theia_refresh_country', { p_country: 'US', p_cutoff: c.iso(), p_now: c.iso() });
    const res = await handleApi(new Request('http://x/api/stories?country=US&category=all&window=24h'), { db: t.db, now: c.now, env: { THEIA_DEV_NO_AUTH: '1' } } as never);
    const view = (await res.json()) as { stories: { headline: string; shortLabel?: string; publisherCount: number }[] };
    expect(view.stories.map((s) => [s.shortLabel ?? null, s.publisherCount])).toEqual([['Harbour Fire arson verdict', 2], [null, 1]]);
    // The publisher's own headline is still there underneath the label.
    expect(view.stories[0]!.headline).toMatch(/Harbour Fire|waterfront/);
  });
});
