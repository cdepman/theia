import { type ClusteringInput, clusterArticles } from '../cluster/cluster';
import { pipelineConfig } from '../config';
import { type Db } from '../db';
import { buildArticles, type ClaimedSource } from '../normalize/article';
import { fetchFeed, type FetchLike } from '../providers/rss/fetch';
import { parseFeed } from '../providers/rss/parse';
import { signatureDf } from '../thread/signature';
import { buildSignatures, planThreads, type ThreadCandidate, type ThreadingStory } from '../thread/thread';

export interface WorkerOptions {
  fetchImpl?: FetchLike;
  /** Fixed clock for tests. In production every database call uses the database's own now(). */
  now?: () => Date;
  budgetMs?: number;
  /** Countries to refresh even if no new articles arrived (for example, views past their refresh target). */
  staleCountries?: string[];
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /** Test hook, called after a source is fetched and before its result is committed. */
  beforeCommit?: (source: ClaimedSource) => Promise<void> | void;
  /** Test hook, called after a source's result is committed. */
  afterCommit?: (source: ClaimedSource) => Promise<void> | void;
}

export interface WorkerSummary {
  claimed: number;
  succeeded: number;
  unchanged: number;
  failed: number;
  inserted: number;
  languagesClustered: string[];
  countriesRefreshed: string[];
  budgetExhausted: boolean;
  durationMs: number;
}

interface CommitResult {
  inserted: number;
  leaseValid: boolean;
  country: string | null;
  language: string;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

function withNow(args: Record<string, unknown>, now?: () => Date): Record<string, unknown> {
  return now ? { ...args, p_now: now().toISOString() } : args;
}

/** Polls one claimed source and commits or fails it. Never throws for a feed-level problem. */
export async function pollSource(db: Db, source: ClaimedSource, opts: WorkerOptions = {}): Promise<{ status: 'success' | 'unchanged' | 'failed'; commit?: CommitResult }> {
  const startedAt = (opts.now?.() ?? new Date()).toISOString();
  const fail = async (message: string, httpStatus: number | null, retryAfterSeconds: number | null) => {
    await db.rpc(
      'theia_fail_poll',
      withNow(
        {
          p_source_key: source.sourceKey,
          p_lease_token: source.leaseToken,
          p_error: { message, httpStatus, retryAfterSeconds, startedAt },
        },
        opts.now,
      ),
    );
    return { status: 'failed' as const };
  };

  const fetched = await fetchFeed(source.feedUrl, source.checkpoint, { fetchImpl: opts.fetchImpl });
  if (fetched.kind === 'error') return fail(fetched.message, fetched.httpStatus, fetched.retryAfterSeconds);

  let result: Record<string, unknown>;
  if (fetched.kind === 'unchanged') {
    result = { status: 'unchanged', httpStatus: 304, startedAt, checkpoint: fetched.checkpoint, articles: [], recordsFetched: 0, recordsRejected: 0 };
  } else {
    let built;
    try {
      const feed = parseFeed(fetched.body);
      built = buildArticles(source, feed.items);
      if (feed.items.length > 0 && built.articles.length === 0) {
        return fail('feed parsed but no item had a usable headline and link', fetched.httpStatus, null);
      }
      result = {
        status: 'success',
        httpStatus: fetched.httpStatus,
        startedAt,
        checkpoint: fetched.checkpoint,
        articles: built.articles,
        recordsFetched: feed.items.length,
        recordsRejected: built.rejected,
        feedOldestItemAt: built.feedOldestItemAt,
      };
    } catch (e) {
      return fail(`parse error: ${(e as Error).message}`.slice(0, 300), fetched.httpStatus, null);
    }
  }

  await opts.beforeCommit?.(source);
  const commit = await db.rpc<CommitResult>(
    'theia_commit_poll',
    withNow({ p_source_key: source.sourceKey, p_lease_token: source.leaseToken, p_result: result }, opts.now),
  );
  await opts.afterCommit?.(source);
  return { status: fetched.kind === 'unchanged' ? 'unchanged' : 'success', commit };
}

/** Clusters unassigned articles for one language, then decides thread membership. */
export async function clusterAndThread(db: Db, language: string, opts: WorkerOptions = {}): Promise<{ assigned: number; linked: number; threadsCreated: number; countries: string[] }> {
  const input = await db.rpc<ClusteringInput>('theia_clustering_input', withNow({ p_language: language }, opts.now));
  let assigned = 0;
  if (input.unassigned.length > 0) {
    const result = clusterArticles(input);
    const applied = await db.rpc<{ assigned: number }>(
      'theia_apply_clustering',
      withNow({ p_language: language, p_payload: result }, opts.now),
    );
    assigned = applied.assigned;
  }

  const threading = await db.rpc<{ stories: ThreadingStory[]; countries: string[] }>('theia_threading_input', withNow({ p_language: language }, opts.now));
  if (threading.stories.length === 0) return { assigned, linked: 0, threadsCreated: 0, countries: assigned > 0 ? threading.countries : [] };

  const corpus = [...input.corpus, ...input.unassigned.map((a) => a.headline)];
  const df = signatureDf(corpus, language);
  const signatures = buildSignatures(threading.stories, language, df);
  const candidates = await db.rpc<ThreadCandidate[]>(
    'theia_thread_candidates',
    withNow(
      {
        p_language: language,
        p_signatures: threading.stories.map((s) => ({ storyId: s.id, terms: [...(signatures.get(s.id)?.weights.keys() ?? [])] })),
      },
      opts.now,
    ),
  );
  const plan = planThreads({ language, stories: threading.stories, candidates, signatures });
  const applied = await db.rpc<{ linked: number; threadsCreated: number }>(
    'theia_apply_threading',
    withNow({ p_language: language, p_payload: plan }, opts.now),
  );
  return { assigned, linked: applied.linked, threadsCreated: applied.threadsCreated, countries: threading.countries };
}

/**
 * One worker run: claim due sources under a lease, fetch and commit them, then
 * cluster, link threads, and refresh the precomputed views for affected countries.
 *
 * Expired leases recover unfinished polls. Pending-language detection recovers both
 * clustering and threading after a committed poll, without fetching the feed again.
 */
export async function runWorker(db: Db, opts: WorkerOptions = {}): Promise<WorkerSummary> {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? pipelineConfig.workerBudgetMs;
  const summary: WorkerSummary = {
    claimed: 0, succeeded: 0, unchanged: 0, failed: 0, inserted: 0,
    languagesClustered: [], countriesRefreshed: [], budgetExhausted: false, durationMs: 0,
  };
  const languages = new Set<string>();
  const countries = new Set<string>(opts.staleCountries ?? []);

  await db.rpc('theia_heartbeat', withNow({ p_component: 'worker', p_detail: { phase: 'started' } }, opts.now));

  for (;;) {
    if (Date.now() - started > budgetMs) {
      summary.budgetExhausted = true;
      break;
    }
    const claimed = await db.rpc<ClaimedSource[]>(
      'theia_claim_due_sources',
      withNow({ p_limit: pipelineConfig.claimBatchSize, p_lease_seconds: pipelineConfig.leaseSeconds }, opts.now),
    );
    if (claimed.length === 0) break;
    summary.claimed += claimed.length;

    // At most one in-flight request per publisher domain: sources that share a domain run in sequence.
    const byDomain = new Map<string, ClaimedSource[]>();
    for (const s of claimed) {
      const list = byDomain.get(s.domain);
      if (list) list.push(s);
      else byDomain.set(s.domain, [s]);
    }
    await mapLimit([...byDomain.values()], pipelineConfig.fetchConcurrency, async (group) => {
      for (const source of group) {
        try {
          const res = await pollSource(db, source, opts);
          if (res.status === 'failed') summary.failed += 1;
          else {
            if (res.status === 'unchanged') summary.unchanged += 1;
            else summary.succeeded += 1;
            if (res.commit && res.commit.inserted > 0) {
              summary.inserted += res.commit.inserted;
              languages.add(res.commit.language);
              if (res.commit.country) countries.add(res.commit.country);
            }
          }
        } catch (e) {
          // A database error for one source must not stop the others. Its lease will expire.
          summary.failed += 1;
          log('source failed outside the normal path', { sourceKey: source.sourceKey, error: (e as Error).message });
        }
      }
    });
  }

  // Also pick up unfinished clustering or threading from a previous run.
  for (const l of await db.rpc<string[]>('theia_pending_languages', withNow({}, opts.now))) languages.add(l);

  for (const language of [...languages].sort()) {
    const r = await clusterAndThread(db, language, opts);
    // Thread membership can change for every country sharing the language, including
    // recovery runs with no new articles and no country marked stale by the dispatcher.
    for (const country of r.countries) countries.add(country);
    summary.languagesClustered.push(language);
    log('clustered', { language, ...r });
  }

  for (const country of [...countries].sort()) {
    const args: Record<string, unknown> = { p_country: country };
    if (opts.now) {
      args.p_cutoff = opts.now().toISOString();
      args.p_now = opts.now().toISOString();
    }
    const r = await db.rpc<{ skipped: boolean }>('theia_refresh_country', args);
    if (!r.skipped) summary.countriesRefreshed.push(country);
  }

  summary.durationMs = Date.now() - started;
  await db.rpc('theia_heartbeat', withNow({ p_component: 'worker', p_detail: { phase: 'finished', ...summary } }, opts.now));
  log('worker finished', { ...summary });
  return summary;
}
