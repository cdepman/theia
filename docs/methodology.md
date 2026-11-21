# Project Theia: methodology

What the numbers mean, how they are computed, and where they are weak. Parameter values live in `pipeline/config.ts` and in `theia.pipeline_settings`; this file describes version 1 of each.

## What is measured

Theia measures reporting observed in RSS feeds from a fixed list of monitored publishers. It does not measure audience attention, article prominence on a homepage, or importance. "United States" means publishers attributed to the United States, not events located there or readers located there.

Only metadata is stored: headline, link, publication time, feed section, and a summary truncated to 500 characters when the feed provides one. Article bodies are never fetched.

## Units

| Unit | Definition |
| --- | --- |
| Article | One normalized URL. Tracking parameters, fragments, and trailing slashes are removed before deduplication. |
| Story | Articles in one language that report the same event, grouped within a 72 hour window. A story closes after 72 hours without a new article. |
| Thread | Stories about the same continuing subject, linked across weeks. A thread goes dormant after 21 days without coverage and can be reopened for 90 days. |
| Publisher | The ranking unit. Several section feeds from one outlet count once. Corporate ownership is not collapsed. |

## Rankings

- **24h and 7d** rank stories by the number of distinct monitored publishers with at least one article in the story inside the window. Ties: article count, then most recent article, then story id.
- **30d** ranks threads by publisher-days: each publisher counts once per UTC day on which it covered the thread. Ties: active days, then distinct publishers, then most recent coverage, then thread id.

Publisher-days rewards sustained coverage. Five outlets covering a subject on twenty days (100) outrank twenty outlets covering it on one day (20). That is the intent of the 30 day view.

The window is the preceding 30 elapsed days, with an exclusive start and inclusive cutoff. It can touch 31 UTC dates; counts on the first and last dates include only articles inside the interval. Rankings, detail totals, and country comparisons use these same boundaries. Recorded gap days are excluded from publisher-days and active days.

## Coverage curves and status

Each thread has a daily series of distinct publishers per UTC day. Status uses a trailing 3 day mean, because daily counts from a small publisher list are small integers:

| Status | Rule |
| --- | --- |
| active | Coverage in the last 3 days and the trailing mean is at least half of its peak. |
| fading | Coverage in the last 3 days, trailing mean below half of peak. |
| quiet | No coverage in the last 3 days, thread not yet dormant. |
| dormant | No coverage for 21 days. |
| unknown | No day in the trailing 3 days is known. |

Decay is the number of days from the peak of the trailing mean to the first day at or below half of it. It is absent when the series never falls that far.

## Unknown is not zero

A day before collection began for a country, or overlapping a recorded coverage gap, is unknown. It is drawn as a gap and excluded from publisher-days, active days, decay, and status. One exception: when an article published on a pre-collection day was picked up later, that day is known as a lower bound and marked partial, unless it overlaps a recorded gap. Articles from gap days remain available in story details and the 24h/7d story rankings.

A day is partial when it is the first collection day or a boundary date of the rolling window. A gap is recorded when a feed is polled after more than twice its cadence and its oldest item is newer than the last successful poll, meaning items may have scrolled out unseen. Gap intervals include their start and exclude their end. Unknown days never create a decay crossing or count as observed silence.

Every view carries a coverage block: monitored and active publisher counts, failing sources, gaps, the observed range, and a status of `complete`, `partial`, `limited` (fewer than 10 monitored publishers), `no_data`, or `no_sources`.

## Clustering (stories)

Per language, each unassigned article is compared with the centroid of every open story using TF-IDF cosine similarity. English uses word unigrams and bigrams; Japanese uses character bigrams within script runs. An article joins the best story at or above the threshold, otherwise it starts a new one.

| Language | Threshold | Labeled pairs | Precision | Recall |
| --- | --- | --- | --- | --- |
| en | 0.28 | 78 | 0.926 | 0.735 |
| ja | 0.33 | 53 | 0.950 | 0.655 |

These figures are in-sample: the thresholds were tuned on the same 135 pairs (`tests/fixtures/cluster-pairs.json`), which were labeled by the implementer, not the owner, and number fewer than the 150 the PRD calls for. Treat them as a starting point. The bias is deliberate: a missed merge splits a story, a false merge invents one.

Near-identical headlines (similarity 0.9 or more within 24 hours) from different publishers are flagged as syndicated. Syndicated articles still count toward their publisher.

## Threading

Each story gets a signature of its 8 most distinctive terms. English prefers proper nouns found in sentence-case text; Japanese uses `Intl.Segmenter` words plus whole katakana runs. A story links to an existing thread when all of these hold:

1. At least 2 shared signature terms that are not near-duplicates of each other.
2. Entity evidence: 2 shared proper nouns in English, 1 rare or Latin-script term in Japanese. Without it, 3 shared terms.
3. Signature cosine of at least 0.2 with a rare shared term, otherwise at least 0.3.

**Thread linking is not validated against labeled data.** Validating it needs several weeks of real history, which does not exist yet. Expect both missed links and some false ones until it is tuned on real collection.

## Categories

In order: the feed's section, then feed-provided labels, then keyword rules for English and Japanese, then `other`. Ties resolve to `other`. A story takes the most common non-`other` category of its articles; a thread does the same over its stories.

## Known limitations

- Stories fragment. In the recorded sample one large event was split into two stories. No merge pass exists yet.
- A publisher that does not expose a feed, or whose feed is excluded on terms grounds, is invisible.
- Feed depth varies. A low-volume feed can undercount a publisher that covers a subject outside the sections monitored.
- English and Japanese are clustered separately. Nothing links a Japanese story to an English one.
- Publication times come from the feed and are trusted unless they are in the future.
