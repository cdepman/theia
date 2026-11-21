import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorker } from '../../pipeline/jobs/worker';
import type { SeriesStats, StoryDetail, ThreadDetail, ViewPayload } from '../../shared/types';
import { clock, createTestDb, fakeFetch, feedUrl, fillerItems, type FixtureItem, registryFor, type TestDb } from '../helpers/db';

const DAY1 = '2026-11-01T12:00:00.000Z';

const voss = (pub: string, n: number, title: string, at: string): FixtureItem => ({
  title,
  link: `https://${pub}.example/voss-${n}`,
  pubDate: at,
  description: 'Mara Voss stepped down as chief executive of Kestrel Dynamics after an audit found accounting errors.',
});
const inquiry = (pub: string, n: number, title: string, at: string): FixtureItem => ({
  title,
  link: `https://${pub}.example/inquiry-${n}`,
  pubDate: at,
  description: 'The regulator opened an inquiry into Kestrel Dynamics days after Mara Voss resigned as chief executive.',
});

describe('refresh, ranking, threads and coverage curves', () => {
  let t: TestDb;
  let c: ReturnType<typeof clock>;
  let feeds: Record<string, FixtureItem[]>;

  const run = async () => {
    const f = fakeFetch(Object.fromEntries(Object.entries(feeds).map(([slug, items]) => [feedUrl(slug), { status: 200 as const, items }])));
    // Make every source due regardless of cadence.
    await t.pg.exec(`update theia.source_schedules set next_due_at = '2000-01-01', leased_until = null where state <> 'disabled'`);
    return runWorker(t.db, { fetchImpl: f.impl, now: c.now });
  };
  const view = (country: string, category: string, window: string) =>
    t.db.rpc<ViewPayload>('theia_get_view', { p_country: country, p_category: category, p_window: window, p_now: c.iso() });

  beforeEach(async () => {
    t = await createTestDb();
    c = clock(DAY1);
    await t.db.rpc('theia_sync_registry', {
      p_registry: registryFor([
        { slug: 'alpha', country: 'GB' },
        { slug: 'bravo', country: 'GB' },
        { slug: 'charlie', country: 'GB' },
        { slug: 'delta', country: 'US' },
        { slug: 'echo', country: 'GB', enabled: false },
        // Unrelated background coverage from another country, for realistic term statistics.
        { slug: 'filler', country: 'JP' },
      ]),
      p_now: c.iso(),
    });
    feeds = {
      alpha: [
        voss('alpha', 1, 'Kestrel Dynamics chief Mara Voss resigns after audit', '2026-11-01T08:00:00Z'),
        { title: 'Council approves new tram line for the city centre', link: 'https://alpha.example/tram', pubDate: '2026-11-01T09:00:00Z' },
      ],
      bravo: [
        voss('bravo', 1, 'Kestrel Dynamics boss Mara Voss quits amid audit findings', '2026-11-01T08:30:00Z'),
        { title: 'Storm warning issued for the north coast', link: 'https://bravo.example/storm', pubDate: '2026-11-01T10:00:00Z' },
        { title: 'Storm warning: what to expect on the north coast', link: 'https://bravo.example/storm-explainer', pubDate: '2026-11-01T10:30:00Z' },
      ],
      charlie: [
        voss('charlie', 1, 'Mara Voss resigns from Kestrel Dynamics following audit', '2026-11-01T09:00:00Z'),
        { title: 'Storm warning issued for north coast as winds strengthen', link: 'https://charlie.example/storm', pubDate: '2026-11-01T10:15:00Z' },
      ],
      delta: [voss('delta', 1, 'Kestrel Dynamics CEO Mara Voss Resigns After Audit', '2026-11-01T11:00:00Z')],
      filler: fillerItems(30, '2026-11-01T05:00:00Z'),
    };
  });
  afterEach(async () => {
    await t.close();
  });

  it('ranks stories by distinct publishers, then articles, then recency, per country', async () => {
    await run();
    const gb = await view('GB', 'all', '24h');
    expect(gb.unit).toBe('story');
    expect(gb.metric).toBe('distinct_monitored_publishers');
    expect(gb.stories.map((s) => [s.publisherCount, s.articleCount])).toEqual([
      [3, 3], // Voss: three GB publishers
      [2, 3], // storm: two GB publishers, three articles
      [1, 1], // tram
    ]);
    expect(gb.stories[0]!.headline).toBe('Kestrel Dynamics chief Mara Voss resigns after audit');
    expect(gb.metricRange).toEqual({ min: 1, max: 3 });
    // Raw article copies never inflate the publisher count.
    expect(gb.stories[1]!.publisherCount).toBe(2);

    // The same story seen from the US counts only the US publisher, and shows its headline.
    const us = await view('US', 'all', '24h');
    expect(us.stories).toHaveLength(1);
    expect(us.stories[0]).toMatchObject({ publisherCount: 1, headline: 'Kestrel Dynamics CEO Mara Voss Resigns After Audit' });
    expect(us.stories[0]!.id).toBe(gb.stories[0]!.id);

    // Coverage is honest about a small source set and a window that predates collection.
    expect(gb.coverage).toMatchObject({ complete: false, status: 'limited', monitoredPublisherCount: 3 });
    expect(gb.coverage.reasons).toEqual(expect.arrayContaining(['below_publisher_floor']));
    const week = await view('GB', 'all', '7d');
    expect(week.coverage.reasons).toContain('window_predates_collection');
    expect(week.dataAsOf).toBe(new Date(DAY1).toISOString().replace('.000Z', '+00:00'));

    // Every country gets all 30 views, even one with a single source.
    expect(await t.one('select count(*) from theia.cached_views')).toBe(90);
    expect((await view('JP', 'all', '24h')).coverage).toMatchObject({ status: 'limited', monitoredPublisherCount: 1 });
  });

  it('breaks ties deterministically', async () => {
    feeds = {
      filler: [],
      alpha: [
        { title: 'Harbour bridge reopens after repairs finish early', link: 'https://alpha.example/1', pubDate: '2026-11-01T06:00:00Z' },
        { title: 'Museum unveils restored medieval tapestry', link: 'https://alpha.example/2', pubDate: '2026-11-01T07:00:00Z' },
      ],
      bravo: [{ title: 'Museum unveils restored medieval tapestry to public', link: 'https://bravo.example/2', pubDate: '2026-11-01T07:30:00Z' }],
      charlie: [{ title: 'Harbour bridge reopens after repairs finish', link: 'https://charlie.example/1', pubDate: '2026-11-01T06:30:00Z' }],
      delta: [],
    };
    await run();
    const gb = await view('GB', 'all', '24h');
    // Both stories have two publishers and two articles; the more recently covered one ranks first.
    expect(gb.stories.map((s) => s.headline)).toEqual([
      'Museum unveils restored medieval tapestry',
      'Harbour bridge reopens after repairs finish early',
    ]);
    expect(gb.metricRange).toEqual({ min: 2, max: 2 });
  });

  it('a delayed refresh cannot overwrite a newer view', async () => {
    await run();
    const newer = '2026-11-01T18:00:00.000Z';
    const older = '2026-11-01T15:00:00.000Z';
    const first = await t.db.rpc<{ viewsWritten: number }>('theia_refresh_country', { p_country: 'GB', p_cutoff: newer, p_now: newer });
    expect(first.viewsWritten).toBe(30);
    const late = await t.db.rpc<{ viewsWritten: number }>('theia_refresh_country', { p_country: 'GB', p_cutoff: older, p_now: '2026-11-01T18:05:00.000Z' });
    expect(late.viewsWritten).toBe(0);
    const cutoffs = await t.sql<{ c: Date }>("select distinct observation_cutoff as c from theia.cached_views where country_code = 'GB'");
    expect(cutoffs.map((r) => new Date(r.c).toISOString())).toEqual([newer]);
    // The late refresh is rejected before changing derived data or reconstructing history.
    expect(late).toMatchObject({ skipped: true });
    expect(Number(await t.one("select count(distinct observation_cutoff) from theia.story_metric_snapshots where country_code = 'GB'"))).toBe(2);
  });

  it('a refresh that fails midway leaves the previous views in place', async () => {
    await run();
    const before = await t.sql("select cache_key, observation_cutoff, computed_at, payload from theia.cached_views where country_code = 'GB' order by cache_key");
    await t.pg.exec(`
      create function theia.fail_on_health() returns trigger language plpgsql as $f$
      begin
        if new.category = 'health' then raise exception 'simulated failure midway through a refresh'; end if;
        return new;
      end $f$;
      create trigger fail_midway before insert or update on theia.cached_views
        for each row execute function theia.fail_on_health();`);
    const later = '2026-11-01T20:00:00.000Z';
    await expect(t.db.rpc('theia_refresh_country', { p_country: 'GB', p_cutoff: later, p_now: later })).rejects.toThrow(/simulated failure/);
    const after = await t.sql("select cache_key, observation_cutoff, computed_at, payload from theia.cached_views where country_code = 'GB' order by cache_key");
    expect(after).toEqual(before);
    // No snapshot from the failed attempt survives either.
    expect(Number(await t.one('select count(*) from theia.story_metric_snapshots where observation_cutoff = $1', [later]))).toBe(0);
    // The stale views are reported as stale once they pass the refresh target.
    c.advance(5 * 3600);
    const stale = await view('GB', 'all', '24h');
    expect(stale.freshness?.stale).toBe(true);
    expect(new Date(stale.observationCutoff!).toISOString()).toBe(DAY1);
  });

  it('links later developments into a thread and ranks threads by publisher-days', async () => {
    await run();
    c.set('2026-11-05T12:00:00.000Z');
    feeds.alpha!.push(inquiry('alpha', 1, 'Regulator opens inquiry into Kestrel Dynamics accounts', '2026-11-05T08:00:00Z'));
    feeds.bravo!.push(inquiry('bravo', 1, 'Kestrel Dynamics faces regulator inquiry over accounts', '2026-11-05T09:00:00Z'));
    await run();

    expect(Number(await t.one("select count(*) from theia.stories s where exists (select 1 from theia.story_articles sa join theia.articles a on a.id = sa.article_id join theia.publishers p on p.id = a.publisher_id where sa.story_id = s.id and p.country_code = 'GB')"))).toBe(4);
    const multi = await t.sql<{ thread_id: string; n: number }>('select thread_id, count(*)::int as n from theia.thread_stories group by thread_id having count(*) > 1');
    expect(multi).toHaveLength(1);
    expect(multi[0]!.n).toBe(2);
    expect(Number(await t.one("select count(*) from theia.story_events where event_type = 'thread_link'"))).toBe(1);

    c.set('2026-11-06T12:00:00.000Z');
    await t.db.rpc('theia_refresh_country', { p_country: 'GB', p_cutoff: c.iso(), p_now: c.iso() });
    const month = await view('GB', 'all', '30d');
    expect(month.unit).toBe('thread');
    expect(month.metric).toBe('publisher_days');
    const top = month.stories[0]!;
    // Three publishers on day one plus two on day five.
    expect(top).toMatchObject({ id: multi[0]!.thread_id, publisherDays: 5, metricValue: 5, activeDays: 2, publisherCount: 3, storyCount: 2 });
    expect(top.headline).toBe('Kestrel Dynamics chief Mara Voss resigns after audit');
    expect(top.status).toBe('fading');
    expect(top.peakCount).toBe(3);
    // The storm ran one day with two publishers.
    expect(month.stories[1]).toMatchObject({ publisherDays: 2, activeDays: 1, storyCount: 1 });

    const detail = await t.db.rpc<ThreadDetail>('theia_get_thread', { p_thread: top.id, p_country: 'GB', p_now: c.iso() });
    expect(detail.stories.map((s) => s.headline)).toEqual([
      'Regulator opens inquiry into Kestrel Dynamics accounts',
      'Kestrel Dynamics chief Mara Voss resigns after audit',
    ]);
    const series = detail.stats.series;
    // Thirty elapsed days touch 31 UTC dates, including partial first and last dates.
    expect(series).toHaveLength(31);
    const byDay = Object.fromEntries(series.map((p) => [p.day, p]));
    // Days before collection began are unknown, never zero.
    expect(byDay['2026-10-31']).toMatchObject({ known: false, count: null });
    expect(byDay['2026-11-01']).toMatchObject({ known: true, count: 3, partial: true });
    // A quiet day inside the collection period is a real zero.
    expect(byDay['2026-11-03']).toMatchObject({ known: true, count: 0, partial: false });
    expect(byDay['2026-11-05']).toMatchObject({ known: true, count: 2 });
    expect(detail.stats).toMatchObject({ publisherDays: 5, activeDays: 2, peakDay: '2026-11-01', daysSinceLastCoverage: 1 });

    const story = await t.db.rpc<StoryDetail>('theia_get_story', { p_story: top.topStoryId, p_country: 'GB', p_now: c.iso() });
    expect(story.thread).toMatchObject({ id: top.id, storyCount: 2 });
    expect(story.articles.total).toBe(4);
    // The selected country's sources come first; every article keeps its original link and publisher.
    expect(story.articles.items.slice(0, 3).every((a) => a.publisher.country === 'GB')).toBe(true);
    expect(story.articles.items[3]!.publisher.country).toBe('US');
    expect(story.articles.items.every((a) => a.url.startsWith('https://'))).toBe(true);
    expect(story.byCountry).toEqual([
      { country: 'GB', publisherCount: 3, articleCount: 3 },
      { country: 'US', publisherCount: 1, articleCount: 1 },
    ]);
  });

  it('recomputes a past day idempotently when late articles arrive, without touching snapshots', async () => {
    await run();
    c.set('2026-11-03T12:00:00.000Z');
    await t.db.rpc('theia_refresh_country', { p_country: 'GB', p_cutoff: c.iso(), p_now: c.iso() });
    const snapshotsBefore = await t.sql('select * from theia.story_metric_snapshots order by id');

    // A feed surfaces an older item late: published on day one, first observed on day four.
    c.set('2026-11-04T12:00:00.000Z');
    feeds = { alpha: [], bravo: [], delta: [], filler: [], charlie: [{ title: 'Storm warning lifted for north coast', link: 'https://charlie.example/storm-late', pubDate: '2026-11-01T20:00:00Z' }] };
    feeds.alpha = [voss('alpha', 2, 'Mara Voss leaves Kestrel Dynamics after audit, board confirms', '2026-11-01T21:00:00Z')];
    await run();
    const day1 = () => t.sql("select thread_id, distinct_publisher_count, article_count from theia.thread_daily_coverage where country_code = 'GB' and day = '2026-11-01' order by thread_id");
    const once = await day1();
    await t.db.rpc('theia_refresh_country', { p_country: 'GB', p_cutoff: '2026-11-04T13:00:00.000Z', p_now: '2026-11-04T13:00:00.000Z' });
    await t.db.rpc('theia_refresh_country', { p_country: 'GB', p_cutoff: '2026-11-04T14:00:00.000Z', p_now: '2026-11-04T14:00:00.000Z' });
    expect(await day1()).toEqual(once);
    expect(once.reduce((n, r) => n + Number((r as { article_count: number }).article_count), 0)).toBe(9);

    // The late article is dated by publication for windows, but its first-observed time is preserved.
    const late = (await t.sql<{ effective_at: Date; first_observed_at: Date }>("select effective_at, first_observed_at from theia.articles where normalized_url = 'https://charlie.example/storm-late'"))[0]!;
    expect(new Date(late.effective_at).toISOString()).toBe('2026-11-01T20:00:00.000Z');
    expect(new Date(late.first_observed_at).toISOString()).toBe('2026-11-04T12:00:00.000Z');

    // History is append-only: earlier snapshots are unchanged.
    const earlier = await t.sql("select * from theia.story_metric_snapshots where observation_cutoff <= '2026-11-03T12:00:00Z' order by id");
    expect(earlier).toEqual(snapshotsBefore);
  });

  it('reopens a dormant thread, records the reignition, and shows the quiet interval as zero', async () => {
    await run();
    // Twenty-five quiet days later the subject returns.
    c.set('2026-11-26T12:00:00.000Z');
    // The feeds still retain the previously seen items. A successful check establishes
    // that this quiet interval is not a collection outage before the new items arrive.
    await run();
    feeds.alpha = [inquiry('alpha', 9, 'Kestrel Dynamics fined after inquiry into accounts', '2026-11-26T08:00:00Z')];
    feeds.bravo = [inquiry('bravo', 9, 'Regulator fines Kestrel Dynamics following accounts inquiry', '2026-11-26T09:00:00Z')];
    feeds.charlie = [];
    feeds.delta = [];
    feeds.filler = [];
    await run();

    const events = await t.sql<{ event_type: string }>('select event_type from theia.story_events order by occurred_at, event_type');
    expect(events.map((e) => e.event_type)).toEqual(['thread_link', 'thread_reignite']);
    const thread = (await t.sql<{ id: string; dormant_at: Date | null; n: number }>(
      `select t.id, t.dormant_at, (select count(*)::int from theia.thread_stories ts where ts.thread_id = t.id) as n
         from theia.threads t order by n desc limit 1`))[0]!;
    expect(thread.n).toBe(2);
    expect(thread.dormant_at).toBeNull();

    const detail = await t.db.rpc<ThreadDetail>('theia_get_thread', { p_thread: thread.id, p_country: 'GB', p_now: c.iso() });
    const quiet = detail.stats.series.filter((p) => p.day > '2026-11-01' && p.day < '2026-11-26');
    expect(quiet).toHaveLength(24);
    expect(quiet.every((p) => p.known && p.count === 0)).toBe(true);
    expect(detail.stats.status).toBe('fading');
    expect(detail.stats.decayDays).toBe(1);
  });

  it('keeps unrelated stories in separate threads', async () => {
    await run();
    // Three subjects from the monitored GB outlets plus thirty unrelated fillers: no links.
    expect(Number(await t.one('select count(*) from theia.threads'))).toBe(33);
    expect(Number(await t.one('select count(*) from (select thread_id from theia.thread_stories group by 1 having count(*) > 1) q'))).toBe(0);
  });

  it('computes status and decay from a daily series, ignoring unknown days', async () => {
    const stats = (counts: number[], known: boolean[], dormant = false) =>
      t.one<SeriesStats>(
        `select theia.series_stats($1::date[], $2::int[], $3::boolean[], $4::boolean[], $5)`,
        [
          `{${counts.map((_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`).join(',')}}`,
          `{${counts.join(',')}}`,
          `{${known.join(',')}}`,
          `{${counts.map(() => false).join(',')}}`,
          dormant,
        ],
      );
    const all = (n: number) => Array.from({ length: n }, () => true);

    // Sustained: the trailing 3-day mean is at least half the peak 3-day mean.
    expect(await stats([4, 5, 6, 5, 4, 4], all(6))).toMatchObject({ status: 'active', decayDays: null, publisherDays: 28, activeDays: 6, peakCount: 6 });
    // Faded: still covered in the last three days, but well below the peak.
    expect(await stats([8, 9, 8, 2, 1, 1], all(6))).toMatchObject({ status: 'fading', decayDays: 3 });
    // Quiet: nothing in the last three days.
    expect(await stats([5, 6, 2, 0, 0, 0], all(6))).toMatchObject({ status: 'quiet', daysSinceLastCoverage: 3 });
    // Dormant overrides the curve.
    expect(await stats([5, 6, 2, 0, 0, 0], all(6), true)).toMatchObject({ status: 'dormant' });
    // Unknown days are excluded from every measure, not counted as zero.
    const partial = await stats([0, 0, 0, 3, 3, 3], [false, false, false, true, true, true]);
    expect(partial).toMatchObject({ status: 'active', knownDays: 3, publisherDays: 9, activeDays: 3 });
    expect(partial.series.slice(0, 3).every((p) => p.count === null && !p.known)).toBe(true);
    // No known days at all: status is unknown, not quiet.
    expect(await stats([0, 0, 0], [false, false, false])).toMatchObject({ status: 'unknown', knownDays: 0 });
  });

  it('applies category filters from section feeds and keyword rules', async () => {
    await t.db.rpc('theia_sync_registry', {
      p_registry: registryFor([
        { slug: 'alpha', country: 'GB', feeds: [{ section: 'headlines' }, { section: 'technology', defaultCategory: 'technology' }] },
        { slug: 'bravo', country: 'GB' },
      ]),
      p_now: c.iso(),
    });
    const f = fakeFetch({
      [feedUrl('alpha', 'headlines')]: { status: 200, items: [{ title: 'Chancellor defends budget in parliament', link: 'https://alpha.example/budget', pubDate: '2026-11-01T08:00:00Z' }] },
      [feedUrl('alpha', 'technology')]: { status: 200, items: [{ title: 'Review: the quietest keyboard we have tried', link: 'https://alpha.example/keyboard', pubDate: '2026-11-01T08:00:00Z' }] },
      [feedUrl('bravo')]: { status: 200, items: [{ title: 'Premier League: late goal settles derby', link: 'https://bravo.example/derby', pubDate: '2026-11-01T08:00:00Z' }] },
    });
    await runWorker(t.db, { fetchImpl: f.impl, now: c.now });
    const cats = await t.sql<{ headline_original: string; category: string; category_method: string }>('select headline_original, category, category_method from theia.articles order by headline_original');
    expect(cats).toEqual([
      { headline_original: 'Chancellor defends budget in parliament', category: 'politics', category_method: 'keyword' },
      { headline_original: 'Premier League: late goal settles derby', category: 'sports', category_method: 'keyword' },
      { headline_original: 'Review: the quietest keyboard we have tried', category: 'technology', category_method: 'feed_section' },
    ]);
    expect((await view('GB', 'technology', '24h')).stories.map((s) => s.headline)).toEqual(['Review: the quietest keyboard we have tried']);
    expect((await view('GB', 'sports', '24h')).stories).toHaveLength(1);
    expect((await view('GB', 'health', '24h')).stories).toEqual([]);
    expect((await view('GB', 'all', '24h')).stories).toHaveLength(3);
  });
});
