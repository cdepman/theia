#!/usr/bin/env python3
"""Bounded Phase 0 research probe. No database writes or article-body scraping.

Fetches only explicit candidate feed URLs; retains headline/link/date metadata.
Uses Python's standard library so it can run before the application is installed.
"""
import argparse
import concurrent.futures
import datetime as dt
import email.utils
import hashlib
import html
import gzip
import io
import json
from pathlib import Path
import re
import statistics
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
UTC = dt.timezone.utc
LIMIT = 2_000_000
AGENT = 'ProjectTheiaFeasibility/0.1 (personal news-feed research; no article scraping)'


def local(tag):
    return tag.rsplit('}', 1)[-1]


def clean(value):
    return re.sub(r'\s+', ' ', html.unescape(re.sub('<[^>]+>', ' ', value or ''))).strip()


def fields(element, name):
    return [e for e in element if local(e.tag) == name]


def value(element, names):
    for name in names:
        found = fields(element, name)
        if found:
            return ''.join(found[0].itertext()).strip()
    return ''


def parse_date(text):
    if not text:
        return None
    try:
        date = email.utils.parsedate_to_datetime(text)
    except (ValueError, TypeError, OverflowError):
        try:
            date = dt.datetime.fromisoformat(text.replace('Z', '+00:00'))
        except ValueError:
            return None
    # Do not guess the timezone for unreliable source dates.
    if date.tzinfo is None:
        return None
    return date.astimezone(UTC)


def url_key(url):
    p = urllib.parse.urlsplit(url)
    query = [(k, v) for k, v in urllib.parse.parse_qsl(p.query)
             if not k.lower().startswith('utm_') and k.lower() not in {'fbclid', 'gclid'}]
    return urllib.parse.urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path,
                                   urllib.parse.urlencode(sorted(query)), ''))


def normalized(title):
    text = unicodedata.normalize('NFKC', title).casefold()
    return ' '.join(''.join(c if c.isalnum() else ' ' for c in text).split())


def probe_feed(publisher, feed, cutoff):
    result = {'publisherId': publisher['id'], 'country': publisher['country'],
              'language': feed.get('language', publisher['language']),
              'section': feed['section'], 'requestedUrl': feed['url'],
              'observedAt': dt.datetime.now(UTC).isoformat(), 'articles': []}
    started = time.monotonic()
    try:
        request = urllib.request.Request(feed['url'], headers={'User-Agent': AGENT,
            'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9'})
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read(LIMIT + 1)
            result.update(httpStatus=response.status, finalUrl=response.url,
                          contentType=response.headers.get('Content-Type'),
                          contentEncoding=response.headers.get('Content-Encoding'),
                          serverDate=response.headers.get('Date'),
                          etag=response.headers.get('ETag'),
                          lastModified=response.headers.get('Last-Modified'))
        if len(raw) > LIMIT:
            raise ValueError('Feed exceeds 2 MB research limit')
        if result.get('contentEncoding') == 'gzip' or raw[:2] == b'\x1f\x8b':
            with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed:
                raw = compressed.read(LIMIT + 1)
            if len(raw) > LIMIT:
                raise ValueError('Decompressed feed exceeds 2 MB research limit')
        result.update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        # Never resolve entities or accept a DTD from a feed.
        if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
            raise ValueError('DTD/HTML response rejected')
        root = ET.fromstring(raw)
        if local(root.tag) not in {'rss', 'RDF', 'feed'}:
            raise ValueError('Response is not RSS/RDF/Atom')
        channel = next((e for e in root if local(e.tag) == 'channel'), root)
        result.update(feedTitle=clean(value(channel, ['title'])),
                      copyright=clean(value(channel, ['copyright', 'rights']))[:600],
                      declaredTtlMinutes=value(channel, ['ttl']) or None,
                      declaredUpdatePeriod=value(channel, ['updatePeriod']) or None,
                      declaredUpdateFrequency=value(channel, ['updateFrequency']) or None)
        entries = [e for e in root.iter() if local(e.tag) in {'item', 'entry'}]
        if len(entries) > 1000:
            raise ValueError('Feed exceeds 1000-item research limit')
        dates, seen = [], set()
        for entry in entries:
            headline = clean(value(entry, ['title']))
            link = value(entry, ['link'])
            if not link:
                link = next((e.get('href', '') for e in fields(entry, 'link')
                             if e.get('rel', 'alternate') == 'alternate'), '')
            link = urllib.parse.urljoin(result['finalUrl'], link)
            if not headline or urllib.parse.urlsplit(link).scheme not in {'http', 'https'}:
                continue
            key = url_key(link)
            if key in seen:
                continue
            seen.add(key)
            date_text = value(entry, ['pubDate', 'published', 'date', 'updated'])
            date = parse_date(date_text)
            if date:
                dates.append(date)
            result['articles'].append({'headline': headline, 'url': link,
                'publishedAt': date.isoformat() if date else None,
                'hasSummary': bool(value(entry, ['description', 'summary'])),
                'inSampleDay': bool(date and cutoff-dt.timedelta(days=1) <= date <= cutoff),
                'futureDated': bool(date and date > cutoff)})
        dates.sort()
        intervals = [(b-a).total_seconds()/60 for a, b in zip(dates, dates[1:]) if b > a]
        result.update(status='ok', itemCount=len(entries), validArticleCount=len(result['articles']),
            sampleDayCount=sum(a['inSampleDay'] for a in result['articles']),
            summaryCount=sum(a['hasSummary'] for a in result['articles']),
            undatedCount=sum(a['publishedAt'] is None for a in result['articles']),
            futureDatedCount=sum(a['futureDated'] for a in result['articles']),
            oldestPublishedAt=dates[0].isoformat() if dates else None,
            newestPublishedAt=dates[-1].isoformat() if dates else None,
            medianItemIntervalMinutes=round(statistics.median(intervals), 1) if intervals else None)
    except urllib.error.HTTPError as exc:
        result.update(status='http_error', httpStatus=exc.code,
                      retryAfter=exc.headers.get('Retry-After'), error=str(exc))
    except Exception as exc:
        result.update(status='error', error=f'{type(exc).__name__}: {exc}'[:300])
    result['elapsedMs'] = round((time.monotonic()-started)*1000)
    return result


def summarize(results, cutoff):
    countries = {}
    for country in ['US', 'GB', 'JP']:
        feeds = [r for r in results if r['country'] == country]
        articles = {}
        for feed in feeds:
            for article in feed['articles']:
                if article['inSampleDay']:
                    articles[(feed['publisherId'], url_key(article['url']))] = {
                        **article, 'publisherId': feed['publisherId'], 'language': feed['language']}
        groups = {}
        for article in articles.values():
            key = (article['language'], normalized(article['headline']))
            groups.setdefault(key, []).append(article)
        multi = [group for group in groups.values() if len({a['publisherId'] for a in group}) >= 2]
        countries[country] = {
            'successfulFeeds': sum(r['status'] == 'ok' for r in feeds),
            'testedFeeds': len(feeds),
            'publishersWithValidFeeds': len({r['publisherId'] for r in feeds if r['status'] == 'ok'}),
            'publishersWithItemsInDay': len({a['publisherId'] for a in articles.values()}),
            'uniqueArticlesInDay': len(articles), 'naiveExactHeadlineGroups': len(groups),
            'groupsWithTwoOrMorePublishers': len(multi),
            'articlesInMultiPublisherGroups': sum(map(len, multi)),
            'examples': sorted(multi, key=lambda g: len({a['publisherId'] for a in g}), reverse=True)[:5]}
    return {'cutoff': cutoff.isoformat(), 'windowStart': (cutoff-dt.timedelta(days=1)).isoformat(),
            'method': 'Same-language Unicode NFKC + casefold + punctuation removal + whitespace collapse; exact normalized-title equality; URL dedup per publisher.',
            'limitation': 'One retrieval of feed-listed items published in the preceding 24h, not continuous 24h observation. Missing/invalid/future dates excluded. Groups are candidates, not validated story identities.',
            'countries': countries}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--country', choices=['US', 'GB', 'JP'])
    parser.add_argument('--output', default='docs/evidence/rss-probe.json')
    args = parser.parse_args()
    registry = json.loads((ROOT/'config/source-candidates.json').read_text())
    cutoff = dt.datetime.now(UTC)
    publishers = [p for p in registry['publishers'] if not args.country or p['country'] == args.country]
    # Sequential within a publisher; modest concurrency across publishers.
    def run_publisher(p):
        return [probe_feed(p, f, cutoff) for f in p['feeds']]
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for group in pool.map(run_publisher, publishers):
            results.extend(group)
            for r in group:
                print(r['publisherId'], r['section'], r['status'], r.get('httpStatus'),
                      'items', r.get('validArticleCount', 0), flush=True)
    output = ROOT/args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({'schemaVersion': 1, 'summary': summarize(results, cutoff),
                                 'feeds': results}, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({c: {k: v for k, v in summary.items() if k != 'examples'}
                      for c, summary in summarize(results, cutoff)['countries'].items()}, indent=2))


if __name__ == '__main__':
    main()
