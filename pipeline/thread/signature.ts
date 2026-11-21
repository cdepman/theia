import { pipelineConfig } from '../config';
import { IdfModel, isStopword, tokenize } from '../cluster/features';

/** Distinctive terms of a story or thread, with weights. */
export type Signature = Map<string, number>;

export interface StoryText {
  /** Original headline, as published. */
  h: string;
  /** Normalized headline. */
  n: string;
  /** Feed-provided summary, if any. */
  s: string | null;
}

export interface StorySignature {
  weights: Signature;
  /**
   * Terms that look like names. English: words capitalized mid-sentence. Japanese:
   * rare words and Latin-alphabet tokens. `null` means there was no evidence either way
   * (for example, only title-case headlines and no summaries).
   */
  entities: Set<string> | null;
  /** Terms that appear in very few recent headlines. */
  rare: Set<string>;
}

const HAS_KANJI_OR_KATAKANA = /[゠-ヿ㐀-䶿一-鿿豈-﫿]/;
const NUMERIC = /^[\d\s]+$/;

let jaSegmenter: Intl.Segmenter | null = null;
function segmenter(): Intl.Segmenter {
  jaSegmenter ??= new Intl.Segmenter('ja', { granularity: 'word' });
  return jaSegmenter;
}

function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Candidate signature terms from normalized text.
 * English: content unigrams of three or more letters, and bigrams of content words.
 * Japanese: dictionary word segments that contain kanji or katakana, two or more
 * characters long, plus Latin tokens such as product names.
 */
export function signatureTerms(normalized: string, language: string): string[] {
  if (!normalized) return [];
  if (language === 'ja') {
    const out: string[] = [];
    // Katakana runs are kept whole: the dictionary segmenter splits unfamiliar foreign names.
    const katakanaRuns = normalized.match(/[\u30A0-\u30FF\u30FC]{2,}/g) ?? [];
    out.push(...katakanaRuns);
    const rest = normalized.replace(/[\u30A0-\u30FF\u30FC]+/g, ' ');
    for (const seg of segmenter().segment(rest)) {
      if (!seg.isWordLike) continue;
      const w = seg.segment;
      if (NUMERIC.test(w)) continue;
      if (HAS_KANJI_OR_KATAKANA.test(w)) {
        if ([...w].length >= 2) out.push(w);
      } else if (/^[a-z0-9]+$/.test(w) && w.length >= 2 && /[a-z]/.test(w)) {
        out.push(w);
      }
    }
    return out;
  }
  return tokenize(normalized, language).filter((t) => {
    if (NUMERIC.test(t)) return false;
    const words = t.split(' ');
    if (words.length === 1) return t.length >= 3 && !/^\d/.test(t);
    return words.every((w) => w.length >= 2 && !NUMERIC.test(w) && !isStopword(w));
  });
}

export function signatureDf(corpus: string[], language: string): IdfModel {
  return IdfModel.fromCorpus(corpus, language, signatureTerms);
}

function isSentenceCase(headline: string): boolean {
  const words = headline.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  if (words.length < 4) return false;
  const capitalized = words.filter((w) => /^[A-Z]/.test(w)).length;
  return capitalized / words.length <= 0.6;
}

/** Lowercased words that appear capitalized somewhere other than the start of a sentence. */
export function properWords(texts: StoryText[]): { words: Set<string>; evidence: boolean } {
  const words = new Set<string>();
  let evidence = false;
  const scan = (text: string) => {
    for (const sentence of text.split(/(?<=[.!?:;])\s+|\s[–—|]\s/)) {
      const tokens = sentence.split(/\s+/).filter(Boolean);
      tokens.forEach((raw, i) => {
        const tok = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/[‘’']s$/i, '');
        if (!tok) return;
        const isCap = /^[A-Z][\p{L}\p{N}’'-]*$/u.test(tok);
        if (isCap && i > 0) words.add(normalizeText(tok));
        // An acronym is a name wherever it stands.
        if (/^[A-Z]{2,}$/.test(tok)) words.add(tok.toLowerCase());
      });
    }
  };
  for (const t of texts) {
    if (t.s) {
      evidence = true;
      scan(t.s);
    }
    if (isSentenceCase(t.h)) {
      evidence = true;
      scan(t.h);
    }
  }
  words.delete('');
  return { words, evidence };
}

/**
 * The signature of one story: its most distinctive terms.
 * Weight = sqrt(share of member articles containing the term, summary-only mentions
 * counting half) x clipped IDF x name boost.
 * Terms present in more than `commonTermRatio` of recent headlines are excluded.
 */
export function storySignature(
  texts: StoryText[],
  language: string,
  df: IdfModel,
  config = pipelineConfig.thread,
): StorySignature {
  // A term in a headline counts fully; a term found only in the summary counts half.
  const counts = new Map<string, number>();
  for (const t of texts) {
    const inHeadline = new Set(signatureTerms(t.n, language));
    for (const term of inHeadline) counts.set(term, (counts.get(term) ?? 0) + 1);
    if (t.s) {
      for (const term of new Set(signatureTerms(normalizeText(t.s), language))) {
        if (!inHeadline.has(term)) counts.set(term, (counts.get(term) ?? 0) + 0.5);
      }
    }
  }

  const guard = df.docCount >= config.minCorpusForGuard;
  const proper = language === 'ja' ? null : properWords(texts);
  const entities = new Set<string>();
  const rare = new Set<string>();
  const scored: [string, number][] = [];

  for (const [term, count] of counts) {
    const ratio = df.ratio(term);
    if (guard && ratio > config.commonTermRatio) continue;
    let isEntity: boolean;
    if (language === 'ja') {
      // Katakana alone is not evidence of a name (many are ordinary loanwords), so rarity decides.
      isEntity = /^[a-z0-9]+$/.test(term) || !guard || ratio <= config.rareTermRatio;
    } else {
      isEntity = term.split(' ').every((w) => proper!.words.has(w));
    }
    if (isEntity) entities.add(term);
    if (!guard || ratio <= config.rareTermRatio) rare.add(term);
    const weight =
      Math.sqrt(count / texts.length) * Math.min(df.idf(term), 7) * (isEntity ? config.properNounBoost : 1);
    scored.push([term, weight]);
  }

  scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const weights: Signature = new Map(scored.slice(0, config.storySignatureSize));
  const kept = new Set([...entities].filter((t) => weights.has(t)));
  const known = language === 'ja' ? true : proper!.evidence;
  return { weights, entities: known ? kept : null, rare: new Set([...rare].filter((t) => weights.has(t))) };
}

/**
 * Shared terms that are independent of each other. "north korea", "north" and "korea"
 * are one piece of evidence, not three.
 */
export function independentShared(a: Signature, b: Signature): string[] {
  const shared = [...a.keys()]
    .filter((t) => b.has(t))
    .sort((x, y) => y.length - x.length || x.localeCompare(y));
  const out: string[] = [];
  for (const term of shared) {
    const words = term.split(' ');
    const dependent = out.some(
      (o) => o.includes(term) || term.includes(o) || o.split(' ').some((w) => words.includes(w)),
    );
    if (!dependent) out.push(term);
  }
  return out;
}

export function signatureCosine(a: Signature, b: Signature): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (const [t, w] of a) {
    na += w * w;
    const o = b.get(t);
    if (o !== undefined) d += w * o;
  }
  for (const w of b.values()) nb += w * w;
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
}

/** Folds a story's signature into a thread's, letting older terms fade without dropping the core. */
export function mergeSignature(thread: Signature, story: Signature, config = pipelineConfig.thread): Signature {
  const merged = new Map<string, number>();
  for (const [t, w] of thread) merged.set(t, w * config.signatureDecay);
  for (const [t, w] of story) merged.set(t, (merged.get(t) ?? 0) + w);
  const top = [...merged.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return new Map(top.slice(0, config.threadSignatureSize));
}

export function signatureToJson(sig: Signature): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [t, w] of sig) out[t] = Number(w.toFixed(3));
  return out;
}

export function signatureFromJson(obj: Record<string, number> | null | undefined): Signature {
  return new Map(Object.entries(obj ?? {}).map(([t, w]) => [t, Number(w)]));
}

/** A deterministic label for navigation and audit. Never shown as a headline. */
export function threadLabel(sig: Signature): string {
  return [...sig.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([t]) => t)
    .join(' · ');
}
