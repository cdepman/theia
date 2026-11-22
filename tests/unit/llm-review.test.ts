import { describe, expect, it } from 'vitest';
import { applyReview, reviewRequest, type ReviewGroup } from '../../pipeline/group/review';
import type { Decision } from '../../pipeline/group/llm';
import { combineCosts, summarizeLedger } from '../../pipeline/llm/ledger';

const decisions: Decision[] = ['a', 'b', 'c'].map((id, i) => ({ articleId: id, eventKey: i < 2 ? 'mixed' : 'bridge',
  eventLabel: i < 2 ? 'Bridge and election' : 'Bridge opens', subjectKey: 's' + i, subjectLabel: 'Subject ' + i,
  category: 'other', places: [], confidence: 'high', model: 'openai:gpt-6-luna', escalated: false }));
const group = (articles: number[], label = 'Bridge opens'): ReviewGroup => ({ articles, label, subjectLabel: label, category: 'other', places: [], sure: true });
const model = 'anthropic:claude-haiku-5-5';

describe('whole-event correction review', () => {
  it('can split a mixed event and merge its article into a duplicate event, conserving every article', () => {
    const original = structuredClone(decisions);
    const result = applyReview(decisions, { changes: [{ events: [0, 1], reason: 'Separate election from bridge opening',
      groups: [group([0, 2]), group([1], 'Election result')] }] }, model);
    expect(decisions).toEqual(original);
    expect(result.decisions.map((d) => d.articleId)).toEqual(['a', 'b', 'c']);
    expect(result.decisions[0]!.eventKey).toBe(result.decisions[2]!.eventKey);
    expect(result.decisions[0]!.eventKey).not.toBe(result.decisions[1]!.eventKey);
    expect(result.decisions[1]).toMatchObject({ eventLabel: 'Election result', model, escalated: true });
    expect(result.changedArticles).toBe(3);
  });

  it('preserves untouched judgments and supports label-only repairs', () => {
    expect(applyReview(decisions, { changes: [] }, model).decisions).toEqual(decisions);
    const result = applyReview(decisions, { changes: [{ events: [1], reason: 'Correct name', groups: [group([2], 'Correct bridge name')] }] }, model);
    expect(result.decisions.slice(0, 2)).toEqual(decisions.slice(0, 2));
    expect(result.decisions[2]!.eventLabel).toBe('Correct bridge name');
  });

  it.each([
    { events: [0], reason: 'missing', groups: [group([0])] },
    { events: [0], reason: 'duplicate', groups: [group([0, 1]), group([1])] },
    { events: [0], reason: 'outside', groups: [group([0, 1, 2])] },
    { events: [0], reason: 'invented', groups: [group([0, 1, 99])] },
    { events: [99], reason: 'unknown event', groups: [group([0])] },
    { events: [-1], reason: 'negative event ID', groups: [group([0])] },
    { events: [0], reason: 'empty', groups: [] },
    { events: [0], reason: 'empty label', groups: [group([0, 1], '')] },
  ])('rejects an unsafe replacement: $reason', (change) => {
    expect(() => applyReview(decisions, { changes: [change] }, model)).toThrow(/Review correction/);
    expect(decisions[0]!.eventKey).toBe('mixed');
  });

  it('rejects overlapping corrections before applying any of them', () => {
    const change = { events: [0], reason: 'test', groups: [group([0, 1])] };
    expect(() => applyReview(decisions, { changes: [change, change] }, model)).toThrow(/overlapping/);
    expect(() => applyReview(decisions, null, model)).toThrow(/changes array/);
  });

  it('gives the reviewer actual member headlines and original event IDs', () => {
    const articles = decisions.map((d, i) => ({ id: d.articleId, publisher: 'paper', headline: 'Headline ' + i, country: 'US', at: '2026-11-22' }));
    const request = reviewRequest(articles, decisions, model);
    const data = JSON.parse(request.user);
    expect(data.events.map((e: { articles: number[] }) => e.articles)).toEqual([[0, 1], [2]]);
    expect(data.articles[1]).toMatchObject({ id: 1, headline: 'Headline 1' });
    expect(request.maxTokens).toBe(32000);
    // Raw Claude JSON schemas reject numeric minimum/maximum constraints with HTTP 400.
    expect(JSON.stringify(request.schema)).not.toMatch(/"(?:minimum|maximum|minLength|maxLength)":/);
    expect(() => reviewRequest(articles.slice(1), decisions, model)).toThrow(/same ordered/);
  });

  it('adds review cost to the initial pass and preserves unknown charges', () => {
    const first = summarizeLedger([]), second = summarizeLedger([]);
    first.calculatedCostUsd = first.knownCostUsd = .05;
    second.calculatedCostUsd = second.knownCostUsd = .01;
    expect(combineCosts(first, second).calculatedCostUsd).toBeCloseTo(.06);
    second.calculatedCostUsd = null; second.unknownCostAttempts = 1;
    expect(combineCosts(first, second)).toMatchObject({ calculatedCostUsd: null, knownCostUsd: .060000000000000005, unknownCostAttempts: 1 });
    expect(first.knownCostUsd).toBe(.05);
  });
});
