# Project Theia — candidate source registry

Review date: 2026-11-21. Final common RSS cutoff: `2026-11-21T09:45:10.832273+00:00`.

**Candidate registry, not a production allowlist. Every publisher is disabled.** A successful HTTP/XML check is separate from permission to collect, archive, transform, or display content. No publisher is described here as legally cleared. The owner approval gate is in `decisions.md`.

The machine-readable registry is `config/source-candidates.json`. Evidence is in `docs/evidence/rss-probe-final.json` and `docs/evidence/terms-probe.json`. Initial failed probes remain in `rss-probe.json`; corrected-address checks are in `rss-probe-supplemental.json`. A failed guessed URL does not establish that a publisher has no RSS service.

## Reading the measurements

- **Items** is the count in this one response, not a long-run typical count.
- **24h items** uses published timestamps in the common preceding day, excludes invalid/future dates, and is only a lower bound on output. Feeds can truncate or select stories.
- **Median interval** is the median positive gap between item timestamps in that response, not a measured server update frequency. Declared RSS TTL/update hints are shown where supplied. Typical frequency remains unmeasured until recurring observation is authorized.
- **Summary** counts entries with a feed description/summary field. No summary text or article body is retained by this probe.
- **Country** is the curated association of the outlet. It is neither event location nor audience geography. Global wires and international editions need explicit review before activation.
- Ownership notes are candidate context, not a verified current ownership register. Multiple titles under the same parent are not independent owners; section feeds are never additional publishers.

## Diversity and known gaps

The candidates include national dailies, public/commercial broadcasters, political and business press, regional titles, specialist science/technology press, and licensing candidates for wire services. They span different editorial traditions, but this study does not assign political-bias scores or claim balance. US regional coverage is selective; UK Reach titles share ownership; Japan mixes Japanese and English editions, has weak regional-feed coverage, and has substantial unresolved reuse restrictions. AP, Reuters, and PA are candidates without a verified open feed; they were not polled or purchased.

## United States (US) — 19 candidates

| Publisher | Language / format | Ownership context | Reuse review |
| --- | --- | --- | --- |
| [The New York Times](https://www.nytimes.com/rss) | en / national daily | NYT Company | [personal_rss_conditional](https://help.nytimes.com/hc/en-us/articles/115014893428-Terms-of-Service) — Official RSS page permits personal reader/noncommercial blog use with required format and attribution. Keep original headlines and direct links; commercial use needs permission. |
| [NPR](https://www.npr.org/rss/) | en / public radio | NPR | [personal_feed_conditional](https://www.npr.org/about-npr/179876898/terms-of-use) — Official terms contain personal/noncommercial content-feed conditions; feed itself says personal use only. Retain attribution; broader redistribution and model training are not authorized. |
| [PBS NewsHour](https://www.pbs.org/newshour/) | en / public television | WETA/PBS | [review_required](https://www.pbs.org/about/about-pbs/terms-of-use/) — General terms describe personal uses and podcast permissions; no distinct headline-cloud authorization established. |
| [CBS News](https://www.cbsnews.com/rss/) | en / broadcaster | Paramount/Skydance | [review_required](https://www.cbsnews.com/news/cbs-news-rss-feeds/) — Official RSS index confirms feed URLs; index is not the full reuse contract. Activation requires review of applicable terms. |
| [NBC News](https://www.nbcnews.com/) | en / broadcaster | Comcast/NBCUniversal | [review_required](https://www.nbcuniversal.com/terms) — General license limits use to personal use in authorized services. Separate permission for a hosted headline aggregator was not established. |
| [ABC News](https://abcnews.go.com/) | en / broadcaster | Disney | [review_required](https://disneytermsofuse.com/english/) — Disney terms limit consumer use and distribution; the reviewed terms do not establish an explicit headline-feed reuse grant. |
| [CNN](https://www.cnn.com/services/rss/) | en / broadcaster | Warner Bros. Discovery (verify at activation) | [unverified](https://www.cnn.com/terms) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [Fox News](https://www.foxnews.com/about/rss) | en / broadcaster | Fox Corporation | [format_conflict](https://www.foxnews.com/terms-of-use) — RSS terms allow personal/noncommercial use but prohibit modifications and intermediate pages. A detail-panel interaction and selected headline cloud need review before activation. |
| [The Wall Street Journal](https://www.wsj.com/news/rss-news-and-feeds) | en / business press | News Corp/Dow Jones | [review_required](https://www.dowjones.com/terms-of-use/) — Dow Jones terms restrict use to individual personal/noncommercial purposes and restrict systematic storing/sharing. A lasting research archive is not established as permitted. |
| [The Washington Post](https://www.washingtonpost.com/) | en / national daily | Nash Holdings | [unverified](https://www.washingtonpost.com/terms-of-service/) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [Los Angeles Times](https://www.latimes.com/) | en / regional daily | LA Times Communications | [review_required](https://www.latimes.com/terms-of-service) — Personal online use and limited copies described; no explicit automatic headline archive grant established. |
| [ProPublica](https://www.propublica.org/) | en / nonprofit investigative | ProPublica | [format_conflict](https://www.propublica.org/steal-our-stories) — Republishing guidance forbids automatic/wholesale republication. Do not treat its permissive individual-story policy as automatic aggregator permission. |
| [Politico US](https://www.politico.com/rss) | en / political press | Axel Springer | [unverified](https://www.politico.com/terms-of-service) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [The Hill](https://thehill.com/) | en / political press | Nexstar | [unverified](https://thehill.com/terms-of-service/) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [USA Today](https://www.usatoday.com/) | en / national daily | Gannett | [unverified](https://www.usatoday.com/terms/) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [The Boston Globe](https://www.bostonglobe.com/) | en / regional daily | Boston Globe Media Partners | [unverified](https://www.bostonglobe.com/about/terms-service/) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [The Seattle Times](https://www.seattletimes.com/) | en / regional daily | Seattle Times Company | [unverified](https://www.seattletimes.com/terms-of-service/) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [The Texas Tribune](https://www.texastribune.org/) | en / nonprofit regional | Texas Tribune | [review_required](https://www.texastribune.org/republishing-guidelines/) — Republishing guidelines exist; candidate feed returned HTML. Confirm a current feed and automated-use conditions before activation. |
| [Associated Press](https://www.ap.org/content/formats/text/) | en / wire service | Not verified in this study | [unverified](https://www.ap.org/terms-and-conditions/) — No open headline RSS endpoint verified. Licensing candidate only; do not scrape or buy access. |

### Feed observations

| Publisher / section | Feed | Result | Items / 24h items | Summary | Median item interval / declared refresh |
| --- | --- | --- | --- | --- | --- |
| The New York Times / headlines | [RSS](https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml) | ok / HTTP 200 | 18 / 18 | 18/18 | 22.4 min / not declared |
| The New York Times / technology | [RSS](https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml) | ok / HTTP 200 | 41 / 8 | 38/41 | 111.7 min / not declared |
| NPR / headlines | [RSS](https://feeds.npr.org/1001/rss.xml) | ok / HTTP 200 | 10 / 10 | 10/10 | 47.7 min / not declared |
| NPR / politics | [RSS](https://feeds.npr.org/1014/rss.xml) | ok / HTTP 200 | 10 / 9 | 10/10 | 85.2 min / not declared |
| PBS NewsHour / headlines | [RSS](https://www.pbs.org/newshour/feeds/rss/headlines) | ok / HTTP 200 | 20 / 20 | 20/20 | 9.7 min / not declared |
| CBS News / headlines | [RSS](https://www.cbsnews.com/latest/rss/main) | ok / HTTP 200 | 30 / 30 | 30/30 | 8.9 min / TTL 5 min |
| NBC News / headlines | [RSS](https://feeds.nbcnews.com/nbcnews/public/news) | ok / HTTP 200 | 25 / 16 | 21/21 | 51.0 min / not declared |
| ABC News / headlines | [RSS](https://abcnews.go.com/abcnews/topstories) | ok / HTTP 200 | 25 / 14 | 25/25 | 84.7 min / not declared |
| CNN / headlines | [RSS](https://rss.cnn.com/rss/cnn_topstories.rss) | error: URLError: <urlopen error EOF occurred in violation of protocol (_ssl.c:1129)> | unknown / unknown | unknown | unknown min / not declared |
| Fox News / headlines | [RSS](https://moxie.foxnews.com/google-publisher/latest.xml) | ok / HTTP 200 | 25 / 24 | 25/25 | 15.9 min / not declared |
| The Wall Street Journal / headlines | [RSS](https://feeds.content.dowjones.io/public/rss/RSSWorldNews) | ok / HTTP 200 | 73 / 20 | 70/70 | 144.5 min / not declared |
| The Washington Post / headlines | [RSS](https://feeds.washingtonpost.com/rss/world) | ok / HTTP 200 | 15 / 6 | 15/15 | 83.3 min / TTL 1 min, 1/hourly |
| Los Angeles Times / headlines | [RSS](https://www.latimes.com/world-nation/rss2.0.xml) | ok / HTTP 200 | 92 / 5 | 92/92 | 314.0 min / not declared |
| ProPublica / headlines | [RSS](https://www.propublica.org/feeds/propublica/main) | ok / HTTP 200 | 20 / 3 | 20/20 | 60.0 min / not declared |
| Politico US / headlines | [RSS](https://www.politico.com/rss/politicopicks.xml) | http_error: HTTP Error 403: Forbidden | unknown / unknown | unknown | unknown min / not declared |
| The Hill / headlines | [RSS](https://thehill.com/feed/) | ok / HTTP 200 | 100 / 69 | 100/100 | 11.2 min / 1/hourly |
| USA Today / headlines | [RSS](https://rssfeeds.usatoday.com/usatoday-NewsTopStories) | error: ValueError: DTD/HTML response rejected | unknown / unknown | unknown | unknown min / not declared |
| The Boston Globe / headlines | [RSS](https://www.bostonglobe.com/metro/?outputType=rss) | ok / HTTP 200 | 25 / 13 | 25/25 | 181.5 min / not declared |
| The Seattle Times / headlines | [RSS](https://www.seattletimes.com/feed/) | ok / HTTP 200 | 34 / 34 | 34/34 | 7.8 min / 1/hourly |
| The Texas Tribune / headlines | [RSS](https://www.texastribune.org/feeds/all/) | error: ValueError: DTD/HTML response rejected | unknown / unknown | unknown | unknown min / not declared |
| Associated Press | No verified open endpoint | Not tested | unknown | unknown | unknown |

## United Kingdom (GB) — 20 candidates

| Publisher | Language / format | Ownership context | Reuse review |
| --- | --- | --- | --- |
| [BBC News](https://www.bbc.co.uk/news/10628494) | en / public broadcaster | BBC | [format_conflict](https://www.bbc.co.uk/usingthebbc/terms-of-use/#15metadataandrssfeeds) — Feed points to current BBC terms. Official 2022 terms PDF section 15 allows attributed RSS use but restricts altering feeds/extracting metadata; section 8 discusses computer analysis. Current applicability to the cloud/archive needs review; not cleared. |
| [The Guardian](https://www.theguardian.com/help/feeds) | en / national daily | Scott Trust | [personal_rss_conditional](https://www.theguardian.com/help/terms-of-service) — Official feed help permits personal noncommercial reader use subject to terms. Preserve original attribution/links; no blanket redistribution license. |
| [Sky News](https://news.sky.com/info/rss) | en / broadcaster | Comcast/Sky | [reader_only_unresolved](https://news.sky.com/info/terms-and-conditions) — Official RSS page documents desktop feed-reader use and section feeds. The tested terms URL was 404; hosted-display rights remain unresolved. |
| [The Independent](https://www.independent.co.uk/service/rss-feeds-775086.html) | en / national digital | Independent Digital News & Media | [personal_rss_conditional](https://www.independent.co.uk/service/terms-and-conditions-759573.html) — Official RSS page limits use to personal/noncommercial purposes and requires a license for republication/other use. Hosted display must remain within that scope. |
| [The Telegraph](https://www.telegraph.co.uk/) | en / national daily | Ownership requires current verification | [format_conflict](https://www.telegraph.co.uk/about-us/terms-and-conditions/) — Terms section 4.4 excludes software-program development from noncommercial use absent consent. Do not enable under the generic personal-use clause. |
| [Financial Times](https://www.ft.com/) | en / business press | Nikkei | [unverified](https://help.ft.com/legal-privacy/terms-and-conditions/) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [The Economist](https://www.economist.com/) | en / weekly analysis | Economist Group | [unverified](https://www.economist.com/legal/terms-of-use) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [Daily Mail](https://www.dailymail.co.uk/home/rss/index.html) | en / national tabloid | DMGT | [unverified](https://www.dailymail.co.uk/home/terms.html) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [Daily Mirror](https://www.mirror.co.uk/) | en / national tabloid | Reach | [review_required](https://www.mirror.co.uk/terms-conditions/) — Personal/noncommercial viewing terms reviewed; not an affirmative grant for the planned automated archive/display. |
| [Metro](https://metro.co.uk/) | en / urban daily | DMGT | [review_required](https://metro.co.uk/terms/) — Terms permit personal viewing and occasional nonsystematic printing; automatic archive/display permission not established. |
| [The Standard](https://www.standard.co.uk/) | en / London regional | Independent Digital News & Media (2026 feed copyright; ownership not independently verified) | [unverified](https://www.standard.co.uk/terms) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [The Scotsman](https://www.scotsman.com/) | en / Scottish regional | Iconic Media Group (2026 feed copyright; ownership not independently verified) | [unverified](https://www.scotsman.com/terms-and-conditions) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [The Herald](https://www.heraldscotland.com/) | en / Scottish regional | Newsquest/Gannett | [unverified](https://www.heraldscotland.com/terms/) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [WalesOnline](https://www.walesonline.co.uk/) | en / Welsh regional | Reach | [review_required](https://www.walesonline.co.uk/terms-conditions/) — Reach personal/noncommercial terms reviewed. Shares corporate ownership with Mirror/MEN; do not label those publishers as independent owners. |
| [Manchester Evening News](https://www.manchestereveningnews.co.uk/) | en / English regional | Reach | [review_required](https://www.manchestereveningnews.co.uk/terms-conditions/) — Reach personal/noncommercial terms reviewed. Shares corporate ownership with Mirror/WalesOnline; headline archive rights not established. |
| [Belfast Telegraph](https://www.belfasttelegraph.co.uk/) | en / Northern Irish regional | Mediahuis | [unverified](https://www.belfasttelegraph.co.uk/service/terms-and-conditions/) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [New Scientist](https://www.newscientist.com/) | en / science press | DMGT | [review_required](https://www.newscientist.com/terms/) — Terms mention personal use and a single-device download of RSS. A hosted research archive is not explicitly approved by that provision. |
| [City A.M.](https://www.cityam.com/) | en / business press | THG (verify at activation) | [unverified](https://www.cityam.com/terms-and-conditions/) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [Reuters](https://reutersagency.com/) | en / wire service | Not verified in this study | [unverified](https://www.reuters.com/info-pages/terms-of-use/) — No open headline RSS endpoint verified. Licensing candidate only; do not scrape or buy access. |
| [PA Media](https://pa.media/) | en / wire service | Not verified in this study | [unverified](https://pa.media/terms-conditions/) — No open headline RSS endpoint verified. Licensing candidate only; do not scrape or buy access. |

### Feed observations

| Publisher / section | Feed | Result | Items / 24h items | Summary | Median item interval / declared refresh |
| --- | --- | --- | --- | --- | --- |
| BBC News / headlines | [RSS](https://feeds.bbci.co.uk/news/rss.xml) | ok / HTTP 200 | 29 / 23 | 29/29 | 36.7 min / TTL 15 min |
| BBC News / politics | [RSS](https://feeds.bbci.co.uk/news/politics/rss.xml) | ok / HTTP 200 | 61 / 10 | 57/57 | 182.3 min / TTL 15 min |
| BBC News / technology | [RSS](https://feeds.bbci.co.uk/news/technology/rss.xml) | ok / HTTP 200 | 21 / 7 | 21/21 | 435.4 min / TTL 15 min |
| The Guardian / headlines | [RSS](https://www.theguardian.com/uk/rss) | ok / HTTP 200 | 145 / 108 | 145/145 | 19.3 min / not declared |
| The Guardian / politics | [RSS](https://www.theguardian.com/politics/rss) | ok / HTTP 200 | 21 / 15 | 21/21 | 52.8 min / not declared |
| The Guardian / technology | [RSS](https://www.theguardian.com/uk/technology/rss) | ok / HTTP 200 | 32 / 10 | 32/32 | 231.0 min / not declared |
| Sky News / headlines | [RSS](https://feeds.skynews.com/feeds/rss/home.xml) | ok / HTTP 200 | 6 / 6 | 6/6 | 182.0 min / TTL 1 min |
| The Independent / headlines | [RSS](https://www.independent.co.uk/news/uk/rss) | ok / HTTP 200 | 51 / 49 | 51/51 | 8.2 min / not declared |
| The Telegraph / headlines | [RSS](https://www.telegraph.co.uk/rss.xml) | ok / HTTP 200 | 120 / 4 | 120/120 | 180.1 min / TTL 1 min |
| Financial Times / headlines | [RSS](https://www.ft.com/rss/home) | ok / HTTP 200 | 11 / 11 | 11/11 | 4.0 min / TTL 15 min |
| The Economist / headlines | [RSS](https://www.economist.com/the-world-this-week/rss.xml) | ok / HTTP 200 | 300 / 0 | 73/300 | 5676.4 min / not declared |
| Daily Mail / headlines | [RSS](https://www.dailymail.co.uk/news/index.rss) | ok / HTTP 200 | 150 / 148 | 150/150 | 6.0 min / not declared |
| Daily Mirror / headlines | [RSS](https://www.mirror.co.uk/news/?service=rss) | ok / HTTP 200 | 25 / 25 | 25/25 | 10.9 min / not declared |
| Metro / headlines | [RSS](https://metro.co.uk/news/feed/) | ok / HTTP 200 | 25 / 24 | 5/25 | 39.2 min / 1/hourly |
| The Standard / headlines | [RSS](https://www.standard.co.uk/news/rss) | ok / HTTP 200 | 66 / 66 | 66/66 | 10.5 min / not declared |
| The Scotsman / headlines | [RSS](https://www.scotsman.com/news/rss) | ok / HTTP 200 | 24 / 24 | 24/24 | 10.5 min / not declared |
| The Herald / headlines | [RSS](https://www.heraldscotland.com/news/rss/) | ok / HTTP 200 | 50 / 35 | 50/50 | 21.5 min / not declared |
| WalesOnline / headlines | [RSS](https://www.walesonline.co.uk/news/?service=rss) | ok / HTTP 200 | 25 / 25 | 25/25 | 13.8 min / not declared |
| Manchester Evening News / headlines | [RSS](https://www.manchestereveningnews.co.uk/news/?service=rss) | ok / HTTP 200 | 25 / 25 | 25/25 | 3.0 min / not declared |
| Belfast Telegraph / headlines | [RSS](https://www.belfasttelegraph.co.uk/rss) | http_error: HTTP Error 308: Permanent Redirect | unknown / unknown | unknown | unknown min / not declared |
| New Scientist / headlines | [RSS](https://www.newscientist.com/feed/home/) | ok / HTTP 200 | 10 / 8 | 10/10 | 60.0 min / 1/hourly |
| City A.M. / headlines | [RSS](https://www.cityam.com/feed/) | ok / HTTP 200 | 30 / 21 | 30/30 | 25.5 min / 1/hourly |
| Reuters | No verified open endpoint | Not tested | unknown | unknown | unknown |
| PA Media | No verified open endpoint | Not tested | unknown | unknown | unknown |

## Japan (JP) — 18 candidates

| Publisher | Language / format | Ownership context | Reuse review |
| --- | --- | --- | --- |
| [NHK](https://www.nhk.or.jp/) | ja / public broadcaster | NHK | [unverified](https://www.nhk.or.jp/toppage/rules/) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [Asahi Shimbun](https://www.asahi.com/information/service/rss.html) | ja / national daily | Asahi Shimbun Company | [review_required](https://www.asahi.com/policy/) — Feed copyright prohibits reproduction/republication without written permission. Official RSS service page exists; inspect its specific personal-use conditions before activation. |
| [Mainichi Shimbun](https://mainichi.jp/rss/) | ja / national daily | Mainichi Newspapers | [review_required](https://mainichi.jp/corporate/terms/) — Official RSS index confirms flash/sports/entertainment/opinion feeds. Copyright remains reserved; unrestricted third-party reproduction not granted. |
| [Sankei Shimbun](https://www.sankei.com/) | ja / national daily | Sankei Shimbun/Fujisankei | [review_required](https://www.sankei.com/terms/) — Terms section 11 limits uses beyond permitted conditions/private copying; no explicit hosted-aggregator grant established. |
| [Nikkei](https://www.nikkei.com/) | ja / business press | Nikkei | [review_required](https://www.nikkei.com/info/copyright.html) — Official copyright page restricts redistribution; candidate endpoint is 404. Do not replace with scraping. |
| [Yomiuri Shimbun](https://www.yomiuri.co.jp/) | ja / national daily | Yomiuri Shimbun Holdings | [review_required](https://www.yomiuri.co.jp/policy/) — Official policy disallows reproduction/transmission without consent; candidate endpoint is 404. |
| [Kyodo News English](https://english.kyodonews.net/) | en / wire service | Kyodo News | [unverified](https://english.kyodonews.net/terms-of-use.html) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [Jiji Press](https://www.jiji.com/jc/info?p=rss) | ja / wire service | Jiji Press | [unverified](https://www.jiji.com/jc/c?g=info&k=copyright) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [Tokyo Shimbun](https://www.tokyo-np.co.jp/) | ja / regional daily | Chunichi Shimbun | [unverified](https://www.tokyo-np.co.jp/site/policy) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [Hokkaido Shimbun](https://www.hokkaido-np.co.jp/) | ja / regional daily | Hokkaido Shimbun Press | [review_required](https://www.hokkaido-np.co.jp/company/copyright/) — Official site lists RSS and reserves redistribution rights; tested /rss/ is an HTML page, not a feed. |
| [Kahoku Shimpo](https://kahoku.news/) | ja / regional daily | Kahoku Shimpo Publishing | [unverified](https://kahoku.news/terms/) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [Chugoku Shimbun](https://www.chugoku-np.co.jp/) | ja / regional daily | Chugoku Shimbun | [review_required](https://www.chugoku-np.co.jp/list/company/terms) — Official homepage reserves reproduction rights; tested feed path is 404. |
| [Nishinippon Shimbun](https://www.nishinippon.co.jp/) | ja / regional daily | Nishinippon Shimbun | [unverified](https://www.nishinippon.co.jp/site/policy/) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [Okinawa Times](https://www.okinawatimes.co.jp/) | ja / regional daily | Okinawa Times | [review_required](https://www.okinawatimes.co.jp/list/info/copyright) — Official homepage reserves copying/reproduction; a readable feed does not itself establish a license. |
| [The Japan Times](https://www.japantimes.co.jp/) | en / English national daily | News2u Holdings | [unverified](https://www.japantimes.co.jp/info/terms-conditions/) — The tested terms URL redirects to the homepage. A valid feed exists; no RSS reuse grant verified. |
| [ITmedia](https://corp.itmedia.co.jp/media/rss_list/) | ja / technology press | ITmedia/SoftBank group | [format_conflict](https://corp.itmedia.co.jp/media/rss_condition/) — RSS-specific terms ask for consultation on app integration and restrict removal/extraction, modification, translation, and omitted attribution. Personal RSS-reader permission does not settle this cloud/archival use. |
| [Impress Watch](https://www.watch.impress.co.jp/) | ja / technology press | Impress Holdings | [unverified](https://www.impress.co.jp/terms/) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |
| [Toyo Keizai](https://toyokeizai.net/) | ja / business press | Toyo Keizai | [unverified](https://toyokeizai.net/list/info/terms) — Public feed availability is not a reuse license. Review publisher terms before activation. No production ingestion enabled. |

### Feed observations

| Publisher / section | Feed | Result | Items / 24h items | Summary | Median item interval / declared refresh |
| --- | --- | --- | --- | --- | --- |
| NHK / headlines | [RSS](https://www.nhk.or.jp/rss/news/cat0.xml) | ok / HTTP 200 | 7 / 7 | 7/7 | 28.1 min / not declared |
| NHK / politics | [RSS](https://www.nhk.or.jp/rss/news/cat4.xml) | ok / HTTP 200 | 128 / 18 | 128/128 | 27.0 min / not declared |
| NHK / business | [RSS](https://www.nhk.or.jp/rss/news/cat5.xml) | ok / HTTP 200 | 110 / 15 | 110/110 | 39.5 min / not declared |
| Asahi Shimbun / headlines | [RSS](https://www.asahi.com/rss/asahi/newsheadlines.rdf) | ok / HTTP 200 | 40 / 32 | 0/40 | 29.8 min / 1/hourly |
| Asahi Shimbun / politics | [RSS](https://www.asahi.com/rss/asahi/politics.rdf) | ok / HTTP 200 | 20 / 18 | 0/20 | 35.2 min / 1/hourly |
| Asahi Shimbun / science | [RSS](https://www.asahi.com/rss/asahi/science.rdf) | ok / HTTP 200 | 4 / 4 | 0/4 | 74.3 min / 1/hourly |
| Mainichi Shimbun / headlines | [RSS](https://mainichi.jp/rss/etc/mainichi-flash.rss) | ok / HTTP 200 | 20 / 20 | 0/20 | 5.1 min / not declared |
| Mainichi Shimbun / sports | [RSS](https://mainichi.jp/rss/etc/mainichi-sports.rss) | ok / HTTP 200 | 20 / 20 | 0/20 | 30.4 min / not declared |
| Sankei Shimbun / headlines | [RSS](https://www.sankei.com/arc/outboundfeeds/rss/?outputType=xml) | ok / HTTP 200 | 100 / 97 | 100/100 | 3.6 min / TTL 1 min, 1/hourly |
| Nikkei / headlines | [RSS](https://www.nikkei.com/rss/news/headline.rdf) | http_error: HTTP Error 404: Not Found | unknown / unknown | unknown | unknown min / not declared |
| Yomiuri Shimbun / headlines | [RSS](https://www.yomiuri.co.jp/rss/news.xml) | http_error: HTTP Error 404: Not Found | unknown / unknown | unknown | unknown min / not declared |
| Kyodo News English / headlines | [RSS](https://english.kyodonews.net/list/feed/rss4kyodonews-fzone) | ok / HTTP 200 | 19 / 18 | 19/19 | 38.6 min / not declared |
| Jiji Press / headlines | [RSS](https://www.jiji.com/rss/ranking.rdf) | ok / HTTP 200 | 10 / 8 | 0/10 | 20.0 min / 1/hourly |
| Tokyo Shimbun / headlines | [RSS](https://www.tokyo-np.co.jp/rss) | http_error: HTTP Error 404: Not Found | unknown / unknown | unknown | unknown min / not declared |
| Hokkaido Shimbun / headlines | [RSS](https://www.hokkaido-np.co.jp/rss/) | error: ValueError: DTD/HTML response rejected | unknown / unknown | unknown | unknown min / not declared |
| Kahoku Shimpo / headlines | [RSS](https://kahoku.news/rss/) | http_error: HTTP Error 404: Not Found | unknown / unknown | unknown | unknown min / not declared |
| Chugoku Shimbun / headlines | [RSS](https://www.chugoku-np.co.jp/list/rss) | http_error: HTTP Error 404: Not Found | unknown / unknown | unknown | unknown min / not declared |
| Nishinippon Shimbun / headlines | [RSS](https://www.nishinippon.co.jp/rss/) | http_error: HTTP Error 404: Not Found | unknown / unknown | unknown | unknown min / not declared |
| Okinawa Times / headlines | [RSS](https://www.okinawatimes.co.jp/list/feed/rss) | ok / HTTP 200 | 20 / 20 | 20/20 | 19.0 min / not declared |
| The Japan Times / headlines | [RSS](https://www.japantimes.co.jp/feed/) | ok / HTTP 200 | 30 / 25 | 30/30 | 23.0 min / 1/hourly |
| ITmedia / headlines | [RSS](https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml) | ok / HTTP 200 | 50 / 2 | 49/50 | 51.5 min / not declared |
| Impress Watch / headlines | [RSS](https://www.watch.impress.co.jp/data/rss/1.0/ipw/feed.rdf) | ok / HTTP 200 | 20 / 8 | 20/20 | 38.3 min / not declared |
| Impress Watch / technology | [RSS](https://internet.watch.impress.co.jp/data/rss/1.0/iw/feed.rdf) | ok / HTTP 200 | 20 / 2 | 20/20 | 30.0 min / not declared |
| Toyo Keizai / headlines | [RSS](https://toyokeizai.net/list/feed/rss) | ok / HTTP 200 | 20 / 20 | 20/20 | 22.5 min / not declared |

## Activation criteria

Before enabling a source: confirm its canonical publisher identity/country, verify the current official feed, resolve the recorded terms issue for private headline clustering and retention, preserve original attribution and direct links, and record the decision and evidence. Do not infer approval from an empty extracted terms page or an HTTP 200 that redirects to a homepage. Start at a three-hour cadence while respecting publisher-specific limits.

Any country with fewer than ten enabled, usable publishers must display **limited coverage**. The current technical totals do not satisfy that launch criterion by themselves.
