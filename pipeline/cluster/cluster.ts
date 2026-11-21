import { CLUSTER_VERSION, pipelineConfig } from '../config';
import { addInto, cosine, dot, IdfModel, norm, type SparseVec, tokenize, vectorize } from './features';

export interface ClusterArticle {
  id: string;
  publisherId: string;
  headline: string; // normalized headline
  summary: string | null;
  effectiveAt: string;
}

export interface OpenStory {
  id: string;
  lastSeenAt: string;
  members: ClusterArticle[];
}

export interface ClusteringInput {
  language: string;
  storyWindowHours: number;
  unassigned: ClusterArticle[];
  openStories: OpenStory[];
  corpus: string[];
}

export interface Assignment {
  article_id: string;
  story_id: string | null;
  story_key: string | null;
  similarity: number | null;
  method: 'centroid' | 'new_story';
}

export interface ClusteringResult {
  clusterVersion: number;
  newStoryKeys: string[];
  assignments: Assignment[];
  syndication: string[][];
}

interface Member {
  id: string;
  publisherId: string;
  time: number;
  headVec: SparseVec;
}

interface StoryState {
  id: string | null;
  key: string | null;
  lastSeen: number;
  headSum: SparseVec;
  fullSum: SparseVec;
  hasFull: boolean;
  members: Member[];
}

interface Vectors {
  head: SparseVec;
  full: SparseVec | null;
}

function normalizeSummary(summary: string | null): string {
  if (!summary) return '';
  return summary
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function articleVectors(article: { headline: string; summary: string | null }, language: string, idf: IdfModel): Vectors {
  const headTokens = tokenize(article.headline, language);
  const head = vectorize(headTokens, idf);
  const summary = normalizeSummary(article.summary);
  if (!summary) return { head, full: null };
  // Headline terms are counted twice so they outweigh summary terms.
  const full = vectorize([...headTokens, ...headTokens, ...tokenize(summary, language)], idf);
  return { head, full };
}

/** Similarity between an article and a story centroid (the mean of its member vectors). */
function similarity(v: Vectors, story: StoryState, headlineWeight: number): number {
  const headNorm = norm(story.headSum);
  const headSim = headNorm > 0 ? dot(v.head, story.headSum) / headNorm : 0;
  if (!v.full || !story.hasFull) return headSim;
  const fullNorm = norm(story.fullSum);
  const fullSim = fullNorm > 0 ? dot(v.full, story.fullSum) / fullNorm : 0;
  return headlineWeight * headSim + (1 - headlineWeight) * fullSim;
}

function addMember(story: StoryState, article: ClusterArticle, v: Vectors, time: number): void {
  addInto(story.headSum, v.head);
  addInto(story.fullSum, v.full ?? v.head);
  if (v.full) story.hasFull = true;
  story.members.push({ id: article.id, publisherId: article.publisherId, time, headVec: v.head });
  if (time > story.lastSeen) story.lastSeen = time;
}

/**
 * Deterministic clustering within one language.
 *
 * Each unassigned article, oldest first, joins the open story whose centroid it is
 * most similar to, provided the similarity meets the language threshold and the
 * article falls within the story window of that story's latest article. Otherwise
 * it starts a new story. Matching against a centroid, not against any single
 * member, resists the chaining that single-link matching produces.
 */
export function clusterArticles(input: ClusteringInput, config = pipelineConfig): ClusteringResult {
  const { language } = input;
  const threshold = config.cluster.thresholds[language] ?? config.cluster.defaultThreshold;
  const windowMs = input.storyWindowHours * 3600 * 1000;

  const corpus = [...input.corpus];
  for (const a of input.unassigned) corpus.push(a.headline);
  const idf = IdfModel.fromCorpus(corpus, language);

  const stories: StoryState[] = [];
  const index = new Map<string, Set<number>>();
  const indexStory = (i: number, vec: SparseVec) => {
    for (const term of vec.keys()) {
      let set = index.get(term);
      if (!set) index.set(term, (set = new Set()));
      set.add(i);
    }
  };

  for (const s of input.openStories) {
    const state: StoryState = {
      id: s.id,
      key: null,
      lastSeen: new Date(s.lastSeenAt).getTime(),
      headSum: new Map(),
      fullSum: new Map(),
      hasFull: false,
      members: [],
    };
    for (const m of s.members.slice(0, config.cluster.maxMembersPerStory)) {
      const v = articleVectors(m, language, idf);
      addMember(state, m, v, new Date(m.effectiveAt).getTime());
    }
    state.lastSeen = Math.max(state.lastSeen, new Date(s.lastSeenAt).getTime());
    stories.push(state);
    indexStory(stories.length - 1, state.headSum);
  }

  const ordered = [...input.unassigned].sort(
    (a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.id.localeCompare(b.id),
  );

  const assignments: Assignment[] = [];
  const newStoryKeys: string[] = [];
  const pairs: [string, string][] = [];

  for (const article of ordered) {
    const time = new Date(article.effectiveAt).getTime();
    const v = articleVectors(article, language, idf);

    const candidates = new Set<number>();
    for (const term of v.head.keys()) {
      const set = index.get(term);
      if (set) for (const i of set) candidates.add(i);
    }

    let bestIdx = -1;
    let bestSim = 0;
    for (const i of [...candidates].sort((a, b) => a - b)) {
      const story = stories[i]!;
      if (Math.abs(time - story.lastSeen) > windowMs) continue;
      const sim = similarity(v, story, config.cluster.headlineWeight);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    let story: StoryState;
    if (bestIdx >= 0 && bestSim >= threshold) {
      story = stories[bestIdx]!;
      assignments.push({
        article_id: article.id,
        story_id: story.id,
        story_key: story.key,
        similarity: Number(bestSim.toFixed(4)),
        method: 'centroid',
      });
      // Near-identical headlines from different publishers within a day are likely syndicated copy.
      const syndWindow = config.syndication.windowHours * 3600 * 1000;
      for (const m of story.members) {
        if (m.publisherId === article.publisherId) continue;
        if (Math.abs(m.time - time) > syndWindow) continue;
        if (cosine(m.headVec, v.head) >= config.syndication.threshold) pairs.push([m.id, article.id]);
      }
      addMember(story, article, v, time);
      indexStory(bestIdx, v.head);
    } else {
      const key = `n${newStoryKeys.length}`;
      story = { id: null, key, lastSeen: time, headSum: new Map(), fullSum: new Map(), hasFull: false, members: [] };
      addMember(story, article, v, time);
      stories.push(story);
      indexStory(stories.length - 1, v.head);
      newStoryKeys.push(key);
      assignments.push({ article_id: article.id, story_id: null, story_key: key, similarity: null, method: 'new_story' });
    }
  }

  return { clusterVersion: CLUSTER_VERSION, newStoryKeys, assignments, syndication: groupPairs(pairs) };
}

/** Union-find over article pairs, returning groups of two or more. */
export function groupPairs(pairs: [string, string][]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    if (p !== x) {
      p = find(p);
      parent.set(x, p);
    }
    return p;
  };
  for (const [a, b] of pairs) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const list = groups.get(root);
    if (list) list.push(id);
    else groups.set(root, [id]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort());
}

/** Pairwise headline similarity, used by the labeled-pair evaluation. */
export function headlineSimilarity(a: string, b: string, language: string, idf: IdfModel): number {
  return cosine(vectorize(tokenize(a, language), idf), vectorize(tokenize(b, language), idf));
}
