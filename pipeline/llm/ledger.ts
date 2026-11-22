import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { calculateCost, type CostEstimate } from './accounting';
import type { LlmCallEvent, LlmCallObserver, LlmUsage } from './types';

export interface UsageTotal {
  input: number; output: number; cachedInput: number; cacheWriteInput: number;
  reasoningOutput: number; reasoningReportedCalls: number; calls: number;
  estimatedCostUsd: number | null;
}

export function addUsage(totals: Record<string, UsageTotal>, usage: LlmUsage, cost = calculateCost(usage).usd): void {
  const total = totals[usage.model] ??= { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0,
    reasoningOutput: 0, reasoningReportedCalls: 0, calls: 0, estimatedCostUsd: 0 };
  total.input += usage.inputTokens; total.output += usage.outputTokens;
  total.cachedInput += usage.cachedInputTokens ?? 0;
  total.cacheWriteInput += usage.cacheWriteInputTokens ?? 0;
  total.reasoningOutput += usage.reasoningOutputTokens ?? 0;
  if (usage.reasoningOutputTokens !== undefined) total.reasoningReportedCalls++;
  total.calls++;
  total.estimatedCostUsd = cost === null || total.estimatedCostUsd === null ? null : total.estimatedCostUsd + cost;
}

export type LedgerEntry = LlmCallEvent & { sessionId: string; cost?: CostEstimate | null };
export interface CostSummary {
  calculatedCostUsd: number | null; knownCostUsd: number;
  breakdownUsd: { input: number; cachedInput: number; cacheWrite: number; output: number };
  attempts: number; successful: number; failed: number; unfinished: number; unknownCostAttempts: number;
  usage: Record<string, UsageTotal>;
}

/** Contains only request identifiers, timings, usage, and prices; never credentials or prompts. */
export function ledgerObserver(file: string, sessionId: string): LlmCallObserver {
  return (event) => {
    const entry: LedgerEntry = { ...event, sessionId,
      ...(event.type === 'finish' ? { cost: event.usage ? calculateCost(event.usage) : null } : {}) };
    // Flush before making the call / before processing its answer. Ledger failure stops spending.
    appendFileSync(file, JSON.stringify(entry) + '\n', { encoding: 'utf8', flush: true });
  };
}

export function readLedger(file: string): LedgerEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line, i) => {
    try { return JSON.parse(line) as LedgerEntry; }
    catch { throw new Error(`Invalid cost ledger record ${i + 1} in ${file}; repair it before resuming`); }
  });
}

export function summarizeLedger(entries: LedgerEntry[], sessionId?: string): CostSummary {
  const summary: CostSummary = { calculatedCostUsd: 0, knownCostUsd: 0,
    breakdownUsd: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
    attempts: 0, successful: 0, failed: 0, unfinished: 0, unknownCostAttempts: 0, usage: {} };
  const starts = new Map<string, LedgerEntry>();
  const finishes = new Map<string, LedgerEntry>();
  for (const entry of entries) {
    if (sessionId && entry.sessionId !== sessionId) continue;
    const map = entry.type === 'start' ? starts : finishes;
    if (map.has(entry.id)) throw new Error(`Duplicate cost ledger record: ${entry.id}`);
    map.set(entry.id, entry);
  }
  for (const id of finishes.keys()) if (!starts.has(id)) throw new Error(`Cost ledger is missing the start of request ${id}`);
  for (const id of starts.keys()) {
    summary.attempts++;
    const finish = finishes.get(id);
    if (!finish || finish.type !== 'finish') {
      summary.unfinished++; summary.unknownCostAttempts++;
      continue;
    }
    if (finish.outcome === 'success') summary.successful++;
    else summary.failed++;
    const cost = finish.cost;
    if (finish.usage) addUsage(summary.usage, finish.usage, cost?.usd ?? null);
    if (cost?.usd == null) { summary.unknownCostAttempts++; continue; }
    summary.knownCostUsd += cost.usd;
    for (const key of Object.keys(summary.breakdownUsd) as (keyof CostSummary['breakdownUsd'])[]) {
      summary.breakdownUsd[key] += cost.breakdown?.[key] ?? 0;
    }
  }
  summary.calculatedCostUsd = summary.unknownCostAttempts ? null : summary.knownCostUsd;
  return summary;
}

export function costReport(summary: CostSummary, label = 'CUMULATIVE'): string {
  const amount = summary.calculatedCostUsd === null ? `unknown (known portion $${summary.knownCostUsd.toFixed(6)})` : `$${summary.calculatedCostUsd.toFixed(6)}`;
  const parts = Object.entries(summary.breakdownUsd).map(([key, value]) => `${key}=$${value.toFixed(6)}`).join(' ');
  return `${label} CALCULATED_COST_USD ${amount} (${parts})\n`
    + `API_ATTEMPTS ${summary.attempts} SUCCESSFUL ${summary.successful} FAILED ${summary.failed} UNFINISHED ${summary.unfinished} UNKNOWN_COST ${summary.unknownCostAttempts}\n`
    + `REPORTED_USAGE ${JSON.stringify(summary.usage)}`;
}

export function combineCosts(a: CostSummary, b: CostSummary): CostSummary {
  const combined: CostSummary = structuredClone(a);
  combined.knownCostUsd += b.knownCostUsd;
  for (const key of ['attempts', 'successful', 'failed', 'unfinished', 'unknownCostAttempts'] as const) combined[key] += b[key];
  for (const key of Object.keys(combined.breakdownUsd) as (keyof CostSummary['breakdownUsd'])[]) combined.breakdownUsd[key] += b.breakdownUsd[key];
  for (const [model, usage] of Object.entries(b.usage)) {
    const target = combined.usage[model];
    if (!target) { combined.usage[model] = structuredClone(usage); continue; }
    for (const key of ['input', 'output', 'cachedInput', 'cacheWriteInput', 'reasoningOutput', 'reasoningReportedCalls', 'calls'] as const) target[key] += usage[key];
    target.estimatedCostUsd = target.estimatedCostUsd === null || usage.estimatedCostUsd === null ? null : target.estimatedCostUsd + usage.estimatedCostUsd;
  }
  combined.calculatedCostUsd = a.calculatedCostUsd === null || b.calculatedCostUsd === null ? null : a.calculatedCostUsd + b.calculatedCostUsd;
  return combined;
}
