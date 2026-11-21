import { describe, expect, it } from 'vitest';
import { cleanText, decodeEntities, normalizeHeadline } from '../../pipeline/normalize/headline';
import { canonicalDomain, normalizeUrl } from '../../pipeline/normalize/url';

describe('URL normalization', () => {
  it('strips tracking parameters and fragments but keeps meaningful ones', () => {
    expect(normalizeUrl('https://www.bbc.co.uk/news/articles/abc123?at_medium=RSS&at_campaign=rss#comments')).toBe(
      'https://www.bbc.co.uk/news/articles/abc123',
    );
    expect(normalizeUrl('https://example.com/story?id=42&utm_source=feed&page=2')).toBe('https://example.com/story?id=42&page=2');
    expect(normalizeUrl('https://example.com/a?partner=rss&emc=rss')).toBe('https://example.com/a');
  });

  it('is conservative about what counts as the same URL', () => {
    expect(normalizeUrl('http://Example.com:80/Path/')).toBe('https://example.com/Path');
    expect(normalizeUrl('https://example.com/a')).not.toBe(normalizeUrl('https://example.com/A'));
    expect(normalizeUrl('https://example.com/a?v=1')).not.toBe(normalizeUrl('https://example.com/a?v=2'));
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('resolves relative links and rejects non-web schemes', () => {
    expect(normalizeUrl('/news/1', 'https://example.com/feed.xml')).toBe('https://example.com/news/1');
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('mailto:someone@example.com')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });

  it('is idempotent', () => {
    const once = normalizeUrl('https://example.com/a/?utm_medium=x&q=1#top')!;
    expect(normalizeUrl(once)).toBe(once);
  });

  it('canonicalizes publisher domains', () => {
    expect(canonicalDomain('WWW.TheGuardian.com')).toBe('theguardian.com');
    expect(canonicalDomain('https://feeds.npr.org/1001/rss.xml')).toBe('npr.org');
    expect(canonicalDomain('m.example.co.uk.')).toBe('example.co.uk');
  });
});

describe('headline normalization', () => {
  it('keeps display text faithful to the original', () => {
    expect(cleanText('  <b>Trump &amp; Xi</b> meet &#8211; live&nbsp;updates ')).toBe('Trump & Xi meet – live updates');
    expect(cleanText('<![CDATA[Plain <i>title</i>]]>')).toBe('Plain title');
    expect(decodeEntities('&quot;quoted&quot; &#x3042;')).toBe('"quoted" あ');
    expect(cleanText(null)).toBe('');
  });

  it('removes publisher suffixes, prefixes and bracketed labels for comparison', () => {
    expect(normalizeHeadline('Two men killed after glider crash - BBC News', ['BBC News'])).toBe('two men killed after glider crash');
    expect(normalizeHeadline('NPR: A second judge blocks the arch', ['NPR'])).toBe('a second judge blocks the arch');
    expect(normalizeHeadline('[Video] Storm batters coast', [])).toBe('storm batters coast');
    expect(normalizeHeadline("Trump's ‘tremendous’ tariffs", [])).toBe('trumps tremendous tariffs');
  });

  it('handles Japanese: NFKC folding and leading labels', () => {
    expect(normalizeHeadline('【速報】ＡＩで「リーマン予想」証明か', [])).toBe('aiで リーマン予想 証明か');
    expect(normalizeHeadline('高市首相、ペルー大統領と会談　| 朝日新聞', ['朝日新聞'])).toBe('高市首相 ペルー大統領と会談');
  });

  it('never returns punctuation-only output', () => {
    expect(normalizeHeadline('?!...', [])).toBe('');
  });
});
