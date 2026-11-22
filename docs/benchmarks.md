# Project Theia: measurements

Baseline recorded 2026-11-21 against local in-process Postgres (PGlite). The 2026-11-22 source and model comparison below uses live public feeds and provider APIs. Hosted latency, function duration, Netlify usage, and alert delivery are **not measured**.

## Fresh sources and model comparison (2026-11-22)

Added Memeorandum, Lobsters, and Hatena Bookmark without new credentials. A live probe succeeded for all 14 credential-free source scopes, returning 399 attention entries. The additions supplied 15, 25, and 40 entries respectively. Attention lists remain separate from publisher counts. Live Hatena titles exposed numeric HTML entities; decoding is fixed and covered by a regression test.

Both model trials used the same ordered 1,087 English headlines from 33 publishers, captured at 2026-11-22 09:01 UTC, within a 72-hour publication window. The input includes 377 US, 662 GB, and 48 JP publisher articles. Both used the same `llm-v2` prompt, batches of 60, and no escalation. Haiku used its default effort; Luna used `low`.

| Measure | Claude Haiku 5.5 | OpenAI GPT-6 Luna |
| --- | ---: | ---: |
| Calculated USD | $0.1378994 | $0.0501192 |
| Model run time | 765.0 s | 398.9 s |
| API calls | 19 | 19 |
| Failed / unknown-cost calls | 0 / 0 | 0 / 0 |
| Input tokens, including cache | 317,119 | 176,249 |
| Output tokens, including reasoning | 212,375 | 56,179 |
| Separately reported reasoning tokens | Not reported | 10,272 |
| Events | 708 | 711 |
| Events with multiple publishers | 136 | 152 |
| Labeled same-event pairs joined | 9 / 9 | 7 / 9 |
| Labeled different-event pairs kept apart | 1 / 3 | 3 / 3 |

Luna cost 63.7% less and finished in 52.1% of the time. Cost is calculated from actual reported tokens and saved published standard rates, not an invoice. Luna's total includes $0.022024 in cache-write charges; neither run reported cache hits. Each attempt has a durable usage/price record, and reports preserve totals across resumes.

The small labeled sample does not establish a quality winner: 66 older pairs were no longer available, and the labels came from the build agent. Both scored 10/12 overall but made different mistakes. Outside that sample, Luna placed ten unrelated headlines into an "Edible packaging solution" event and changed Burchett to Boebert in another label. The lower cost alone is insufficient reason to switch production grouping. A review pass needs the event's member headlines to catch these errors.

Detailed [measurements and configuration](evidence/model-comparison-2026-11-22.json) and [comparison output](evidence/model-comparison-2026-11-22.txt) are saved in `docs/evidence/` for version control. Full input, decisions, and per-call ledgers remain local under `scratch/llm-trials/`; keep each `.json` with its `.json.calls.jsonl` file.

Final checks: 181 unit/integration tests pass across 18 files; 23 browser tests pass with 3 mobile-inapplicable checks skipped; typecheck and production build pass. The deployed pipeline and hosted database were not changed by these trials.

## Test results

The following baseline table is from 2026-11-21. The latest correction-pass validation is 195 unit/integration tests across 19 files, 23 browser tests passing with 3 skipped, and passing typecheck/build.

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

## OpenAI initial pass followed by Claude correction (2026-11-22)

The `event-review-v1` experiment reviews the completed Luna run rather than paying for its initial grouping again. Claude Haiku 5.5 receives all 711 event labels and all 1,087 member headlines, proposes only corrections, and runs at low effort. The code checks the full proposal before applying it, requiring every original headline to remain assigned exactly once and rejecting overlapping replacements. The initial runs remain unchanged.

| Successful configuration | Cost from reported usage | Time | New audit: same pairs joined | New audit: different pairs separated | Total correct |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude Haiku alone, default effort | $0.1378994 | 765.0 s | 12/15 | 10/11 | 22/26 |
| OpenAI Luna alone, low effort | $0.0501192 | 398.9 s | 9/15 | 7/11 | 16/26 |
| Luna then Haiku review, both low effort | $0.0623809 | 428.1 s | 11/15 | 9/11 | 20/26 |

The review added $0.0122617 and 29.2 seconds. It made five corrections affecting 48 headlines. It fixed four scored errors and introduced none **in this sample**. It separated the ten unrelated members of the packaging event, cleaned mixed cyber-director coverage, and reunited Texas-execution coverage. It missed the wrong-person Burchett/Boebert label, Palisades splits, and Myanmar verdict/reaction splits. All replacement groups had empty location lists, reducing events with location annotations from 435 to 430; the partition score does not measure this metadata loss.

The new [32-pair audit](../tests/fixtures/review-pairs-2026-11-22.json) was sampled by deterministic hash order from four initial-model agreement/disagreement strata, eight pairs each, with at most two uses of an article. Six ambiguous pairs were excluded. The build agent fixed the labels from headlines before viewing the hybrid result; the labels were not sent to the reviewer. This is an exploratory, deliberately difficult sample, not a population accuracy estimate or owner-reviewed ground truth. On the older 12-pair subset, all three configurations still score 10/12.

**Judgment:** the hybrid improves on Luna alone for little additional cost, but it did not beat Claude alone in this sample. The successful hybrid is about 55% cheaper than Claude alone. It is a useful experimental tradeoff, not a validated default. Further review should measure erroneous corrections as well as fixes, wrong names, and location preservation.

Setup failures are excluded from the reusable configuration totals above but remain in the cost ledger: one HTTP 400 schema rejection supplied no usage (cost unknown), and one default-effort review exhausted 32,000 output tokens, costing $0.0250742 from reported usage. The unsupported numeric schema constraint was removed while retaining local validation; the low-effort configuration then completed successfully. Total additional known spend for developing/testing the review was $0.0373359, plus the unpriced rejection.

See the [complete experiment record](evidence/hybrid-review-2026-11-22.json), [hybrid versus Luna](evidence/hybrid-vs-openai-2026-11-22.txt), and [hybrid versus Claude](evidence/hybrid-vs-claude-2026-11-22.txt). Reports include combined initial-plus-review cost; `group:review --report` reproduces the cost without more API calls.

## Claude initial pass followed by OpenAI correction (2026-11-22)

The reverse experiment reuses the completed Claude Haiku 5.5 grouping and asks OpenAI Luna at low effort to review all 708 events and 1,087 headlines. It uses the same `event-review-v1` prompt, 32,000-token output limit, and unchanged evaluation fixtures as the forward experiment.

| Configuration | Cost from reported usage | Same pairs joined | Different pairs separated | Total correct |
| --- | ---: | ---: | ---: | ---: |
| Claude alone | $0.1378994 | 12/15 | 10/11 | 22/26 |
| OpenAI alone | $0.0501192 | 9/15 | 7/11 | 16/26 |
| OpenAI then Claude | $0.0623809 | 11/15 | 9/11 | 20/26 |
| Claude then OpenAI, including rejected attempt | $0.14594288 | 12/15 | 10/11 | 22/26 |

OpenAI's first proposal failed local validation: its fourth correction named an unrelated original event and assigned article 459 twice. The entire proposal was rejected, preserving the original grouping. One retry with the same settings passed. Both responses completed successfully at the API level, but only one was a valid review. Both attempts are included in the reverse configuration's cost. The forward configuration still excludes its separately documented setup failures above.

The accepted proposal made one correction covering eight headlines. It moved White House briefing coverage into the news-conference event and separated a Pence/Vance/Iran commentary from the GOP-race event. These look like useful corrections from the headlines, but they did not change any scored audit pair. The older 12-pair subset also remained at 10/12. No audit labels were changed or sent to the reviewer. This remains a small, agent-labeled exploratory sample.

The review added **$0.00804348** and 25.276 seconds of API time across both attempts. The accepted retry alone cost $0.00105368, benefiting from 50,688 cached input tokens; that is not a fresh-run cost estimate. Combined initial-run and review API time was approximately 790.2 seconds. The saved trial's `durationMs` and raw comparison output include only the accepted review invocation (777.4 seconds combined), so the evidence record separately reports the rejected attempt's 12.864 seconds. Cost totals already include both attempts.

Location coverage fell from 260 events to 259; three rewritten headlines lost their location list. The audit pair score does not measure location or label quality. The reverse pass offers no measured audit improvement over Claude alone; Claude remains the quality baseline, while OpenAI followed by Claude remains the cheaper experimental tradeoff. Production defaults were not changed.

The [complete reverse experiment record](evidence/reverse-hybrid-review-2026-11-22.json) retains both proposals, per-attempt usage and cost, and before/after headlines. See also [reverse versus Claude](evidence/reverse-hybrid-vs-claude-2026-11-22.txt) and [reverse versus forward](evidence/reverse-hybrid-vs-forward-2026-11-22.txt). Source hashes and all 1,087 unique article assignments were verified; rejection and successful application were reproduced locally. All 195 unit/integration tests and the typecheck/production build pass again.
