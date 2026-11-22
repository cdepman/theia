// End-to-end harness. Serves the built app, the access gate and the read API from one
// process, backed by an in-process Postgres with the real migrations.
//
// The data is a recorded snapshot of real feed metadata (docs/evidence/rss-probe-final.json,
// captured during the Phase 0 source review), pushed through the real pipeline: fetch,
// parse, normalize, cluster, thread, refresh. It exists only in memory, for tests and local
// design review. It is never written to Supabase.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { buildRegistry, type CandidatePublisher } from '../../pipeline/jobs/registry';
import { runWorker } from '../../pipeline/jobs/worker';
import { normalizeUrl } from '../../pipeline/normalize/url';
import { gate } from '../../server/gate';
import { handleApi } from '../../server/routes';
import { createTestDb, fakeFetch, type FeedResponse, type FixtureItem } from '../helpers/db';

const ROOT = join(import.meta.dirname, '../..');
const PORT = Number(process.env.E2E_PORT ?? 4173);
export const E2E_PASSWORD = 'e2e-only-password';
const env = { GATE_PASSWORD: E2E_PASSWORD, GATE_SIGNING_KEY: 'e2e-only-signing-key', STATUS_CHECK_SECRET: 'e2e-status', WORKER_SECRET: 'e2e-worker' };
// The moment the snapshot was taken. Everything in the harness runs on this clock.
const NOW = new Date('2026-11-21T10:00:00.000Z');

interface ProbeFeed {
  requestedUrl: string;
  status: string;
  articles?: { headline: string; url: string; publishedAt: string | null; futureDated: boolean }[];
}

async function seed() {
  const t = await createTestDb();
  const candidates = JSON.parse(readFileSync(join(ROOT, 'config/source-candidates.json'), 'utf8')) as { publishers: CandidatePublisher[] };
  const probe = JSON.parse(readFileSync(join(ROOT, 'docs/evidence/rss-probe-final.json'), 'utf8')) as { feeds: ProbeFeed[] };
  const feeds: Record<string, FeedResponse> = {};
  const failed: { url: string }[] = [];
  for (const f of probe.feeds) {
    const items: FixtureItem[] = (f.articles ?? [])
      .filter((a) => a.publishedAt && !a.futureDated)
      .map((a) => ({ title: a.headline, link: a.url, pubDate: a.publishedAt! }));
    if (items.length === 0) failed.push({ url: f.requestedUrl });
    else feeds[f.requestedUrl] = { status: 200, items };
  }
  // Every candidate with a working feed is enabled here, so the harness shows a fuller cloud
  // than the production activation file does. One country can be left empty to exercise that state.
  const emptyCountry = process.env.E2E_EMPTY_COUNTRY ?? '';
  const registry = buildRegistry(candidates, {
    enabledPublishers: candidates.publishers.filter((p) => p.country !== emptyCountry).map((p) => p.id),
    excludedFeeds: [...failed, ...candidates.publishers.flatMap((p) => p.feeds.filter((f) => !feeds[f.url]).map((f) => ({ url: f.url })))],
  });
  await t.db.rpc('theia_sync_registry', { p_registry: registry, p_now: NOW.toISOString() });
  const summary = await runWorker(t.db, { fetchImpl: fakeFetch(feeds).impl, now: () => NOW, staleCountries: ['US', 'GB', 'JP'] });
  console.log('[e2e] seeded', JSON.stringify(summary));
  // Grouping first: the signal fixtures point at the stories as they will be shown.
  await applyTrialGrouping(t);
  await seedSignals(t);
  return t;
}

// Preview of the language-model grouping: set E2E_LLM_TRIAL to the result file written by
// scratch/llm-trial.ts. Its judgments are logged and projected through the real functions.
async function applyTrialGrouping(t: Awaited<ReturnType<typeof createTestDb>>) {
  const file = process.env.E2E_LLM_TRIAL;
  if (!file) return;
  const trial = JSON.parse(readFileSync(file, 'utf8')) as { grouper: string; decisions: Record<string, unknown>[] };
  const ids = new Map((await t.sql<{ id: string; normalized_url: string }>('select id, normalized_url from theia.articles')).map((a) => [a.normalized_url, a.id]));
  const decisions = trial.decisions.flatMap((d) => {
    const id = ids.get(normalizeUrl(String(d.articleId)) ?? '');
    return id ? [{ ...d, articleId: id }] : [];
  });
  const later = new Date(NOW.getTime() + 1000).toISOString();
  const recorded = await t.db.rpc('theia_record_decisions', { p_grouper: trial.grouper, p_language: 'en', p_decisions: decisions, p_now: later });
  const applied = await t.db.rpc('theia_apply_grouping', { p_grouper: trial.grouper, p_language: 'en', p_now: later });
  for (const country of ['US', 'GB']) await t.db.rpc('theia_refresh_country', { p_country: country, p_cutoff: later, p_now: later });
  console.log('[e2e] applied trial grouping', trial.decisions.length, recorded, JSON.stringify(applied));
}

// Attention signals are seeded through the real sync, claim and commit functions with
// hand-written fixture lists. So that the links between the lanes can be seen and tested,
// a few entries per source are made to point at an article from one of the country's
// most widely covered stories. Those links are fixtures: they say nothing about what any
// of these services really listed.
const LINKED_PICKS: Record<string, number[]> = {
  google_trending_now: [0, 1, 3],
  x_trends: [0, 2],
  wikipedia_pageviews: [0, 4],
  wikipedia_in_the_news: [1],
  hackernews: [2],
  techmeme: [1, 5],
};

async function seedSignals(t: Awaited<ReturnType<typeof createTestDb>>) {
  const config = JSON.parse(readFileSync(join(ROOT, 'config/signal-sources.json'), 'utf8')) as { origins: { key: string }[] };
  await t.db.rpc('theia_sync_origins', { p_config: config, p_now: NOW.toISOString() });
  // X news stories stay uncollected here, to exercise the "not collected yet" state.
  const claimed = await t.db.rpc<{ sourceKey: string; leaseToken: string; originKey: string; country: string | null }[]>(
    'theia_claim_due_signals', { p_limit: 50, p_exclude_origins: ['x_news'], p_now: NOW.toISOString() });
  const lists: Record<string, string[]> = {
    google_trending_now: ['harbour bridge closure', 'lantern festival tickets', 'school term dates', 'rail strike dates', 'county cup final'],
    x_trends: ['#HarbourBridge', 'Lantern Festival', '#CountyCup', 'Rail Strike'],
    wikipedia_pageviews: ['Harbour Bridge', 'Lantern Festival', 'County Cup', 'List of rail strikes'],
    wikipedia_in_the_news: ['An inspection closes the Harbour Bridge to traffic.', 'The County Cup final is decided on penalties.'],
    wikipedia_most_read: ['Harbour Bridge', 'County Cup'],
    hackernews: ['Show HN: A tide table in 2 KB', 'Bridge inspection report (2026)', 'Why lanterns float'],
    techmeme: ['Harbour Systems buys Lantern Labs', 'Regulator opens inquiry into tide-table apps'],
    memeorandum: ['Lawmakers debate bridge inspection funding', 'County election results announced'],
    lobsters: ['A tiny tide-table parser', 'Making bridge sensors easier to test'],
    hatena: ['橋の点検報告書が公開', '灯籠祭の開催日程'],
  };

  // The most widely covered stories in each country's 24-hour view, with one article link each.
  const at = new Date(NOW.getTime() + 1000).toISOString();
  const top: Record<string, { title: string; url: string }[]> = {};
  for (const country of ['US', 'GB', 'JP']) {
    const view = await t.db.rpc<{ stories?: { id: string; headline: string }[] } | null>('theia_get_view', { p_country: country, p_category: 'all', p_window: '24h', p_now: at });
    const stories = (view?.stories ?? []).slice(0, 6);
    const labels = stories.length > 0 ? await t.db.rpc<Record<string, string>>('theia_short_labels', { p_ids: stories.map((s) => s.id) }) : {};
    top[country] = [];
    for (const s of stories) {
      const url = await t.one<string>(
        `select a.normalized_url from theia.story_articles sa join theia.articles a on a.id = sa.article_id
          where sa.story_id = $1 order by a.effective_at, a.id limit 1`, [s.id]);
      top[country]!.push({ title: labels[s.id] ?? s.headline, url });
    }
  }
  const viewCountries = new Map((await t.sql<{ source_key: string; view_countries: string[] }>('select source_key, view_countries from theia.signal_schedules')).map((r) => [r.source_key, r.view_countries]));

  for (const c of claimed) {
    const picks = LINKED_PICKS[c.originKey] ?? [];
    // A country's own source points at that country's stories; a source with no country of its
    // own (worldwide, or one language) points at one story in each country it is shown for.
    const hasCountrySources = claimed.some((o) => o.originKey === c.originKey && o.country);
    const targets = c.country ? [c.country] : hasCountrySources ? [] : (viewCountries.get(c.sourceKey) ?? []);
    const linked = targets.flatMap((country) => picks.flatMap((k) => {
      const story = top[country]?.[k];
      return story ? [{ key: `linked:${country}:${k}`, title: c.originKey === 'google_trending_now' ? story.title.toLowerCase() : story.title, related: [story.url] }] : [];
    }));
    const plain = (lists[c.originKey] ?? []).map((title) => ({ key: title.toLowerCase(), title, related: [] as string[] }));
    const items = [...linked, ...plain].map((e, i) => ({
      item_key: e.key, title: e.title, url: `https://example.org/fixture/${encodeURIComponent(e.key)}`, rank: i + 1,
      metric_kind: c.originKey === 'google_trending_now' ? 'approx_searches' : c.originKey === 'hatena' ? 'bookmarks' : null,
      metric_value: c.originKey === 'google_trending_now' ? Math.max(1, 8 - i) * 10000 : c.originKey === 'hatena' ? 81 - i : null,
      related_urls: e.related,
    }));
    await t.db.rpc('theia_commit_signal_poll', { p_source_key: c.sourceKey, p_lease_token: c.leaseToken, p_result: { status: 'success', items }, p_now: NOW.toISOString() });
  }
  console.log('[e2e] seeded signals from', claimed.length, 'sources');
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json',
};

function staticFile(pathname: string): Response {
  const dist = join(ROOT, 'dist');
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(dist, safe);
  let body: Buffer;
  try {
    body = readFileSync(extname(file) ? file : (file = join(dist, 'index.html')));
  } catch {
    body = readFileSync((file = join(dist, 'index.html')));
  }
  return new Response(new Uint8Array(body), { headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' } });
}

const t = await seed();

createServer(async (nodeReq, nodeRes) => {
  const chunks: Buffer[] = [];
  for await (const c of nodeReq) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) if (typeof v === 'string') headers.set(k, v);
  const method = nodeReq.method ?? 'GET';
  const req = new Request(`http://localhost:${PORT}${nodeReq.url ?? '/'}`, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks) });
  const url = new URL(req.url);
  let res: Response;
  try {
    const decision = await gate(req, env, Date.now());
    if (decision.action === 'respond') res = decision.response;
    else if (url.pathname.startsWith('/api/')) res = await handleApi(req, { db: t.db, env, now: () => NOW });
    else res = staticFile(url.pathname);
  } catch (e) {
    res = new Response(String((e as Error).message), { status: 500 });
  }
  nodeRes.statusCode = res.status;
  res.headers.forEach((v, k) => nodeRes.setHeader(k, v));
  nodeRes.end(Buffer.from(await res.arrayBuffer()));
}).listen(PORT, '127.0.0.1', () => console.log(`[e2e] ready on http://127.0.0.1:${PORT}`));
