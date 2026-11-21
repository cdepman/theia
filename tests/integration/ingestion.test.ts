import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatchTick } from '../../pipeline/jobs/dispatcher';
import { pollSource, runWorker } from '../../pipeline/jobs/worker';
import { type ClaimedSource } from '../../pipeline/normalize/article';
import { clock, createTestDb, fakeFetch, feedUrl, registryFor, type TestDb } from '../helpers/db';

const T0 = '2026-11-20T12:00:00.000Z';

const ALPHA = [
  { title: 'Glider crashes into loch, two men killed', link: 'https://alpha.example/a/glider?utm_source=rss', pubDate: '2026-11-20T09:00:00Z' },
  { title: 'Parliament votes on youth mobility scheme', link: 'https://alpha.example/a/mobility', pubDate: '2026-11-20T10:00:00Z' },
];
const BRAVO = [
  { title: 'Two men killed after glider crashes into loch', link: 'https://bravo.example/b/glider', pubDate: '2026-11-20T09:30:00Z' },
  { title: 'Robins will keep visiting your garden this winter', link: 'https://bravo.example/b/robins', pubDate: '2026-11-20T08:00:00Z' },
];

async function counts(t: TestDb) {
  return {
    articles: Number(await t.one('select count(*) from theia.articles')),
    stories: Number(await t.one('select count(*) from theia.stories')),
    memberships: Number(await t.one('select count(*) from theia.story_articles')),
    threads: Number(await t.one('select count(*) from theia.threads')),
    threadLinks: Number(await t.one('select count(*) from theia.thread_stories')),
  };
}

describe('ingestion integration gates', () => {
  let t: TestDb;
  let c: ReturnType<typeof clock>;

  beforeEach(async () => {
    t = await createTestDb();
    c = clock(T0);
    await t.db.rpc('theia_sync_registry', {
      p_registry: registryFor([
        { slug: 'alpha', country: 'GB' },
        { slug: 'bravo', country: 'GB' },
      ]),
      p_now: c.iso(),
    });
  });
  afterEach(async () => {
    await t.close();
  });

  const feeds = () => fakeFetch({ [feedUrl('alpha')]: { status: 200, items: ALPHA }, [feedUrl('bravo')]: { status: 200, items: BRAVO } });

  it('running the same poll twice matches a single run', async () => {
    const f = feeds();
    const first = await runWorker(t.db, { fetchImpl: f.impl, now: c.now });
    expect(first.succeeded).toBe(2);
    expect(first.inserted).toBe(4);
    const baseline = await counts(t);
    expect(baseline.articles).toBe(4);
    // The two glider headlines are one story; the other two stand alone.
    expect(baseline.stories).toBe(3);
    const snapshotsBefore = Number(await t.one('select count(*) from theia.story_metric_snapshots'));

    // Same content again once the sources are due.
    c.advance(10800 + 60);
    const second = await runWorker(t.db, { fetchImpl: f.impl, now: c.now });
    expect(second.succeeded).toBe(2);
    expect(second.inserted).toBe(0);
    expect(await counts(t)).toEqual(baseline);
    expect(Number(await t.one("select count(*) from theia.ingestion_runs where status = 'success'"))).toBe(4);
    // first_observed_at is never rewritten.
    expect(await t.one('select count(distinct first_observed_at) from theia.articles')).toBe(1);
    // Replaying a refresh at an existing cutoff cannot double-count snapshots.
    await t.db.rpc('theia_refresh_country', { p_country: 'GB', p_cutoff: T0, p_now: c.iso() });
    const atT0 = Number(await t.one('select count(*) from theia.story_metric_snapshots where observation_cutoff = $1', [T0]));
    expect(atT0).toBe(snapshotsBefore);
  });

  it('a worker killed before commit is reclaimed after the lease expires', async () => {
    const f = feeds();
    // Baseline from an untouched database.
    const base = await createTestDb();
    await base.db.rpc('theia_sync_registry', { p_registry: registryFor([{ slug: 'alpha', country: 'GB' }, { slug: 'bravo', country: 'GB' }]), p_now: T0 });
    await runWorker(base.db, { fetchImpl: feeds().impl, now: clock(T0).now });
    const baseline = await counts(base);
    await base.close();

    const died = await runWorker(t.db, {
      fetchImpl: f.impl,
      now: c.now,
      beforeCommit: () => {
        throw new Error('worker killed before commit');
      },
    });
    expect(died.failed).toBe(2);
    expect((await counts(t)).articles).toBe(0);
    expect(Number(await t.one('select count(*) from theia.source_schedules where leased_until is not null'))).toBe(2);

    // While the lease is live, another worker gets nothing.
    c.advance(60);
    expect(await t.db.rpc('theia_claim_due_sources', { p_now: c.iso() })).toEqual([]);

    // After it expires, the next tick finds the work and a worker finishes it.
    c.advance(300);
    const tick = await dispatchTick(t.db, async () => {
      await runWorker(t.db, { fetchImpl: f.impl, now: c.now });
    }, { now: c.now });
    expect(tick.dueSources).toBe(2);
    expect(tick.invoked).toBe(true);
    expect(await counts(t)).toEqual(baseline);
    expect(Number(await t.one("select count(*) from theia.source_schedules where state = 'ok' and lease_token is null and last_success_at is not null"))).toBe(2);
  });

  it('a worker killed immediately after commit leaves nothing to redo', async () => {
    const f = feeds();
    const claimed = await t.db.rpc<ClaimedSource[]>('theia_claim_due_sources', { p_now: c.iso() });
    expect(claimed).toHaveLength(2);
    for (const s of claimed) await pollSource(t.db, s, { fetchImpl: f.impl, now: c.now });
    // The worker dies here: committed, never clustered, never refreshed.
    expect((await counts(t)).articles).toBe(4);
    expect((await counts(t)).stories).toBe(0);

    c.advance(900);
    const requestsBefore = f.calls.length;
    const tick = await dispatchTick(t.db, async (status) => {
      await runWorker(t.db, { fetchImpl: f.impl, now: c.now, staleCountries: status.staleCountries });
    }, { now: c.now });
    // Nothing is due, so nothing is fetched again; the tick still finds the unfinished work.
    expect(tick.dueSources).toBe(0);
    expect(tick.pendingLanguages).toEqual(['en']);
    expect(tick.staleCountries).toEqual(['GB']);
    expect(f.calls.length).toBe(requestsBefore);
    const after = await counts(t);
    expect(after.articles).toBe(4);
    expect(after.stories).toBe(3);
    expect(Number(await t.one("select count(*) from theia.cached_views where country_code = 'GB'"))).toBe(30);
  });

  it('a slow worker that commits after its lease was taken over changes no schedule state', async () => {
    const f = feeds();
    const slow = (await t.db.rpc<ClaimedSource[]>('theia_claim_due_sources', { p_limit: 1, p_now: c.iso() }))[0]!;
    expect(slow.sourceKey).toBe('rss:alpha:headlines');

    c.advance(400); // lease expired
    const fast = (await t.db.rpc<ClaimedSource[]>('theia_claim_due_sources', { p_limit: 1, p_now: c.iso() }))[0]!;
    expect(fast.sourceKey).toBe(slow.sourceKey);
    expect(fast.leaseToken).not.toBe(slow.leaseToken);
    const fastResult = await pollSource(t.db, fast, { fetchImpl: f.impl, now: c.now });
    expect(fastResult.commit?.leaseValid).toBe(true);
    const scheduleAfterFast = await t.sql("select next_due_at, last_success_at, lease_token, attempt_count from theia.source_schedules where source_key = 'rss:alpha:headlines'");

    c.advance(30);
    const slowResult = await pollSource(t.db, slow, { fetchImpl: f.impl, now: c.now });
    expect(slowResult.commit?.leaseValid).toBe(false);
    expect(slowResult.commit?.inserted).toBe(0);
    expect(Number(await t.one("select count(*) from theia.articles a join theia.publishers p on p.id = a.publisher_id where p.slug = 'alpha'"))).toBe(2);
    expect(await t.sql("select next_due_at, last_success_at, lease_token, attempt_count from theia.source_schedules where source_key = 'rss:alpha:headlines'")).toEqual(scheduleAfterFast);
  });

  it('handles a rate-limited feed, a healthy feed and an unchanged feed together', async () => {
    await t.db.rpc('theia_sync_registry', {
      p_registry: registryFor([
        { slug: 'alpha', country: 'GB' },
        { slug: 'bravo', country: 'GB' },
        { slug: 'charlie', country: 'GB' },
      ]),
      p_now: c.iso(),
    });
    // First run gives charlie an ETag to send back.
    const first = fakeFetch({
      [feedUrl('alpha')]: { status: 200, items: ALPHA },
      [feedUrl('bravo')]: { status: 200, items: BRAVO },
      [feedUrl('charlie')]: { status: 200, items: [{ title: 'Budget statement due next week', link: 'https://charlie.example/c/1', pubDate: '2026-11-20T07:00:00Z' }], etag: '"v1"' },
    });
    await runWorker(t.db, { fetchImpl: first.impl, now: c.now });

    c.advance(10800 + 60);
    const second = fakeFetch({
      [feedUrl('alpha')]: { status: 429, retryAfter: '7200' },
      [feedUrl('bravo')]: { status: 200, items: [...BRAVO, { title: 'Cold weather alert extended', link: 'https://bravo.example/b/cold', pubDate: '2026-11-20T14:00:00Z' }] },
      [feedUrl('charlie')]: { status: 304 },
    });
    const run = await runWorker(t.db, { fetchImpl: second.impl, now: c.now });
    expect(run).toMatchObject({ failed: 1, succeeded: 1, unchanged: 1, inserted: 1 });

    // The conditional request carried the stored ETag.
    expect(second.calls.find((x) => x.url === feedUrl('charlie'))?.headers['If-None-Match']).toBe('"v1"');

    const rows = await t.sql<{ source_key: string; state: string; attempt_count: number; wait: number; fresh: boolean }>(
      `select source_key, state, attempt_count, extract(epoch from (next_due_at - $1::timestamptz))::int as wait,
              last_success_at = $1::timestamptz as fresh from theia.source_schedules order by source_key`, [c.iso()]);
    const alpha = rows.find((r) => r.source_key.includes('alpha'))!;
    const bravo = rows.find((r) => r.source_key.includes('bravo'))!;
    const charlie = rows.find((r) => r.source_key.includes('charlie'))!;
    // Retry honors the publisher's delay, even though backoff alone would retry sooner.
    expect(alpha).toMatchObject({ state: 'retrying', attempt_count: 1, wait: 7200, fresh: false });
    expect(bravo).toMatchObject({ state: 'ok', fresh: true });
    // An unchanged feed is a successful check.
    expect(charlie).toMatchObject({ state: 'ok', fresh: true, wait: 10800 });
    expect(await t.one("select status from theia.ingestion_runs where source_key = 'rss:charlie:headlines' order by started_at desc limit 1")).toBe('unchanged');

    // Repeated failure becomes visible, and the source keeps being retried at its normal cadence.
    for (let i = 0; i < 4; i++) {
      c.advance(10800 + 60);
      await runWorker(t.db, { fetchImpl: second.impl, now: c.now });
    }
    const exhausted = (await t.sql<{ state: string; attempt_count: number; wait: number }>(
      `select state, attempt_count, extract(epoch from (next_due_at - $1::timestamptz))::int as wait
         from theia.source_schedules where source_key = 'rss:alpha:headlines'`, [c.iso()]))[0]!;
    expect(exhausted).toMatchObject({ state: 'needs_attention', attempt_count: 5, wait: 10800 });
    const status = await t.db.rpc<{ ok: boolean; sourcesNeedingAttention: string[]; problems: { code: string }[] }>('theia_data_status', { p_now: c.iso() });
    expect(status.ok).toBe(false);
    expect(status.sourcesNeedingAttention).toEqual(['rss:alpha:headlines']);
    expect(status.problems.map((p) => p.code)).toContain('sources_need_attention');

    // It heals on its own when the feed returns.
    c.advance(10800 + 60);
    await runWorker(t.db, { fetchImpl: fakeFetch({ [feedUrl('alpha')]: { status: 200, items: ALPHA } }).impl, now: c.now });
    expect(await t.one("select state from theia.source_schedules where source_key = 'rss:alpha:headlines'")).toBe('ok');
  });

  it.each([T0, '2000-01-01T12:00:00.000Z', '2040-01-01T12:00:00.000Z'])('backoff uses the fixture clock at %s, respects Retry-After and stays capped', async (start) => {
    c.set(start);
    // Leave a single active source so every claim is the same one.
    await t.db.rpc('theia_sync_registry', { p_registry: registryFor([{ slug: 'alpha', country: 'GB' }]), p_now: c.iso() });
    await t.sql('update theia.source_schedules set next_due_at = $1', [c.iso()]);
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      const s = (await t.db.rpc<ClaimedSource[]>('theia_claim_due_sources', { p_limit: 1, p_now: c.iso() }))[0]!;
      const r = await t.db.rpc<{ nextDueAt: string; state: string }>('theia_fail_poll', {
        p_source_key: s.sourceKey, p_lease_token: s.leaseToken, p_error: { message: 'HTTP 500', httpStatus: 500, jitter: 0.5 }, p_now: c.iso(),
      });
      waits.push(Math.round((new Date(r.nextDueAt).getTime() - c.now().getTime()) / 1000));
      expect(r.state).toBe('retrying');
      c.set(r.nextDueAt);
      c.advance(1);
    }
    // jitter 0.5 gives a multiplier of exactly 1: 300, 600, 1200, 2400 seconds.
    expect(waits).toEqual([300, 600, 1200, 2400]);

    // A long Retry-After wins over a short backoff; a short one does not shorten the backoff.
    await t.sql("update theia.source_schedules set attempt_count = 0, next_due_at = $1::timestamptz - interval '1 second', state = 'ok'", [c.iso()]);
    const s1 = (await t.db.rpc<ClaimedSource[]>('theia_claim_due_sources', { p_limit: 1, p_now: c.iso() }))[0]!;
    expect(s1).toBeDefined();
    const long = await t.db.rpc<{ nextDueAt: string }>('theia_fail_poll', {
      p_source_key: s1.sourceKey, p_lease_token: s1.leaseToken, p_error: { message: 'HTTP 503', retryAfterSeconds: 5000, jitter: 0.5 }, p_now: c.iso(),
    });
    expect(Math.round((new Date(long.nextDueAt).getTime() - c.now().getTime()) / 1000)).toBe(5000);
    // Backoff alone never exceeds the cadence.
    await t.sql("update theia.source_schedules set attempt_count = 3, cadence_seconds = 900, next_due_at = $1::timestamptz - interval '1 second'", [c.iso()]);
    const s2 = (await t.db.rpc<ClaimedSource[]>('theia_claim_due_sources', { p_limit: 1, p_now: c.iso() }))[0]!;
    expect(s2).toBeDefined();
    const capped = await t.db.rpc<{ nextDueAt: string }>('theia_fail_poll', {
      p_source_key: s2.sourceKey, p_lease_token: s2.leaseToken, p_error: { message: 'HTTP 500', jitter: 1 }, p_now: c.iso(),
    });
    expect(Math.round((new Date(capped.nextDueAt).getTime() - c.now().getTime()) / 1000)).toBe(900);
  });

  it('records a coverage gap after downtime when the feed no longer reaches the last successful check', async () => {
    const f = feeds();
    await runWorker(t.db, { fetchImpl: f.impl, now: c.now });
    // Two days of downtime. The feed now only holds items newer than the last successful check.
    c.advance(2 * 86400);
    const later = fakeFetch({
      [feedUrl('alpha')]: { status: 200, items: [{ title: 'New item after the outage', link: 'https://alpha.example/a/new', pubDate: '2026-11-22T10:00:00Z' }] },
      [feedUrl('bravo')]: { status: 200, items: [...BRAVO, { title: 'Bravo kept its old items', link: 'https://bravo.example/b/new', pubDate: '2026-11-22T09:00:00Z' }] },
    });
    await runWorker(t.db, { fetchImpl: later.impl, now: c.now });
    const gaps = await t.sql<{ source_key: string; gap_start: Date; gap_end: Date }>('select source_key, gap_start, gap_end from theia.coverage_gaps');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.source_key).toBe('rss:alpha:headlines');
    expect(new Date(gaps[0]!.gap_start).toISOString()).toBe(T0);
    expect(new Date(gaps[0]!.gap_end).toISOString()).toBe('2026-11-22T10:00:00.000Z');
    // The gap is surfaced as partial coverage.
    const view = await t.db.rpc<{ coverage: { complete: boolean; reasons: string[] } }>('theia_get_view', { p_country: 'GB', p_category: 'all', p_window: '7d', p_now: c.iso() });
    expect(view.coverage.complete).toBe(false);
    expect(view.coverage.reasons).toContain('coverage_gaps');
  });

  it('pausing dispatch stops ticks without losing work', async () => {
    await t.db.rpc('theia_set_setting', { p_key: 'dispatch_paused', p_value: true });
    let invoked = 0;
    const paused = await dispatchTick(t.db, async () => { invoked += 1; }, { now: c.now });
    expect(paused).toMatchObject({ paused: true, invoked: false });
    expect(await t.one("select count(*) from theia.pipeline_heartbeats where component = 'dispatcher'")).toBe(0);
    await t.db.rpc('theia_set_setting', { p_key: 'dispatch_paused', p_value: false });
    const resumed = await dispatchTick(t.db, async () => { invoked += 1; }, { now: c.now });
    expect(resumed).toMatchObject({ paused: false, dueSources: 2, invoked: true });
    expect(invoked).toBe(1);
  });
});
