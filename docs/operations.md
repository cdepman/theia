# Project Theia: operations

## Environment variables

All server-side. None may be prefixed with `VITE_`.

| Variable | Used by | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | API, worker, CLI | `https://<ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | API, worker, CLI | Starts with `sb_secret_`. Bypasses RLS; treat as root. |
| `GATE_PASSWORD` | gate | The shared password. |
| `GATE_SIGNING_KEY` | gate, API | Signs session cookies. Rotating it signs everyone out. |
| `WORKER_SECRET` | dispatcher, worker | Dispatcher sends it; worker requires it. |
| `STATUS_CHECK_SECRET` | API, GitHub Actions | For `/api/data-status` only. |

Generate each secret with `openssl rand -base64 32`. Locally they live in `.env`; on Netlify, in the site's environment variables.

## Commands

| Command | Effect |
| --- | --- |
| `npm run check:connection` | Calls `theia_meta` with the secret key. Confirms URL, key, and migrations. |
| `npm run registry:sync` | Upserts publishers and feeds from `config/`. Never deletes; removed sources are disabled. |
| `npm run pipeline` | One worker run from your machine: poll due feeds, cluster, thread, refresh. Add `-- --force` to poll every enabled feed now. |
| `npm run status` | Prints source states, heartbeats, and view freshness. |
| `npx tsx --env-file=.env pipeline/jobs/cli.ts pause` | Stops the dispatcher from starting work. `resume` reverses it. |
| `npm run dev` | Vite on 5173 plus the API on 8788. |
| `npm test`, `npm run test:e2e` | Unit and integration; Playwright against an in-process stack. |

## Enabling or disabling sources

Edit `config/source-activation.json`, then run `npm run registry:sync`.

- `enabledPublishers`: publisher ids from `config/source-candidates.json`.
- `excludedFeeds`: individual feed URLs to skip, with a reason.
- `cadenceSeconds`: poll interval, 10800 (3 hours) by default.

Check a publisher's terms in `docs/source-registry.md` before enabling it. A country shows as `limited` until it has 10 monitored publishers.

## Schedule

- Dispatcher: every 15 minutes. Cheap: one database call.
- Worker: started by the dispatcher when something is due, stale, unclustered, or awaiting threading. Budget 10 minutes.
- Views: refreshed after any run that ingested articles, and at least every 4 hours.

## Monitoring

`/api/data-status` reports `ok: false` with a list of problems when the dispatcher heartbeat is older than 45 minutes, a view is stale, or a source needs attention. The freshness workflow calls it twice an hour from outside Netlify; a failed run emails the repository owner. It needs two repository secrets: `THEIA_SITE_URL` and `STATUS_CHECK_SECRET`.

The two workflow files are kept as templates in `ops/github-workflows/`. To activate them:

```sh
mkdir -p .github/workflows && cp ops/github-workflows/*.yml .github/workflows/
```

`/admin/status` in the app shows the same information with per-source detail.

## Runbook

**Dispatcher heartbeat is stale.** The scheduled function is not firing. Check the Netlify function log for `dispatcher`. To keep data flowing meanwhile, run `npm run pipeline` locally, or enable the schedule in the `worker-fallback.yml` workflow.

**A source shows `needs_attention`.** Five consecutive failures. `npm run status` shows the last error. A 404 or 410 usually means the feed moved: update the URL in `config/source-candidates.json` or add it to `excludedFeeds`, then sync. It keeps retrying at its normal cadence and clears itself on the first success.

**A publisher asks you to stop.** Remove it from `enabledPublishers`, sync. Its history stays and it stops being polled. Removing its stored metadata is a manual SQL task and is not scripted yet.

**Views are stale but sources are healthy.** Run `npm run pipeline`. If the refresh errors, the message names the function; `theia_refresh_country` is idempotent and safe to rerun.

**Stop everything.** `pause`. In-flight leases expire within 5 minutes.

**Rotate the Supabase secret key.** Create a new key in the dashboard, update Netlify and `.env`, redeploy, then revoke the old one.

**Storage is growing.** The measured cost is roughly 4 to 5 KB per article including indexes and snapshots. The Free plan allows 500 MB. Rank snapshots are the largest steady contributor; see `docs/benchmarks.md`. Pruning snapshots older than a chosen horizon is the first lever, and it is not automated yet.

## Migrations

Files in `supabase/migrations/` are the source of truth. They are applied to the hosted project through the Supabase connector, which assigns its own version timestamps; filenames are renamed to match so the Supabase CLI sees a consistent history. As of 2026-11-21 only `theia_schema` is applied. The three original function migrations and `theia_review_fixes` are pending. Apply them in filename order before running the updated worker. Before `supabase db push`, run `supabase migration list` and confirm local and remote agree. The review-fixes migration preserves existing snapshots and affects future computations; after applying it, refresh all countries at a new cutoff to replace old cached payloads.

Every function migration ends with a block that revokes execute on all `public.theia_*` functions from `public`, `anon`, and `authenticated`. Any new migration that adds a function must end with the same block.
