export type SparseVec = Map<string, number>;

const EN_STOPWORDS = new Set(
  `a an the and or but if then than so of in on at to from by for with without about into over under after before
   between through during against as is are was were be been being am do does did has have had having will would
   can could should may might must shall it its this that these those he she they them his her their we our you your
   i me my not no nor only own same too very just also more most other some such s t up out off down again further
   here there when where why how all any both each few what which who whom says said say new live latest update
   updates video watch amid`
    .split(/\s+/)
    .filter(Boolean),
);

const HIRAGANA_ONLY = /^[぀-ゟー]+$/;
const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿豈-﫿々]/;
const ALNUM = /[\p{L}\p{N}]/u;

/** Splits text into runs of CJK characters and runs of other letters or digits. */
function scriptRuns(text: string): { cjk: boolean; text: string }[] {
  const runs: { cjk: boolean; text: string }[] = [];
  let current: { cjk: boolean; text: string } | null = null;
  for (const ch of text) {
    const cjk = CJK_CHAR.test(ch);
    if (!cjk && !ALNUM.test(ch)) {
      current = null;
      continue;
    }
    if (!current || current.cjk !== cjk) {
      current = { cjk, text: '' };
      runs.push(current);
    }
    current.text += ch;
  }
  return runs;
}

function japaneseTokens(text: string): string[] {
  const out: string[] = [];
  // Runs of CJK characters become character bigrams; runs of Latin letters or digits stay whole.
  for (const run of scriptRuns(text)) {
    if (!run.cjk) {
      if (run.text.length > 1 || /\d/.test(run.text)) out.push(run.text);
      continue;
    }
    const chars = [...run.text];
    if (chars.length === 1) {
      if (!HIRAGANA_ONLY.test(run.text)) out.push(run.text);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i++) {
      const bigram = chars[i]! + chars[i + 1]!;
      // Bigrams made only of hiragana are grammar, not content.
      if (!HIRAGANA_ONLY.test(bigram)) out.push(bigram);
    }
  }
  return out;
}

function englishTokens(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w && !EN_STOPWORDS.has(w) && (w.length > 1 || /\d/.test(w)));
  const out = [...words];
  for (let i = 0; i < words.length - 1; i++) out.push(`${words[i]} ${words[i + 1]}`);
  return out;
}

/**
 * Tokens for similarity. Input is already normalized (NFKC, lowercase, no punctuation).
 * English: word unigrams and bigrams minus stopwords. Japanese: character bigrams,
 * because Japanese has no whitespace word boundaries.
 */
export function tokenize(text: string, language: string): string[] {
  if (!text) return [];
  return language === 'ja' ? japaneseTokens(text) : englishTokens(text);
}

export function isStopword(word: string): boolean {
  return EN_STOPWORDS.has(word);
}

export class IdfModel {
  readonly df = new Map<string, number>();
  readonly docCount: number;

  constructor(docs: Iterable<string[]>) {
    let n = 0;
    for (const tokens of docs) {
      n += 1;
      for (const t of new Set(tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.docCount = n;
  }

  static fromCorpus(
    corpus: string[],
    language: string,
    tokenizer: (t: string, l: string) => string[] = tokenize,
  ): IdfModel {
    return new IdfModel(corpus.map((doc) => tokenizer(doc, language)));
  }

  idf(term: string): number {
    return Math.log((this.docCount + 1) / ((this.df.get(term) ?? 0) + 1)) + 1;
  }

  /** Share of corpus documents that contain the term. */
  ratio(term: string): number {
    return this.docCount === 0 ? 0 : (this.df.get(term) ?? 0) / this.docCount;
  }
}

export function vectorize(tokens: string[], idf: IdfModel): SparseVec {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const vec: SparseVec = new Map();
  let sumSq = 0;
  for (const [t, c] of tf) {
    const w = (1 + Math.log(c)) * idf.idf(t);
    vec.set(t, w);
    sumSq += w * w;
  }
  const n = Math.sqrt(sumSq);
  if (n > 0) for (const [t, w] of vec) vec.set(t, w / n);
  return vec;
}

export function dot(a: SparseVec, b: SparseVec): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [t, w] of small) {
    const o = large.get(t);
    if (o !== undefined) s += w * o;
  }
  return s;
}

export function norm(v: SparseVec): number {
  let s = 0;
  for (const w of v.values()) s += w * w;
  return Math.sqrt(s);
}

export function cosine(a: SparseVec, b: SparseVec): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

export function addInto(target: SparseVec, v: SparseVec, scale = 1): void {
  for (const [t, w] of v) target.set(t, (target.get(t) ?? 0) + w * scale);
}
