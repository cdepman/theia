# Project Theia

A private news explorer. It shows which stories the most monitored publishers are reporting in the United States, the United Kingdom, and Japan over 24 hours and 7 days, and over 30 days which subjects keep being covered and which fade.

It measures reporting observed in a fixed list of RSS feeds. It does not measure audience attention, and a publisher's country is not where an event happened. See [methodology](docs/methodology.md).

**Status: MVP built and tested locally. Not deployed. The hosted database has the tables but not yet the functions.** See [what is left](#what-is-left).

## Setup

Requires Node 22 or newer.

```sh
npm install
cp .env.example .env    # skip if .env exists; fill in the values
```

`.env` needs `SUPABASE_URL` and `SUPABASE_SECRET_KEY`, plus four secrets you generate yourself with `openssl rand -base64 32`: `GATE_PASSWORD`, `GATE_SIGNING_KEY`, `WORKER_SECRET`, `STATUS_CHECK_SECRET`.

## First run

```sh
npm run check:connection   # URL, key, and migrations are in place
npm run registry:sync      # load publishers and feeds from config/
npm run pipeline           # poll due feeds, cluster, thread, build views
npm run dev                # http://localhost:5173, sign in with GATE_PASSWORD
```

Apply all five migrations in `supabase/migrations/` before running the app. `check:connection` checks connectivity and the read API; the review-fixes migration is also required by the worker.

The first pipeline run gives a thin picture: feeds only hold their most recent items, and the 30 day view needs weeks of collection. Days before collection began are shown as unknown, not as zero.

## Choosing sources

`config/source-candidates.json` lists 57 candidate publishers. `config/source-activation.json` decides which are polled; four are enabled by default (NYT, NPR, The Guardian, The Independent). Japan has none enabled, so it shows no data until you enable some. Review terms in [the source registry](docs/source-registry.md), edit the activation file, and run `npm run registry:sync`.

## Public attention

Beside the press, the explorer shows what other services list as trending: Google Trending Now, X trends and X news stories, Wikipedia most viewed and "In the news", Hacker News and Techmeme. Every entry is attributed to its origin. `config/signal-sources.json` controls which origins are collected and their weight, order and default visibility; run `npm run registry:sync` after editing it.

X needs `X_BEARER_TOKEN` in `.env` and costs money per request; without it the two X origins are skipped and everything else runs. See [operations](docs/operations.md#attention-sources) for the cost at the shipped settings.

## Comparing language models

The grouper supports Anthropic Messages and OpenAI Responses with the same prompt and JSON schema. Add `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` to `.env` for the providers you select.

```sh
# Inspect the dataset, model configuration, and result path without making requests.
npm run group:trial -- en --provider openai --model gpt-6-luna --reasoning low --dry-run
# A small live trial; rerunning without --max-batches resumes to completion.
npm run group:trial -- en --provider openai --model gpt-6-luna --reasoning low --max-batches 1
npm run group:trial -- en --provider openai --model gpt-6.1-terra --reasoning low
# Compare complete runs, using the STATE paths printed by those commands.
npm run group:compare -- en scratch/llm-trials/RUN_A.json scratch/llm-trials/RUN_B.json
# Apply a separate Claude correction pass to a completed OpenAI run.
npm run group:review -- scratch/llm-trials/RUN_B.json
```

Trials use recorded headlines and save results locally; they do not update the hosted database or the app's grouping. Provider calls incur API charges. Each run prints costs calculated from reported token usage and saves a per-call ledger, including failed attempts and the rates used. See [model trial settings](docs/operations.md#language-model-trials) for mixed-provider escalation, reports, resuming, and billing limitations.

For fresh data, capture feeds with `python3 scripts/probe_sources.py --output scratch/rss-fresh.json`, then add `--probe scratch/rss-fresh.json` to both trial commands. `npm run signals:probe -- --output scratch/signals-fresh.json` separately refreshes all attention sources that need no keys, including Memeorandum, Lobsters, and Hatena Bookmark.

## Tests

```sh
npm test            # unit and integration, in-process Postgres with the real migrations
npm run test:e2e    # Playwright, uses your installed Chrome
npm run build       # typecheck and production bundle
```

None of these touch the hosted database or the network.

## Deploying

Not done yet. In outline:

1. Create a private GitHub repository and push.
2. Create a Netlify site from it. `netlify.toml` already defines the build, functions, and headers.
3. Set the six environment variables on the site.
4. Deploy. The dispatcher runs every 15 minutes and starts the worker when feeds are due.
5. Copy the workflow templates from `ops/github-workflows/` into `.github/workflows/`, then add `THEIA_SITE_URL` and `STATUS_CHECK_SECRET` as repository secrets to turn on the freshness check.

Details and the runbook are in [operations](docs/operations.md).

## What is left

- Apply the three original function migrations and `theia_review_fixes` to the hosted project, then sync the registry.
- Decide which publishers to enable beyond the default four.
- Deploy, then measure what has not been measured: hosted latency, function duration, Netlify usage, alert delivery.
- Validate thread linking once a few weeks of history exist. It is untested against labeled data.
- Story merge pass and snapshot pruning are not implemented.

## Documents

- [Methodology](docs/methodology.md): definitions, formulas, limitations.
- [Architecture](docs/architecture.md): how the pieces fit.
- [Operations](docs/operations.md): commands, monitoring, runbook.
- [Measurements](docs/benchmarks.md): what was measured, and what was not.
- [Decisions](docs/decisions.md): approvals, open questions, deviations from the PRD.
- Phase 0 research: [data feasibility](docs/data-feasibility.md), [source registry](docs/source-registry.md), [platform readiness](docs/platform-readiness.md). Reproduce with the Python scripts in `scripts/`.

The governing PRD is in the vault: `project-theia/project-theia-mvp-prd-initial.md`, version 1.4.

Keep `.env` and `.mcp.json` local. The Supabase secret key bypasses row level security; never commit it or expose it to the browser.
