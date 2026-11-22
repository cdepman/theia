import type { TrialArticle } from './trial';

export interface ProbeDataset {
  summary: { cutoff: string };
  feeds: {
    publisherId: string; country: string; language: string;
    articles?: { url: string; headline: string; publishedAt: string | null; futureDated: boolean }[];
  }[];
}

/** Freeze one ordered, deduplicated corpus for both providers; never mix in attention-list votes. */
export function articlesFromProbe(probe: ProbeDataset, language: string, snapshot: string, hours = 72): TrialArticle[] {
  const cutoff = Date.parse(snapshot);
  if (!Number.isFinite(cutoff)) throw new Error('The dataset has no valid snapshot cutoff');
  const seen = new Set<string>(), articles: TrialArticle[] = [];
  for (const feed of probe.feeds) {
    if (feed.language !== language) continue;
    if (!feed.publisherId || !feed.country) throw new Error('The dataset is missing publisher attribution');
    for (const article of feed.articles ?? []) {
      if (!article.publishedAt || article.futureDated || seen.has(article.url) || !article.headline.trim()) continue;
      const at = Date.parse(article.publishedAt), age = cutoff - at;
      if (!Number.isFinite(at) || age < 0 || age > hours * 3600e3) continue;
      seen.add(article.url);
      articles.push({ id: article.url, publisher: feed.publisherId, headline: article.headline,
        at: article.publishedAt, country: feed.country });
    }
  }
  return articles.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
