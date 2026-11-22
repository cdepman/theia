// Reproducible, resumable model trials against recorded headlines. See docs/operations.md.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLlmRouter, modelRef } from '../llm/client';
import { newTrial, trialFile, trialIdentity, trialOptions, validateTrial, type TrialArticle, type TrialState } from '../group/trial';
import { groupBatch } from '../group/llm';
import { costReport, ledgerObserver, readLedger, summarizeLedger } from '../llm/ledger';
import { articlesFromProbe, type ProbeDataset } from '../group/dataset';

async function main(): Promise<void> {
  const opts = trialOptions(process.argv.slice(2), process.env);
  const LANG = opts.language;
  const probe = JSON.parse(readFileSync(opts.probeFile, 'utf8')) as ProbeDataset;
  // Preserve the original benchmark cutoff. New captures use their recorded cutoff.
  const SNAPSHOT = opts.probeFile === 'docs/evidence/rss-probe-final.json' ? '2026-11-21T10:00:00Z' : probe.summary.cutoff;
  const HOURS = 72, CHUNK = 60;
  type Art = TrialArticle;
  const articles = articlesFromProbe(probe, LANG, SNAPSHOT, HOURS);
  if (!articles.length) throw new Error('The selected dataset contains no usable headlines');
  const identity = trialIdentity(opts, articles, SNAPSHOT, HOURS, CHUNK);
  const STATE = trialFile(identity);
  const LEDGER = `${STATE}.calls.jsonl`;
  const sessionId = crypto.randomUUID();
  const state: TrialState = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : newTrial(identity, articles);
  validateTrial(state, identity, articles);
  console.log(`PRIMARY ${modelRef(opts.primary)} REVIEW ${opts.review ? modelRef(opts.review) : 'none'} REASONING ${identity.reasoningEffort ?? 'provider default'}`);
  console.log(`STATE ${STATE} PROGRESS ${state.next}/${articles.length}`);
  if (opts.dryRun) return;
  if (opts.report && !existsSync(STATE)) throw new Error('No saved trial for this configuration. Use --dry-run to inspect it or run the trial first.');
  if (!existsSync(LEDGER) && (state.next || state.cost?.attempts)) throw new Error(`Missing cost ledger: ${LEDGER}`);

  function checkpoint(value: TrialState): void {
    value.cost = summarizeLedger(readLedger(LEDGER));
    value.usage = value.cost.usage;
    const temporary = `${STATE}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value));
    renameSync(temporary, STATE);
  }

  function reportCost(): void {
    const entries = readLedger(LEDGER);
    if (entries.some((e) => e.sessionId === sessionId)) console.log(costReport(summarizeLedger(entries, sessionId), 'THIS_INVOCATION'));
    console.log(costReport(summarizeLedger(entries)));
    console.log(`COST_LEDGER ${LEDGER}\nCosts use reported tokens and saved standard rates; final provider billing can differ.`);
  }

  if (!opts.report && state.next < articles.length) {
    const llm = createLlmRouter([opts.primary, ...(opts.review ? [opts.review] : [])], process.env, {
      reasoningEffort: opts.reasoningEffort ?? undefined, onCall: ledgerObserver(LEDGER, sessionId),
    });
    mkdirSync(dirname(STATE), { recursive: true });
    // Prevent two terminals from charging for and overwriting the same run.
    const lock = `${STATE}.lock`;
    let fd: number;
    try { fd = openSync(lock, 'wx'); } catch { throw new Error(`Trial is already locked: ${lock}. Remove the lock only if its previous process has stopped.`); }
    try {
      writeFileSync(fd, String(process.pid));
      // Re-read under the lock in case another process finished after our initial read.
      if (existsSync(STATE)) { Object.assign(state, JSON.parse(readFileSync(STATE, 'utf8'))); validateTrial(state, identity, articles); }
      if (!existsSync(LEDGER)) {
        if (state.next || state.cost?.attempts) throw new Error(`Missing cost ledger: ${LEDGER}`);
        writeFileSync(LEDGER, '', { flag: 'wx' });
      }
      checkpoint(state);
      let batches = 0;
      const started = Date.now();
      while (state.next < articles.length && Date.now() - started < opts.budgetMs && batches < opts.maxBatches) {
        const batchStarted = Date.now();
        const chunk = articles.slice(state.next, state.next + CHUNK);
        const t0 = Date.parse(chunk[0]!.at);
        const open = state.events.filter((e) => t0 - Date.parse(e.lastAt) <= HOURS * 3600e3);
        const res = await groupBatch({ language: LANG, articles: chunk, events: open, subjects: state.subjects }, llm, { smallModel: modelRef(opts.primary), midModel: opts.review ? modelRef(opts.review) : null, newKey: () => `k${++state.seq}` });
        state.subjects.push(...res.newSubjects);
        for (const e of res.newEvents) state.events.push({ ...e, lastAt: chunk[0]!.at });
        const byKey = new Map(state.events.map((e) => [e.key, e]));
        res.decisions.forEach((d, i) => { const e = byKey.get(d.eventKey); if (e && chunk[i]!.at > e.lastAt) e.lastAt = chunk[i]!.at; });
        state.decisions.push(...res.decisions);
        state.escalated += res.escalated;
        state.next += chunk.length;
        state.durationMs += Date.now() - batchStarted;
        checkpoint(state);
        batches++;
        console.log(`grouped ${state.next}/${articles.length}, events ${state.events.length}, escalated so far ${state.escalated}`);
      }
    } catch (error) {
      // Keep only committed grouping progress, but include every charged attempt.
      if (existsSync(STATE)) checkpoint(JSON.parse(readFileSync(STATE, 'utf8')) as TrialState);
      reportCost();
      throw error;
    } finally { closeSync(fd); unlinkSync(lock); }
  }

  reportCost();

  {
    const art = new Map(articles.map((a) => [a.id, a]));
    const groups = new Map<string, { label: string; subject: string; places: string; items: Art[] }>();
    for (const d of state.decisions) {
      const g = groups.get(d.eventKey) ?? { label: d.eventLabel, subject: d.subjectLabel, places: (d.places ?? []).map((p) => `${p.name}${p.country && p.kind !== 'country' ? ' ' + p.country : ''}`).join('; ') || '(no place)', items: [] };
      g.items.push(art.get(d.articleId)!);
      groups.set(d.eventKey, g);
    }
    const pubs = (g: { items: Art[] }) => new Set(g.items.map((a) => a.publisher)).size;
    const list = [...groups.values()].sort((a, b) => pubs(b) - pubs(a) || b.items.length - a.items.length);
    const subjects = new Map<string, number>();
    for (const g of list) subjects.set(g.subject, (subjects.get(g.subject) ?? 0) + 1);
    console.log(`STATUS ${state.next >= articles.length ? 'complete' : 'partial'} DURATION_SECONDS ${(state.durationMs / 1000).toFixed(1)}`);
    console.log(`\nARTICLES ${state.decisions.length} EVENTS ${list.length} MULTI_PUBLISHER ${list.filter((g) => pubs(g) > 1).length} SUBJECTS ${subjects.size} MULTI_EVENT_SUBJECTS ${[...subjects.values()].filter((n) => n > 1).length}`);
    console.log(`ESCALATED ${state.escalated} LOW_CONFIDENCE ${state.decisions.filter((d) => d.confidence === 'low').length}`);
    console.log(`EVENTS WITH A PLACE ${list.filter((g) => g.places !== '(no place)').length} of ${list.length}`);
    console.log('\nTOP EVENTS (publishers | articles | event label | places | subject label)');
    for (const g of list.slice(0, 40)) console.log(`${String(pubs(g)).padStart(2)} | ${String(g.items.length).padStart(2)} | ${g.label} | ${g.places} | ${g.subject}`);
    const flagged: Record<string, RegExp> = { palisades: /palisades/i, datacenters: /data cent/i, conference: /(press|news) conference/i, detonation: /detonat|blow up|explosives/i, summit: /putin|\bxi\b/i };
    for (const [name, re] of Object.entries(flagged)) {
      console.log(`\n== ${name}`);
      for (const g of list.filter((x) => x.items.some((a) => re.test(a.headline)))) {
        console.log(` [${pubs(g)} pubs, ${g.items.length} articles] ${g.label}  <subject: ${g.subject}>`);
        for (const a of g.items.slice(0, 12)) console.log(`     ${a.publisher.padEnd(14)} ${a.headline.slice(0, 105)}`);
      }
    }
  }

}

main().catch((e: Error) => { console.error(`[group:trial] ${e.message}`); process.exitCode = 1; });
