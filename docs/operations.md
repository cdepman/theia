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
| `X_BEARER_TOKEN` | worker, dispatcher | Optional. X trends and X news are skipped until it is set. Paid per request. |
| `THEIA_CONTACT` | worker | Optional. An email or URL added to the User-Agent, as Wikimedia's policy asks. |

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

## Attention sources

Edit `config/signal-sources.json`, then run `npm run registry:sync` (it syncs press and attention sources together).

- `enabled`: collect or stop. History is kept either way.
- `weight`, `displayOrder`, `visible`: how entries are scored, where the origin sits, and whether it shows by default.
- `scopes`: one schedule each. `viewCountries` lists the country views it appears in.
- `cadenceSeconds`: per origin, or per scope to override.

Cost at the shipped settings: X trends makes 32 requests a day (4 places, every 3 hours), about $0.32 a day at the listed $0.01 per request. X news makes up to 18 requests a day (3 countries, 3 seed trends, every 12 hours); its per-request price was not confirmed, so check the X console after the first day. Lower `seedLimit` or set `enabled` to false to cut it. Everything else is free.

`npm run status` prints the state of every attention source after the press status. The admin page and the freshness alert do not cover attention sources yet.

Three additional sources require no credentials: [Memeorandum](https://www.memeorandum.com/about/) (US politics aggregation, shown in US/GB), [Lobsters](https://lobste.rs/about) (computing community, shown in all three views), and [Hatena Bookmark](https://b.hatena.ne.jp/help/entry/walking) (Japanese popular links, shown in Japan). Each polls one public feed every three hours and has weight 0.5. Their ordering represents each feed's list, not a population-wide measurement; Hatena bookmark counts and Lobsters points remain attributed to those communities. They are attention origins and never increase the distinct monitored publisher count.

`npm run signals:probe -- --output scratch/signals-fresh.json` captures all credential-free attention sources to a new local file, with failures recorded alongside successes. Use `--origins memeorandum,lobsters,hatena` for just the additions. It never calls paid APIs or changes the database. The configured pipeline picks up the new origins after the usual registry sync.

## Language-model trials

`npm run group:trial -- en` runs the versioned grouper on the recorded 72-hour English dataset. Use `ja` for Japanese. The default is Anthropic's `claude-haiku-5-5`, alone. These are local experiments; the scheduled press worker continues to use its existing clustering pipeline.

Select `--provider openai --model gpt-6-luna` or `--provider openai --model gpt-6.1-terra` to test OpenAI. `--reasoning low` sets the OpenAI reasoning effort explicitly; omit it for the model default. The OpenAI adapter uses the Responses API, strict JSON output, and `store: false`.

The same selections can be made with `LLM_PROVIDER`, `LLM_MODEL`, and `OPENAI_REASONING_EFFORT` in `.env`. CLI flags take precedence. Set `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` for the selected providers. Adding a key alone does not switch providers.

For escalation of unsure or unresolved assignments, add `--review-provider anthropic --review-model claude-sonnet-5-5` or `--review-provider openai --review-model gpt-6.2-sol`. The corresponding environment variables are `LLM_REVIEW_PROVIDER` and `LLM_REVIEW_MODEL`. Use `--review-model none` to disable escalation, including when `.env` enables it. The legacy `TRIAL_MODE=mid` selects the provider's default review model. This is the existing per-headline escalation, not the proposed whole-event review pass.

For a separate correction pass over a **completed** run, use `npm run group:review -- SOURCE.json`. Its default reviewer is Claude Haiku 5.5 at low effort; `--provider`, `--model`, and `--effort` select another configuration. The reviewer receives the full event catalog and member headlines, including confidently assigned entries, and proposes atomic splits, merges, or label repairs. Every affected article must remain assigned exactly once; missing, duplicated, invented, or overlapping assignments reject the proposal before it is applied. Original results remain intact. The proposal, corrected result, and per-call ledger are saved separately, with the source file's hash, review version, and effort setting.

`group:review` prints incremental and combined initial-plus-review cost. `--dry-run` inspects the request size and output path; `--report` reads saved costs without an API call. Repeating a completed configuration reports its result instead of spending again. The default output ceiling is 32,000 tokens, configurable with `--max-output-tokens` and included in the review identity. The correction request has a five-minute timeout. Keep the proposal and ledger with the reviewed JSON. A failed request still remains in its ledger, even if a later retry succeeds.

- `--dry-run` prints the configuration, progress, and result path without requiring keys or making requests.
- `--probe scratch/rss-fresh.json` uses a fresh capture and its recorded cutoff. Capture it first with `python3 scripts/probe_sources.py --output scratch/rss-fresh.json`, then pass that same path to both model runs. Each result embeds the ordered input headlines, so comparison uses the tested titles and publisher attribution even if other feed files later change.
- `--max-batches 1` runs at most one 60-headline batch. Omit it to finish. `TRIAL_BUDGET_MS` stops before starting another batch once the time budget is spent; an in-flight batch still completes.
- Repeat the same command to resume. Each result under `scratch/llm-trials/` is identified by its dataset hash, grouper version, language, model/provider selections, reasoning setting, batch size, and accounting version. Changing any of these starts a separate run. Old scratch JSON files are preserved, not silently resumed.
- Add `--report` (or positional `report`) to read a saved trial without API calls. An absent result is reported as an error.
- A `.lock` file prevents concurrent writers for the same configuration. After a killed process, remove its lock only once that process has stopped. Checkpoints are written atomically after each successful batch; an interrupted in-flight batch may need to be paid for again.
- `npm run group:compare -- en PATH_A PATH_B` compares complete runs with the same input and prompt version. It reports labeled-pair merges/splits, agreement, grouping sizes, runtime, and calculated costs. Legacy files without identity metadata can still be compared, with a warning.
- Add `--pairs tests/fixtures/review-pairs-2026-11-22.json` to score the exploratory review audit instead of the original clustering pairs. This audit deliberately samples agreement/disagreement cases, contains agent-written labels, and is not a representative production accuracy estimate. Reviewed result costs include both the initial pass and the additional review.

Each run prints `THIS_INVOCATION` spending and the `CUMULATIVE` total across resumes, with per-model token counts and dollar breakdowns for ordinary input, cached input, cache writes, and output. Reasoning tokens are included in output, never charged twice; their separate count is shown only when the provider reports it. Anthropic currently does not provide that separate count through this adapter.

The adjacent `.json.calls.jsonl` file records each attempt before sending it, then saves request/response IDs, timing, reported usage, outcome, and the exact rate snapshot used. It contains no credentials, prompts, or answers. Keep this ledger alongside the result JSON when moving a trial. A failed batch still contributes its paid calls; resuming does not erase them. Incomplete answers with usage are priced, while timeouts or killed calls without usage make the full total **unknown**, with the known portion shown separately. Unknown models, service tiers, or cache-write retention also remain unpriced. Damaged ledgers stop the run rather than silently discard charges.

`CALCULATED_COST_USD` uses actual API-reported tokens and published Standard rates checked on 2026-11-22 for both providers. It is not an invoice: account discounts, taxes, credits, and unreported usage can differ. The clients explicitly request standard service. Pricing handles cache retention and long-context thresholds; its date and source are saved per call. See [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing). Legacy trial costs cover only their saved successful batches.

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
