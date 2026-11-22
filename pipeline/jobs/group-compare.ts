// Compare two complete trial files without API calls. Legacy A/B paths remain the default.
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { articleDigest, type TrialArticle, type TrialIdentity } from '../group/trial';
import { combineCosts, costReport, readLedger, summarizeLedger, type CostSummary } from '../llm/ledger';
import { scoreLabeledPairs, type LabeledPair } from '../group/evaluate';

function main(): void {

  const { positionals, values } = parseArgs({ allowPositionals: true, options: { pairs: { type: 'string' } } });
  const LANG = positionals[0] ?? 'en';
  const SNAP = Date.parse('2026-11-21T10:00:00Z');
  interface Art { id: string; publisher: string; headline: string }
  interface Dec { articleId: string; eventKey: string; eventLabel: string; subjectKey: string; confidence: string; model: string; escalated: boolean }
  interface Run { identity?: TrialIdentity; grouper?: string; next?: number; durationMs?: number; decisions: Dec[]; usage: Record<string, { input: number; output: number; calls: number; estimatedCostUsd?: number | null }>; escalated: number; cost?: CostSummary; articles?: TrialArticle[]; reviewAudit?: { baseCost: CostSummary } }

  const candidates = JSON.parse(readFileSync('config/source-candidates.json', 'utf8')).publishers as { id: string; language: string; feeds: { url: string }[] }[];
  const probe = JSON.parse(readFileSync('docs/evidence/rss-probe-final.json', 'utf8')).feeds as { requestedUrl: string; articles?: { headline: string; url: string; publishedAt: string | null; futureDated: boolean }[] }[];
  const byUrl = new Map<string, { id: string; language: string }>();
  for (const p of candidates) for (const f of p.feeds) byUrl.set(f.url, p);
  const art = new Map<string, Art>();
  for (const f of probe) {
    const p = byUrl.get(f.requestedUrl);
    if (!p || p.language !== LANG) continue;
    for (const a of f.articles ?? []) if (a.publishedAt && !a.futureDated && !art.has(a.url) && SNAP - Date.parse(a.publishedAt) >= 0) art.set(a.url, { id: a.url, publisher: p.id, headline: a.headline });
  }

  const load = (file: string): Run | null => {
    if (!existsSync(file)) return null;
    const run = JSON.parse(readFileSync(file, 'utf8')) as Run;
    if (run.identity?.accountingVersion) {
      const ledger = `${file}.calls.jsonl`;
      if (!existsSync(ledger)) throw new Error(`Missing cost ledger: ${ledger}`);
      run.cost = summarizeLedger(readLedger(ledger));
      if (run.identity.postReview) {
        if (!run.reviewAudit) throw new Error('Reviewed trial is missing its initial-pass cost');
        run.cost = combineCosts(run.reviewAudit.baseCost, run.cost);
      }
    }
    return run;
  };
  const pathA = positionals[1] ?? `scratch/llm-trial-${LANG}.json`;
  const pathB = positionals[2] ?? `scratch/llm-trial-${LANG}-small.json`;
  if (!['en', 'ja'].includes(LANG) || Boolean(positionals[1]) !== Boolean(positionals[2]) || positionals.length > 3) {
    throw new Error('Usage: group:compare -- [en|ja] [RUN_A.json RUN_B.json] [--pairs FIXTURE.json]');
  }
  const A = load(pathA);
  const B = load(pathB);
  if (!A || !B) throw new Error(`Need both saved runs: ${pathA} and ${pathB}`);
  console.log(`A: ${pathA}\nB: ${pathB}`);
  if (!A.identity || !B.identity) console.log('Legacy run: dataset and prompt identity cannot be fully verified.');
  if (A.articles && B.articles) art.clear();
  for (const run of [A, B]) {
    if (run.identity && (run.identity.language !== LANG || run.decisions.length !== run.identity.articleCount)) throw new Error('Comparison requires complete runs in the selected language');
    if (run.articles) {
      if (run.identity?.datasetHash !== articleDigest(run.articles)) throw new Error('Saved headlines do not match the trial dataset hash');
      for (const article of run.articles) art.set(article.id, article);
    }
  }
  if (A.identity && B.identity && (A.identity.datasetHash !== B.identity.datasetHash || A.identity.grouper !== B.identity.grouper || A.identity.batchSize !== B.identity.batchSize)) {
    throw new Error('Comparison requires the same ordered dataset, prompt version, and batch size');
  }
  const idsA = new Set(A.decisions.map((d) => d.articleId));
  if (idsA.size !== A.decisions.length || B.decisions.length !== A.decisions.length || new Set(B.decisions.map((d) => d.articleId)).size !== B.decisions.length || B.decisions.some((d) => !idsA.has(d.articleId))) {
    throw new Error('Comparison requires the same distinct headline IDs in both runs');
  }
  const PRICE: Record<string, [number, number]> = { 'claude-haiku-5-5': [0.1, 0.5], 'claude-sonnet-5-5': [2, 10] };

  function shape(run: Run) {
    const eventOf = new Map(run.decisions.map((d) => [d.articleId, d.eventKey]));
    const labelOf = new Map(run.decisions.map((d) => [d.eventKey, d.eventLabel]));
    const members = new Map<string, string[]>();
    for (const d of run.decisions) members.set(d.eventKey, [...(members.get(d.eventKey) ?? []), d.articleId]);
    const pubs = (k: string) => new Set(members.get(k)!.map((id) => art.get(id)?.publisher)).size;
    let cost: number | null = 0;
    for (const [m, u] of Object.entries(run.usage)) {
      const estimate = u.estimatedCostUsd !== undefined ? u.estimatedCostUsd : PRICE[m] ? (u.input * PRICE[m]![0] + u.output * PRICE[m]![1]) / 1e6 : null;
      cost = cost === null || estimate === null ? null : cost + estimate;
    }
    if (run.cost) cost = run.cost.calculatedCostUsd;
    return { eventOf, labelOf, members, pubs, cost, subjects: new Set(run.decisions.map((d) => d.subjectKey)).size };
  }
  const a = shape(A), b = shape(B);
  const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
  const row = (name: string, x: ReturnType<typeof shape>, run: Run) =>
    `${name.padEnd(22)} events ${String(x.members.size).padStart(4)}  multi-publisher ${String([...x.members.keys()].filter((k) => x.pubs(k) > 1).length).padStart(3)}  subjects ${String(x.subjects).padStart(4)}  escalated ${String(run.escalated).padStart(3)}  low-confidence ${String(run.decisions.filter((d) => d.confidence === 'low').length).padStart(3)}  calculated cost ${x.cost === null ? 'unknown' : '$' + x.cost.toFixed(6)}  seconds ${run.durationMs === undefined ? 'unknown' : (run.durationMs / 1000).toFixed(1)}`;
  console.log(`HEADLINES ${A.decisions.length} (A) / ${B.decisions.length} (B)\n`);
  console.log(row('A', a, A));
  console.log(row('B', b, B));
  if (A.cost) console.log(costReport(A.cost, 'A'));
  if (B.cost) console.log(costReport(B.cost, 'B'));
  console.log('Costs are calculated from reported usage, not provider invoices. Legacy runs exclude unsaved/failed calls.');

  // 1. Labeled pairs: the only ground truth here. Labeled by hand before either run.
  const fixtureFile = values.pairs ?? 'tests/fixtures/cluster-pairs.json';
  console.log(`PAIR_FIXTURE ${fixtureFile}`);
  const fixture = (JSON.parse(readFileSync(fixtureFile, 'utf8')).pairs as LabeledPair[]).filter((p) => p.language === LANG);
  const la = scoreLabeledPairs(a.eventOf, [...art.values()], fixture), lb = scoreLabeledPairs(b.eventOf, [...art.values()], fixture);
  console.log(`\nLABELED PAIRS (hand-labeled; ${la.sameTotal} "same event" and ${la.diffTotal} "different" pairs fall inside this window)`);
  console.log(`A  same-event pairs grouped together ${la.sameHit}/${la.sameTotal} (${pct(la.sameHit, la.sameTotal)})   different pairs kept apart ${la.diffHit}/${la.diffTotal}`);
  console.log(`B  same-event pairs grouped together ${lb.sameHit}/${lb.sameTotal} (${pct(lb.sameHit, lb.sameTotal)})   different pairs kept apart ${lb.diffHit}/${lb.diffTotal}`);
  console.log(`Unavailable/ambiguous labeled pairs: ${la.unavailable} (A), ${lb.unavailable} (B). Labels were made by the build agent, not the owner.`);
  const onlyA = la.misses.filter((m) => !lb.misses.includes(m)), onlyB = lb.misses.filter((m) => !la.misses.includes(m));
  console.log(` wrong in A only: ${onlyA.length}   wrong in B only: ${onlyB.length}   wrong in both: ${la.misses.length - onlyA.length}`);
  for (const m of onlyA.slice(0, 8)) console.log(' A' + m);
  for (const m of onlyB.slice(0, 8)) console.log(' B' + m);

  // 2. How much the two groupings agree, pair by pair.
  function pairs(x: ReturnType<typeof shape>, y: ReturnType<typeof shape>, only?: Set<string>) {
    let total = 0, kept = 0;
    for (const ids of x.members.values()) {
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        if (only && !only.has(ids[i]!) && !only.has(ids[j]!)) continue;
        total++;
        if (y.eventOf.get(ids[i]!) === y.eventOf.get(ids[j]!)) kept++;
      }
    }
    return { total, kept };
  }
  const esc = new Set(A.decisions.filter((d) => d.escalated).map((d) => d.articleId));
  const ab = pairs(a, b), ba = pairs(b, a), abE = pairs(a, b, esc), baE = pairs(b, a, esc);
  console.log(`\nAGREEMENT (pairs of headlines placed in the same event)`);
  console.log(` pairs A groups together: ${ab.total}, of which B also does: ${ab.kept} (${pct(ab.kept, ab.total)})`);
  console.log(` pairs B groups together: ${ba.total}, of which A also does: ${ba.kept} (${pct(ba.kept, ba.total)})`);
  console.log(` same, counting only pairs that involve a headline the review model handled in A: A->B ${abE.kept}/${abE.total} (${pct(abE.kept, abE.total)}), B->A ${baE.kept}/${baE.total} (${pct(baE.kept, baE.total)})`);

  // 3. The sets flagged in the screenshot.
  const flagged: Record<string, RegExp> = { palisades: /palisades/i, datacenters: /data cent/i, conference: /(press|news) conference/i, detonation: /detonat|blow up|explosives/i, summit: /\bsummit\b.*(putin|xi)|(putin|xi).*\bsummit\b/i };
  console.log(`\nFLAGGED SETS (events holding a matching headline: publishers in each)`);
  for (const [name, re] of Object.entries(flagged)) {
    const sizes = (x: ReturnType<typeof shape>) => [...x.members.entries()].filter(([, ids]) => ids.some((id) => re.test(art.get(id)?.headline ?? ''))).map(([k]) => x.pubs(k)).sort((p, q) => q - p).join(', ');
    console.log(` ${name.padEnd(12)} A: ${sizes(a).padEnd(22)} B: ${sizes(b)}`);
  }

  // 4. Where they differ, for a human to judge. Largest differences first.
  const co = (x: ReturnType<typeof shape>, id: string) => new Set(x.members.get(x.eventOf.get(id)!)!);
  const diffs = A.decisions.map((d) => {
    const ca = co(a, d.articleId), cb = co(b, d.articleId);
    const moved = [...ca].filter((i) => !cb.has(i)).length + [...cb].filter((i) => !ca.has(i)).length;
    return { id: d.articleId, moved, ca: ca.size, cb: cb.size };
  }).filter((x) => x.moved > 0 && b.eventOf.has(x.id));
  console.log(`\nHEADLINES WHOSE GROUP DIFFERS: ${diffs.length} of ${A.decisions.length} (${esc.size} were handled by the review model in A; ${diffs.filter((x) => esc.has(x.id)).length} of the differing ones were)`);
  console.log(' headline | A: event (articles) | B: event (articles)');
  const seen = new Set<string>();
  for (const x of diffs.sort((p, q) => q.moved - p.moved)) {
    const key = a.eventOf.get(x.id)! + '|' + b.eventOf.get(x.id)!;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(` ${art.get(x.id)!.headline.slice(0, 70).padEnd(70)} | ${a.labelOf.get(a.eventOf.get(x.id)!)!.slice(0, 34)} (${x.ca}) | ${b.labelOf.get(b.eventOf.get(x.id)!)!.slice(0, 34)} (${x.cb})`);
    if (seen.size >= 30) break;
  }

}
try { main(); } catch (e) { console.error(`[group:compare] ${(e as Error).message}`); process.exitCode = 1; }
