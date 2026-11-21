import { categorize } from '../classify/categorize';
import { pipelineConfig } from '../config';
import { type FeedItem, parseDate } from '../providers/rss/parse';
import { cleanText, normalizeHeadline } from './headline';
import { normalizeUrl } from './url';

export interface ClaimedSource {
  sourceKey: string;
  leaseToken: string;
  checkpoint: { etag?: string | null; lastModified?: string | null } | null;
  cadenceSeconds: number;
  lastSuccessAt: string | null;
  feedUrl: string;
  language: string;
  section: string | null;
  defaultCategory: string | null;
  publisherId: string;
  publisherSlug: string;
  publisherName: string;
  domain: string;
  country: string | null;
}

export interface ArticleInput {
  normalized_url: string;
  original_url: string;
  headline_original: string;
  headline_normalized: string;
  summary: string | null;
  published_at: string | null;
  language_code: string;
  category: string;
  category_method: string;
  category_version: number;
  provider_record_id: string | null;
  source_metadata: Record<string, unknown>;
}

export interface BuiltArticles {
  articles: ArticleInput[];
  rejected: number;
  feedOldestItemAt: string | null;
}

/** Turns parsed feed items into article records. Only metadata and links; never body text. */
export function buildArticles(source: ClaimedSource, items: FeedItem[]): BuiltArticles {
  const seen = new Set<string>();
  const articles: ArticleInput[] = [];
  let rejected = 0;
  let oldest: Date | null = null;

  for (const item of items) {
    const headline = cleanText(item.title).slice(0, 500);
    const normalizedUrl = item.link ? normalizeUrl(item.link, source.feedUrl) : null;
    if (!headline || !normalizedUrl) {
      rejected += 1;
      continue;
    }
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);

    const published = parseDate(item.published);
    if (published && (!oldest || published < oldest)) oldest = published;

    const headlineNormalized = normalizeHeadline(headline, [source.publisherName]);
    if (!headlineNormalized) {
      rejected += 1;
      continue;
    }
    const summaryText = cleanText(item.summary);
    // A "summary" that merely repeats the headline adds nothing.
    const summary = summaryText && summaryText !== headline ? summaryText.slice(0, pipelineConfig.summaryMaxChars) : null;
    const feedCategories = item.categories
      .slice(0, 5)
      .map((c) => cleanText(c).slice(0, 40))
      .filter(Boolean);
    const cat = categorize({
      headlineNormalized,
      summary,
      language: source.language,
      defaultCategory: source.defaultCategory,
      feedCategories,
    });

    let originalUrl: string;
    try {
      originalUrl = new URL(item.link as string, source.feedUrl).toString();
    } catch {
      originalUrl = normalizedUrl;
    }

    articles.push({
      normalized_url: normalizedUrl,
      original_url: originalUrl,
      headline_original: headline,
      headline_normalized: headlineNormalized,
      summary,
      published_at: published ? published.toISOString() : null,
      language_code: source.language,
      category: cat.category,
      category_method: cat.method,
      category_version: cat.version,
      provider_record_id: item.guid ? item.guid.slice(0, 500) : null,
      source_metadata: {
        section: source.section,
        ...(feedCategories.length ? { feedCategories } : {}),
        ...(item.published && !published ? { unparsedDate: item.published.slice(0, 60) } : {}),
      },
    });
  }

  return { articles, rejected, feedOldestItemAt: oldest ? oldest.toISOString() : null };
}
