# Project Theia: measurements

Recorded 2026-11-21. Everything here was measured locally against an in-process Postgres (PGlite), not on Netlify or the hosted Supabase project. Hosted latency, function duration, Netlify usage, and alert delivery are **not measured**.

## Test results

| Suite | Result |
| --- | --- |
| Unit and integration (`npm test`) | 8 files, 80 tests, all passing |
| End to end (`npm run test:e2e`) | 16 passing, 2 skipped, desktop and mobile Chrome |
| Typecheck | clean |
| Production build | 353 KB JavaScript, 117 KB gzipped |

The integration tests run the real migrations and the real pipeline: registry sync, leasing with concurrent workers, lease expiry, stale-lease commits, backoff and `Retry-After`, `needs_attention`, gap recording, idempotent replays, clustering, threading, refresh, and the cutoff guard on cached views.

## Pipeline on recorded real feed metadata

Input: `docs/evidence/rss-probe-final.json`, the Phase 0 probe of live feeds (headline, URL, timestamp; no summaries). This is one snapshot of what feeds held at one moment, not a collection history.

| Measure | Value |
| --- | --- |
| Feeds ingested | 54 |
| Articles | 2,051 |
| Stories | 1,848 |
| Threads | 1,783 (53 with more than one story) |
| Full run: ingest, cluster, thread, refresh 3 countries | 14 s in process |
| Theia tables after the run | 10.2 MB |
| Approximate cost per article, all tables and indexes | 4 to 5 KB |

The story count is close to the article count because a single snapshot contains little cross-publisher overlap per feed section, and because clustering is tuned toward precision. Expect a lower ratio with all sections of many publishers collected continuously.

## Storage projection

Unverified arithmetic from the figures above, for the full candidate registry polled every 3 hours:

- Rank snapshots: up to 100 stories by 3 windows by 3 countries per refresh, plus threads, at 6 or more refreshes a day. Roughly 9,600 rows a day. This is the main steady growth.
- Articles: depends on publisher volume; the snapshot above is a few days of feed depth.

On those assumptions the Free plan's 500 MB could be reached within a few months. Measure real growth for two weeks before deciding on pruning or a plan change.

## Clustering quality

See `docs/methodology.md`. In-sample, 135 pairs labeled by the implementer: English precision 0.926 and recall 0.735; Japanese precision 0.950 and recall 0.655. Thread linking has no labeled evaluation.

## Not measured

- Cold and warm latency of `/api/stories` on Netlify.
- Background function duration and whether the legacy Free plan runs it as expected.
- Netlify usage per day at the 15 minute tick.
- Behavior of the edge gate with the CDN in front.
- Delivery of GitHub's failed-workflow email.
- Any live feed fetch from the deployed worker.
