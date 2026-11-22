import { describe, expect, it } from 'vitest';
import { addUsage, estimateCost, newTrial, trialFile, trialIdentity, trialOptions, validateTrial } from '../../pipeline/group/trial';
import { articlesFromProbe } from '../../pipeline/group/dataset';

const articles = [{ id: 'one', publisher: 'a', headline: 'A bridge opens', country: 'US', at: '2026-11-21T09:00:00Z' }];
const identity = (args: string[] = []) => trialIdentity(trialOptions(args, {}), articles, '2026-11-21T10:00:00Z', 72, 60);

describe('model trial configuration and checkpoints', () => {
  it('preserves Anthropic defaults and supports OpenAI, mixed escalation, and explicit disabling', () => {
    expect(trialOptions([], {})).toMatchObject({ primary: { provider: 'anthropic', model: 'claude-haiku-5-5' }, review: null });
    expect(trialOptions(['ja', '--provider', 'openai', '--reasoning', 'low'], {})).toMatchObject({
      language: 'ja', primary: { provider: 'openai', model: 'gpt-6-luna' }, reasoningEffort: 'low',
    });
    expect(trialOptions(['--provider', 'openai', '--review-provider', 'anthropic', '--review-model', 'claude-sonnet-5-5'], {})).toMatchObject({
      review: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    });
    expect(trialOptions(['--review-model', 'none'], { TRIAL_MODE: 'mid', LLM_REVIEW_MODEL: 'x' }).review).toBeNull();
    expect(trialOptions([], { LLM_PROVIDER: 'openai', TRIAL_MODE: 'mid' }).review).toEqual({ provider: 'openai', model: 'gpt-6.2-sol' });
  });

  it('lets flags override environment selections and reports without credentials', () => {
    const options = trialOptions(['en', 'report', '--model', 'gpt-6.1-terra', '--max-batches', '1'], {
      LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-6-luna', OPENAI_REASONING_EFFORT: 'low',
    });
    expect(options).toMatchObject({ primary: { model: 'gpt-6.1-terra' }, report: true, maxBatches: 1, reasoningEffort: 'low' });
    expect(trialOptions(['--dry-run'], {}).dryRun).toBe(true);
    expect(trialOptions(['--probe', 'scratch/fresh.json'], {}).probeFile).toBe('scratch/fresh.json');
  });

  it('freezes fresh feed metadata with stable order, attribution, and a bounded date window', () => {
    const items = [
      { url: 'b', headline: 'B', publishedAt: '2026-11-22T09:00:00Z', futureDated: false },
      { url: 'a', headline: 'A', publishedAt: '2026-11-22T09:00:00Z', futureDated: false },
      { url: 'a', headline: 'Duplicate', publishedAt: '2026-11-22T09:00:00Z', futureDated: false },
      { url: 'old', headline: 'Old', publishedAt: '2026-11-18T00:00:00Z', futureDated: false },
      { url: 'bad', headline: 'Bad date', publishedAt: 'invalid', futureDated: false },
      { url: 'future', headline: 'Future', publishedAt: '2026-11-23T00:00:00Z', futureDated: false },
    ];
    const probe = { summary: { cutoff: '2026-11-22T10:00:00Z' }, feeds: [
      { publisherId: 'paper', language: 'en', country: 'US', articles: items },
      { publisherId: 'jp', language: 'ja', country: 'JP', articles: [{ ...items[0]!, url: 'jp' }] },
    ] };
    const corpus = articlesFromProbe(probe, 'en', probe.summary.cutoff);
    expect(corpus.map((a) => [a.id, a.publisher, a.country])).toEqual([['a', 'paper', 'US'], ['b', 'paper', 'US']]);
    expect(() => articlesFromProbe(probe, 'en', 'invalid')).toThrow(/snapshot cutoff/);
    const id = trialIdentity(trialOptions([], {}), corpus, probe.summary.cutoff, 72, 60);
    expect(newTrial(id, corpus).articles).toEqual(corpus);
  });

  it.each([
    ['--provider', 'typo'], ['--reasoning', 'typo'], ['--model', ''], ['--max-batches', '0'],
    ['--max-batches', 'NaN'], ['--max-batches', '1.5'], ['--unknown'], ['fr'], ['en', 'typo'],
  ])('rejects invalid settings %j before an API call', (...args) => {
    expect(() => trialOptions(args, {})).toThrow();
  });

  it('isolates runs by model, review model, reasoning, corpus, and prompt version', () => {
    const a = identity(['--provider', 'openai']);
    const files = [a,
      identity(['--provider', 'openai', '--model', 'gpt-6.1-terra']),
      identity(['--provider', 'openai', '--review-model', 'gpt-6.2-sol']),
      identity(['--provider', 'openai', '--reasoning', 'low']),
      { ...a, datasetHash: 'changed' }, { ...a, grouper: 'new-prompt' },
    ].map(trialFile);
    expect(new Set(files).size).toBe(files.length);
    // A bounded smoke run resumes the same full dataset, rather than creating a different benchmark.
    expect(trialFile(identity(['--provider', 'openai', '--max-batches', '1']))).toBe(files[0]);
  });

  it('rejects checkpoints from another run or with inconsistent progress', () => {
    const id = identity();
    const state = newTrial(id);
    expect(() => validateTrial(state, id, articles)).not.toThrow();
    expect(() => validateTrial(state, { ...id, datasetHash: 'different' }, articles)).toThrow(/does not match/);
    expect(() => validateTrial({ ...state, next: 1 }, id, articles)).toThrow(/progress/);
  });

  it('accounts for cached input and refuses to price unknown models as free', () => {
    const usage = { model: 'openai:gpt-6-luna', inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 10_000 };
    // Long context doubles input rates and multiplies output by 1.5.
    expect(estimateCost(usage)).toBeCloseTo(0.1355);
    expect(estimateCost({ ...usage, model: 'openai:unknown' })).toBeNull();
    const totals = {};
    addUsage(totals, usage); addUsage(totals, usage);
    expect(totals).toMatchObject({ 'openai:gpt-6-luna': { calls: 2, input: 2_000_000, cachedInput: 800_000, estimatedCostUsd: 0.271 } });
  });
});
