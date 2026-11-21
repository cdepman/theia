#!/usr/bin/env python3
"""Render Phase 0 reports from the recorded, real provider observations."""
import datetime as dt
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return json.loads((ROOT/path).read_text())


def cell(value):
    return str(value if value is not None else 'unknown').replace('|', '\\|').replace('\n', ' ')


def main():
    registry = read('config/source-candidates.json')['publishers']
    rss = read('docs/evidence/rss-probe-final.json')
    gdelt = read('docs/evidence/gdelt-probe.json')['queries']
    feed_by_url = {f['requestedUrl']: f for f in rss['feeds']}
    cutoff = rss['summary']['cutoff']
    start = rss['summary']['windowStart']
    lines = [
        '# Project Theia — candidate source registry', '',
        f'Review date: 2026-11-21. Final common RSS cutoff: `{cutoff}`.', '',
        '**Candidate registry, not a production allowlist. Every publisher is disabled.** '
        'A successful HTTP/XML check is separate from permission to collect, archive, transform, or display content. '
        'No publisher is described here as legally cleared. The owner approval gate is in `decisions.md`.', '',
        'The machine-readable registry is `config/source-candidates.json`. Evidence is in '
        '`docs/evidence/rss-probe-final.json` and `docs/evidence/terms-probe.json`. '
        'Initial failed probes remain in `rss-probe.json`; corrected-address checks are in '
        '`rss-probe-supplemental.json`. A failed guessed URL does not establish that a publisher has no RSS service.', '',
        '## Reading the measurements', '',
        '- **Items** is the count in this one response, not a long-run typical count.',
        '- **24h items** uses published timestamps in the common preceding day, excludes invalid/future dates, '
        'and is only a lower bound on output. Feeds can truncate or select stories.',
        '- **Median interval** is the median positive gap between item timestamps in that response, '
        'not a measured server update frequency. Declared RSS TTL/update hints are shown where supplied. '
        'Typical frequency remains unmeasured until recurring observation is authorized.',
        '- **Summary** counts entries with a feed description/summary field. No summary text or article body is retained by this probe.',
        '- **Country** is the curated association of the outlet. It is neither event location nor audience geography. '
        'Global wires and international editions need explicit review before activation.',
        '- Ownership notes are candidate context, not a verified current ownership register. '
        'Multiple titles under the same parent are not independent owners; section feeds are never additional publishers.', '',
        '## Diversity and known gaps', '',
        'The candidates include national dailies, public/commercial broadcasters, political and business press, '
        'regional titles, specialist science/technology press, and licensing candidates for wire services. '
        'They span different editorial traditions, but this study does not assign political-bias scores or claim balance. '
        'US regional coverage is selective; UK Reach titles share ownership; Japan mixes Japanese and English editions, '
        'has weak regional-feed coverage, and has substantial unresolved reuse restrictions. '
        'AP, Reuters, and PA are candidates without a verified open feed; they were not polled or purchased.', '',
    ]
    for country, name in [('US', 'United States'), ('GB', 'United Kingdom'), ('JP', 'Japan')]:
        pubs = [p for p in registry if p['country'] == country]
        lines += [f'## {name} ({country}) — {len(pubs)} candidates', '',
            '| Publisher | Language / format | Ownership context | Reuse review |',
            '| --- | --- | --- | --- |']
        for p in pubs:
            lines.append(f"| [{cell(p['name'])}]({p['sourcePage']}) | {p['language']} / {cell(p['format'])} | "
                         f"{cell(p['ownershipCandidate'])} | [{p['termsStatus']}]({p['termsUrl']}) — {cell(p['usageNotes'])} |")
        lines += ['', '### Feed observations', '',
            '| Publisher / section | Feed | Result | Items / 24h items | Summary | Median item interval / declared refresh |',
            '| --- | --- | --- | --- | --- | --- |']
        for p in pubs:
            if not p['feeds']:
                lines.append(f"| {p['name']} | No verified open endpoint | Not tested | unknown | unknown | unknown |")
            for feed in p['feeds']:
                f = feed_by_url.get(feed['url'], {})
                status = f.get('status', 'not tested')
                if status != 'ok':
                    status += ': ' + str(f.get('error', f.get('httpStatus', 'unknown')))
                else:
                    status += ' / HTTP ' + str(f['httpStatus'])
                refresh = []
                if f.get('declaredTtlMinutes'):
                    refresh.append('TTL '+f['declaredTtlMinutes']+' min')
                if f.get('declaredUpdatePeriod'):
                    refresh.append(str(f.get('declaredUpdateFrequency') or '?')+'/'+f['declaredUpdatePeriod'])
                interval = str(f.get('medianItemIntervalMinutes', 'unknown')) + ' min / ' + (', '.join(refresh) or 'not declared')
                summary = f"{f['summaryCount']}/{f['validArticleCount']}" if status.startswith('ok') else 'unknown'
                counts = f"{f.get('itemCount', 'unknown')} / {f.get('sampleDayCount', 'unknown')}"
                lines.append(f"| {p['name']} / {feed['section']} | [RSS]({feed['url']}) | {cell(status)} | {counts} | {summary} | {interval} |")
        lines.append('')
    lines += ['## Activation criteria', '',
        'Before enabling a source: confirm its canonical publisher identity/country, verify the current official feed, '
        'resolve the recorded terms issue for private headline clustering and retention, preserve original attribution '
        'and direct links, and record the decision and evidence. Do not infer approval from an empty extracted terms page '
        'or an HTTP 200 that redirects to a homepage. Start at a three-hour cadence while respecting publisher-specific limits.', '',
        'Any country with fewer than ten enabled, usable publishers must display **limited coverage**. '
        'The current technical totals do not satisfy that launch criterion by themselves.', '']
    (ROOT/'docs/source-registry.md').write_text('\n'.join(lines))

    lines = ['# Project Theia — Phase 0 data feasibility', '',
        'Review date: 2026-11-21. Governing brief: vault `project-theia-mvp-prd-initial.md`, version 1.4. '
        'This report is the first approval gate; it is not evidence of a completed or deployed MVP.', '',
        '## Recommendation', '',
        '**Proceed to a US vertical slice only after the owner approves Phase 0 and the platform connection is fixed.** '
        'Use curated RSS, keep GDELT disabled for production/backfill, and keep US/GB/JP as the planned countries. '
        'Enable only sources whose specific private display/retention use is established; label coverage limited '
        'until ten usable publishers are enabled. Do not replace Japan or add a paid feed without approval.', '',
        'The review found enough technically readable feeds to investigate all three countries, but it did **not** '
        'establish ten permission-compatible production sources per country. '
        'Exact title matching alone has weak dynamic range, particularly for Japanese. '
        'No 30-day historical coverage or validated story/thread matching accuracy has been demonstrated.', '',
        '## Actual RSS sampling', '',
        f'The common publication window is `{start}` through `{cutoff}`. '
        'This is one snapshot of records available in feeds with dates in the preceding 24 hours, '
        '**not continuous observation for a full day**. The snapshot contains only real fetched metadata.', '',
        '| Country | Candidates | Valid feeds / tested | Publishers with valid feeds | Publishers represented in day | Unique article URLs in day | Exact-title groups | Groups with ≥2 publishers |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
    for country, s in rss['summary']['countries'].items():
        count = sum(p['country'] == country for p in registry)
        lines.append(f"| {country} | {count} | {s['successfulFeeds']}/{s['testedFeeds']} | {s['publishersWithValidFeeds']} | "
                     f"{s['publishersWithItemsInDay']} | {s['uniqueArticlesInDay']} | {s['naiveExactHeadlineGroups']} | {s['groupsWithTwoOrMorePublishers']} |")
    lines += ['', 'Method: deduplicate by publisher + URL after removing only known tracking parameters; '
        'group within one language by exact headline equality after Unicode NFKC, case folding, punctuation removal, '
        'and whitespace collapse. Missing/invalid/future publication dates do not enter this feasibility-day sample. '
        'Production will instead follow the PRD’s first-observed/effective-time rules. Multiple feeds from one publisher '
        'never inflate its count. These groups are naive candidates, not ground-truth stories.', '',
        'All detected cross-publisher exact groups have two publishers. Several are consistent with syndicated copy; '
        'exact equality cannot establish independent reporting. Japan’s zero exact multi-publisher groups does not '
        'mean Japanese outlets cover unrelated events. Language-specific similarity and labeled evaluation are needed '
        'before using prominence visually. Do not enlarge singleton headlines to manufacture hierarchy.', '',
        'Evidence and reproducibility: [final RSS metadata](evidence/rss-probe-final.json), '
        '[candidate registry](../config/source-candidates.json), [probe](../scripts/probe_sources.py), '
        '[source review](source-registry.md). Original source URLs, dates, hashes, response health, and examples are retained. '
        'Full article bodies are neither fetched nor retained.', '',
        '### Japan and rights', '',
        'Readable Japanese-language feeds include NHK, Asahi, Mainichi, Sankei, Jiji, Okinawa Times, ITmedia, '
        'Impress, and Toyo Keizai. Kyodo English and The Japan Times are English-language Japanese outlets; '
        'they must not be silently linked to Japanese stories. Several regional/national candidate paths return 404 or HTML. '
        'That is a failed endpoint check, not proof of universal feed absence.', '',
        'Reuse requirements are material. For example, '
        '[ITmedia’s RSS conditions](https://corp.itmedia.co.jp/media/rss_condition/) restrict extraction/modification '
        'and request consultation for app integration. Asahi’s feed reserves reproduction/republication rights. '
        'The Japan Times candidate terms URL redirects to its homepage. These are unresolved activation issues, '
        'not permissions granted by a working feed. No country is currently declared production-ready.', '',
        'NYT, NPR, Guardian, and Independent publish personal/noncommercial RSS or content-feed conditions; '
        'those conditional uses still need to fit this owner-only app. '
        '[Fox RSS terms](https://www.foxnews.com/about/rss) restrict modifications/intermediate pages, '
        '[ProPublica’s republishing rules](https://www.propublica.org/steal-our-stories) prohibit automatic/wholesale republication, '
        'and [Telegraph terms](https://www.telegraph.co.uk/about-us/terms-and-conditions/) address software development. '
        'The registry records these restrictions rather than treating generic personal-use wording as blanket clearance.', '',
        '## GDELT DOC 2.0', '',
        'The [official DOC documentation](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) '
        'describes `sourcecountry` as outlet location, with country names or FIPS codes; it is not an event-location filter. '
        'The probes use country names to avoid confusing ISO `GB`/`JP` with FIPS codes. '
        'It documents a rolling three-month search range, 75 default/250 maximum article results, '
        'time-bounded queries, language filtering, and translated search over supported languages. '
        'Its default relevance ordering favors prominent outlets; this study explicitly requested `DateDesc`.', '',
        'Six requests were issued sequentially, with at least six seconds after each response, to test each '
        'country at 24h and 30d. Four returned HTTP 429, whose response requests at most one call per five seconds. '
        'Spacing at six seconds did not ensure service. This confirms a stated rate constraint, not a usable capacity guarantee. '
        'No rapid-fire throttle test or exhaustive backfill was attempted.', '',
        '| Query | Result | Records | Distinct domains | Observed `seendate` range |',
        '| --- | --- | ---: | ---: | --- |']
    for q in gdelt:
        dates = sorted(a['seendate'] for a in q.get('articles', []) if a.get('seendate'))
        span = f'{dates[0]} – {dates[-1]}' if dates else 'unavailable'
        lines.append(f"| [{q['country']} {q['window']}]({q['url']}) | HTTP {q.get('httpStatus', '?')} / {q['status']} | "
                     f"{q.get('recordCount', 'unknown')} | {len(q['domains']) if 'domains' in q else 'unknown'} | {span} |")
    lines += ['', 'The US 30d query returned the documented maximum while its returned observation times span '
        'only 6 hours 15 minutes. It therefore does not establish a 30-day archive. JP 24h returned 78 records '
        'with Japanese, English, and Spanish labels. Its domains include `3djuegos.com`, `engadget.com`, and '
        '`nintendolife.com`; this warrants manual outlet-attribution review rather than accepting the country label as truth. '
        'Those surprising domains are a review signal, not a completed ownership/geography determination.', '',
        'The returned US sample intersects this registry at `npr.org`; the JP sample intersects Asahi, '
        'Nikkei’s Asia edition, Tokyo Shimbun, and Okinawa Times. Missing registry publishers are not evidence '
        'that GDELT never covers them: date ordering, caps, indexing delays, edition/domain identity, and '
        'request failure all bias this comparison. UK breadth could not be evaluated because both probes were rate-limited.', '',
        '[Actual GDELT records and responses](evidence/gdelt-probe.json) include original URLs, titles, domains, '
        'language, `sourcecountry`, and `seendate`. Do not substitute `seendate` for verified publication time '
        'or Theia’s immutable `first_observed_at`. GDELT discovery does not retroactively make a signal available '
        'to Theia at the article’s historical date.', '',
        '[GDELT’s published terms](https://gdeltproject.org/about.html#termsofuse) allow use of its datasets '
        'with attribution/link requirements for redistribution. That does not establish rights to scrape '
        'or republish the linked publishers’ full content. No article-body scraping is proposed.', '',
        'Recommendation: leave GDELT off. If later approved, probe selected registry domains over bounded time slices, '
        'record truncation and country conflicts, and never call the result comprehensive. '
        'At launch, 7d/30d windows should show the observed partial history. Days before collection and known gaps '
        'must be unknown, not zero; do not fabricate a backfill or thread history.', '',
        '## What this phase does and does not establish', '',
        '- Established: a candidate set within the required 15–25 outlets per country, real feed availability, '
        'one-day-window sample counts, reproducible naive matching, source restrictions, live DOC outcomes, and platform readiness checks.',
        '- Not established: continuous full-day capture, typical feed output/update rates, ten approved sources per country, '
        'labeled clustering/thread precision, storage bytes per article, SQL/API/UI latency, hosting credit usage, '
        'private deployment, alert delivery, or the production outage drill. These require subsequent authorized phases.',
        '- No app, production database schema, polling pipeline, hosted repository, or Netlify site has been created. '
        'No paid service was enabled. All observed data here is research evidence, not production seed data.', '',
        '## Required decision', '',
        'Approve or revise the concrete settings in [decisions.md](decisions.md). '
        'The governing PRD section 3 explicitly says to present these results and wait for approval before Phase 1. '
        'The Supabase connection also needs repair as recorded in [platform-readiness.md](platform-readiness.md).', '']
    (ROOT/'docs/data-feasibility.md').write_text('\n'.join(lines))


if __name__ == '__main__':
    main()
