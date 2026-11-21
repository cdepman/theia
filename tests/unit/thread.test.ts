import { describe, expect, it } from 'vitest';
import { IdfModel } from '../../pipeline/cluster/features';
import { buildRegistry } from '../../pipeline/jobs/registry';
import { normalizeHeadline } from '../../pipeline/normalize/headline';
import {
  independentShared, mergeSignature, properWords, signatureCosine, signatureDf, signatureTerms, storySignature, threadLabel,
} from '../../pipeline/thread/signature';
import { buildSignatures, decideLink, planThreads, type ThreadingStory } from '../../pipeline/thread/thread';
import { fillerItems } from '../helpers/db';

const text = (h: string, s: string | null = null) => ({ h, n: normalizeHeadline(h), s });
const background = fillerItems(30, '2026-11-01T00:00:00Z').map((i) => normalizeHeadline(i.title));

function df(extra: string[]): IdfModel {
  return signatureDf([...background, ...extra.map((h) => normalizeHeadline(h))], 'en');
}

describe('signature terms', () => {
  it('keeps content words and bigrams, drops numbers and stopwords', () => {
    const terms = signatureTerms('regulator opens inquiry into kestrel dynamics accounts 2026', 'en');
    expect(terms).toContain('kestrel dynamics');
    expect(terms).toContain('regulator');
    expect(terms).not.toContain('into');
    expect(terms).not.toContain('2026');
  });

  it('segments Japanese into words and keeps katakana names whole', () => {
    const terms = signatureTerms('ゼレンスキー大統領がプーチン氏を批判 kddiも発表', 'ja');
    expect(terms).toContain('ゼレンスキー');
    expect(terms).toContain('プーチン');
    expect(terms).toContain('大統領');
    expect(terms).toContain('kddi');
    expect(terms.every((t) => [...t].length >= 2)).toBe(true);
  });

  it('finds names from sentence-case text only', () => {
    const fromSummary = properWords([text('KESTREL CHIEF RESIGNS', 'Shares fell after Mara Voss left Kestrel Dynamics on Monday.')]);
    expect(fromSummary.evidence).toBe(true);
    expect([...fromSummary.words]).toEqual(expect.arrayContaining(['mara', 'voss', 'kestrel', 'dynamics', 'monday']));
    expect(fromSummary.words.has('shares')).toBe(false);
    // A title-case headline with no summary gives no evidence either way.
    expect(properWords([text('Kestrel Dynamics Chief Mara Voss Resigns After Audit')]).evidence).toBe(false);
  });
});

describe('independent shared terms', () => {
  it('counts a name once however many of its parts match', () => {
    const a = new Map([['north korea', 1], ['north', 1], ['korea', 1], ['missile', 1]]);
    const b = new Map([['north korea', 1], ['korea', 1], ['north', 1], ['missile', 1], ['seoul', 1]]);
    expect(independentShared(a, b)).toEqual(['north korea', 'missile']);
  });
});

describe('link decisions', () => {
  const headlines = [
    'Kestrel Dynamics chief Mara Voss resigns after audit',
    'Regulator opens inquiry into Kestrel Dynamics accounts',
    'Mara Voss gives lecture on corporate governance',
    'Voss family opens bakery in Leeds',
  ];
  const model = df(headlines);
  const sig = (h: string, s: string) => storySignature([text(h, s)], 'en', model);

  const resignation = sig(headlines[0]!, 'Mara Voss stepped down as chief executive of Kestrel Dynamics after an audit.');

  it('links a later development that shares two distinct names', () => {
    const inquiry = sig(headlines[1]!, 'The regulator opened an inquiry into Kestrel Dynamics days after Mara Voss resigned.');
    const d = decideLink(inquiry, resignation.weights, 'en');
    expect(d.link).toBe(true);
    expect(d.shared.length).toBeGreaterThanOrEqual(2);
  });

  it('does not link on one shared name', () => {
    const bakery = sig(headlines[3]!, 'The Voss family opened a bakery in Leeds on Saturday.');
    const d = decideLink(bakery, resignation.weights, 'en');
    expect(d.link).toBe(false);
    expect(d.shared.length).toBeLessThan(2);
  });

  it('needs three shared terms when names cannot be told apart from ordinary words', () => {
    const noEvidence = storySignature([text('Kestrel Dynamics Faces Inquiry Into Accounts')], 'en', model);
    expect(noEvidence.entities).toBeNull();
    const thread = new Map([['kestrel', 5], ['inquiry', 3], ['voss', 4]]);
    expect(decideLink(noEvidence, thread, 'en').link).toBe(false);
    const richer = new Map([['kestrel', 5], ['inquiry', 3], ['accounts', 3]]);
    expect(decideLink(noEvidence, richer, 'en').link).toBe(true);
  });

  it('merges signatures so a thread follows its subject without forgetting its core', () => {
    const merged = mergeSignature(new Map([['kestrel dynamics', 10], ['audit', 4]]), new Map([['kestrel dynamics', 9], ['inquiry', 6]]));
    expect([...merged.keys()][0]).toBe('kestrel dynamics');
    expect(merged.get('audit')).toBeCloseTo(2.8);
    expect(merged.has('inquiry')).toBe(true);
    expect(signatureCosine(merged, merged)).toBeCloseTo(1);
    expect(threadLabel(merged)).toBe('kestrel dynamics · inquiry · audit');
  });
});

describe('thread planning', () => {
  const story = (id: string, at: string, h: string, s: string, threadId: string | null = null): ThreadingStory => ({ id, threadId, firstSeenAt: at, lastSeenAt: at, texts: [text(h, s)] });
  const stories = [
    story('s1', '2026-11-01T08:00:00Z', 'Kestrel Dynamics chief Mara Voss resigns after audit', 'Mara Voss stepped down as chief executive of Kestrel Dynamics after an audit.'),
    story('s2', '2026-11-05T08:00:00Z', 'Regulator opens inquiry into Kestrel Dynamics accounts', 'The regulator opened an inquiry into Kestrel Dynamics days after Mara Voss resigned.'),
    story('s3', '2026-11-05T09:00:00Z', 'Storm warning issued for the north coast', 'Forecasters warned of strong winds along the coast.'),
  ];
  const model = df(stories.flatMap((s) => s.texts.map((t) => t.h)));

  it('gives every story exactly one thread and links related stories within a batch', () => {
    const plan = planThreads({ language: 'en', stories, candidates: [], signatures: buildSignatures(stories, 'en', model) });
    expect(plan.evaluated.sort()).toEqual(['s1', 's2', 's3']);
    expect(plan.links).toHaveLength(3);
    const byStory = new Map(plan.links.map((l) => [l.storyId, l]));
    expect(byStory.get('s1')).toMatchObject({ method: 'new_thread' });
    expect(byStory.get('s2')).toMatchObject({ method: 'signature', threadKey: byStory.get('s1')!.threadKey });
    expect(byStory.get('s3')).toMatchObject({ method: 'new_thread' });
    expect(plan.newThreads).toHaveLength(2);
  });

  it('links to an existing thread offered by the database and updates its signature', () => {
    const signatures = buildSignatures(stories, 'en', model);
    const existing = Object.fromEntries(signatures.get('s1')!.weights);
    const plan = planThreads({
      language: 'en',
      stories: [stories[1]!],
      signatures,
      candidates: [{ storyId: 's2', threadId: 'thread-1', signature: existing, lastSeenAt: '2026-11-01T08:00:00Z', dormant: false, storyCount: 1 }],
    });
    expect(plan.links).toEqual([expect.objectContaining({ storyId: 's2', threadId: 'thread-1', method: 'signature' })]);
    expect(plan.newThreads).toEqual([]);
    expect(plan.threadUpdates).toEqual([expect.objectContaining({ threadId: 'thread-1' })]);
    // The thread's signature now also carries what the new story added.
    const added = [...signatures.get('s2')!.weights.keys()].filter((k) => !(k in existing));
    expect(added.length).toBeGreaterThan(0);
    expect(Object.keys(plan.threadUpdates[0]!.signature)).toEqual(expect.arrayContaining(added));
  });
});

describe('source registry', () => {
  const candidates = {
    publishers: [
      { id: 'one', country: 'US', name: 'One', domain: 'www.one.example', language: 'en', format: 'wire service', termsStatus: 'personal_rss_conditional', feeds: [{ url: 'https://one.example/a.xml', section: 'headlines' }, { url: 'https://one.example/b.xml', section: 'technology' }] },
      { id: 'two', country: 'JP', name: 'Two', domain: 'two.example', language: 'ja', termsStatus: 'unverified', feeds: [{ url: 'https://two.example/a.xml', section: 'headlines' }] },
    ],
  };

  it('enables only publishers the owner lists, and records the rest as disabled', () => {
    const reg = buildRegistry(candidates, { enabledPublishers: ['one'], excludedFeeds: [{ url: 'https://one.example/b.xml' }] });
    expect(reg.publishers.map((p) => [p.slug, p.enabled])).toEqual([['one', true], ['two', false]]);
    expect(reg.publishers[0]).toMatchObject({ domain: 'one.example', isWire: true });
    expect(reg.publishers[0]!.feeds.map((f) => [f.sourceKey, f.enabled, f.defaultCategory])).toEqual([
      ['rss:one:headlines', true, null],
      ['rss:one:technology', false, 'technology'],
    ]);
    expect(reg.publishers[1]!.feeds[0]!.enabled).toBe(false);
  });

  it('rejects an activation file that names an unknown publisher', () => {
    expect(() => buildRegistry(candidates, { enabledPublishers: ['nope'] })).toThrow(/unknown publishers/);
  });
});
