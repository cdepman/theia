# Project Theia: decisions

Updated 2026-11-21, after the MVP build.

## Confirmed by the owner

| Decision | Status |
| --- | --- |
| Build directory | `/Users/charlie/Developer/project-theia`. |
| Governing requirements | Vault `project-theia-mvp-prd-initial.md`, version 1.4 (stories plus threads and coverage curves). |
| Phase 0 gate | Crossed. The owner asked for the working MVP to be built after reviewing the PRD. |
| Supabase project | `ezcdosyfaugtemuboxmh`, named `theia`, us-east-1, Postgres 17, Free plan. Verified through the Supabase connector: dedicated and empty before the Theia schema. |
| Secrets | Stay in `.env` and `.mcp.json`, both ignored by Git. Never in a `VITE_*` variable or the client bundle. |

## Still the owner's call

| Decision | Proposal | Why it is open |
| --- | --- | --- |
| Which publishers to poll | Default enables NYT, NPR, The Guardian, The Independent. | These four publish feed terms that allow personal, non-commercial reader use. Every other candidate needs a terms decision. Japan has none enabled, so it shows no data. |
| GitHub repository | New private `cdepman/project-theia`. | Creating a repository needs explicit approval. Nothing is committed yet. |
| Netlify site | New `project-theia` site in Charlie Depman's team, existing Free plan. | Creating a site and deploying needs explicit approval. Background function behavior on the legacy plan is unverified. |
| Alerting channel | GitHub Actions freshness check, failed-run email. | Needs the repository and two secrets; delivery untested. |
| Paid services | None. | Not approved. Storage growth may force the question in a few months; see `benchmarks.md`. |
| Second gate | Review the deployed private slice before widening sources. | Not reached; nothing is deployed. |

## Deviations from the PRD

| PRD | Built | Reason |
| --- | --- | --- |
| Database functions in a dedicated `api` schema. | `public.theia_*` functions, execute granted to `service_role` only; tables in private schema `theia`. | Same isolation without changing the exposed-schema setting in the dashboard. |
| 150 or more labeled pairs, labeled by the owner. | 135 pairs labeled by the implementer. | No owner labeling session happened. Thresholds are provisional. |
| Japanese signatures from kanji runs. | `Intl.Segmenter` words plus whole katakana runs. | Raw kanji runs produced poor terms; katakana names were being split. |
| Story merge and split events. | Not implemented. `story_events` records thread links, singleton-thread consolidations, and reignitions. | Scope. Stories can fragment. |
| Deployed vertical slice with measured latency and usage. | Built and tested locally only. | No shell here can reach Netlify, GitHub, or Supabase directly, and creating the site needs approval. |
| Snapshot pruning. | Not implemented. | Wait for real growth numbers. |

## Routine implementation decisions

- Lease-based polling on the schedule table instead of a queue. One fewer moving part, and `SKIP LOCKED` already gives safe concurrency.
- Views are precomputed at refresh time and replaced only by a newer observation cutoff. Reads are a single row.
- The API fails closed without a signing key. The gate is checked at the edge and again in the function.
- `Cache-Control: private` everywhere until CDN behavior behind the gate is verified.
- Publisher identity, not feed URL or corporate parent, is the ranking unit.
- Unknown days are never rendered or counted as zero.
- Nothing is deleted on registry sync. A removed source is disabled and keeps its history.
- Tests run the real migrations in PGlite, so the SQL is exercised without a hosted database.

## Implementation review fixes

The follow-up review fixes are in the additive `theia_review_fixes` migration. Consolidation preserves thread identities and snapshots; old detail links resolve to the current thread. Recorded gap days remain unknown, and rolling 30-day totals share exact timestamp boundaries across rankings and details. Equal or older refresh cutoffs are rejected before writes, and unfinished threading is recovered without new feed items. The backoff tests use their fixture clock throughout, including cases in 2000 and 2040. This work is validated locally; the hosted migration remains pending.
- Phase 0 Python probes are kept as research tooling. They are not part of the app.

## Origins and attention signals (added 2026-11-21)

- The owner asked for Google Trending Now, X trends, X news stories, the Wikipedia featured feed, Wikipedia pageviews, Hacker News and Techmeme as first-class entries beside the press, each attributed so display, position and weight can be changed later. Paying for X was approved "for the time being".
- Attributes live on the origin, in `config/signal-sources.json`, and reach every API entry. Press is an origin too. Publishers gained `weight` and `tags`, stored but not used in ranking.
- Signals use their own schedule table, not the press one, so neither registry sync can disable the other's sources.
- The attention view is computed on read. No cache table until size requires one.
- The Wikipedia featured feed is split into two origins, "In the news" and "most read", because one is editorial and the other is traffic. "Most read" is hidden by default since per-country pageviews say the same thing more precisely.
- Hacker News and Techmeme are weighted 0.5 by default: they are English-language technology lists shown in every country view.
- Linking attention to press is by exact article URL only. Term matching against threads is not built.
- Not done: attention in the admin page and freshness alert, the in-app methodology page, a cross-country "world" view, and recorded-response fixtures.

## Attention-signal review fixes (2026-11-21)

Five faults found in review, each fixed with a regression test that fails on the earlier code:

- **Readings are per source.** What a source said about an entry (title, link, attached articles) is stored on that source's daily row. A UK poll can no longer replace the links on the US reading of the same trend.
- **A lost lease writes nothing.** Signal readings replace earlier ones, so a commit is applied only while the caller holds the lease. Readings are timed from when the poll started, and an older reading never replaces a newer one.
- **Disabling ends polls in flight.** Removing or switching off a source clears its lease, and a disabled source is never moved back to `ok`, `retrying` or `needs_attention` by a late commit. This also stops further paid requests.
- **The request deadline covers the body.** One deadline spans headers and body and holds even if the transport ignores the abort.
- **Empty is a failure.** A source that returns no entries, or a Wikipedia feed without the section asked for, is recorded as failing. Japanese "In the news" is removed from the configuration because that edition does not publish the section. X news is the one origin allowed to be empty.

## Approval record

- Phase 0 to Phase 1: approved by the owner's request to build.
- Phase 1 to Phase 2: not reached.
- Paid services or plan changes: not approved.
- Repository, site creation, deployment: not approved, not done.
- Production source enablement: four publishers by default in `config/source-activation.json`; the registry has not been synced to the hosted database.
