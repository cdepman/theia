import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Db } from '../../pipeline/db';

const MIGRATIONS_DIR = join(import.meta.dirname, '../../supabase/migrations');

export interface TestDb {
  db: Db;
  pg: PGlite;
  /** Runs a query and returns its rows. */
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  /** Returns a single value. */
  one<T = unknown>(query: string, params?: unknown[]): Promise<T>;
  close(): Promise<void>;
}

/**
 * An in-process Postgres (PGlite) with the real migrations applied. The pipeline talks
 * to it through the same `theia_*` functions it calls on hosted Supabase.
 */
export async function createTestDb(opts: { apiRoles?: boolean } = {}): Promise<TestDb> {
  const pg = new PGlite();
  if (opts.apiRoles) {
    // Exercise the same migration grants and revocations used on hosted Supabase.
    await pg.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  }
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  const db: Db = {
    async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
      if (!/^theia_[a-z_]+$/.test(fn)) throw new Error(`unexpected function ${fn}`);
      const keys = Object.keys(args);
      const call = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      const params = keys.map((k) => {
        const v = args[k];
        return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
      });
      const res = await pg.query<{ result: T }>(`select public.${fn}(${call}) as result`, params);
      return res.rows[0]!.result;
    },
  };
  return {
    db,
    pg,
    async sql<T>(query: string, params: unknown[] = []) {
      return (await pg.query<T>(query, params)).rows;
    },
    async one<T>(query: string, params: unknown[] = []) {
      const rows = (await pg.query<Record<string, T>>(query, params)).rows;
      return Object.values(rows[0] ?? {})[0] as T;
    },
    close: () => pg.close(),
  };
}

export interface FixtureItem {
  title: string;
  link: string;
  pubDate?: string;
  description?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function rssXml(items: FixtureItem[], title = 'Fixture feed'): string {
  const body = items
    .map(
      (i) =>
        `<item><title>${esc(i.title)}</title><link>${esc(i.link)}</link>` +
        (i.pubDate ? `<pubDate>${new Date(i.pubDate).toUTCString()}</pubDate>` : '') +
        (i.description ? `<description>${esc(i.description)}</description>` : '') +
        `</item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(title)}</title>${body}</channel></rss>`;
}

export type FeedResponse =
  | { status: 200; items: FixtureItem[]; etag?: string }
  | { status: 304 }
  | { status: number; retryAfter?: string }
  | { throw: string };

/** A fetch stand-in that serves fixture feeds by URL and records every request. */
export function fakeFetch(feeds: Record<string, FeedResponse | (() => FeedResponse)>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const entry = feeds[url];
    if (!entry) return new Response('not found', { status: 404 });
    const r = typeof entry === 'function' ? entry() : entry;
    if ('throw' in r) throw new Error(r.throw);
    if (r.status === 304) return new Response(null, { status: 304 });
    if (r.status === 200 && 'items' in r) {
      return new Response(rssXml(r.items), {
        status: 200,
        headers: { 'content-type': 'application/rss+xml', ...(r.etag ? { etag: r.etag } : {}) },
      });
    }
    const headers: Record<string, string> = {};
    if ('retryAfter' in r && r.retryAfter) headers['retry-after'] = r.retryAfter;
    return new Response('error', { status: r.status, headers });
  };
  return { impl, calls };
}

export interface TestPublisher {
  slug: string;
  name?: string;
  country: string;
  language?: string;
  enabled?: boolean;
  isWire?: boolean;
  feeds?: { section?: string; url?: string; defaultCategory?: string | null }[];
}

export function feedUrl(slug: string, section = 'headlines'): string {
  return `https://${slug}.example/${section}.xml`;
}

export function registryFor(publishers: TestPublisher[]) {
  return {
    dataSource: { name: 'Test registry', licenseNotes: 'fixtures' },
    publishers: publishers.map((p) => ({
      slug: p.slug,
      name: p.name ?? p.slug.toUpperCase(),
      domain: `${p.slug}.example`,
      country: p.country,
      languages: [p.language ?? 'en'],
      isWire: p.isWire ?? false,
      termsStatus: 'fixture',
      termsUrl: null,
      attributionMethod: 'fixture',
      enabled: p.enabled ?? true,
      feeds: (p.feeds ?? [{}]).map((f) => ({
        sourceKey: `rss:${p.slug}:${f.section ?? 'headlines'}`,
        url: f.url ?? feedUrl(p.slug, f.section ?? 'headlines'),
        language: p.language ?? 'en',
        section: f.section ?? 'headlines',
        defaultCategory: f.defaultCategory ?? null,
        enabled: true,
        cadenceSeconds: 10800,
      })),
    })),
  };
}

export function clock(startIso: string) {
  let t = new Date(startIso).getTime();
  return {
    now: () => new Date(t),
    iso: () => new Date(t).toISOString(),
    advance(seconds: number) {
      t += seconds * 1000;
    },
    set(iso: string) {
      t = new Date(iso).getTime();
    },
  };
}

const FILLER_A = ['Harbour', 'Orchard', 'Quarry', 'Lantern', 'Meadow', 'Foundry', 'Canal', 'Viaduct', 'Granary', 'Pavilion', 'Tannery', 'Arcade', 'Cloister', 'Wharf', 'Belfry', 'Causeway', 'Dockyard', 'Greenhouse', 'Lighthouse', 'Mill', 'Observatory', 'Priory', 'Reservoir', 'Sawmill', 'Terrace', 'Vineyard', 'Windmill', 'Aqueduct', 'Boathouse', 'Colliery'];
const FILLER_B = ['auction', 'festival', 'survey', 'restoration', 'exhibition', 'ballot', 'audition', 'regatta', 'harvest', 'parade', 'workshop', 'lecture', 'marathon', 'recital', 'tasting', 'census', 'pageant', 'seminar', 'rehearsal', 'carnival', 'referendum', 'bazaar', 'tournament', 'vigil', 'banquet', 'screening', 'expedition', 'hackathon', 'symposium', 'ceremony'];
const FILLER_C = ['postponed', 'expanded', 'relocated', 'shortened', 'televised', 'sponsored', 'cancelled', 'rescheduled', 'oversubscribed', 'streamlined', 'livestreamed', 'digitised', 'subsidised', 'crowdfunded', 'rebranded', 'merged', 'franchised', 'automated', 'outsourced', 'privatised', 'nationalised', 'downsized', 'upgraded', 'audited', 'insured', 'licensed', 'archived', 'catalogued', 'translated', 'illustrated'];
const FILLER_D = ['Tuesday', 'volunteers', 'pensioners', 'cyclists', 'beekeepers', 'historians', 'anglers', 'ramblers', 'choristers', 'gardeners', 'potters', 'weavers', 'birdwatchers', 'astronomers', 'allotmenteers', 'bellringers', 'canoeists', 'falconers', 'glassblowers', 'knitters', 'luthiers', 'magicians', 'numismatists', 'orienteers', 'philatelists', 'quilters', 'rowers', 'stargazers', 'thatchers', 'woodturners'];

/**
 * Unrelated filler headlines with no words in common, so a test corpus has realistic
 * term statistics (a name that appears in a handful of headlines is rare, as in real news).
 */
export function fillerItems(count: number, at: string, slug = 'filler'): FixtureItem[] {
  return Array.from({ length: Math.min(count, FILLER_A.length) }, (_, i) => ({
    title: `${FILLER_A[i]} ${FILLER_B[i]} ${FILLER_C[i]} for ${FILLER_D[i]}`,
    link: `https://${slug}.example/filler-${i}`,
    pubDate: at,
  }));
}
