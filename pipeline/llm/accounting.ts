import type { LlmCallFinish, LlmCallObserver, LlmProvider, LlmUsage } from './types';

/** Log before sending, and after reading: a killed process leaves an identifiable unknown charge. */
export function startCall(provider: LlmProvider, model: string, attempt: number, observer?: LlmCallObserver) {
  const started = Date.now();
  const id = crypto.randomUUID();
  const ref = `${provider}:${model}`;
  observer?.({ type: 'start', id, provider, model: ref, attempt, startedAt: new Date(started).toISOString() });
  const result: Omit<LlmCallFinish, 'type' | 'id' | 'finishedAt' | 'durationMs'> = {
    httpStatus: null, requestId: null, responseId: null, outcome: 'failed', usage: null,
  };
  return {
    result,
    finish() {
      observer?.({ type: 'finish', id, finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
        ...result, usage: result.usage ? { ...result.usage, provider, model: ref } : null });
    },
  };
}

export interface TokenRates {
  input: number; output: number; cachedInput: number; cacheWriteShort: number; cacheWriteLong: number;
}
export interface CostEstimate {
  usd: number | null;
  breakdown: { input: number; cachedInput: number; cacheWrite: number; output: number } | null;
  ratesPerMillion: TokenRates | null;
  checkedAt: string;
  source: string;
  reason?: string;
}

// Standard, direct API pricing. Persist the applied rates with every response so a
// later rate edit cannot rewrite the cost of an earlier run.
const RATES: Record<string, TokenRates> = {
  'openai:gpt-6-luna': { input: .1, output: .5, cachedInput: .01, cacheWriteShort: .125, cacheWriteLong: .25 },
  'openai:gpt-6.1-terra': { input: 1, output: 5, cachedInput: .05, cacheWriteShort: 1.25, cacheWriteLong: 2.5 },
  'openai:gpt-6.2-sol': { input: 2, output: 10, cachedInput: .1, cacheWriteShort: 2.5, cacheWriteLong: 5 },
  'anthropic:claude-haiku-5-5': { input: .1, output: .5, cachedInput: .01, cacheWriteShort: .125, cacheWriteLong: .2 },
  'anthropic:claude-sonnet-5-5': { input: 2, output: 10, cachedInput: .1, cacheWriteShort: 2.5, cacheWriteLong: 4 },
};

export function calculateCost(usage: LlmUsage): CostEstimate {
  const provider = usage.provider ?? usage.model.split(':')[0];
  const model = usage.model.includes(':') ? usage.model : `${provider}:${usage.model}`;
  const base = {
    checkedAt: '2026-11-22',
    source: provider === 'openai' ? 'https://developers.openai.com/api/docs/pricing' : 'https://platform.claude.com/docs/en/about-claude/pricing',
  };
  const unknown = (reason: string): CostEstimate => ({ ...base, usd: null, breakdown: null, ratesPerMillion: null, reason });
  if (!RATES[model]) return unknown('No configured rate for this model');
  if (usage.serviceTier && !['default', 'standard'].includes(usage.serviceTier)) return unknown(`Unpriced service tier: ${usage.serviceTier}`);
  const cached = usage.cachedInputTokens ?? 0, writes = usage.cacheWriteInputTokens ?? 0;
  const short = usage.cacheWriteShortInputTokens ?? 0, long = usage.cacheWriteLongInputTokens ?? 0;
  const counts = [usage.inputTokens, usage.outputTokens, cached, writes, short, long, usage.reasoningOutputTokens ?? 0];
  if (counts.some((n) => !Number.isSafeInteger(n) || n < 0) || cached + writes > usage.inputTokens
      || (usage.reasoningOutputTokens ?? 0) > usage.outputTokens) return unknown('Invalid token usage');
  if (short + long !== writes) return unknown('Cache-write retention was not reported');
  const rates = { ...RATES[model]! };
  if (provider === 'openai' && usage.inputTokens > 272_000) {
    rates.input *= 2; rates.cachedInput *= 2; rates.cacheWriteShort *= 2; rates.cacheWriteLong *= 2; rates.output *= 1.5;
  } else if (model === 'anthropic:claude-haiku-5-5' && usage.inputTokens > 100_000) {
    for (const k of Object.keys(rates) as (keyof TokenRates)[]) rates[k] *= 5;
  }
  const breakdown = {
    input: (usage.inputTokens - cached - writes) * rates.input / 1e6,
    cachedInput: cached * rates.cachedInput / 1e6,
    cacheWrite: (short * rates.cacheWriteShort + long * rates.cacheWriteLong) / 1e6,
    // Reasoning is already included in the provider's output total.
    output: usage.outputTokens * rates.output / 1e6,
  };
  return { ...base, usd: Object.values(breakdown).reduce((a, b) => a + b, 0), breakdown, ratesPerMillion: rates };
}
