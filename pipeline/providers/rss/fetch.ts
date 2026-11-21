import { pipelineConfig } from '../../config';

export interface FeedCheckpoint {
  etag?: string | null;
  lastModified?: string | null;
}

export type FetchResult =
  | { kind: 'ok'; httpStatus: number; body: string; checkpoint: FeedCheckpoint }
  | { kind: 'unchanged'; httpStatus: number; checkpoint: FeedCheckpoint }
  | { kind: 'error'; httpStatus: number | null; message: string; retryAfterSeconds: number | null };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function parseRetryAfter(value: string | null, now: Date = new Date()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v), 86_400);
  const date = new Date(v);
  if (Number.isNaN(date.getTime())) return null;
  return Math.min(Math.max(Math.round((date.getTime() - now.getTime()) / 1000), 0), 86_400);
}

export async function fetchFeed(
  feedUrl: string,
  checkpoint: FeedCheckpoint | null | undefined,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; userAgent?: string; maxBytes?: number } = {},
): Promise<FetchResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const headers: Record<string, string> = {
    'User-Agent': opts.userAgent ?? pipelineConfig.userAgent,
    Accept: 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
  };
  if (checkpoint?.etag) headers['If-None-Match'] = checkpoint.etag;
  if (checkpoint?.lastModified) headers['If-Modified-Since'] = checkpoint.lastModified;

  let res: Response;
  try {
    res = await fetchImpl(feedUrl, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? pipelineConfig.fetchTimeoutMs),
    });
  } catch (e) {
    const err = e as Error;
    const message = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'request timed out' : `network error: ${err.message}`;
    return { kind: 'error', httpStatus: null, message, retryAfterSeconds: null };
  }

  const next: FeedCheckpoint = {
    etag: res.headers.get('etag') ?? checkpoint?.etag ?? null,
    lastModified: res.headers.get('last-modified') ?? checkpoint?.lastModified ?? null,
  };

  if (res.status === 304) return { kind: 'unchanged', httpStatus: 304, checkpoint: next };
  if (!res.ok) {
    return {
      kind: 'error',
      httpStatus: res.status,
      message: `HTTP ${res.status}`,
      retryAfterSeconds: parseRetryAfter(res.headers.get('retry-after')),
    };
  }

  let body: string;
  try {
    body = await res.text();
  } catch (e) {
    return { kind: 'error', httpStatus: res.status, message: `body could not be read: ${(e as Error).message}`, retryAfterSeconds: null };
  }
  const maxBytes = opts.maxBytes ?? pipelineConfig.maxFeedBytes;
  if (body.length > maxBytes) {
    return { kind: 'error', httpStatus: res.status, message: `feed larger than ${maxBytes} bytes`, retryAfterSeconds: null };
  }
  return { kind: 'ok', httpStatus: res.status, body, checkpoint: next };
}
