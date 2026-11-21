#!/usr/bin/env python3
"""Fetch explicit publisher information pages for manual terms review.

Extracts bounded relevant passages and RSS links. Does not decide legal permission.
"""
import concurrent.futures
import datetime as dt
from html.parser import HTMLParser
import hashlib
import json
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts, self.links = [], []
        self.ignore = 0

    def handle_starttag(self, tag, attrs):
        if tag in {'script', 'style'}:
            self.ignore += 1
        attrs = dict(attrs)
        if tag in {'a', 'link'} and attrs.get('href'):
            self.links.append(attrs['href'])
        if tag in {'p', 'br', 'li', 'h1', 'h2', 'h3'}:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in {'script', 'style'}:
            self.ignore = max(0, self.ignore-1)

    def handle_data(self, data):
        if not self.ignore:
            self.parts.append(data)


def fetch(publisher):
    pages = []
    for url in dict.fromkeys([publisher['termsUrl'], publisher['sourcePage']]):
        result = {'requestedUrl': url, 'observedAt': dt.datetime.now(dt.timezone.utc).isoformat()}
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'ProjectTheiaFeasibility/0.1'})
            with urllib.request.urlopen(req, timeout=15) as response:
                raw = response.read(2_000_001)
                result.update(httpStatus=response.status, finalUrl=response.url)
                encoding = response.headers.get_content_charset() or 'utf-8'
            if len(raw) > 2_000_000:
                raise ValueError('Page exceeds 2 MB research limit')
            parser = Page()
            parser.feed(raw.decode(encoding, errors='replace'))
            lines = [re.sub(r'\s+', ' ', s).strip() for s in ''.join(parser.parts).split('\n')]
            passages = [s for s in lines if re.search(r'\brss\b|syndicat|non.?commercial|personal.{0,30}use|私的|転載|再配信', s, re.I)]
            result.update(status='ok', sha256=hashlib.sha256(raw).hexdigest(),
                matchingPassageCount=len(passages),
                note='Review the linked original terms; no copyrighted terms text retained.',
                feedLinks=sorted({urllib.parse.urljoin(result['finalUrl'], u) for u in parser.links
                                  if re.search(r'rss|\.rdf(?:\?|$)|\.xml(?:\?|$)|/feed/?(?:\?|$)', u, re.I)})[:80])
        except urllib.error.HTTPError as exc:
            result.update(status='http_error', httpStatus=exc.code)
        except Exception as exc:
            result.update(status='error', error=f'{type(exc).__name__}: {exc}'[:200])
        pages.append(result)
    print(publisher['id'], [(p.get('httpStatus'), p.get('matchingPassageCount', 0)) for p in pages], flush=True)
    return {'publisherId': publisher['id'], 'pages': pages}


if __name__ == '__main__':
    publishers = json.loads((ROOT/'config/source-candidates.json').read_text())['publishers']
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        result = list(pool.map(fetch, publishers))
    (ROOT/'docs/evidence/terms-probe.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
