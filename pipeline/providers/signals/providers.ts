// Attention-signal providers. Each one turns a public list (trending searches, platform
// trends, most-read pages, a front page) into ranked items. Only list metadata is kept:
// a title, a link, a rank, and the article links the list itself attaches.
import { XMLParser } from 'fast-xml-parser';
import { normalizeUrl } from '../../normalize/url';
import { parseRetryAfter, type FetchLike } from '../rss/fetch';

export interface ClaimedSignal {
  sourceKey: string;
  leaseToken: string;
  originKey: string;
  scopeKey: string;
  country: string | null;
  language: string | null;
  params: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  cadenceSeconds: number;
  lastSuccessAt: string | null;
  /** Current top titles of the seed source, when params.seedSource names one. */
  seeds: string[];
}

export interface RelatedLink {
  title: string;
  url: string;
  source?: string;
}

export interface SignalItem {
  item_key: string;
  title: string;
  url?: string | null;
  language_code?: string | null;
  summary?: string | null;
  entity_id?: string | null;
  related?: RelatedLink[];
  related_urls?: string[];
  rank: number;
  metric_kind?: string | null;
  metric_value?: number | null;
}

export interface SignalFetch {
  items: SignalItem[];
  /** UTC day the list describes, when the source reports a day other than today. */
  day?: string;
  httpStatus?: number;
  /**
   * An empty list is normally treated as a failure, because a healthy source always lists
   * something. Set this when empty is a legitimate answer.
   */
  allowEmpty?: boolean;
}

export interface ProviderContext {
  source: ClaimedSignal;
  fetchImpl: FetchLike;
  now: Date;
  env: Record<string, string | undefined>;
  /** Deadline for one request including its body. Defaults to 15 seconds. */
  timeoutMs?: number;
}

export class SignalHttpError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly retryAfterSeconds?: number | null,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 5_000_000;

function userAgent(env: Record<string, string | undefined>): string {
  const contact = env.THEIA_CONTACT ? `; ${env.THEIA_CONTACT}` : '';
  return `ProjectTheia/0.1 (private news explorer${contact})`;
}

/**
 * Fetches a URL and reads the whole body under one deadline. The deadline covers the body,
 * not only the headers, and holds even if the transport ignores the abort signal, so a
 * response that never finishes cannot hold up the batch.
 */
async function request(ctx: ProviderContext, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const timeoutMs = ctx.timeoutMs ?? TIMEOUT_MS;
  const host = new URL(url).host;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SignalHttpError(`Timed out after ${timeoutMs} ms reading ${host}`));
    }, timeoutMs);
  });
  const work = (async () => {
    const res = await ctx.fetchImpl(url, {
      headers: { 'user-agent': userAgent(ctx.env), accept: '*/*', ...headers },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new SignalHttpError(`HTTP ${res.status} from ${host}`, res.status, parseRetryAfter(res.headers.get('retry-after'), ctx.now));
    }
    const body = await res.text();
    if (body.length > MAX_BODY_CHARS) throw new SignalHttpError(`Response from ${host} is larger than expected`, res.status);
    return { status: res.status, body };
  })();
  // If the deadline wins, the abandoned request may still reject later; that must not go unhandled.
  work.catch(() => {});
  try {
    return await Promise.race([work, deadline]);
  } catch (e) {
    if (e instanceof SignalHttpError) throw e;
    throw new SignalHttpError((e as Error).name === 'AbortError' ? `Timed out after ${timeoutMs} ms reading ${host}` : (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(ctx: ProviderContext, url: string, headers?: Record<string, string>): Promise<T> {
  const res = await request(ctx, url, headers);
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new SignalHttpError(`Response from ${new URL(url).host} was not JSON`, res.status);
  }
}

function urls(list: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    const n = raw ? normalizeUrl(raw) : null;
    if (n) out.add(n);
  }
  return [...out];
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code: string) => {
      const n = /^x/i.test(code) ? parseInt(code.slice(1), 16) : Number(code);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\uFFFD';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const xml = new XMLParser({
  ignoreAttributes: false,
  processEntities: true,
  isArray: (name) => name === 'item' || name === 'ht:news_item',
});

/** "500+", "20K+", "2M+" as a number. */
export function parseApproxTraffic(v: string): number | null {
  const m = /^([\d.,]+)\s*([KMB])?\+?$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? '').toUpperCase()] ?? 1;
  return Math.round(n * mult);
}

// Google Trends "Trending now" RSS, one feed per country.
export function parseGoogleTrending(body: string, language: string | null): SignalItem[] {
  const doc = xml.parse(body) as { rss?: { channel?: { item?: Record<string, unknown>[] } } };
  const items = doc.rss?.channel?.item ?? [];
  return items.flatMap((it, i) => {
    const title = text(it.title);
    if (!title) return [];
    const news = ((it['ht:news_item'] as Record<string, unknown>[] | undefined) ?? [])
      .map((n) => ({ title: text(n['ht:news_item_title']), url: text(n['ht:news_item_url']), source: text(n['ht:news_item_source']) || undefined }))
      .filter((n) => n.title && n.url);
    return [{
      item_key: title.toLowerCase(),
      title,
      url: `https://trends.google.com/trends/explore?q=${encodeURIComponent(title)}&date=now%201-d`,
      language_code: language,
      related: news.slice(0, 5),
      related_urls: urls(news.map((n) => n.url)),
      rank: i + 1,
      metric_kind: 'approx_searches',
      metric_value: parseApproxTraffic(text(it['ht:approx_traffic'])),
    }];
  });
}

async function googleTrendingNow(ctx: ProviderContext): Promise<SignalFetch> {
  const geo = text(ctx.source.params.geo) || ctx.source.country || 'US';
  const res = await request(ctx, `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`);
  return { items: parseGoogleTrending(res.body, ctx.source.language), httpStatus: res.status };
}

// X trends for one place (WOEID). Paid per request.
export function parseXTrends(body: unknown, language: string | null): SignalItem[] {
  const data = (body as { data?: { trend_name?: string; tweet_count?: number }[] }).data ?? [];
  return data.flatMap((t, i) => {
    const name = text(t.trend_name);
    if (!name) return [];
    return [{
      item_key: name.toLowerCase(),
      title: name,
      url: `https://x.com/search?q=${encodeURIComponent(name)}`,
      language_code: language,
      rank: i + 1,
      metric_kind: typeof t.tweet_count === 'number' ? 'post_count' : null,
      metric_value: typeof t.tweet_count === 'number' ? t.tweet_count : null,
    }];
  });
}

function bearer(ctx: ProviderContext): Record<string, string> {
  const token = ctx.env.X_BEARER_TOKEN;
  if (!token) throw new SignalHttpError('X_BEARER_TOKEN is not set');
  return { authorization: `Bearer ${token}` };
}

async function xTrends(ctx: ProviderContext): Promise<SignalFetch> {
  const woeid = Number(ctx.source.params.woeid);
  if (!Number.isInteger(woeid)) throw new SignalHttpError(`${ctx.source.sourceKey} has no woeid`);
  const max = Math.min(Math.max(Number(ctx.source.params.maxTrends) || 20, 1), 50);
  const body = await getJson(ctx, `https://api.x.com/2/trends/by/woeid/${woeid}?max_trends=${max}`, bearer(ctx));
  return { items: parseXTrends(body, ctx.source.language) };
}

// X news stories: X's own summaries of what is breaking, found by searching the current
// top trends of the same place. One request per seed, so the seed limit is the cost cap.
interface XNewsStory {
  id?: string;
  name?: string;
  summary?: string;
  hook?: string;
  category?: string;
}

export function parseXNews(batches: { data?: XNewsStory[] }[], language: string | null): SignalItem[] {
  const seen = new Set<string>();
  const out: SignalItem[] = [];
  for (const batch of batches) {
    for (const s of batch.data ?? []) {
      const id = text(s.id);
      const name = text(s.name);
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      out.push({
        item_key: id,
        title: name,
        url: `https://x.com/i/trending/${id}`,
        language_code: language,
        summary: (text(s.hook) || text(s.summary)).slice(0, 500) || null,
        rank: out.length + 1,
      });
    }
  }
  return out;
}

async function xNews(ctx: ProviderContext): Promise<SignalFetch> {
  const headers = bearer(ctx);
  const perSeed = Math.min(Math.max(Number(ctx.source.params.maxResults) || 3, 1), 10);
  const maxAge = Math.min(Math.max(Number(ctx.source.params.maxAgeHours) || 24, 1), 720);
  const batches: { data?: XNewsStory[] }[] = [];
  for (const seed of ctx.source.seeds.slice(0, 10)) {
    const q = new URLSearchParams({ query: seed, max_results: String(perSeed), max_age_hours: String(maxAge), 'news.fields': 'category,hook,id,name,summary,updated_at' });
    batches.push(await getJson(ctx, `https://api.x.com/2/news/search?${q}`, headers));
  }
  // No seeds yet, or no story for today's trends, are both ordinary.
  return { items: parseXNews(batches, ctx.source.language), allowEmpty: true };
}

// Wikipedia pages are skipped when they are navigation, not subjects.
const WIKI_SKIP = /^(Main_Page|メインページ|-|Special:|特別:|Wikipedia:|Portal:|File:|ファイル:|Help:|Category:|Template:|Talk:|User:)/i;

interface TopPerCountry {
  items?: { articles?: { article?: string; project?: string; views_ceil?: number; rank?: number }[] }[];
}

export function parseWikiTopPerCountry(body: TopPerCountry, limit = 50): SignalItem[] {
  const articles = body.items?.[0]?.articles ?? [];
  const out: SignalItem[] = [];
  for (const a of articles) {
    const article = text(a.article);
    const project = text(a.project);
    if (!article || !project.endsWith('.wikipedia') || WIKI_SKIP.test(article)) continue;
    out.push({
      item_key: `${project}:${article}`,
      title: article.replace(/_/g, ' '),
      url: `https://${project}.org/wiki/${encodeURIComponent(article)}`,
      language_code: project.split('.')[0] ?? null,
      rank: out.length + 1,
      metric_kind: 'views_ceil',
      metric_value: typeof a.views_ceil === 'number' ? a.views_ceil : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function wikipediaPageviews(ctx: ProviderContext): Promise<SignalFetch> {
  const country = ctx.source.country ?? text(ctx.source.params.country);
  // The daily file for a UTC day appears some hours into the next day. Try yesterday, then the day before.
  for (const back of [1, 2]) {
    const day = new Date(ctx.now.getTime() - back * 86_400_000);
    const [y, m, d] = utcDay(day).split('-');
    try {
      const body = await getJson<TopPerCountry>(ctx, `https://wikimedia.org/api/rest_v1/metrics/pageviews/top-per-country/${country}/all-access/${y}/${m}/${d}`);
      return { items: parseWikiTopPerCountry(body, Number(ctx.source.params.limit) || 50), day: utcDay(day) };
    } catch (e) {
      if (!(e instanceof SignalHttpError) || e.httpStatus !== 404 || back === 2) throw e;
    }
  }
  return { items: [] };
}

interface WikiPage {
  title?: string;
  titles?: { normalized?: string };
  normalizedtitle?: string;
  wikibase_item?: string;
  description?: string;
  views?: number;
  rank?: number;
  content_urls?: { desktop?: { page?: string } };
}

interface WikiFeatured {
  mostread?: { date?: string; articles?: WikiPage[] };
  news?: { story?: string; links?: WikiPage[] }[];
}

function wikiTitle(p: WikiPage): string {
  return text(p.titles?.normalized) || text(p.normalizedtitle) || text(p.title).replace(/_/g, ' ');
}

export function parseWikiMostRead(body: WikiFeatured, language: string, limit = 50): { items: SignalItem[]; day?: string } {
  const out: SignalItem[] = [];
  for (const p of body.mostread?.articles ?? []) {
    const raw = text(p.title);
    const title = wikiTitle(p);
    if (!title || WIKI_SKIP.test(raw)) continue;
    out.push({
      item_key: `${language}.wikipedia:${raw || title}`,
      title,
      url: p.content_urls?.desktop?.page ?? `https://${language}.wikipedia.org/wiki/${encodeURIComponent(raw || title)}`,
      language_code: language,
      summary: text(p.description) || null,
      entity_id: text(p.wikibase_item) || null,
      rank: out.length + 1,
      metric_kind: 'views',
      metric_value: typeof p.views === 'number' ? p.views : null,
    });
    if (out.length >= limit) break;
  }
  const day = text(body.mostread?.date).slice(0, 10);
  return { items: out, day: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined };
}

export function parseWikiInTheNews(body: WikiFeatured, language: string): SignalItem[] {
  return (body.news ?? []).flatMap((n, i) => {
    const story = stripHtml(text(n.story)).slice(0, 300);
    if (!story) return [];
    const links = (n.links ?? []).map((l) => ({ title: wikiTitle(l), url: l.content_urls?.desktop?.page ?? '', qid: text(l.wikibase_item) })).filter((l) => l.title && l.url);
    const lead = links[0];
    return [{
      item_key: lead?.qid || (lead ? `${language}:${lead.title}` : `${language}:${hashKey(story)}`),
      title: story,
      url: lead?.url ?? null,
      language_code: language,
      entity_id: lead?.qid || null,
      related: links.slice(0, 6).map((l) => ({ title: l.title, url: l.url, source: 'Wikipedia' })),
      rank: i + 1,
    }];
  });
}

async function wikiFeatured(ctx: ProviderContext): Promise<WikiFeatured> {
  const lang = ctx.source.language ?? text(ctx.source.params.language) ?? 'en';
  const [y, m, d] = utcDay(ctx.now).split('-');
  return getJson<WikiFeatured>(ctx, `https://api.wikimedia.org/feed/v1/wikipedia/${lang}/featured/${y}/${m}/${d}`);
}

// The featured feed leaves out a section it does not have: "In the news" exists only for
// some language editions, and "most read" can be missing early in the day. A missing
// section is reported as a failure so the source never looks healthy while collecting nothing.
async function wikipediaMostRead(ctx: ProviderContext): Promise<SignalFetch> {
  const body = await wikiFeatured(ctx);
  if (!body.mostread) throw new SignalHttpError(`The ${ctx.source.language ?? 'en'} featured feed has no "most read" section right now`);
  return parseWikiMostRead(body, ctx.source.language ?? 'en', Number(ctx.source.params.limit) || 50);
}

async function wikipediaInTheNews(ctx: ProviderContext): Promise<SignalFetch> {
  const body = await wikiFeatured(ctx);
  if (!Array.isArray(body.news)) throw new SignalHttpError(`The ${ctx.source.language ?? 'en'} featured feed has no "In the news" section; this edition may not publish one`);
  return { items: parseWikiInTheNews(body, ctx.source.language ?? 'en') };
}

// Hacker News front page, in front-page order.
interface HnItem {
  id?: number;
  title?: string;
  url?: string;
  score?: number;
  type?: string;
  dead?: boolean;
  deleted?: boolean;
}

export function parseHackerNews(items: (HnItem | null)[]): SignalItem[] {
  const out: SignalItem[] = [];
  for (const it of items) {
    if (!it || it.dead || it.deleted || !it.id || !text(it.title)) continue;
    const discussion = `https://news.ycombinator.com/item?id=${it.id}`;
    out.push({
      item_key: String(it.id),
      title: text(it.title),
      url: it.url || discussion,
      language_code: 'en',
      related: it.url ? [{ title: 'Discussion on Hacker News', url: discussion, source: 'Hacker News' }] : [],
      related_urls: urls([it.url]),
      rank: out.length + 1,
      metric_kind: 'points',
      metric_value: typeof it.score === 'number' ? it.score : null,
    });
  }
  return out;
}

async function hackerNews(ctx: ProviderContext): Promise<SignalFetch> {
  const limit = Math.min(Math.max(Number(ctx.source.params.limit) || 30, 1), 60);
  const ids = (await getJson<number[]>(ctx, 'https://hacker-news.firebaseio.com/v0/topstories.json')).slice(0, limit);
  const items: (HnItem | null)[] = new Array(ids.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, ids.length) }, async () => {
    for (let i = next++; i < ids.length; i = next++) {
      items[i] = await getJson<HnItem | null>(ctx, `https://hacker-news.firebaseio.com/v0/item/${ids[i]}.json`);
    }
  }));
  return { items: parseHackerNews(items) };
}

// Techmeme's river of top technology headlines. Each entry links the article it leads with.
function parseMemeFeed(body: string, host: string, name: string): SignalItem[] {
  const doc = xml.parse(body) as { rss?: { channel?: { item?: Record<string, unknown>[] } } };
  const out: SignalItem[] = [];
  for (const it of doc.rss?.channel?.item ?? []) {
    const title = stripHtml(text(it.title));
    const permalink = text(it.link) || text((it.guid as { '#text'?: string } | undefined)?.['#text'] ?? it.guid);
    if (!title || !permalink || !normalizeUrl(permalink)) continue;
    // The description is HTML. The lead article is the off-site link with the longest path.
    const hrefs = [...text(it.description).matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => stripHtml(m[1]!)).filter((h) => {
      try { const u = new URL(h); return ['http:', 'https:'].includes(u.protocol) && u.hostname !== host && !u.hostname.endsWith(`.${host}`); }
      catch { return false; }
    });
    const lead = hrefs.sort((a, b) => pathLength(b) - pathLength(a))[0];
    out.push({
      item_key: permalink,
      title,
      url: lead ?? permalink,
      language_code: 'en',
      related: [{ title: `On ${name}`, url: permalink, source: name }],
      related_urls: urls([lead]),
      rank: out.length + 1,
    });
  }
  return out;
}

export function parseTechmeme(body: string): SignalItem[] { return parseMemeFeed(body, 'techmeme.com', 'Techmeme'); }
export function parseMemeorandum(body: string): SignalItem[] { return parseMemeFeed(body, 'memeorandum.com', 'Memeorandum'); }

interface LobstersStory { short_id?: string; title?: string; url?: string; comments_url?: string; score?: number }

export function parseLobsters(body: unknown): SignalItem[] {
  if (!Array.isArray(body)) throw new SignalHttpError('Lobsters returned an unexpected list');
  const seen = new Set<string>(), out: SignalItem[] = [];
  for (const value of body) {
    if (!value || typeof value !== 'object') continue;
    const story = value as LobstersStory, id = text(story.short_id), title = stripHtml(text(story.title));
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const discussion = normalizeUrl(text(story.comments_url)) ?? `https://lobste.rs/s/${encodeURIComponent(id)}`;
    const article = normalizeUrl(text(story.url));
    out.push({ item_key: id, title, url: article ?? discussion, language_code: 'en', rank: out.length + 1,
      related: [{ title: 'Discussion on Lobsters', url: discussion, source: 'Lobsters' }], related_urls: article ? [article] : [],
      metric_kind: 'points', metric_value: typeof story.score === 'number' && Number.isFinite(story.score) ? story.score : null });
    if (out.length >= 30) break;
  }
  return out;
}

/** Hatena publishes RSS 1.0/RDF. Keep the feed order, not a fabricated country-wide rank. */
export function parseHatena(body: string): SignalItem[] {
  const doc = xml.parse(body) as Record<string, { item?: Record<string, unknown>[] }>;
  const items = (doc['rdf:RDF'] ?? doc.RDF)?.item;
  if (!Array.isArray(items)) throw new SignalHttpError('Hatena returned no RDF item list');
  const seen = new Set<string>(), out: SignalItem[] = [];
  for (const item of items) {
    const title = stripHtml(text(item.title)), url = normalizeUrl(text(item.link));
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    const rawCount = text(item['hatena:bookmarkcount']);
    const count = /^\d+$/.test(rawCount) ? Number(rawCount) : null;
    const discussion = normalizeUrl(text(item['hatena:bookmarkCommentListPageUrl']));
    out.push({ item_key: url, title, url, language_code: 'ja', rank: out.length + 1,
      related_urls: [url], related: discussion ? [{ title: 'Bookmarks on Hatena', url: discussion, source: 'Hatena Bookmark' }] : [],
      metric_kind: 'bookmarks', metric_value: count !== null && Number.isSafeInteger(count) ? count : null });
    if (out.length >= 50) break;
  }
  return out;
}

function pathLength(u: string): number {
  try {
    return new URL(u).pathname.length;
  } catch {
    return 0;
  }
}

async function techmeme(ctx: ProviderContext): Promise<SignalFetch> {
  const res = await request(ctx, 'https://www.techmeme.com/feed.xml');
  return { items: parseTechmeme(res.body), httpStatus: res.status };
}

export interface ProviderEntry {
  run: (ctx: ProviderContext) => Promise<SignalFetch>;
  /** Environment variables the provider cannot run without. */
  requiresEnv?: string[];
}

export const signalProviders: Record<string, ProviderEntry> = {
  google_trending_now: { run: googleTrendingNow },
  x_trends: { run: xTrends, requiresEnv: ['X_BEARER_TOKEN'] },
  x_news: { run: xNews, requiresEnv: ['X_BEARER_TOKEN'] },
  wikipedia_pageviews: { run: wikipediaPageviews },
  wikipedia_most_read: { run: wikipediaMostRead },
  wikipedia_in_the_news: { run: wikipediaInTheNews },
  hackernews: { run: hackerNews },
  techmeme: { run: techmeme },
  memeorandum: { run: async (ctx) => {
    const res = await request(ctx, 'https://www.memeorandum.com/feed.xml');
    return { items: parseMemeorandum(res.body), httpStatus: res.status };
  } },
  lobsters: { run: async (ctx) => ({ items: parseLobsters(await getJson(ctx, 'https://lobste.rs/hottest.json')) }) },
  hatena: { run: async (ctx) => {
    const res = await request(ctx, 'https://b.hatena.ne.jp/hotentry.rss');
    return { items: parseHatena(res.body), httpStatus: res.status };
  } },
};

/** Origins that cannot run with the given environment. They are left unclaimed, not failed. */
export function originsWithoutCredentials(env: Record<string, string | undefined>): string[] {
  return Object.entries(signalProviders)
    .filter(([, p]) => (p.requiresEnv ?? []).some((name) => !env[name]))
    .map(([key]) => key)
    .sort();
}
