import { type QueryClient, useQuery } from '@tanstack/react-query';
import { CATEGORIES, type Category, type CountryCode, WINDOWS, type WindowCode } from '../../../shared/constants';
import type { DataStatus, MetaPayload, SignalsPayload, StoryDetail, ThreadDetail, ViewPayload } from '../../../shared/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ApiError';
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { signal, headers: { accept: 'application/json' }, credentials: 'same-origin' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'The server could not be reached.');
  }
  if (res.status === 401) {
    // The session expired: the gate will show the sign-in page.
    window.location.assign('/auth/login');
    throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, 'bad_response', 'The server returned something unexpected.');
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Request failed (${res.status}).`);
  }
  return body as T;
}

const viewKey = (country: CountryCode, category: Category, window: WindowCode) => ['view', country, category, window] as const;
const viewPath = (country: CountryCode, category: Category, window: WindowCode) =>
  `/api/stories?country=${country}&category=${category}&window=${window}`;

export function useView(country: CountryCode, category: Category, window: WindowCode) {
  return useQuery({
    queryKey: viewKey(country, category, window),
    queryFn: ({ signal }) => getJson<ViewPayload>(viewPath(country, category, window), signal),
    // Keep showing the previous view while the next one loads, so switching filters never blanks the page.
    placeholderData: (previous) => previous,
  });
}

/** Warms the views one click away: the other windows, and the neighbouring categories. */
export function prefetchAdjacent(client: QueryClient, country: CountryCode, category: Category, window: WindowCode): void {
  const targets: [Category, WindowCode][] = WINDOWS.filter((w) => w !== window).map((w) => [category, w]);
  const i = CATEGORIES.indexOf(category);
  for (const c of [CATEGORIES[i - 1], CATEGORIES[i + 1], 'all' as Category]) {
    if (c && c !== category) targets.push([c, window]);
  }
  for (const [c, w] of targets) {
    void client.prefetchQuery({ queryKey: viewKey(country, c, w), queryFn: () => getJson<ViewPayload>(viewPath(country, c, w)) });
  }
}

export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: ({ signal }) => getJson<MetaPayload>('/api/meta', signal), staleTime: 5 * 60_000 });
}

export function useStory(id: string | null, country: CountryCode) {
  return useQuery({
    queryKey: ['story', id, country],
    queryFn: ({ signal }) => getJson<StoryDetail>(`/api/stories/${id}?country=${country}&limit=100`, signal),
    enabled: id !== null,
  });
}

export function useThread(id: string | null, country: CountryCode) {
  return useQuery({
    queryKey: ['thread', id, country],
    queryFn: ({ signal }) => getJson<ThreadDetail>(`/api/threads/${id}?country=${country}`, signal),
    enabled: id !== null,
  });
}

export interface CoveragePayload {
  country: CountryCode;
  collectionStartedAt: string | null;
  publishers: {
    name: string;
    domain: string;
    enabled: boolean;
    isWire: boolean;
    languages: string[];
    termsStatus: string | null;
    termsUrl: string | null;
    articleCount30d: number;
    feeds: { section: string | null; state: string | null; lastSuccessAt: string | null; enabled: boolean }[];
  }[];
  gaps: { sourceKey: string; start: string; end: string; reason: string }[];
}

export function useCoverage(country: CountryCode) {
  return useQuery({ queryKey: ['coverage', country], queryFn: ({ signal }) => getJson<CoveragePayload>(`/api/coverage?country=${country}`, signal) });
}

export interface AdminStatus {
  status: DataStatus;
  heartbeats: { component: string; lastBeatAt: string; ageSeconds: number; detail: Record<string, unknown> }[];
  totals: Record<string, number>;
  settings: Record<string, unknown>;
  sources: {
    sourceKey: string;
    publisher: string;
    country: string;
    section: string | null;
    state: string;
    lastSuccessAt: string | null;
    lastNewArticleAt: string | null;
    nextDueAt: string;
    attemptCount: number;
    lastError: string | null;
    overdueSeconds: number;
    withinFreshnessTarget: boolean;
  }[];
  recentRuns: { sourceKey: string; status: string; startedAt: string; durationMs: number; httpStatus: number | null; fetched: number; inserted: number; rejected: number; error: string | null }[];
  gaps: { sourceKey: string; country: string | null; start: string; end: string; reason: string }[];
}

export function useAdminStatus() {
  return useQuery({ queryKey: ['admin-status'], queryFn: ({ signal }) => getJson<AdminStatus>('/api/admin/status', signal), staleTime: 15_000, refetchInterval: 60_000 });
}

export function useSignals(country: CountryCode, window: WindowCode) {
  return useQuery({
    queryKey: ['signals', country, window],
    queryFn: ({ signal }) => getJson<SignalsPayload>(`/api/signals?country=${country}&window=${window}`, signal),
    staleTime: 60_000,
  });
}
