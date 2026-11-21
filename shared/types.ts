import type { Category, CountryCode, WindowCode } from './constants';

export type Unit = 'story' | 'thread';
export type Metric = 'distinct_monitored_publishers' | 'publisher_days';
export type ThreadStatus = 'active' | 'fading' | 'quiet' | 'dormant' | 'unknown';
export type CoverageStatus = 'complete' | 'partial' | 'limited' | 'no_data' | 'no_sources';

export interface Coverage {
  complete: boolean;
  status: CoverageStatus;
  reasons: string[];
  monitoredPublisherCount: number;
  activePublisherCount: number;
  publisherFloor: number;
  failingSourceCount: number;
  gapCount: number;
  collectionStartedAt: string | null;
  observedStart: string | null;
  observedEnd: string | null;
}

export interface ViewItem {
  id: string;
  unit: Unit;
  rank: number;
  headline: string;
  language: string;
  category: string;
  metricValue: number;
  publisherCount: number;
  articleCount: number;
  lastSeenAt: string;
  syndicated: boolean;
  // story items
  firstSeenAt?: string;
  threadId?: string | null;
  threadStoryCount?: number;
  // thread items
  label?: string;
  publisherDays?: number;
  activeDays?: number;
  storyCount?: number;
  topStoryId?: string;
  status?: ThreadStatus;
  peakDay?: string | null;
  peakCount?: number;
  daysSinceLastCoverage?: number | null;
  decayDays?: number | null;
}

export interface Freshness {
  computedAt: string;
  ageSeconds: number;
  refreshTargetSeconds: number;
  stale: boolean;
}

export interface ViewPayload {
  schemaVersion: number;
  metricVersion: number;
  country: CountryCode;
  category: Category;
  window: WindowCode;
  unit: Unit;
  metric: Metric;
  windowStart: string | null;
  observationCutoff: string | null;
  dataAsOf: string | null;
  computedAt: string | null;
  coverage: Coverage;
  metricRange: { min: number | null; max: number | null };
  stories: ViewItem[];
  freshness: Freshness | null;
  notComputed?: boolean;
}

export interface SeriesPoint {
  day: string;
  count: number | null;
  known: boolean;
  partial: boolean;
}

export interface SeriesStats {
  status: ThreadStatus;
  publisherDays: number;
  activeDays: number;
  knownDays: number;
  peakDay: string | null;
  peakCount: number;
  lastCoverageDay: string | null;
  daysSinceLastCoverage: number | null;
  decayDays: number | null;
  series: SeriesPoint[];
}

export interface ArticleRef {
  id: string;
  headline: string;
  url: string;
  language: string;
  category: string;
  publishedAt: string | null;
  firstObservedAt: string;
  effectiveAt: string;
  syndicationGroupId: string | null;
  publisher: { name: string; domain: string; country: string | null; isWire: boolean; attributionMethod: string | null };
}

export interface StoryDetail {
  id: string;
  unit: 'story';
  country: CountryCode;
  language: string;
  category: string;
  headline: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  thread: { id: string; label: string; storyCount: number } | null;
  windows: Record<WindowCode, { publisherCount: number; articleCount: number }>;
  byCountry: { country: string; publisherCount: number; articleCount: number }[];
  stats: SeriesStats;
  articles: { total: number; limit: number; offset: number; items: ArticleRef[] };
}

export interface ThreadDetail {
  id: string;
  unit: 'thread';
  country: CountryCode;
  language: string;
  category: string;
  label: string;
  signatureTerms: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  dormantAt: string | null;
  storyCount: number;
  stats: SeriesStats;
  byCountry: { country: string; publisherDays: number; activeDays: number }[];
  stories: {
    id: string;
    headline: string;
    category: string;
    firstSeenAt: string;
    lastSeenAt: string;
    publisherCount: number;
    articleCount: number;
  }[];
}

export interface MetaPayload {
  countries: {
    code: CountryCode;
    name: string;
    collectionStartedAt: string | null;
    monitoredPublisherCount: number;
    candidatePublisherCount: number;
  }[];
  categories: Category[];
  windows: WindowCode[];
  publisherFloor: number;
}

export interface DataStatus {
  ok: boolean;
  checkedAt: string;
  paused: boolean;
  activeSourceCount: number;
  dispatcher: { lastBeatAt: string | null; ageSeconds: number | null };
  countries: {
    code: CountryCode;
    monitoredPublisherCount: number;
    lastComputedAt: string | null;
    dataAsOf: string | null;
    viewAgeSeconds: number | null;
    stale: boolean;
  }[];
  sourcesNeedingAttention: string[];
  problems: { code: string; [k: string]: unknown }[];
}
