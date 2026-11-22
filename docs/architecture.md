# Project Theia: architecture

One React app, a handful of Netlify functions, one Postgres database. No queue, no cache service, no second datastore.

```
RSS feeds
   |
   v
dispatcher (scheduled, every 15 min) --> worker-background (up to 10 min)
                                              |  claim -> fetch -> commit
                                              |  cluster -> thread -> refresh
                                              v
                                    Supabase Postgres (schema theia)
                                              ^
browser --> edge gate (cookie) --> /api/* ----+   reads precomputed views
```

## Directory map

| Path | Purpose |
| --- | --- |
| `src/` | React 19 + Vite + Tailwind 4 client. Pages: Explorer, Methodology, Admin status. |
| `server/routes.ts` | Every API route, as one framework-free `handleApi(request, ctx)`. |
| `server/gate.ts` | Login page, cookie issue and check. Runs in the Netlify Edge Function and in local dev. |
| `netlify/functions/` | `api`, `dispatcher` (scheduled), `worker-background`. Thin wrappers. |
| `netlify/edge-functions/gate.ts` | Applies the gate to every path. |
| `pipeline/` | Fetch, parse, normalize, classify, cluster, thread. Pure TypeScript apart from `db.ts` and `fetch.ts`. |
| `shared/` | Types, constants, and session signing used by both sides. |
| `supabase/migrations/` | Schema and every database function. |
| `config/` | Candidate publishers and the activation list. |
| `ops/github-workflows/` | Workflow templates: external freshness check and a worker fallback. Copy into `.github/workflows/` to activate. |
| `tests/` | Unit, integration (in-process Postgres), end to end (Playwright). |

## Database access

Tables live in a private `theia` schema with row level security enabled and no policies. The app never queries tables. It calls `public.theia_*` functions, which are `SECURITY DEFINER` with an empty `search_path`, and whose execute privilege is revoked from `public`, `anon`, and `authenticated` and granted to `service_role` only.

Consequences:

- Each multi-step write is one function call, so it is one transaction.
- The browser holds no Supabase key. The publishable key is unused.
- `pipeline/db.ts` defines `Db { rpc(fn, args) }`. Production uses supabase-js; tests use PGlite with the same migrations.

The PRD specified a dedicated `api` schema. Functions in `public` locked to `service_role` give the same isolation without changing the project's exposed-schema setting in the dashboard.

## Polling without a queue

`theia.source_schedules` has one row per feed: `next_due_at`, a lease token and expiry, the conditional-GET checkpoint, an attempt counter, and a state.

1. `theia_dispatch_tick` writes a heartbeat and reports due sources, stale countries, and languages with unclustered articles. If there is work, the dispatcher starts the background worker.
2. `theia_claim_due_sources` leases up to 10 due rows with `FOR UPDATE SKIP LOCKED`. Overlapping workers never take the same row.
3. The worker fetches with `If-None-Match` and `If-Modified-Since`, a 15 second timeout, and 4 feeds in flight.
4. `theia_commit_poll` upserts articles (idempotent on normalized URL) and advances the schedule only if the caller still holds the lease. A late worker's articles are kept; its schedule update is ignored.
5. `theia_fail_poll` backs off exponentially from 5 minutes with jitter, capped at the feed's cadence, never earlier than `Retry-After`. After 5 consecutive failures the source is marked `needs_attention` and keeps retrying at its normal cadence.

A worker that dies mid-run leaves leases that expire after 5 minutes. A worker that dies after committing is recovered on the next tick: pending work includes unassigned articles, stories without threads, and singleton threads awaiting re-evaluation. Completing this work refreshes every affected publisher country in the language, even when no feed inserts new articles.

## Clustering, threading, refresh

After polling, per language: `theia_clustering_input` returns unassigned articles, open stories, and a 30 day corpus; the worker clusters in memory; `theia_apply_clustering` writes assignments. Threading follows the same read, decide, apply shape, with `theia.thread_terms` as an inverted index so candidate threads are found in SQL.

`theia_refresh_country` then recomputes one country in one transaction against a single observation cutoff: daily coverage for the trailing month, append-only rank snapshots (top 100), and 30 cached views (10 categories by 3 windows). Under a per-country advisory lock, an equal or older cutoff is rejected before any writes, protecting both cached views and daily coverage. Rejected refreshes do not reconstruct historical snapshots.

Consolidated singleton threads retain their identity and historical snapshots. `merged_into_id` resolves old detail URLs to the current thread, retired threads leave the candidate index, and a `thread_merge` event records the move. Thread snapshot foreign keys restrict deletion. Membership updates serialize per language and resolve stale targets before applying a decision.

## Origins and signals

`theia.origins` lists every place an entry can come from, press included, with kind, lane, weight, display order and visibility. Non-press origins are collected as signals:

- `theia.signal_schedules`: one row per origin and scope (a country, a language edition, or global), with the same lease, backoff and `needs_attention` handling as press feeds, in its own table so registry syncs for press and signals cannot disturb each other.
- `theia.signal_items`: one row per distinct item per origin. `theia.signal_daily`: one row per item, source and UTC day.
- `pipeline/providers/signals/providers.ts`: one small fetch-and-parse function per origin. `pipeline/jobs/signals.ts` claims due sources, runs the provider, and commits or fails.
- An origin whose credentials are missing is left unclaimed. It is not counted as due and never marked as failing.
- X news has no "top stories" call, so its schedule names a seed source; the claim hands it that source's current top trend names to search for.

The worker polls signals after the press pipeline, inside the same time budget. A failure there cannot block clustering or views. `theia_get_signals` computes the attention view on read; nothing is cached, because the tables are small.

## Read path

`/api/stories` returns one row of `theia.cached_views`: a JSON payload built at refresh time. Detail routes (`/api/stories/:id`, `/api/threads/:id`) compute a small bounded read. Inputs are checked against allowlists before any database call. Responses use `Cache-Control: private`, so nothing is stored in a shared cache.

## Access control

A shared password is exchanged for an HMAC-signed session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`). The edge function checks it on every path, and the API function checks it again, so a misrouted request still fails closed. Without `GATE_SIGNING_KEY` the API refuses all requests unless `THEIA_DEV_NO_AUTH=1`, which is for local development only.

Two routes accept a machine secret instead of a cookie: the worker (`WORKER_SECRET`) and `/api/data-status` (`STATUS_CHECK_SECRET`).

## Visualization

The explorer draws headlines as SVG text over a country outline. Size encodes rank through a fixed ladder of steps, not a continuous scale, with a 12.5px legibility floor. Layout is a deterministic spiral: the same data always produces the same picture. Items that cannot be placed without overlap are omitted and counted, and the ranked list shows everything. Phones get the list by default.

Country outlines are generated at build time by `scripts/build-outlines.mjs` from world-atlas and committed as `src/lib/visualization/outlines.ts`.
