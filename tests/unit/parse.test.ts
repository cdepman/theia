import { describe, expect, it } from 'vitest';
import { categorize, sectionToCategory } from '../../pipeline/classify/categorize';
import { buildArticles, type ClaimedSource } from '../../pipeline/normalize/article';
import { parseRetryAfter } from '../../pipeline/providers/rss/fetch';
import { FeedParseError, parseDate, parseFeed } from '../../pipeline/providers/rss/parse';

const source: ClaimedSource = {
  sourceKey: 'rss:demo:headlines', leaseToken: 'x', checkpoint: null, cadenceSeconds: 10800, lastSuccessAt: null,
  feedUrl: 'https://demo.example/feed.xml', language: 'en', section: 'headlines', defaultCategory: null,
  publisherId: 'p1', publisherSlug: 'demo', publisherName: 'Demo News', domain: 'demo.example', country: 'GB',
};

describe('feed parsing', () => {
  it('parses RSS 2.0, including CDATA, guid permalinks and categories', () => {
    const feed = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><title>Demo</title>
      <item><title><![CDATA[Budget &amp; tax: what changed]]></title><link>https://demo.example/a?utm_source=rss</link>
        <guid isPermaLink="false">abc-1</guid><pubDate>Fri, 20 Nov 2026 09:00:00 GMT</pubDate>
        <description><![CDATA[<p>The chancellor set out <b>changes</b>.</p>]]></description><category>Politics</category></item>
      <item><title>Guid only</title><guid>https://demo.example/b</guid></item>
    </channel></rss>`);
    expect(feed.format).toBe('rss');
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toMatchObject({ link: 'https://demo.example/a?utm_source=rss', guid: 'abc-1', categories: ['Politics'] });
    expect(feed.items[1]!.link).toBe('https://demo.example/b');
  });

  it('parses Atom with alternate links', () => {
    const feed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Demo</title>
      <entry><title type="html">Atom story</title><link rel="self" href="https://demo.example/self"/>
        <link rel="alternate" href="https://demo.example/atom-1"/><id>tag:demo,2026:1</id>
        <updated>2026-11-20T10:00:00Z</updated><summary>Short summary</summary></entry></feed>`);
    expect(feed.format).toBe('atom');
    expect(feed.items[0]).toMatchObject({ title: 'Atom story', link: 'https://demo.example/atom-1', published: '2026-11-20T10:00:00Z' });
  });

  it('parses RDF (RSS 1.0), as used by several Japanese outlets', () => {
    const feed = parseFeed(`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel><title>朝日</title></channel>
      <item rdf:about="https://demo.example/jp-1"><title>高市首相、ペルー大統領と会談</title><link>https://demo.example/jp-1</link><dc:date>2026-11-20T18:00:00+09:00</dc:date></item></rdf:RDF>`);
    expect(feed.format).toBe('rdf');
    expect(feed.items[0]).toMatchObject({ title: '高市首相、ペルー大統領と会談', published: '2026-11-20T18:00:00+09:00' });
    expect(parseDate(feed.items[0]!.published)?.toISOString()).toBe('2026-11-20T09:00:00.000Z');
  });

  it('rejects documents that are not feeds', () => {
    expect(() => parseFeed('<html><body>Not found</body></html>')).toThrow(FeedParseError);
    expect(parseDate('not a date')).toBeNull();
  });

  it('builds article records with metadata only', () => {
    const feed = parseFeed(`<rss version="2.0"><channel>
      <item><title>Chancellor defends budget - Demo News</title><link>/a?utm_campaign=x</link><pubDate>Fri, 20 Nov 2026 09:00:00 GMT</pubDate>
        <description>${'Long text. '.repeat(100)}</description></item>
      <item><title>Chancellor defends budget - Demo News</title><link>https://demo.example/a</link></item>
      <item><title></title><link>https://demo.example/empty</link></item>
      <item><title>No link at all</title></item>
    </channel></rss>`);
    const built = buildArticles(source, feed.items);
    expect(built.articles).toHaveLength(1);
    expect(built.rejected).toBe(2);
    const a = built.articles[0]!;
    expect(a).toMatchObject({
      normalized_url: 'https://demo.example/a',
      headline_original: 'Chancellor defends budget - Demo News',
      headline_normalized: 'chancellor defends budget',
      published_at: '2026-11-20T09:00:00.000Z',
      category: 'politics',
      category_method: 'keyword',
    });
    expect(a.summary!.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(a.source_metadata).length).toBeLessThan(1024);
    expect(built.feedOldestItemAt).toBe('2026-11-20T09:00:00.000Z');
  });

  it('parses Retry-After as seconds or as a date', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter('Fri, 20 Nov 2026 10:00:00 GMT', new Date('2026-11-20T09:30:00Z'))).toBe(1800);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('categorization', () => {
  it('prefers the feed section, then feed labels, then keywords, then other', () => {
    expect(categorize({ headlineNormalized: 'premier league late goal', language: 'en', defaultCategory: 'technology' })).toMatchObject({ category: 'technology', method: 'feed_section' });
    expect(categorize({ headlineNormalized: 'an untitled piece', language: 'en', feedCategories: ['Sport'] })).toMatchObject({ category: 'sports', method: 'feed_category' });
    expect(categorize({ headlineNormalized: 'nhs warns of rise in hospital admissions', language: 'en' })).toMatchObject({ category: 'health', method: 'keyword' });
    expect(categorize({ headlineNormalized: 'robins will keep visiting your garden', language: 'en' })).toMatchObject({ category: 'other', method: 'default' });
  });

  it('treats an exact tie as uncertain', () => {
    // One politics keyword and one business keyword.
    expect(categorize({ headlineNormalized: 'senate inflation', language: 'en' }).category).toBe('other');
  });

  it('categorizes Japanese headlines', () => {
    expect(categorize({ headlineNormalized: '高市首相 国会で答弁', language: 'ja' }).category).toBe('politics');
    expect(categorize({ headlineNormalized: '日銀 利上げを検討 円安進む', language: 'ja' }).category).toBe('business');
    expect(categorize({ headlineNormalized: '大谷 2試合連続の本塁打', language: 'ja' }).category).toBe('sports');
  });

  it('maps section labels', () => {
    expect(sectionToCategory('Technology')).toBe('technology');
    expect(sectionToCategory('headlines')).toBeNull();
  });
});
