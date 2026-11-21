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
  return t;
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
