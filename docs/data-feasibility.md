# Project Theia — Phase 0 data feasibility

Review date: 2026-11-21. Governing brief: vault `project-theia-mvp-prd-initial.md`, version 1.4. This report is the first approval gate; it is not evidence of a completed or deployed MVP.

## Recommendation

**Proceed to a US vertical slice only after the owner approves Phase 0 and the platform connection is fixed.** Use curated RSS, keep GDELT disabled for production/backfill, and keep US/GB/JP as the planned countries. Enable only sources whose specific private display/retention use is established; label coverage limited until ten usable publishers are enabled. Do not replace Japan or add a paid feed without approval.

The review found enough technically readable feeds to investigate all three countries, but it did **not** establish ten permission-compatible production sources per country. Exact title matching alone has weak dynamic range, particularly for Japanese. No 30-day historical coverage or validated story/thread matching accuracy has been demonstrated.

## Actual RSS sampling

The common publication window is `2026-11-20T09:45:10.832273+00:00` through `2026-11-21T09:45:10.832273+00:00`. This is one snapshot of records available in feeds with dates in the preceding 24 hours, **not continuous observation for a full day**. The snapshot contains only real fetched metadata.

| Country | Candidates | Valid feeds / tested | Publishers with valid feeds | Publishers represented in day | Unique article URLs in day | Exact-title groups | Groups with ≥2 publishers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| US | 19 | 16/20 | 14 | 14 | 294 | 289 | 5 |
| GB | 20 | 21/22 | 17 | 16 | 623 | 620 | 3 |
| JP | 18 | 17/24 | 11 | 11 | 326 | 318 | 0 |

Method: deduplicate by publisher + URL after removing only known tracking parameters; group within one language by exact headline equality after Unicode NFKC, case folding, punctuation removal, and whitespace collapse. Missing/invalid/future publication dates do not enter this feasibility-day sample. Production will instead follow the PRD’s first-observed/effective-time rules. Multiple feeds from one publisher never inflate its count. These groups are naive candidates, not ground-truth stories.

All detected cross-publisher exact groups have two publishers. Several are consistent with syndicated copy; exact equality cannot establish independent reporting. Japan’s zero exact multi-publisher groups does not mean Japanese outlets cover unrelated events. Language-specific similarity and labeled evaluation are needed before using prominence visually. Do not enlarge singleton headlines to manufacture hierarchy.

Evidence and reproducibility: [final RSS metadata](evidence/rss-probe-final.json), [candidate registry](../config/source-candidates.json), [probe](../scripts/probe_sources.py), [source review](source-registry.md). Original source URLs, dates, hashes, response health, and examples are retained. Full article bodies are neither fetched nor retained.

### Japan and rights

Readable Japanese-language feeds include NHK, Asahi, Mainichi, Sankei, Jiji, Okinawa Times, ITmedia, Impress, and Toyo Keizai. Kyodo English and The Japan Times are English-language Japanese outlets; they must not be silently linked to Japanese stories. Several regional/national candidate paths return 404 or HTML. That is a failed endpoint check, not proof of universal feed absence.

Reuse requirements are material. For example, [ITmedia’s RSS conditions](https://corp.itmedia.co.jp/media/rss_condition/) restrict extraction/modification and request consultation for app integration. Asahi’s feed reserves reproduction/republication rights. The Japan Times candidate terms URL redirects to its homepage. These are unresolved activation issues, not permissions granted by a working feed. No country is currently declared production-ready.

NYT, NPR, Guardian, and Independent publish personal/noncommercial RSS or content-feed conditions; those conditional uses still need to fit this owner-only app. [Fox RSS terms](https://www.foxnews.com/about/rss) restrict modifications/intermediate pages, [ProPublica’s republishing rules](https://www.propublica.org/steal-our-stories) prohibit automatic/wholesale republication, and [Telegraph terms](https://www.telegraph.co.uk/about-us/terms-and-conditions/) address software development. The registry records these restrictions rather than treating generic personal-use wording as blanket clearance.

## GDELT DOC 2.0

The [official DOC documentation](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) describes `sourcecountry` as outlet location, with country names or FIPS codes; it is not an event-location filter. The probes use country names to avoid confusing ISO `GB`/`JP` with FIPS codes. It documents a rolling three-month search range, 75 default/250 maximum article results, time-bounded queries, language filtering, and translated search over supported languages. Its default relevance ordering favors prominent outlets; this study explicitly requested `DateDesc`.

Six requests were issued sequentially, with at least six seconds after each response, to test each country at 24h and 30d. Four returned HTTP 429, whose response requests at most one call per five seconds. Spacing at six seconds did not ensure service. This confirms a stated rate constraint, not a usable capacity guarantee. No rapid-fire throttle test or exhaustive backfill was attempted.

| Query | Result | Records | Distinct domains | Observed `seendate` range |
| --- | --- | ---: | ---: | --- |
| [US 24h](https://api.gdeltproject.org/api/v2/doc/doc?query=sourcecountry%3Aunitedstates&mode=ArtList&format=json&maxrecords=250&sort=DateDesc&timespan=24h) | HTTP 429 / http_error | unknown | unknown | unavailable |
| [US 30d](https://api.gdeltproject.org/api/v2/doc/doc?query=sourcecountry%3Aunitedstates&mode=ArtList&format=json&maxrecords=250&sort=DateDesc&timespan=30d) | HTTP 200 / ok | 250 | 120 | 20261121T003000Z – 20261121T064500Z |
| [GB 24h](https://api.gdeltproject.org/api/v2/doc/doc?query=sourcecountry%3Aunitedkingdom&mode=ArtList&format=json&maxrecords=250&sort=DateDesc&timespan=24h) | HTTP 429 / http_error | unknown | unknown | unavailable |
| [GB 30d](https://api.gdeltproject.org/api/v2/doc/doc?query=sourcecountry%3Aunitedkingdom&mode=ArtList&format=json&maxrecords=250&sort=DateDesc&timespan=30d) | HTTP 429 / http_error | unknown | unknown | unavailable |
| [JP 24h](https://api.gdeltproject.org/api/v2/doc/doc?query=sourcecountry%3Ajapan&mode=ArtList&format=json&maxrecords=250&sort=DateDesc&timespan=24h) | HTTP 200 / ok | 78 | 18 | 20261120T214500Z – 20261121T064500Z |
| [JP 30d](https://api.gdeltproject.org/api/v2/doc/doc?query=sourcecountry%3Ajapan&mode=ArtList&format=json&maxrecords=250&sort=DateDesc&timespan=30d) | HTTP 429 / http_error | unknown | unknown | unavailable |

The US 30d query returned the documented maximum while its returned observation times span only 6 hours 15 minutes. It therefore does not establish a 30-day archive. JP 24h returned 78 records with Japanese, English, and Spanish labels. Its domains include `3djuegos.com`, `engadget.com`, and `nintendolife.com`; this warrants manual outlet-attribution review rather than accepting the country label as truth. Those surprising domains are a review signal, not a completed ownership/geography determination.

The returned US sample intersects this registry at `npr.org`; the JP sample intersects Asahi, Nikkei’s Asia edition, Tokyo Shimbun, and Okinawa Times. Missing registry publishers are not evidence that GDELT never covers them: date ordering, caps, indexing delays, edition/domain identity, and request failure all bias this comparison. UK breadth could not be evaluated because both probes were rate-limited.

[Actual GDELT records and responses](evidence/gdelt-probe.json) include original URLs, titles, domains, language, `sourcecountry`, and `seendate`. Do not substitute `seendate` for verified publication time or Theia’s immutable `first_observed_at`. GDELT discovery does not retroactively make a signal available to Theia at the article’s historical date.

[GDELT’s published terms](https://gdeltproject.org/about.html#termsofuse) allow use of its datasets with attribution/link requirements for redistribution. That does not establish rights to scrape or republish the linked publishers’ full content. No article-body scraping is proposed.

Recommendation: leave GDELT off. If later approved, probe selected registry domains over bounded time slices, record truncation and country conflicts, and never call the result comprehensive. At launch, 7d/30d windows should show the observed partial history. Days before collection and known gaps must be unknown, not zero; do not fabricate a backfill or thread history.

## What this phase does and does not establish

- Established: a candidate set within the required 15–25 outlets per country, real feed availability, one-day-window sample counts, reproducible naive matching, source restrictions, live DOC outcomes, and platform readiness checks.
- Not established: continuous full-day capture, typical feed output/update rates, ten approved sources per country, labeled clustering/thread precision, storage bytes per article, SQL/API/UI latency, hosting credit usage, private deployment, alert delivery, or the production outage drill. These require subsequent authorized phases.
- No app, production database schema, polling pipeline, hosted repository, or Netlify site has been created. No paid service was enabled. All observed data here is research evidence, not production seed data.

## Required decision

Approve or revise the concrete settings in [decisions.md](decisions.md). The governing PRD section 3 explicitly says to present these results and wait for approval before Phase 1. The Supabase connection also needs repair as recorded in [platform-readiness.md](platform-readiness.md).
