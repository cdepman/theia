// Review a completed trial without rerunning or overwriting its initial grouping.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { applyReview, reviewEvents, reviewRequest, REVIEW_VERSION } from '../group/review';
import { articleDigest, trialFile, validateTrial, type TrialState } from '../group/trial';
import { createLlmRouter, modelRef, type ModelTarget } from '../llm/client';
import { combineCosts, costReport, ledgerObserver, readLedger, summarizeLedger } from '../llm/ledger';
import type { AnthropicEffort } from '../llm/types';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    provider: { type: 'string', default: 'anthropic' }, model: { type: 'string', default: 'claude-haiku-5-5' },
    'max-output-tokens': { type: 'string', default: '32000' }, report: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    effort: { type: 'string', default: 'low' },
  } });
  if (positionals.length !== 1) throw new Error('Usage: group:review -- SOURCE.json [--provider anthropic --model claude-haiku-5-5] [--report|--dry-run]');
  if (!['anthropic', 'openai'].includes(values.provider)) throw new Error('Unsupported review provider');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(values.effort)) throw new Error('Unsupported review effort');
  const effort = values.effort as AnthropicEffort;
  const maxTokens = Number(values['max-output-tokens']);
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > 128000) throw new Error('max-output-tokens must be an integer from 1 to 128000');
  const source = positionals[0]!, sourceText = readFileSync(source, 'utf8');
  const original = JSON.parse(sourceText) as TrialState;
  if (!original.identity || !original.articles?.length || original.next !== original.identity.articleCount) throw new Error('Review requires a complete trial with embedded headlines');
  if (original.identity.postReview) throw new Error('Choose an initial trial, not an already reviewed result');
  if (original.identity.datasetHash !== articleDigest(original.articles)) throw new Error('Input headlines do not match the saved dataset hash');
  validateTrial(original, original.identity, original.articles);
  if (!existsSync(`${source}.calls.jsonl`)) throw new Error('The source trial is missing its cost ledger');
  const baseCost = summarizeLedger(readLedger(`${source}.calls.jsonl`));
  const target: ModelTarget = { provider: values.provider as ModelTarget['provider'], model: values.model };
  const identity = { ...original.identity, postReview: { version: REVIEW_VERSION,
    sourceSha256: createHash('sha256').update(sourceText).digest('hex'), model: target, maxTokens, effort } };
  const stateFile = trialFile(identity), ledger = `${stateFile}.calls.jsonl`, session = crypto.randomUUID();
  const request = reviewRequest(original.articles, original.decisions, modelRef(target), maxTokens);
  console.log(`REVIEW ${modelRef(target)} EFFORT ${effort} SOURCE ${source}\nSTATE ${stateFile}\nEVENTS ${reviewEvents(original.decisions).length} ARTICLES ${original.articles.length} PROMPT_CHARACTERS ${request.user.length}`);
  if (values['dry-run']) return;
  const report = () => {
    const added = summarizeLedger(readLedger(ledger));
    console.log(costReport(added, 'REVIEW_ONLY'));
    console.log(costReport(combineCosts(baseCost, added), 'INITIAL_PLUS_REVIEW'));
    if (existsSync(stateFile)) {
      const result = JSON.parse(readFileSync(stateFile, 'utf8')) as TrialState;
      console.log(`CORRECTIONS ${result.reviewAudit?.corrections} AFFECTED_ARTICLES ${result.reviewAudit?.changedArticles} EVENTS ${result.events.length}`);
    }
  };
  if (existsSync(stateFile) || values.report) {
    if (!existsSync(ledger)) throw new Error('No saved cost ledger for this review');
    report(); return;
  }
  const llm = createLlmRouter([target], process.env, { timeoutMs: 300_000, onCall: ledgerObserver(ledger, session),
    anthropicEffort: effort, reasoningEffort: effort });
  mkdirSync(dirname(stateFile), { recursive: true });
  const lock = `${stateFile}.lock`;
  let fd: number;
  try { fd = openSync(lock, 'wx'); } catch { throw new Error(`Review is locked: ${lock}; remove only after the previous process stops`); }
  try {
    writeFileSync(fd, String(process.pid));
    if (existsSync(stateFile)) { report(); return; }
    // Validate an earlier failed attempt's ledger before making another paid call.
    summarizeLedger(readLedger(ledger));
    const started = Date.now();
    const response = await llm(request);
    const proposalFile = `${stateFile}.proposal-${session}.json`;
    writeFileSync(proposalFile, JSON.stringify(response.input, null, 2) + '\n', { flag: 'wx' });
    const applied = applyReview(original.decisions, response.input, modelRef(target));
    const addedCost = summarizeLedger(readLedger(ledger));
    const seconds = (Date.now() - started) / 1000;
    const events = new Map<string, TrialState['events'][number]>(), subjects = new Map<string, TrialState['subjects'][number]>();
    applied.decisions.forEach((d, i) => {
      const existing = events.get(d.eventKey), at = original.articles[i]!.at;
      events.set(d.eventKey, { key: d.eventKey, label: d.eventLabel, subjectKey: d.subjectKey, category: d.category, places: d.places,
        lastAt: existing && existing.lastAt > at ? existing.lastAt : at });
      subjects.set(d.subjectKey, { key: d.subjectKey, label: d.subjectLabel });
    });
    const cost = combineCosts(baseCost, addedCost);
    const result: TrialState = { ...original, identity, decisions: applied.decisions, events: [...events.values()], subjects: [...subjects.values()],
      durationMs: original.durationMs + seconds * 1000, cost, usage: cost.usage,
      escalated: applied.decisions.filter((d) => d.escalated).length,
      reviewAudit: { source, baseCost, addedCost, seconds, corrections: applied.changes.length, changedArticles: applied.changedArticles, proposalFile } };
    const temporary = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(result)); renameSync(temporary, stateFile);
    report();
  } catch (error) {
    report(); throw error;
  } finally { closeSync(fd); unlinkSync(lock); }
}

main().catch((error: Error) => { console.error(`[group:review] ${error.message}`); process.exitCode = 1; });
