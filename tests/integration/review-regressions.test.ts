import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../pipeline/db';
import { dispatchTick } from '../../pipeline/jobs/dispatcher';
import { runWorker } from '../../pipeline/jobs/worker';
import type { StoryDetail, ThreadDetail, ViewPayload } from '../../shared/types';
import { clock, createTestDb, fakeFetch, feedUrl, registryFor, type FixtureItem, type TestDb } from '../helpers/db';

const bridge = (slug: string, n: number, at: string): FixtureItem => ({
  title: 'Harbour bridge reopens after extensive repairs',
  link: `https://${slug}.example/bridge-${n}`,
  pubDate: at,
});

describe('review regressions', () => {
  let t: TestDb;
  let c: ReturnType<typeof clock>;
  beforeEach(async () => {
    t = await createTestDb({ apiRoles: true });
    c = clock('2026-11-01T12:00:00Z');
    await t.db.rpc('theia_sync_registry', {
      p_registry: registryFor([{ slug: 'alpha', country: 'GB' }, { slug: 'bravo', country: 'GB' }]),
      p_now: c.iso(),
    });
  });
  afterEach(async () => { await t.close(); });

  const poll = (alpha: FixtureItem[], bravo: FixtureItem[] = []) => runWorker(t.db, {
    now: c.now,
    fetchImpl: fakeFetch({
      [feedUrl('alpha')]: { status: 200, items: alpha },
      [feedUrl('bravo')]: { status: 200, items: bravo },
    }).impl,
  });
  const refresh = (cutoff = c.iso()) => t.db.rpc<{ skipped: boolean; viewsWritten: number }>('theia_refresh_country', {
    p_country: 'GB', p_cutoff: cutoff, p_now: c.iso(),
  });
  const view = () => t.db.rpc<ViewPayload>('theia_get_view', { p_country: 'GB', p_category: 'all', p_window: '30d', p_now: c.iso() });
  const detail = (id: string) => t.db.rpc<ThreadDetail>('theia_get_thread', { p_thread: id, p_country: 'GB', p_now: c.iso() });

  it('keeps snapshots and old detail links when a singleton thread is consolidated', async () => {
    await poll([
      bridge('alpha', 1, '2026-11-01T10:00:00Z'),
      { title: 'Orchard festival postponed for volunteers', link: 'https://alpha.example/festival', pubDate: '2026-11-01T11:00:00Z' },
    ]);
    const links = await t.sql<{ story_id: string; thread_id: string }>('select story_id, thread_id from theia.thread_stories order by story_id');
    const source = links[0]!;
    const target = links[1]!;
    const snapshots = await t.sql('select * from theia.thread_metric_snapshots order by id');
    expect(snapshots).toHaveLength(2);
    c.advance(60);
    const payload = { links: [{ storyId: source.story_id, threadId: target.thread_id, method: 'signature', score: 0.9 }] };
    await t.db.rpc('theia_apply_threading', { p_language: 'en', p_payload: payload, p_now: c.iso() });
    // Replaying a decision must neither erase history nor record the merge twice.
    await t.db.rpc('theia_apply_threading', { p_language: 'en', p_payload: payload, p_now: c.iso() });
    expect(await t.sql('select * from theia.thread_metric_snapshots order by id')).toEqual(snapshots);
    expect(await detail(source.thread_id)).toMatchObject({ id: target.thread_id, storyCount: 2 });
    expect(await t.one("select count(*) from theia.story_events where event_type='thread_merge'")).toBe(1);
    await expect(t.sql('delete from theia.threads where id = $1', [source.thread_id])).rejects.toThrow(/foreign key/);
    expect(await t.one('select count(*) from theia.thread_terms where thread_id = $1', [source.thread_id])).toBe(0);
    // A stale plan must not move a story back into a retired identity.
    await t.db.rpc('theia_apply_threading', { p_language: 'en', p_now: c.iso(), p_payload: {
      links: [{ storyId: source.story_id, threadId: source.thread_id, method: 'signature', score: 0.9 }],
    } });
    expect(await detail(source.thread_id)).toMatchObject({ id: target.thread_id, storyCount: 2 });
    await refresh();
    expect((await view()).stories.map(s => s.id)).toEqual([target.thread_id]);
    expect(await t.sql('select * from theia.thread_metric_snapshots where observation_cutoff < $1 order by id', [c.iso()])).toEqual(snapshots);
  });

  it.each(['theia_threading_input', 'theia_apply_threading'])('recovers a worker interrupted at %s without new feed items', async (crashAt) => {
    const fetcher = fakeFetch({
      [feedUrl('alpha')]: { status: 200, items: [bridge('alpha', 1, '2026-11-01T11:00:00Z')] },
      [feedUrl('bravo')]: { status: 200, items: [] },
    });
    const crashDb: Db = { rpc: async <T>(fn: string, args?: Record<string, unknown>): Promise<T> => {
      if (fn === crashAt) throw new Error('injected interruption');
      return t.db.rpc<T>(fn, args);
    } };
    await expect(runWorker(crashDb, { now: c.now, fetchImpl: fetcher.impl })).rejects.toThrow('injected interruption');
    expect(await t.one('select count(*) from theia.stories')).toBe(1);
    expect(await t.one('select count(*) from theia.threads')).toBe(0);
    // Another worker can have refreshed while this language was unfinished. Recovery
    // must invalidate that fresh-but-incomplete view even without a stale-country flag.
    if (crashAt === 'theia_apply_threading') {
      await refresh();
      expect((await view()).stories).toHaveLength(0);
    }
    c.advance(900);
    const requests = fetcher.calls.length;
    const tick = await dispatchTick(t.db, async status => {
      await runWorker(t.db, { now: c.now, fetchImpl: fetcher.impl, staleCountries: status.staleCountries });
    }, { now: c.now });
    expect(tick.pendingLanguages).toEqual(['en']);
    if (crashAt === 'theia_apply_threading') expect(tick.staleCountries).toEqual([]);
    expect(tick.dueSources).toBe(0);
    expect(fetcher.calls).toHaveLength(requests);
    expect(await t.one('select count(*) from theia.thread_stories')).toBe(1);
    expect((await view()).stories).toHaveLength(1);
    expect(await t.db.rpc('theia_pending_languages', { p_now: c.iso() })).toEqual([]);
  });

  it('preserves daily coverage and detail totals after an older refresh arrives', async () => {
    await poll([bridge('alpha', 1, '2026-11-01T11:00:00Z')]);
    c.set('2026-11-01T18:00:00Z');
    await poll([], [bridge('bravo', 1, '2026-11-01T17:00:00Z')]);
    const month = await view();
    const id = month.stories[0]!.id;
    const coverage = await t.sql('select * from theia.thread_daily_coverage order by thread_id, country_code, day');
    const before = await detail(id);
    expect(before.stats.publisherDays).toBe(2);
    const late = await refresh('2026-11-01T15:00:00Z');
    expect(late.viewsWritten).toBe(0);
    expect(await t.sql('select * from theia.thread_daily_coverage order by thread_id, country_code, day')).toEqual(coverage);
    expect(await detail(id)).toEqual(before);
    expect(await view()).toEqual(month);
    // An equal cutoff is also a no-op, even if more articles have since arrived.
    await refresh();
    expect(await t.sql('select * from theia.thread_daily_coverage order by thread_id, country_code, day')).toEqual(coverage);
  });

  it('excludes outage days even when another feed supplied articles during the gap', async () => {
    const retained = bridge('bravo', 1, '2026-11-01T11:00:00Z');
    await poll([bridge('alpha', 1, '2026-11-01T11:00:00Z')], [retained]);
    c.set('2026-11-03T12:00:00Z');
    await poll([], [retained, bridge('bravo', 2, '2026-11-03T11:00:00Z')]);
    await t.sql(`insert into theia.coverage_gaps (source_key,country_code,gap_start,gap_end,reason)
      values ('rss:alpha:headlines','GB','2026-11-02','2026-11-05','outage')`);
    c.set('2026-11-04T12:00:00Z');
    await refresh();
    const month = await view();
    const thread = await detail(month.stories[0]!.id);
    const story = await t.db.rpc<StoryDetail>('theia_get_story', { p_story: thread.stories[0]!.id, p_country: 'GB', p_now: c.iso() });
    for (const stats of [thread.stats, story.stats]) {
      expect(stats.series.filter(p => p.day >= '2026-11-02')).toEqual([
        { day: '2026-11-02', count: null, known: false, partial: false },
        { day: '2026-11-03', count: null, known: false, partial: false },
        { day: '2026-11-04', count: null, known: false, partial: false },
      ]);
      expect(stats).toMatchObject({ status: 'unknown', decayDays: null, publisherDays: 2, activeDays: 1 });
    }
    expect(month.stories[0]).toMatchObject({ publisherDays: thread.stats.publisherDays, activeDays: thread.stats.activeDays });
    // Gap ends are exclusive: collection is known again at midnight on November 5.
    const end = await t.sql<{ known: boolean }>("select * from theia.day_flags('GB','2026-11-05','2026-11-05','2026-11-06')");
    expect(end[0]!.known).toBe(true);
  });

  it.each(['2026-12-01T12:00:00Z', '2026-12-01T00:00:00Z'])('matches rolling-window detail totals at %s', async cutoff => {
    c.set('2026-11-01T20:00:00Z');
    const start = new Date(new Date(cutoff).getTime() - 30 * 86400_000);
    const before = new Date(start.getTime() - 1000).toISOString();
    const after = new Date(start.getTime() + 1000).toISOString();
    await poll([bridge('alpha', 1, before), bridge('alpha', 2, start.toISOString())], [bridge('bravo', 1, after)]);
    c.set(cutoff);
    await refresh();
    const month = await view();
    expect(month.stories[0]).toMatchObject({ publisherDays: 1, publisherCount: 1, activeDays: 1 });
    const thread = await detail(month.stories[0]!.id);
    expect(thread.stats).toMatchObject({ publisherDays: 1, activeDays: 1 });
    expect(thread.stats.series.find(p => p.day === '2026-11-01')).toMatchObject({ count: 1, known: true, partial: true });
    expect(thread.byCountry.find(p => p.country === 'GB')).toMatchObject({ publisherDays: 1, activeDays: 1 });
    const story = await t.db.rpc<StoryDetail>('theia_get_story', { p_story: thread.stories[0]!.id, p_country: 'GB', p_now: c.iso() });
    expect(story.stats.publisherDays).toBe(story.windows['30d'].publisherCount);
  });

  it('keeps RPCs restricted to the service role and internal helpers private', async () => {
    const privileges = await t.sql<{ name: string; anon: boolean; authenticated: boolean; service: boolean; definer: boolean }>(`
      select p.proname as name, has_function_privilege('anon',p.oid,'execute') as anon,
             has_function_privilege('authenticated',p.oid,'execute') as authenticated,
             has_function_privilege('service_role',p.oid,'execute') as service, p.prosecdef as definer
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname like 'theia\\_%'`);
    expect(privileges.length).toBeGreaterThan(0);
    expect(privileges.every(p => !p.anon && !p.authenticated && p.service && p.definer)).toBe(true);
    for (const role of ['anon', 'authenticated']) {
      expect(await t.one('select has_schema_privilege($1, \'theia\', \'usage\')', [role])).toBe(false);
      expect(await t.one('select has_function_privilege($1, \'theia.resolve_thread(uuid)\', \'execute\')', [role])).toBe(false);
      expect(await t.one('select has_function_privilege($1, \'theia.day_has_gap(text,date,timestamptz)\', \'execute\')', [role])).toBe(false);
    }
  });
});
