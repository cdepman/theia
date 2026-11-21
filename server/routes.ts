import { type Db } from '../pipeline/db';
import { constantTimeEqual, hasValidSession } from '../shared/auth';
import { isCategory, isCountry, isWindow } from '../shared/constants';

export interface ApiEnv {
  GATE_SIGNING_KEY?: string;
  STATUS_CHECK_SECRET?: string;
  /** Local development only: skip the session check. Never set this in a deployed environment. */
  THEIA_DEV_NO_AUTH?: string;
}

export interface ApiContext {
  db: Db;
  env: ApiEnv;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Responses are private: nothing here may sit in a shared cache ahead of authentication.
const VIEW_CACHE = 'private, max-age=60, stale-while-revalidate=300';
const NO_STORE = 'no-store';

function json(body: unknown, status = 200, cache = NO_STORE): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
      'x-content-type-options': 'nosniff',
      vary: 'Cookie',
    },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

async function authorized(req: Request, path: string, env: ApiEnv): Promise<boolean> {
  if (env.THEIA_DEV_NO_AUTH === '1') return true;
  // The external freshness check authenticates with its own secret, for this one route only.
  if (path === '/api/data-status' && env.STATUS_CHECK_SECRET) {
    const provided = req.headers.get('x-theia-status-secret');
    if (provided && (await constantTimeEqual(provided, env.STATUS_CHECK_SECRET))) return true;
  }
  return hasValidSession(req, env.GATE_SIGNING_KEY);
}

function emptyView(country: string, category: string, window: string) {
  return {
    schemaVersion: 1,
    metricVersion: 1,
    country,
    category,
    window,
    unit: window === '30d' ? 'thread' : 'story',
    metric: window === '30d' ? 'publisher_days' : 'distinct_monitored_publishers',
    windowStart: null,
    observationCutoff: null,
    dataAsOf: null,
    computedAt: null,
    coverage: {
      complete: false,
      status: 'no_data',
      reasons: ['not_computed'],
      monitoredPublisherCount: 0,
      activePublisherCount: 0,
      publisherFloor: 10,
      failingSourceCount: 0,
      gapCount: 0,
      collectionStartedAt: null,
      observedStart: null,
      observedEnd: null,
    },
    metricRange: { min: null, max: null },
    stories: [],
    freshness: null,
    notComputed: true,
  };
}

/**
 * The read API. Every route is a thin, bounded read of precomputed data: validate the
 * inputs against allowlists, call one database function, return its JSON.
 */
export async function handleApi(req: Request, ctx: ApiContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (!path.startsWith('/api/')) return error(404, 'not_found', 'Unknown route.');
  if (req.method !== 'GET' && req.method !== 'HEAD') return error(405, 'method_not_allowed', 'This API is read-only.');
  if (!ctx.env.GATE_SIGNING_KEY && ctx.env.THEIA_DEV_NO_AUTH !== '1') {
    return error(503, 'gate_not_configured', 'Access control is not configured. Set GATE_SIGNING_KEY.');
  }
  if (!(await authorized(req, path, ctx.env))) return error(401, 'unauthorized', 'Sign in to continue.');

  const q = url.searchParams;
  const nowArg = ctx.now ? { p_now: ctx.now().toISOString() } : {};

  try {
    if (path === '/api/meta' || path === '/api/countries' || path === '/api/categories') {
      const meta = await ctx.db.rpc<{ countries: unknown; categories: unknown }>('theia_meta');
      if (path === '/api/countries') return json({ countries: meta.countries }, 200, VIEW_CACHE);
      if (path === '/api/categories') return json({ categories: meta.categories }, 200, VIEW_CACHE);
      return json(meta, 200, VIEW_CACHE);
    }

    if (path === '/api/stories') {
      const country = q.get('country');
      const category = q.get('category') ?? 'all';
      const window = q.get('window') ?? '24h';
      if (!isCountry(country)) return error(400, 'invalid_country', 'country must be one of US, GB, JP.');
      if (!isCategory(category)) return error(400, 'invalid_category', 'Unknown category.');
      if (!isWindow(window)) return error(400, 'invalid_window', 'window must be one of 24h, 7d, 30d.');
      const view = await ctx.db.rpc<unknown>('theia_get_view', { p_country: country, p_category: category, p_window: window, ...nowArg });
      return json(view ?? emptyView(country, category, window), 200, VIEW_CACHE);
    }

    const storyMatch = /^\/api\/stories\/([^/]+)$/.exec(path);
    const threadMatch = /^\/api\/threads\/([^/]+)$/.exec(path);
    if (storyMatch || threadMatch) {
      const id = (storyMatch ?? threadMatch)![1]!;
      const country = q.get('country');
      if (!UUID.test(id)) return error(400, 'invalid_id', 'id must be a UUID.');
      if (!isCountry(country)) return error(400, 'invalid_country', 'country must be one of US, GB, JP.');
      if (storyMatch) {
        const limit = Math.min(Math.max(Number(q.get('limit') ?? 50) || 50, 1), 100);
        const offset = Math.max(Number(q.get('offset') ?? 0) || 0, 0);
        const story = await ctx.db.rpc<unknown>('theia_get_story', { p_story: id, p_country: country, p_limit: limit, p_offset: offset, ...nowArg });
        return story ? json(story, 200, VIEW_CACHE) : error(404, 'not_found', 'No such story.');
      }
      const thread = await ctx.db.rpc<unknown>('theia_get_thread', { p_thread: id, p_country: country, ...nowArg });
      return thread ? json(thread, 200, VIEW_CACHE) : error(404, 'not_found', 'No such thread.');
    }

    if (path === '/api/coverage') {
      const country = q.get('country');
      if (!isCountry(country)) return error(400, 'invalid_country', 'country must be one of US, GB, JP.');
      return json(await ctx.db.rpc('theia_coverage', { p_country: country, ...nowArg }), 200, VIEW_CACHE);
    }

    if (path === '/api/data-status') return json(await ctx.db.rpc('theia_data_status', nowArg));

    if (path === '/api/methodology') {
      const [meta, status] = await Promise.all([ctx.db.rpc<Record<string, unknown>>('theia_meta'), ctx.db.rpc<Record<string, unknown>>('theia_data_status', nowArg)]);
      return json({ ...meta, status, metricVersion: 1, schemaVersion: 1 }, 200, VIEW_CACHE);
    }

    if (path === '/api/admin/status') return json(await ctx.db.rpc('theia_admin_status', nowArg));

    return error(404, 'not_found', 'Unknown route.');
  } catch (e) {
    // Never leak database details to the client.
    console.error('[theia api]', (e as Error).message);
    return error(502, 'upstream_error', 'The data service could not be reached. Try again shortly.');
  }
}
