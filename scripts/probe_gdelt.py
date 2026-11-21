#!/usr/bin/env python3
"""Six sequential, bounded GDELT DOC research requests, at least six seconds apart."""
import datetime as dt
import json
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
results = []
for country, source_country in [('US', 'unitedstates'), ('GB', 'unitedkingdom'), ('JP', 'japan')]:
    for window in ['24h', '30d']:
        if results:
            time.sleep(6)
        params = {'query': f'sourcecountry:{source_country}', 'mode': 'ArtList',
                  'format': 'json', 'maxrecords': '250', 'sort': 'DateDesc', 'timespan': window}
        url = 'https://api.gdeltproject.org/api/v2/doc/doc?' + urllib.parse.urlencode(params)
        result = {'country': country, 'window': window, 'url': url,
                  'observedAt': dt.datetime.now(dt.timezone.utc).isoformat()}
        started = time.monotonic()
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'ProjectTheiaFeasibility/0.1'})
            with urllib.request.urlopen(request, timeout=25) as response:
                data = response.read(2_000_001)
                result.update(httpStatus=response.status, contentType=response.headers.get('Content-Type'))
                if len(data) > 2_000_000:
                    raise ValueError('Response exceeds 2 MB research limit')
            try:
                body = json.loads(data)
                articles = body.get('articles', [])
                result.update(status='ok', recordCount=len(articles),
                    domains=sorted({a.get('domain', '') for a in articles}),
                    languages=sorted({a.get('language', '') for a in articles}),
                    sourceCountries=sorted({a.get('sourcecountry', '') for a in articles}),
                    articles=[{k: a.get(k) for k in ['url', 'title', 'seendate', 'domain', 'language', 'sourcecountry']}
                              for a in articles])
            except (json.JSONDecodeError, AttributeError):
                result.update(status='non_json', responseExcerpt=data.decode('utf-8', errors='replace')[:500])
        except urllib.error.HTTPError as exc:
            result.update(status='http_error', httpStatus=exc.code,
                          retryAfter=exc.headers.get('Retry-After'),
                          responseExcerpt=exc.read(500).decode('utf-8', errors='replace'))
        except Exception as exc:
            result.update(status='error', error=f'{type(exc).__name__}: {exc}'[:300])
        result['elapsedMs'] = round((time.monotonic()-started)*1000)
        results.append(result)
        print(country, window, result['status'], result.get('httpStatus'), result.get('recordCount'), flush=True)
        output = ROOT/'docs/evidence/gdelt-probe.json'
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({'schemaVersion': 1, 'queries': results}, ensure_ascii=False, indent=2)+'\n')
