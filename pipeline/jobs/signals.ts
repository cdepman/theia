import { type Db } from '../db';
import { pipelineConfig } from '../config';
import { type FetchLike } from '../providers/rss/fetch';
import { originsWithoutCredentials, signalProviders, SignalHttpError, type ClaimedSignal } from '../providers/signals/providers';

export interface SignalOptions {
  fetchImpl?: FetchLike;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  /** Deadline for one request including its body. */
  timeoutMs?: number;
  /** Stop claiming once this much time has passed. */
  deadlineMs?: number;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface SignalSummary {
  claimed: number;
  succeeded: number;
  failed: number;
  items: number;
  skippedOrigins: string[];
}

function withNow(args: Record<string, unknown>, now?: () => Date): Record<string, unknown> {
  return now ? { ...args, p_now: now().toISOString() } : args;
}

export async function pollSignal(db: Db, source: ClaimedSignal, opts: SignalOptions = {}): Promise<{ ok: boolean; items: number }> {
  const now = opts.now ? opts.now() : new Date();
  const startedAt = now.toISOString();
  const provider = signalProviders[source.originKey];
  try {
    if (!provider) throw new SignalHttpError(`No provider for origin ${source.originKey}`);
    const { allowEmpty, ...result } = await provider.run({ source, fetchImpl: opts.fetchImpl ?? fetch, now, env: opts.env ?? process.env, timeoutMs: opts.timeoutMs });
    if (result.items.length === 0 && !allowEmpty) throw new SignalHttpError('The source returned no entries');
    const commit = await db.rpc<{ items: number }>(
      'theia_commit_signal_poll',
      withNow({ p_source_key: source.sourceKey, p_lease_token: source.leaseToken, p_result: { status: 'success', startedAt, ...result } }, opts.now),
    );
    return { ok: true, items: commit.items };
  } catch (e) {
    const err = e as SignalHttpError;
    await db.rpc(
      'theia_fail_signal_poll',
      withNow({
        p_source_key: source.sourceKey,
        p_lease_token: source.leaseToken,
        p_error: { message: err.message, httpStatus: err.httpStatus ?? null, retryAfterSeconds: err.retryAfterSeconds ?? null, startedAt },
      }, opts.now),
    );
    opts.log?.('signal source failed', { sourceKey: source.sourceKey, error: err.message });
    return { ok: false, items: 0 };
  }
}

/** Claims and polls every due signal source the environment has credentials for. */
export async function pollSignals(db: Db, opts: SignalOptions = {}): Promise<SignalSummary> {
  const skippedOrigins = originsWithoutCredentials(opts.env ?? process.env);
  const summary: SignalSummary = { claimed: 0, succeeded: 0, failed: 0, items: 0, skippedOrigins };
  const started = Date.now();
  for (;;) {
    if (opts.deadlineMs !== undefined && Date.now() - started > opts.deadlineMs) break;
    const claimed = await db.rpc<ClaimedSignal[]>(
      'theia_claim_due_signals',
      withNow({ p_limit: pipelineConfig.claimBatchSize, p_lease_seconds: pipelineConfig.leaseSeconds, p_exclude_origins: skippedOrigins }, opts.now),
    );
    if (claimed.length === 0) break;
    summary.claimed += claimed.length;
    // One request at a time per origin, origins in parallel.
    const byOrigin = new Map<string, ClaimedSignal[]>();
    for (const s of claimed) byOrigin.set(s.originKey, [...(byOrigin.get(s.originKey) ?? []), s]);
    await Promise.all([...byOrigin.values()].map(async (group) => {
      for (const source of group) {
        try {
          const r = await pollSignal(db, source, opts);
          if (r.ok) {
            summary.succeeded += 1;
            summary.items += r.items;
          } else summary.failed += 1;
        } catch (e) {
          summary.failed += 1;
          opts.log?.('signal source failed outside the normal path', { sourceKey: source.sourceKey, error: (e as Error).message });
        }
      }
    }));
  }
  return summary;
}

export interface SignalScopeConfig {
  scope: string;
  country?: string;
  language?: string;
  viewCountries: string[];
  params?: Record<string, unknown>;
  cadenceSeconds?: number;
}

export interface OriginConfig {
  key: string;
  name: string;
  kind: 'press' | 'search' | 'social' | 'reference' | 'community' | 'aggregator';
  lane?: 'press' | 'attention';
  enabled?: boolean;
  weight?: number;
  displayOrder?: number;
  visible?: boolean;
  attribution?: string;
  termsUrl?: string;
  tags?: string[];
  cadenceSeconds?: number;
  scopes?: SignalScopeConfig[];
}

/** Checks config/signal-sources.json before it is sent to the database. */
export function validateOrigins(config: { origins: OriginConfig[] }): { origins: OriginConfig[] } {
  const seen = new Set<string>();
  for (const o of config.origins) {
    if (!o.key || seen.has(o.key)) throw new Error(`Origin keys must be unique and non-empty: ${o.key}`);
    seen.add(o.key);
    if (o.key !== 'press' && !signalProviders[o.key]) throw new Error(`No provider is implemented for origin "${o.key}"`);
    if (o.weight !== undefined && !(o.weight >= 0)) throw new Error(`Origin "${o.key}" has an invalid weight`);
    for (const s of o.scopes ?? []) {
      if (!s.scope || !Array.isArray(s.viewCountries) || s.viewCountries.length === 0) {
        throw new Error(`Origin "${o.key}" has a scope without a name or without viewCountries`);
      }
    }
  }
  return config;
}
