import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DEFAULT_MODELS, modelRef, type ModelTarget } from '../llm/client';
import type { LlmProvider, LlmUsage, ReasoningEffort } from '../llm/types';
import { calculateCost } from '../llm/accounting';
import type { CostSummary, UsageTotal } from '../llm/ledger';
export { addUsage, type UsageTotal } from '../llm/ledger';
import { LLM_GROUPER, type Decision, type GroupArticle, type KnownEvent, type KnownSubject } from './llm';

export interface TrialOptions {
  language: 'en' | 'ja'; primary: ModelTarget; review: ModelTarget | null;
  reasoningEffort: ReasoningEffort | null; report: boolean; dryRun: boolean;
  maxBatches: number; budgetMs: number;
  probeFile: string;
}

function provider(value: string): LlmProvider {
  if (value !== 'openai' && value !== 'anthropic') throw new Error(`Unsupported LLM provider: ${value}`);
  return value;
}

function positive(value: string | undefined, name: string): number {
  if (!value) return Infinity;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function trialOptions(args: string[], env: Record<string, string | undefined>): TrialOptions {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
    provider: { type: 'string' }, model: { type: 'string' },
    'review-provider': { type: 'string' }, 'review-model': { type: 'string' },
    reasoning: { type: 'string' }, 'max-batches': { type: 'string' },
    report: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    probe: { type: 'string' },
  } });
  const language = positionals[0] ?? 'en';
  if (!['en', 'ja'].includes(language) || positionals.length > 2 || (positionals[1] && positionals[1] !== 'report')) {
    throw new Error('Usage: group:trial -- [en|ja] [report] [--provider openai|anthropic] [--model ID] [--review-provider PROVIDER --review-model ID] [--reasoning low] [--max-batches N] [--dry-run]');
  }
  const p = provider(v.provider ?? env.LLM_PROVIDER ?? 'anthropic');
  const model = v.model ?? env.LLM_MODEL ?? DEFAULT_MODELS[p].primary;
  const reviewModel = v['review-model'] ?? env.LLM_REVIEW_MODEL;
  const mode = env.TRIAL_MODE;
  if (mode && mode !== 'small' && mode !== 'mid') throw new Error('TRIAL_MODE must be small or mid');
  const useReview = reviewModel !== 'none' && Boolean(reviewModel || v['review-provider'] || mode === 'mid');
  const rp = provider(v['review-provider'] ?? env.LLM_REVIEW_PROVIDER ?? p);
  const review = useReview ? { provider: rp, model: reviewModel || DEFAULT_MODELS[rp].review } : null;
  if (!model.trim() || (review && !review.model.trim())) throw new Error('Model IDs must not be empty');
  const effort = v.reasoning ?? env.OPENAI_REASONING_EFFORT ?? 'default';
  if (!['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) {
    throw new Error(`Unsupported reasoning effort: ${effort}`);
  }
  return {
    language: language as 'en' | 'ja', primary: { provider: p, model }, review,
    reasoningEffort: effort === 'default' ? null : effort as ReasoningEffort,
    report: Boolean(v.report || positionals[1] === 'report'), dryRun: Boolean(v['dry-run']),
    maxBatches: positive(v['max-batches'] ?? env.TRIAL_MAX_BATCHES, 'max-batches'),
    budgetMs: positive(env.TRIAL_BUDGET_MS, 'TRIAL_BUDGET_MS'),
    probeFile: v.probe ?? 'docs/evidence/rss-probe-final.json',
  };
}

export interface TrialArticle extends GroupArticle { at: string; country: string }
export interface TrialIdentity {
  accountingVersion: number;
  grouper: string; language: string; datasetHash: string; articleCount: number;
  snapshot: string; windowHours: number; batchSize: number;
  primary: ModelTarget; review: ModelTarget | null; reasoningEffort: ReasoningEffort | null;
  postReview?: { version: string; sourceSha256: string; model: ModelTarget; maxTokens: number; effort?: string };
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const articleDigest = (articles: TrialArticle[]) => digest(articles);

export function trialIdentity(opts: TrialOptions, articles: TrialArticle[], snapshot: string, windowHours: number, batchSize: number): TrialIdentity {
  return {
    accountingVersion: 1,
    grouper: LLM_GROUPER, language: opts.language, datasetHash: digest(articles), articleCount: articles.length,
    snapshot, windowHours, batchSize, primary: opts.primary, review: opts.review,
    reasoningEffort: opts.primary.provider === 'openai' || opts.review?.provider === 'openai' ? opts.reasoningEffort : null,
  };
}

export function trialFile(identity: TrialIdentity): string {
  const name = modelRef(identity.primary).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 70);
  return `scratch/llm-trials/${identity.language}-${identity.grouper}-${name}-${digest(identity).slice(0, 16)}.json`;
}

export interface TrialState {
  identity: TrialIdentity; grouper: string; next: number; seq: number; durationMs: number;
  events: (KnownEvent & { lastAt: string })[]; subjects: KnownSubject[]; decisions: Decision[];
  usage: Record<string, UsageTotal>; escalated: number;
  cost?: CostSummary;
  articles: TrialArticle[];
  reviewAudit?: { source: string; baseCost: CostSummary; addedCost: CostSummary; seconds: number; corrections: number; changedArticles: number; proposalFile: string };
}

export function newTrial(identity: TrialIdentity, articles: TrialArticle[] = []): TrialState {
  return { identity, articles, grouper: identity.grouper, next: 0, seq: 0, durationMs: 0, events: [], subjects: [], decisions: [], usage: {}, escalated: 0 };
}

/** Refuse to reuse judgments from a different model, prompt version, or ordered corpus. */
export function validateTrial(state: TrialState, identity: TrialIdentity, articles: TrialArticle[]): void {
  if (JSON.stringify(state.identity) !== JSON.stringify(identity)) throw new Error('Saved trial configuration or dataset does not match this run');
  if (!Number.isSafeInteger(state.next) || state.next < 0 || state.next > articles.length || state.decisions.length !== state.next
      || state.decisions.some((d, i) => d.articleId !== articles[i]?.id)) {
    throw new Error('Saved trial progress does not match the ordered headlines');
  }
}

export function estimateCost(usage: LlmUsage): number | null {
  return calculateCost(usage).usd;
}
