// Tunable pipeline settings. Thresholds are starting values chosen against the
// labeled pair fixtures in tests/fixtures; see docs/methodology.md.

export const CATEGORY_VERSION = 1;
export const CLUSTER_VERSION = 1;
export const THREAD_VERSION = 1;

export const pipelineConfig = {
  userAgent: 'ProjectTheia/0.1 (private RSS reader; metadata and links only)',
  claimBatchSize: 10,
  leaseSeconds: 300,
  fetchTimeoutMs: 15_000,
  fetchConcurrency: 4,
  maxFeedBytes: 5 * 1024 * 1024,
  workerBudgetMs: 10 * 60 * 1000,
  summaryMaxChars: 500,
  cluster: {
    // Minimum cosine similarity between an article and a story centroid.
    thresholds: { en: 0.28, ja: 0.33 } as Record<string, number>,
    defaultThreshold: 0.3,
    // Weight of the headline-only similarity when both sides also have summaries.
    headlineWeight: 0.7,
    maxMembersPerStory: 40,
  },
  syndication: { threshold: 0.9, windowHours: 24 },
  thread: {
    storySignatureSize: 8,
    threadSignatureSize: 16,
    // A term present in more than this share of recent headlines is too common to be distinctive.
    commonTermRatio: 0.04,
    minCorpusForGuard: 200,
    minSharedTerms: 2,
    // A link needs this signature cosine and at least one rare shared term...
    scoreThreshold: 0.2,
    // ...or this higher cosine when every shared term is fairly common.
    strongScoreThreshold: 0.3,
    // A term in no more than this share of recent headlines counts as rare.
    rareTermRatio: 0.004,
    // How much of the existing thread signature survives each time a story is added.
    signatureDecay: 0.7,
    properNounBoost: 1.6,
  },
} as const;

export type PipelineConfig = typeof pipelineConfig;
