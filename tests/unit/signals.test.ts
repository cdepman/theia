import { describe, expect, it } from 'vitest';
import {
  originsWithoutCredentials, parseApproxTraffic, parseGoogleTrending, parseHackerNews, parseTechmeme,
  parseWikiInTheNews, parseWikiMostRead, parseWikiTopPerCountry, parseXNews, parseXTrends, stripHtml,
  parseMemeorandum, parseLobsters, parseHatena, signalProviders,
} from '../../pipeline/providers/signals/providers';
import { validateOrigins } from '../../pipeline/jobs/signals';
import config from '../../config/signal-sources.json';

// Fixtures are hand-written in each source's documented shape. They are not recorded responses.
const GOOGLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:atom="http://www.w3.org/2005/Atom" xmlns:ht="https://trends.google.com/trending/rss" version="2.0"><channel>
<title>Daily Search Trends</title>
<item><title>harbour bridge closure</title><ht:approx_traffic>20K+</ht:approx_traffic><description/>
<link>https://trends.google.com/trending/rss?geo=US</link><pubDate>Sat, 21 Nov 2026 14:10:00 -0800</pubDate>
<ht:news_item><ht:news_item_title>Bridge closed after inspection &amp; review</ht:news_item_title><ht:news_item_snippet/>
<ht:news_item_url>https://example-times.test/2026/11/21/bridge-closed?utm_source=google</ht:news_item_url><ht:news_item_source>Example Times</ht:news_item_source></ht:news_item>
<ht:news_item><ht:news_item_title>What the closure means</ht:news_item_title><ht:news_item_url>https://daily.test/closure</ht:news_item_url><ht:news_item_source>Daily</ht:news_item_source></ht:news_item>
</item>
<item><title>Lantern Festival</title><ht:approx_traffic>500+</ht:approx_traffic></item>
<item><title></title></item>
</channel></rss>`;

describe('signal providers', () => {
  it('parses approximate traffic labels', () => {
    expect(parseApproxTraffic('500+')).toBe(500);
    expect(parseApproxTraffic('20K+')).toBe(20000);
    expect(parseApproxTraffic('2M+')).toBe(2000000);
    expect(parseApproxTraffic('n/a')).toBeNull();
  });

  it('reads Google Trending Now with its attached articles', () => {
    const items = parseGoogleTrending(GOOGLE, 'en');
    expect(items.map((i) => [i.rank, i.item_key, i.metric_value])).toEqual([[1, 'harbour bridge closure', 20000], [2, 'lantern festival', 500]]);
    expect(items[0]!.related).toEqual([
      { title: 'Bridge closed after inspection & review', url: 'https://example-times.test/2026/11/21/bridge-closed?utm_source=google', source: 'Example Times' },
      { title: 'What the closure means', url: 'https://daily.test/closure', source: 'Daily' },
    ]);
    // Tracking parameters are removed so the link can match a collected press article.
    expect(items[0]!.related_urls).toEqual(['https://example-times.test/2026/11/21/bridge-closed', 'https://daily.test/closure']);
    expect(items[1]!.related).toEqual([]);
  });

  it('reads X trends with and without counts', () => {
    const items = parseXTrends({ data: [{ trend_name: '#Budget2026', tweet_count: 12000 }, { trend_name: 'Harbour Bridge' }, { trend_name: '' }] }, 'en');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ item_key: '#budget2026', rank: 1, metric_kind: 'post_count', metric_value: 12000, url: 'https://x.com/search?q=%23Budget2026' });
    expect(items[1]).toMatchObject({ rank: 2, metric_kind: null, metric_value: null });
    expect(parseXTrends({}, 'en')).toEqual([]);
  });

  it('merges X news batches and drops repeats', () => {
    const items = parseXNews([
      { data: [{ id: '1', name: 'Bridge closed', hook: 'A short hook', summary: 'Longer summary' }, { id: '2', name: 'Budget passes', summary: 'Summary only' }] },
      { data: [{ id: '1', name: 'Bridge closed' }, { name: 'no id' }] },
      {},
    ], 'en');
    expect(items.map((i) => [i.item_key, i.rank, i.summary])).toEqual([['1', 1, 'A short hook'], ['2', 2, 'Summary only']]);
  });

  it('keeps subject pages from Wikipedia per-country views', () => {
    const items = parseWikiTopPerCountry({ items: [{ articles: [
      { article: 'Main_Page', project: 'en.wikipedia', views_ceil: 900000, rank: 1 },
      { article: 'Special:Search', project: 'en.wikipedia', views_ceil: 500000, rank: 2 },
      { article: 'Harbour_Bridge', project: 'en.wikipedia', views_ceil: 120000, rank: 3 },
      { article: 'Something', project: 'en.wiktionary', views_ceil: 9000, rank: 4 },
      { article: '灯籠祭', project: 'ja.wikipedia', views_ceil: 8000, rank: 5 },
    ] }] });
    expect(items.map((i) => [i.rank, i.title, i.language_code])).toEqual([[1, 'Harbour Bridge', 'en'], [2, '灯籠祭', 'ja']]);
    expect(items[0]!.url).toBe('https://en.wikipedia.org/wiki/Harbour_Bridge');
    expect(parseWikiTopPerCountry({})).toEqual([]);
  });

  it('reads the Wikipedia featured feed', () => {
    const feed = {
      mostread: { date: '2026-11-20Z', articles: [
        { title: 'Main_Page', views: 1 },
        { title: 'Harbour_Bridge', titles: { normalized: 'Harbour Bridge' }, wikibase_item: 'Q42', description: 'Bridge', views: 5000, content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Harbour_Bridge' } } },
      ] },
      news: [
        { story: '<!--x-->An inspection closes the <a href="./Harbour_Bridge"><b>Harbour Bridge</b></a> &amp; nearby roads.', links: [
          { title: 'Harbour_Bridge', titles: { normalized: 'Harbour Bridge' }, wikibase_item: 'Q42', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Harbour_Bridge' } } },
        ] },
        { story: '<i>No links here</i>' },
      ],
    };
    const mostRead = parseWikiMostRead(feed, 'en');
    expect(mostRead.day).toBe('2026-11-20');
    expect(mostRead.items).toHaveLength(1);
    expect(mostRead.items[0]).toMatchObject({ title: 'Harbour Bridge', entity_id: 'Q42', rank: 1, metric_value: 5000 });
    const news = parseWikiInTheNews(feed, 'en');
    expect(news[0]).toMatchObject({ item_key: 'Q42', title: 'An inspection closes the Harbour Bridge & nearby roads.', entity_id: 'Q42', rank: 1 });
    expect(news[1]!.url).toBeNull();
    expect(news[1]!.item_key).toMatch(/^en:/);
    expect(parseWikiMostRead({}, 'en')).toEqual({ items: [], day: undefined });
  });

  it('reads the Hacker News front page in order', () => {
    const items = parseHackerNews([
      { id: 11, title: 'Show HN: A thing', score: 120 },
      null,
      { id: 12, title: 'Dead', dead: true },
      { id: 13, title: 'Bridge inspection report', url: 'https://example-times.test/report?utm_medium=hn', score: 80 },
    ]);
    expect(items.map((i) => [i.rank, i.item_key])).toEqual([[1, '11'], [2, '13']]);
    expect(items[0]!.url).toBe('https://news.ycombinator.com/item?id=11');
    expect(items[1]!.related_urls).toEqual(['https://example-times.test/report']);
  });

  it('finds the lead article in a Techmeme entry', () => {
    const feed = `<rss version="2.0"><channel><item><title>Harbour Systems buys Lantern Labs (Example Times)</title>
<link>https://www.techmeme.com/261121/p12#a261121p12</link>
<description><![CDATA[<a href="https://www.techmeme.com/261121/p12#a261121p12"><img src="x.jpg"></a>
<p><a href="https://example-times.test/">Example Times</a>: <b><a href="https://example-times.test/2026/11/21/harbour-buys-lantern">Harbour Systems buys Lantern Labs</a></b></p>]]></description></item></channel></rss>`;
    const items = parseTechmeme(feed);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ item_key: 'https://www.techmeme.com/261121/p12#a261121p12', url: 'https://example-times.test/2026/11/21/harbour-buys-lantern', rank: 1 });
    expect(items[0]!.related_urls).toEqual(['https://example-times.test/2026/11/21/harbour-buys-lantern']);
  });

  it('strips markup', () => {
    expect(stripHtml('<b>A</b>&nbsp;&amp; <i>B</i>')).toBe('A & B');
    expect(stripHtml('&#x6A4B;&#12398;&#x70B9;&#26908;')).toBe('橋の点検');
    expect(stripHtml('&#x110000;&#xD800;')).toBe('\uFFFD\uFFFD');
  });

  it('keeps Memeorandum attribution and excludes its own links from press matches', () => {
    const body = `<rss><channel><item><title>Bridge funding passes</title><link>https://www.memeorandum.com/261122/p1</link>
      <description><![CDATA[<a href="https://www.memeorandum.com/very/long/internal/story/path">internal</a>
      <b><a href="https://daily.test/story?a=1&amp;b=2">Bridge funding</a></b>]]></description></item></channel></rss>`;
    expect(parseMemeorandum(body)[0]).toMatchObject({ title: 'Bridge funding passes', url: 'https://daily.test/story?a=1&b=2',
      related: [{ source: 'Memeorandum', url: 'https://www.memeorandum.com/261122/p1' }], related_urls: ['https://daily.test/story?a=1&b=2'] });
  });

  it('keeps Lobsters feed order, removes repeated stories, and handles text-only discussions', () => {
    const items = parseLobsters([
      { short_id: 'one', title: 'First story', url: 'https://daily.test/one?utm_source=lobsters', score: 5 },
      { short_id: 'one', title: 'Duplicate' }, null, { short_id: 'empty' },
      { short_id: 'two', title: 'Ask a question', comments_url: 'https://lobste.rs/s/two/question', score: 10 },
    ]);
    expect(items.map((item) => [item.item_key, item.rank, item.metric_value])).toEqual([['one', 1, 5], ['two', 2, 10]]);
    expect(items[0]!.related_urls).toEqual(['https://daily.test/one']);
    expect(items[1]!.url).toBe('https://lobste.rs/s/two/question');
    expect(items[1]!.related_urls).toEqual([]);
    expect(() => parseLobsters({ error: 'unexpected' })).toThrow(/unexpected list/);
  });

  it('reads Hatena RDF, bookmark counts, and discussion links without storing summaries', () => {
    const body = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:hatena="http://www.hatena.ne.jp/info/xmlns#">
      <item><title><![CDATA[&#x6A4B;&#12398;&#x70B9;&#26908;]]></title><link>https://daily.test/bridge?utm_source=hatena</link><description>Not retained</description>
      <hatena:bookmarkcount>81</hatena:bookmarkcount><hatena:bookmarkCommentListPageUrl>https://b.hatena.ne.jp/entry/s/daily.test/bridge</hatena:bookmarkCommentListPageUrl></item>
      <item><title>Duplicate</title><link>https://daily.test/bridge</link></item>
      <item><title>Other</title><link>https://daily.test/other</link><hatena:bookmarkcount>unknown</hatena:bookmarkcount></item>
      <item><title>Bad URL</title><link>javascript:alert(1)</link></item></rdf:RDF>`;
    const items = parseHatena(body);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: '橋の点検', rank: 1, language_code: 'ja', metric_kind: 'bookmarks', metric_value: 81,
      related_urls: ['https://daily.test/bridge'], related: [{ source: 'Hatena Bookmark' }] });
    expect(items[0]!.summary).toBeUndefined();
    expect(items[1]).toMatchObject({ rank: 2, metric_value: null });
    expect(() => parseHatena('<html>Not a feed</html>')).toThrow(/no RDF item list/);
  });

  it('fetches each new source without credentials', async () => {
    const endpoints: Record<string, [string, string]> = {
      memeorandum: ['https://www.memeorandum.com/feed.xml', '<rss><channel><item><title>Story</title><link>https://www.memeorandum.com/1</link></item></channel></rss>'],
      lobsters: ['https://lobste.rs/hottest.json', '[{"short_id":"one","title":"Story"}]'],
      hatena: ['https://b.hatena.ne.jp/hotentry.rss', '<rdf:RDF><item><title>話題</title><link>https://daily.test/story</link></item></rdf:RDF>'],
    };
    for (const [key, [url, body]] of Object.entries(endpoints)) {
      const provider = signalProviders[key]!;
      const origin = config.origins.find((o) => o.key === key)!;
      expect(provider.requiresEnv).toBeUndefined();
      expect(origin.scopes![0]).not.toHaveProperty('country');
      const result = await provider.run({ now: new Date('2026-11-22T10:00:00Z'), env: {},
        source: { sourceKey: key, originKey: key, scopeKey: 'global', language: null, country: null, params: {}, checkpoint: {},
          leaseToken: 'test', lastSuccessAt: null, cadenceSeconds: 10800, seeds: [] },
        fetchImpl: async (input, init) => {
          expect(input).toBe(url);
          expect(init?.headers).not.toHaveProperty('authorization');
          return new Response(body, { status: 200 });
        } });
      expect(result.items).toHaveLength(1);
    }
  });

  it('lists origins that need a missing credential', () => {
    expect(originsWithoutCredentials({})).toEqual(['x_news', 'x_trends']);
    expect(originsWithoutCredentials({ X_BEARER_TOKEN: 't' })).toEqual([]);
  });

  it('accepts the shipped configuration and rejects unknown origins', () => {
    expect(() => validateOrigins(config as never)).not.toThrow();
    expect(() => validateOrigins({ origins: [{ key: 'tiktok', name: 'TikTok', kind: 'social' }] })).toThrow(/No provider/);
    expect(() => validateOrigins({ origins: [{ key: 'techmeme', name: 'T', kind: 'aggregator', scopes: [{ scope: 'global', viewCountries: [] }] }] })).toThrow(/viewCountries/);
  });
});
