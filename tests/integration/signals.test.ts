import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatchTick } from '../../pipeline/jobs/dispatcher';
import { pollSignals } from '../../pipeline/jobs/signals';
import { runWorker } from '../../pipeline/jobs/worker';
import type { SignalsPayload } from '../../shared/types';
import { clock, createTestDb, fakeFetch, feedUrl, registryFor, type TestDb } from '../helpers/db';

const T0 = '2026-11-20T12:00:00Z';

function origins(overrides: Record<string, Record<string, unknown>> = {}) {
  const base = [
    { key: 'google_trending_now', name: 'Google Trending Now', kind: 'search', enabled: true, weight: 1, displayOrder: 10, cadenceSeconds: 3600,
      scopes: [{ scope: 'US', country: 'US', language: 'en', viewCountries: ['US'], params: { geo: 'US' } }] },
    { key: 'x_trends', name: 'X trends', kind: 'social', enabled: true, weight: 1, displayOrder: 20, cadenceSeconds: 3600,
      scopes: [{ scope: 'US', country: 'US', language: 'en', viewCountries: ['US'], params: { woeid: 23424977 } }] },
    { key: 'x_news', name: 'X news stories', kind: 'social', enabled: true, weight: 1, displayOrder: 30, cadenceSeconds: 3600,
      scopes: [{ scope: 'US', country: 'US', language: 'en', viewCountries: ['US'], params: { seedSource: 'x_trends:US', seedLimit: 2 } }] },
    { key: 'hackernews', name: 'Hacker News', kind: 'community', enabled: true, weight: 0.5, displayOrder: 70, cadenceSeconds: 3600,
      scopes: [{ scope: 'global', language: 'en', viewCountries: ['US', 'GB', 'JP'], params: { limit: 2 } }] },
  ];
  return { origins: base.map((o) => ({ ...o, ...(overrides[o.key] ?? {}) })) };
}

function trendsXml(titles: string[], article?: string) {
  const items = titles.map((t, i) => `<item><title>${t}</title><ht:approx_traffic>${(titles.length - i) * 1000}+</ht:approx_traffic>${
    i === 0 && article ? `<ht:news_item><ht:news_item_title>Coverage</ht:news_item_title><ht:news_item_url>${article}?utm_source=g</ht:news_item_url><ht:news_item_source>Alpha</ht:news_item_source></ht:news_item>` : ''}</item>`).join('');
  return `<rss xmlns:ht="https://trends.google.com/trending/rss" version="2.0"><channel>${items}</channel></rss>`;
}

/** A fetch that serves signal endpoints from a table and records what was asked for. */
function signalFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; auth: string | null }[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.authorization ?? null });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    return key ? routes[key]!() : new Response('not found', { status: 404 });
  };
  return { impl, calls };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('attention signals', () => {
  let t: TestDb;
  const c = clock(T0);
  beforeEach(async () => {
    t = await createTestDb();
    c.set(T0);
  });
  afterEach(async () => {
    await t.close();
  });

  const routes = (titles: string[], article?: string) => ({
    'https://trends.google.com/trending/rss?geo=US': () => new Response(trendsXml(titles, article), { status: 200 }),
    'https://api.x.com/2/trends/by/woeid/23424977': () => json({ data: [{ trend_name: 'Harbour Bridge' }, { trend_name: '#Budget2026' }, { trend_name: 'Lantern' }] }),
    'https://api.x.com/2/news/search': () => json({ data: [{ id: '900', name: 'Bridge closed after inspection', hook: 'Engineers found a fault.' }] }),
    'https://hacker-news.firebaseio.com/v0/topstories.json': () => json([11, 12, 13]),
    'https://hacker-news.firebaseio.com/v0/item/11.json': () => json({ id: 11, title: 'Show HN: A thing', score: 120 }),
    'https://hacker-news.firebaseio.com/v0/item/12.json': () => json({ id: 12, title: 'Bridge inspection report', url: 'https://alpha.example/report', score: 80 }),
  });

  it('collects every origin it has credentials for, and nothing else', async () => {
    await t.db.rpc('theia_sync_origins', { p_config: origins(), p_now: c.iso() });
    const f = signalFetch(routes(['harbour bridge closure', 'lantern festival']));

    // Without the X token only the two keyless origins are due, and X is not marked as failing.
    expect(await t.db.rpc('theia_signals_due', { p_exclude_origins: ['x_news', 'x_trends'], p_now: c.iso() })).toBe(2);
    const first = await pollSignals(t.db, { fetchImpl: f.impl, now: c.now, env: {} });
    expect(first).toMatchObject({ claimed: 2, succeeded: 2, failed: 0, skippedOrigins: ['x_news', 'x_trends'] });
    expect(f.calls.some((x) => x.url.includes('api.x.com'))).toBe(false);
    expect(await t.one('select count(*)::int from theia.signal_schedules where state <> \'ok\'')).toBe(0);

    // With the token, X trends run. X news is claimed in the same batch before any trend
    // exists, so it has no seeds yet and makes no request; it picks them up next time.
    const second = await pollSignals(t.db, { fetchImpl: f.impl, now: c.now, env: { X_BEARER_TOKEN: 'test-token' } });
    expect(second).toMatchObject({ claimed: 2, succeeded: 2, failed: 0, skippedOrigins: [] });
    expect(f.calls.filter((x) => x.url.includes('/2/news/search'))).toHaveLength(0);
    expect(f.calls.find((x) => x.url.includes('/2/trends/'))!.auth).toBe('Bearer test-token');

    c.advance(3700);
    const third = await pollSignals(t.db, { fetchImpl: f.impl, now: c.now, env: { X_BEARER_TOKEN: 'test-token' } });
    expect(third).toMatchObject({ claimed: 4, succeeded: 4, failed: 0 });
    const newsCalls = f.calls.filter((x) => x.url.includes('/2/news/search')).map((x) => new URL(x.url).searchParams.get('query'));
    expect(newsCalls).toEqual(['Harbour Bridge', '#Budget2026']);

    const view = await t.db.rpc<SignalsPayload>('theia_get_signals', { p_country: 'US', p_window: '24h', p_now: c.iso() });
    expect(view.origins.map((o) => o.key)).toEqual(['press', 'google_trending_now', 'x_trends', 'x_news', 'hackernews']);
    expect(view.origins.find((o) => o.key === 'hackernews')).toMatchObject({ kind: 'community', weight: 0.5, lane: 'attention' });
    const byOrigin = (k: string) => view.items.filter((i) => i.origin === k).map((i) => i.title);
    expect(byOrigin('google_trending_now')).toEqual(['harbour bridge closure', 'lantern festival']);
    expect(byOrigin('x_trends')).toEqual(['Harbour Bridge', '#Budget2026', 'Lantern']);
    expect(byOrigin('x_news')).toEqual(['Bridge closed after inspection']);
    expect(byOrigin('hackernews')).toEqual(['Show HN: A thing', 'Bridge inspection report']);
    // Every entry names its origin and kind; the weight is applied to the score.
    const top = (k: string) => view.items.find((i) => i.origin === k)!;
    expect(top('x_trends')).toMatchObject({ originKind: 'social', scope: 'US', rank: 1, score: 1 });
    expect(top('hackernews')).toMatchObject({ originKind: 'community', scope: 'global', score: 0.5 });
    // A global source appears in other countries' views; a country source does not.
    const jp = await t.db.rpc<SignalsPayload>('theia_get_signals', { p_country: 'JP', p_window: '24h', p_now: c.iso() });
    expect([...new Set(jp.items.map((i) => i.origin))]).toEqual(['hackernews']);
  });

  it('keeps one row per item and day, and ranks persistence over longer windows', async () => {
    await t.db.rpc('theia_sync_origins', { p_config: origins(), p_now: c.iso() });
    const lists = [['alpha', 'beta'], ['beta', 'alpha'], ['beta', 'gamma']];
    let n = 0;
    const f = signalFetch({ 'https://trends.google.com/trending/rss?geo=US': () => new Response(trendsXml(lists[n]!), { status: 200 }) });
    const env = {};
    await pollSignals(t.db, { fetchImpl: f.impl, now: c.now, env });
    n = 1;
    c.advance(3700);
    await pollSignals(t.db, { fetchImpl: f.impl, now: c.now, env });
    // Same day, polled twice: two items, two rows, best and latest rank both kept.
    const rows = await t.sql<{ title: string; best_rank: number; last_rank: number; observations: number }>(
      `select i.title, d.best_rank, d.last_rank, d.observations from theia.signal_daily d join theia.signal_items i on i.id = d.signal_item_id
        where d.origin_key = 'google_trending_now' order by i.title`);
    expect(rows).toEqual([
      { title: 'alpha', best_rank: 1, last_rank: 2, observations: 2 },
      { title: 'beta', best_rank: 1, last_rank: 1, observations: 2 },
    ]);
    n = 2;
    c.advance(86_400);
    await pollSignals(t.db, { fetchImpl: f.impl, now: c.now, env });

    const day = await t.db.rpc<SignalsPayload>('theia_get_signals', { p_country: 'US', p_window: '24h', p_now: c.iso() });
    expect(day.items.map((i) => i.title)).toEqual(['beta', 'gamma']);
    const week = await t.db.rpc<SignalsPayload>('theia_get_signals', { p_country: 'US', p_window: '7d', p_now: c.iso() });
    expect(week.items.map((i) => [i.title, i.daysSeen, i.score])).toEqual([['beta', 2, 2], ['alpha', 1, 1], ['gamma', 1, 0.98]]);
  });

  it('applies weight, visibility and order from the configuration without touching history', async () => {
    await t.db.rpc('theia_sync_origins', { p_config: origins(), p_now: c.iso() });
    const f = signalFetch(routes(['harbour bridge closure']));
    await pollSignals(t.db, { fetchImpl: f.impl, now: c.now, env: {} });
    await t.db.rpc('theia_sync_origins', {
      p_config: origins({ hackernews: { weight: 3, displayOrder: 1, visible: false }, google_trending_now: { enabled: false } }), p_now: c.iso() });
    const view = await t.db.rpc<SignalsPayload>('theia_get_signals', { p_country: 'US', p_window: '24h', p_now: c.iso() });
    expect(view.origins.map((o) => o.key).slice(0, 2)).toEqual(['press', 'hackernews']);
    expect(view.origins.find((o) => o.key === 'hackernews')).toMatchObject({ weight: 3, visible: false });
    expect(view.items[0]).toMatchObject({ origin: 'hackernews', score: 3 });
    // A disabled origin stops being collected but what it already recorded stays.
    expect(view.items.some((i) => i.origin === 'google_trending_now')).toBe(true);
    c.advance(3700);
    expect(await t.db.rpc('theia_signals_due', { p_exclude_origins: ['x_news', 'x_trends'], p_now: c.iso() })).toBe(1);
  });

  it('backs off a failing source, flags it after repeated failures, and recovers', async () => {
    await t.db.rpc('theia_sync_origins', { p_config: origins(), p_now: c.iso() });
    let ok = false;
    const f = signalFetch({
      'https://trends.google.com/trending/rss?geo=US': () => (ok ? new Response(trendsXml(['alpha']), { status: 200 }) : new Response('busy', { status: 503 })),
      'https://hacker-news.firebaseio.com/v0/topstories.json': () => json([11]),
      'https://hacker-news.firebaseio.com/v0/item/11.json': () => json({ id: 11, title: 'Show HN: A thing', score: 1 }),
    });
    const state = () => t.sql<{ state: string; attempt_count: number; last_error: string | null }>(
      `select state, attempt_count, last_error from theia.signal_schedules where source_key = 'google_trending_now:US'`);
    const r = await pollSignals(t.db, { fetchImpl: f.impl, now: c.now, env: {} });
    expect(r).toMatchObject({ claimed: 2, succeeded: 1, failed: 1 });
    expect((await state())[0]).toMatchObject({ state: 'retrying', attempt_count: 1 });
    // Not due again until the backoff passes.
    expect((await pollSignals(t.db, { fetchImpl: f.impl, now: c.now, env: {} })).claimed).toBe(0);
    for (let i = 0; i < 4; i++) {
      c.advance(3700);
      await pollSignals(t.db, { fetchImpl: f.impl, now: c.now, env: {} });
    }
    expect((await state())[0]).toMatchObject({ state: 'needs_attention', attempt_count: 5, last_error: 'HTTP 503 from trends.google.com' });
    expect((await t.db.rpc<{ needsAttention: string[] }>('theia_signal_status', { p_now: c.iso() })).needsAttention).toEqual(['google_trending_now:US']);
    ok = true;
    c.advance(3700);
    await pollSignals(t.db, { fetchImpl: f.impl, now: c.now, env: {} });
    expect((await state())[0]).toMatchObject({ state: 'ok', attempt_count: 0, last_error: null });
  });

  it('writes nothing from a worker that no longer holds the lease', async () => {
    await t.db.rpc('theia_sync_origins', { p_config: origins(), p_now: c.iso() });
    const only = { p_limit: 1, p_exclude_origins: ['x_news', 'x_trends', 'hackernews'] };
    const first = await t.db.rpc<{ sourceKey: string; leaseToken: string }[]>('theia_claim_due_signals', { ...only, p_now: c.iso() });
    const startedLate = c.iso();
    const reading = (title: string, rank: number, startedAt: string) => ({ status: 'success', startedAt, items: [{ item_key: 'alpha', title, rank, related_urls: [`https://old.example/${rank}`] }] });
    // The first worker stalls past its lease. A second worker claims the source and commits a newer reading.
    c.advance(400);
    const second = await t.db.rpc<{ leaseToken: string }[]>('theia_claim_due_signals', { ...only, p_now: c.iso() });
    expect(second).toHaveLength(1);
    expect(second[0]!.leaseToken).not.toBe(first[0]!.leaseToken);
    await t.db.rpc('theia_commit_signal_poll', { p_source_key: 'google_trending_now:US', p_lease_token: second[0]!.leaseToken, p_result: reading('Alpha, newer', 1, c.iso()), p_now: c.iso() });
    // The stalled worker finishes. Its reading is older, and it must not replace anything.
    c.advance(30);
    const late = await t.db.rpc<{ leaseValid: boolean; items: number }>('theia_commit_signal_poll', {
      p_source_key: 'google_trending_now:US', p_lease_token: first[0]!.leaseToken, p_result: reading('Alpha, stale', 9, startedLate), p_now: c.iso() });
    expect(late).toMatchObject({ leaseValid: false, items: 0 });
    expect(await t.sql(`select title, last_rank, best_rank, observations, related_urls from theia.signal_daily`)).toEqual([
      { title: 'Alpha, newer', last_rank: 1, best_rank: 1, observations: 1, related_urls: ['https://old.example/1'] }]);
    // A commit with a token that was never issued is treated the same way.
    const forged = await t.db.rpc<{ leaseValid: boolean; items: number }>('theia_commit_signal_poll', {
      p_source_key: 'google_trending_now:US', p_lease_token: '00000000-0000-0000-0000-000000000000', p_result: reading('Forged', 1, c.iso()), p_now: c.iso() });
    expect(forged).toMatchObject({ leaseValid: false, items: 0 });
    expect(await t.one(`select count(*)::int from theia.ingestion_runs where (metadata->>'leaseValid')::boolean = false`)).toBe(2);
  });

  it('keeps each country\'s own reading of an entry that several countries list', async () => {
    const cfg = { origins: [{ key: 'google_trending_now', name: 'Google Trending Now', kind: 'search', enabled: true, cadenceSeconds: 3600, scopes: [
      { scope: 'US', country: 'US', language: 'en', viewCountries: ['US'], params: { geo: 'US' } },
      { scope: 'GB', country: 'GB', language: 'en', viewCountries: ['GB'], params: { geo: 'GB' } }] }] };
    await t.db.rpc('theia_sync_registry', { p_registry: registryFor([{ slug: 'alpha', country: 'US' }]), p_now: c.iso() });
    await t.db.rpc('theia_sync_origins', { p_config: cfg, p_now: c.iso() });
    const press = fakeFetch({ [feedUrl('alpha')]: { status: 200, items: [{ title: 'Harbour bridge closed after inspection', link: 'https://alpha.example/report', pubDate: '2026-11-20T11:00:00Z' }] } });
    const sig = signalFetch({
      'https://trends.google.com/trending/rss?geo=US': () => new Response(trendsXml(['harbour bridge'], 'https://alpha.example/report'), { status: 200 }),
      // The same search term trends in the UK, with a different article attached.
      'https://trends.google.com/trending/rss?geo=GB': () => new Response(trendsXml(['Harbour Bridge'], 'https://uk-paper.example/bridge'), { status: 200 }),
    });
    const impl = (url: string, init?: RequestInit) => (url.includes('alpha.example/') ? press.impl(url, init) : sig.impl(url, init));
    await runWorker(t.db, { fetchImpl: impl, now: c.now, env: {} });
    expect(await t.one('select count(*)::int from theia.signal_items')).toBe(1);

    const us = (await t.db.rpc<SignalsPayload>('theia_get_signals', { p_country: 'US', p_now: c.iso() })).items;
    const gb = (await t.db.rpc<SignalsPayload>('theia_get_signals', { p_country: 'GB', p_now: c.iso() })).items;
    expect(us).toHaveLength(1);
    expect(us[0]).toMatchObject({ title: 'harbour bridge', scope: 'US' });
    expect(us[0]!.related.map((r) => r.url)).toEqual(['https://alpha.example/report?utm_source=g']);
    expect(us[0]!.storyId).not.toBeNull();
    expect(gb[0]).toMatchObject({ title: 'Harbour Bridge', scope: 'GB', storyId: null });
    expect(gb[0]!.related.map((r) => r.url)).toEqual(['https://uk-paper.example/bridge?utm_source=g']);
  });

  it('does not let a poll in flight re-enable a source removed from the configuration', async () => {
    await t.db.rpc('theia_sync_origins', { p_config: origins(), p_now: c.iso() });
    const claimed = await t.db.rpc<{ sourceKey: string; leaseToken: string }[]>('theia_claim_due_signals', { p_limit: 10, p_exclude_origins: ['x_news', 'hackernews', 'google_trending_now'], p_now: c.iso() });
    expect(claimed.map((x) => x.sourceKey)).toEqual(['x_trends:US']);
    // While that poll is running, the owner removes the paid source.
    const without = { origins: origins().origins.filter((o) => o.key !== 'x_trends') };
    await t.db.rpc('theia_sync_origins', { p_config: without, p_now: c.iso() });
    const state = () => t.sql(`select state, lease_token is null as released, last_success_at from theia.signal_schedules where source_key = 'x_trends:US'`);
    expect(await state()).toEqual([{ state: 'disabled', released: true, last_success_at: null }]);

    const done = await t.db.rpc<{ leaseValid: boolean; items: number }>('theia_commit_signal_poll', {
      p_source_key: 'x_trends:US', p_lease_token: claimed[0]!.leaseToken, p_result: { status: 'success', items: [{ item_key: 'a', title: 'A', rank: 1 }] }, p_now: c.iso() });
    expect(done).toMatchObject({ leaseValid: false, items: 0 });
    const failed = await t.db.rpc<{ leaseValid: boolean }>('theia_fail_signal_poll', { p_source_key: 'x_trends:US', p_lease_token: claimed[0]!.leaseToken, p_error: { message: 'x' }, p_now: c.iso() });
    expect(failed.leaseValid).toBe(false);
    expect(await state()).toEqual([{ state: 'disabled', released: true, last_success_at: null }]);
    c.advance(90_000);
    expect(await t.db.rpc('theia_claim_due_signals', { p_limit: 10, p_exclude_origins: ['x_news', 'hackernews', 'google_trending_now'], p_now: c.iso() })).toEqual([]);

    // Switching an origin off with enabled: false behaves the same way for a poll in flight.
    c.set(T0);
    await t.db.rpc('theia_sync_origins', { p_config: origins(), p_now: c.iso() });
    const again = await t.db.rpc<{ leaseToken: string }[]>('theia_claim_due_signals', { p_limit: 10, p_exclude_origins: ['x_news', 'hackernews', 'google_trending_now'], p_now: c.iso() });
    await t.db.rpc('theia_sync_origins', { p_config: origins({ x_trends: { enabled: false } }), p_now: c.iso() });
    const off = await t.db.rpc<{ leaseValid: boolean }>('theia_commit_signal_poll', { p_source_key: 'x_trends:US', p_lease_token: again[0]!.leaseToken, p_result: { status: 'success', items: [] }, p_now: c.iso() });
    expect(off.leaseValid).toBe(false);
    expect((await state())[0]).toMatchObject({ state: 'disabled' });
  });

  it('gives up on a response whose body never finishes', async () => {
    await t.db.rpc('theia_sync_origins', { p_config: origins(), p_now: c.iso() });
    // Headers arrive at once; the body stream stays open forever and ignores the abort signal.
    const stalled = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('<rss>')); } }), { status: 200 });
    const hn = signalFetch(routes([]));
    const impl = (url: string, init?: RequestInit) => (url.includes('trends.google.com') ? stalled() : hn.impl(url, init));
    const started = Date.now();
    const r = await pollSignals(t.db, { fetchImpl: impl, now: c.now, env: {}, timeoutMs: 150 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r).toMatchObject({ claimed: 2, succeeded: 1, failed: 1 });
    expect(await t.one(`select last_error from theia.signal_schedules where source_key = 'google_trending_now:US'`)).toBe('Timed out after 150 ms reading trends.google.com');
  });

  it('reports a source that answers with nothing as failing, not healthy', async () => {
    const cfg = { origins: [
      { key: 'wikipedia_in_the_news', name: 'Wikipedia: In the news', kind: 'reference', enabled: true, cadenceSeconds: 3600, scopes: [{ scope: 'ja', language: 'ja', viewCountries: ['JP'] }] },
      { key: 'wikipedia_most_read', name: 'Most read', kind: 'reference', enabled: true, cadenceSeconds: 3600, scopes: [{ scope: 'ja', language: 'ja', viewCountries: ['JP'] }] },
      { key: 'techmeme', name: 'Techmeme', kind: 'aggregator', enabled: true, cadenceSeconds: 3600, scopes: [{ scope: 'global', viewCountries: ['JP'] }] },
    ] };
    await t.db.rpc('theia_sync_origins', { p_config: cfg, p_now: c.iso() });
    const f = signalFetch({
      // The Japanese featured feed has a most-read list but no news section.
      'https://api.wikimedia.org/feed/v1/wikipedia/ja/featured/': () => json({ mostread: { date: '2026-11-19Z', articles: [{ title: '灯籠祭', views: 900 }] } }),
      'https://www.techmeme.com/feed.xml': () => new Response('<rss version="2.0"><channel></channel></rss>', { status: 200 }),
    });
    const r = await pollSignals(t.db, { fetchImpl: f.impl, now: c.now, env: {} });
    expect(r).toMatchObject({ claimed: 3, succeeded: 1, failed: 2 });
    expect(await t.sql(`select source_key, state, last_error from theia.signal_schedules order by source_key`)).toEqual([
      { source_key: 'techmeme:global', state: 'retrying', last_error: 'The source returned no entries' },
      { source_key: 'wikipedia_in_the_news:ja', state: 'retrying', last_error: 'The ja featured feed has no "In the news" section; this edition may not publish one' },
      { source_key: 'wikipedia_most_read:ja', state: 'ok', last_error: null },
    ]);
    // The shipped configuration does not point "In the news" at an edition without one.
    const shipped = JSON.parse(readFileSync('config/signal-sources.json', 'utf8')) as { origins: { key: string; scopes?: { scope: string }[] }[] };
    expect(shipped.origins.find((o) => o.key === 'wikipedia_in_the_news')!.scopes!.map((x) => x.scope)).toEqual(['en']);
  });

  it('runs inside the worker and links an entry to the press story it points at', async () => {
    const pubs = [{ slug: 'alpha', country: 'US' as const }, { slug: 'bravo', country: 'US' as const }];
    await t.db.rpc('theia_sync_registry', { p_registry: registryFor(pubs), p_now: c.iso() });
    await t.db.rpc('theia_sync_origins', { p_config: origins(), p_now: c.iso() });
    const at = '2026-11-20T11:00:00Z';
    const press = fakeFetch({
      [feedUrl('alpha')]: { status: 200, items: [{ title: 'Harbour bridge closed after inspection finds fault', link: 'https://alpha.example/report', pubDate: at }] },
      [feedUrl('bravo')]: { status: 200, items: [{ title: 'Inspection fault closes the harbour bridge', link: 'https://bravo.example/bridge', pubDate: at }] },
    });
    const sig = signalFetch(routes(['harbour bridge closure'], 'https://alpha.example/report'));
    const impl = (url: string, init?: RequestInit) => (url.includes('.example/') ? press.impl(url, init) : sig.impl(url, init));

    const tick = await dispatchTick(t.db, async () => {}, { now: c.now, env: {} });
    expect(tick).toMatchObject({ dueSources: 2, dueSignals: 2, invoked: true });
    const summary = await runWorker(t.db, { fetchImpl: impl, now: c.now, env: {} });
    expect(summary.inserted).toBe(2);
    expect(summary.signals).toMatchObject({ claimed: 2, succeeded: 2, failed: 0 });

    const storyId = await t.one<string>(`select sa.story_id from theia.story_articles sa join theia.articles a on a.id = sa.article_id where a.normalized_url = 'https://alpha.example/report'`);
    const view = await t.db.rpc<SignalsPayload>('theia_get_signals', { p_country: 'US', p_window: '24h', p_now: c.iso() });
    const google = view.items.find((i) => i.origin === 'google_trending_now')!;
    expect(google.storyId).toBe(storyId);
    expect(google.threadId).not.toBeNull();
    // Hacker News item 12 links the same article; item 11 links nothing collected.
    expect(view.items.find((i) => i.title === 'Bridge inspection report')!.storyId).toBe(storyId);
    expect(view.items.find((i) => i.title === 'Show HN: A thing')!.storyId).toBeNull();
    expect(await t.one(`select count(*)::int from theia.ingestion_runs where provider = 'hackernews' and status = 'success'`)).toBe(1);
  });

  it('stores publisher attributes and rejects unknown countries', async () => {
    await t.db.rpc('theia_sync_registry', { p_registry: registryFor([{ slug: 'alpha', country: 'US' }]), p_now: c.iso() });
    expect(await t.db.rpc('theia_set_publisher_attributes', { p_attributes: { alpha: { weight: 2, tags: ['wire'] }, missing: { weight: 3 } } })).toBe(1);
    expect(await t.sql(`select weight::float8 as weight, tags from theia.publishers where slug = 'alpha'`)).toEqual([{ weight: 2, tags: ['wire'] }]);
    await expect(t.db.rpc('theia_get_signals', { p_country: 'ZZ' })).rejects.toThrow(/unknown country/);
  });
});
