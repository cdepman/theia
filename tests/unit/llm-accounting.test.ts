import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { calculateCost, startCall } from '../../pipeline/llm/accounting';
import { costReport, ledgerObserver, readLedger, summarizeLedger } from '../../pipeline/llm/ledger';
import type { LlmUsage } from '../../pipeline/llm/types';

const dirs: string[] = [];
const file = () => { const dir = mkdtempSync(join(tmpdir(), 'theia-cost-')); dirs.push(dir); return join(dir, 'calls.jsonl'); };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const usage: LlmUsage = { model: 'openai:gpt-6-luna', inputTokens: 1000, outputTokens: 100, reasoningOutputTokens: 80 };

describe('reported-usage pricing', () => {
  it('prices cache reads and both write retentions separately without double-counting reasoning', () => {
    const cost = calculateCost({ ...usage, cachedInputTokens: 400, cacheWriteInputTokens: 300,
      cacheWriteShortInputTokens: 200, cacheWriteLongInputTokens: 100 });
    expect(cost.breakdown).toEqual({ input: .00003, cachedInput: .000004, cacheWrite: .00005, output: .00005 });
    expect(cost.usd).toBeCloseTo(.000134);
    expect(calculateCost({ ...usage, reasoningOutputTokens: undefined }).usd).toBe(calculateCost(usage).usd);
    expect(cost).toMatchObject({ checkedAt: '2026-11-22', ratesPerMillion: { input: .1, output: .5 } });
  });

  it('uses the correct long-context boundary for each provider', () => {
    expect(calculateCost({ ...usage, inputTokens: 272_000 }).ratesPerMillion?.input).toBe(.1);
    expect(calculateCost({ ...usage, inputTokens: 272_001 }).ratesPerMillion).toMatchObject({ input: .2, output: .75 });
    expect(calculateCost({ ...usage, model: 'anthropic:claude-haiku-5-5', inputTokens: 100_000 }).ratesPerMillion?.input).toBe(.1);
    expect(calculateCost({ ...usage, model: 'anthropic:claude-haiku-5-5', inputTokens: 100_001 }).ratesPerMillion).toMatchObject({ input: .5, output: 2.5 });
    expect(calculateCost({ ...usage, model: 'anthropic:claude-sonnet-5-5' }).ratesPerMillion?.cachedInput).toBe(.1);
  });

  it.each([
    { model: 'openai:unknown' }, { serviceTier: 'priority' }, { cacheWriteInputTokens: 20 },
    { inputTokens: -1 }, { cachedInputTokens: 2000 }, { outputTokens: NaN }, { reasoningOutputTokens: 101 },
  ])('flags unknown pricing or invalid usage instead of claiming zero: %j', (override) => {
    expect(calculateCost({ ...usage, ...override })).toMatchObject({ usd: null, reason: expect.any(String) });
  });
});

describe('durable run cost ledger', () => {
  it('keeps paid failed calls across resumes and separates each invocation from the total', () => {
    const path = file();
    const first = startCall('openai', 'gpt-6-luna', 1, ledgerObserver(path, 'session-1'));
    first.result.usage = usage; // A response was paid for, but its answer could not be used.
    first.finish();
    const second = startCall('openai', 'gpt-6-luna', 1, ledgerObserver(path, 'session-2'));
    second.result.usage = usage; second.result.outcome = 'success'; second.finish();
    const entries = readLedger(path);
    const total = summarizeLedger(entries);
    expect(total).toMatchObject({ attempts: 2, failed: 1, successful: 1, unfinished: 0, unknownCostAttempts: 0 });
    expect(total.calculatedCostUsd).toBeCloseTo(.0003);
    expect(summarizeLedger(entries, 'session-2').calculatedCostUsd).toBeCloseTo(.00015);
    expect(total.usage['openai:gpt-6-luna']).toMatchObject({ input: 2000, output: 200, reasoningOutput: 160, calls: 2 });
    // The applied rate snapshot is saved, rather than looked up again when reporting.
    const end = entries.find((e) => e.type === 'finish')!;
    expect(end.cost?.ratesPerMillion?.output).toBe(.5);
    end.cost!.usd = .25;
    expect(summarizeLedger(entries).calculatedCostUsd).toBeCloseTo(.25015);
  });

  it('keeps unknown charges visible after a timeout or a killed process', () => {
    const path = file(), observer = ledgerObserver(path, 'session');
    const success = startCall('openai', 'gpt-6-luna', 1, observer);
    success.result.usage = usage; success.result.outcome = 'success'; success.finish();
    startCall('openai', 'gpt-6-luna', 1, observer).finish(); // No reported usage.
    startCall('openai', 'gpt-6-luna', 2, observer); // Process stopped before completion.
    const summary = summarizeLedger(readLedger(path));
    expect(summary).toMatchObject({ calculatedCostUsd: null, unknownCostAttempts: 2, failed: 1, unfinished: 1, attempts: 3 });
    expect(summary.knownCostUsd).toBeCloseTo(.00015);
    expect(costReport(summary)).toContain('unknown (known portion $0.000150)');
  });

  it('rejects corrupt or duplicate records rather than silently under/overcharging', () => {
    const path = file();
    startCall('openai', 'gpt-6-luna', 1, ledgerObserver(path, 'session'));
    const entries = readLedger(path);
    expect(() => summarizeLedger([...entries, ...entries])).toThrow(/Duplicate/);
    writeFileSync(path, '{broken');
    expect(() => readLedger(path)).toThrow(/Invalid cost ledger/);
  });
});
