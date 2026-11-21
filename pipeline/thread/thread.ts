import { pipelineConfig, THREAD_VERSION } from '../config';
import { type IdfModel } from '../cluster/features';
import {
  independentShared,
  mergeSignature,
  type Signature,
  signatureCosine,
  signatureFromJson,
  signatureToJson,
  type StorySignature,
  storySignature,
  type StoryText,
  threadLabel,
} from './signature';

export interface ThreadingStory {
  id: string;
  /** The story's current thread, if it has one. Only threads of one are re-evaluated. */
  threadId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  texts: StoryText[];
}

export interface ThreadCandidate {
  storyId: string;
  threadId: string;
  signature: Record<string, number>;
  lastSeenAt: string;
  dormant: boolean;
  storyCount: number;
}

export interface ThreadLink {
  storyId: string;
  threadId: string | null;
  threadKey: string | null;
  score: number | null;
  method: 'signature' | 'new_thread';
  sharedTerms?: string[];
}

export interface ThreadUpdate {
  threadId: string | null;
  threadKey: string | null;
  label: string;
  signature: Record<string, number>;
}

export interface ThreadingPlan {
  threadVersion: number;
  newThreads: { key: string; label: string; signature: Record<string, number> }[];
  links: ThreadLink[];
  threadUpdates: ThreadUpdate[];
  evaluated: string[];
}

export interface LinkDecision {
  link: boolean;
  score: number;
  shared: string[];
}

/**
 * Whether a story belongs to a thread. Linking is deliberately conservative: a missed
 * link understates how long a subject ran, but a false link fabricates endurance.
 *
 * Requirements, all of them:
 *  - at least two independent shared terms (one shared name is never enough);
 *  - where names can be told apart from ordinary words, enough of the shared terms are
 *    names: two in English, one in Japanese. Where they cannot, three shared terms;
 *  - signature cosine at or above the score threshold, or the higher threshold when none
 *    of the shared terms is rare.
 */
export function decideLink(
  story: StorySignature,
  thread: Signature,
  language: string,
  config = pipelineConfig.thread,
): LinkDecision {
  const shared = independentShared(story.weights, thread);
  const score = signatureCosine(story.weights, thread);
  if (shared.length < config.minSharedTerms) return { link: false, score, shared };
  if (story.entities === null) {
    if (shared.length < config.minSharedTerms + 1) return { link: false, score, shared };
  } else {
    const sharedEntities = shared.filter((t) => story.entities!.has(t)).length;
    const needed = language === 'ja' ? 1 : 2;
    if (sharedEntities < needed) return { link: false, score, shared };
  }
  // Two common names (two countries, say) appear together in many unrelated stories, so
  // common-only overlap must clear the higher bar.
  const hasRare = shared.some((t) => story.rare.has(t));
  const bar = hasRare ? config.scoreThreshold : config.strongScoreThreshold;
  return { link: score >= bar, score, shared };
}

interface PoolThread {
  id: string | null;
  key: string | null;
  signature: Signature;
  storyCount: number;
  removed: boolean;
}

/**
 * Plans thread membership for a batch of stories, oldest first.
 * Every story ends in exactly one thread; a story that links to nothing is a thread of one.
 */
export function planThreads(
  input: { language: string; stories: ThreadingStory[]; candidates: ThreadCandidate[]; signatures: Map<string, StorySignature> },
  config = pipelineConfig.thread,
): ThreadingPlan {
  const { language } = input;
  const plan: ThreadingPlan = { threadVersion: THREAD_VERSION, newThreads: [], links: [], threadUpdates: [], evaluated: [] };

  const pool = new Map<string, PoolThread>();
  const ref = (t: PoolThread) => (t.id ? `id:${t.id}` : `key:${t.key}`);
  const candidatesByStory = new Map<string, PoolThread[]>();
  for (const c of input.candidates) {
    let t = pool.get(`id:${c.threadId}`);
    if (!t) {
      t = { id: c.threadId, key: null, signature: signatureFromJson(c.signature), storyCount: c.storyCount, removed: false };
      pool.set(`id:${c.threadId}`, t);
    }
    const list = candidatesByStory.get(c.storyId);
    if (list) list.push(t);
    else candidatesByStory.set(c.storyId, [t]);
  }
  // Threads created or changed in this batch are candidates for every later story in it.
  const batchThreads: PoolThread[] = [];
  const updates = new Map<string, PoolThread>();

  const ordered = [...input.stories].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));

  for (const story of ordered) {
    const sig = input.signatures.get(story.id);
    if (!sig) continue;
    plan.evaluated.push(story.id);

    const current = story.threadId ? pool.get(`id:${story.threadId}`) : undefined;
    // A story already sharing its thread with another story stays where it is.
    if (current && current.storyCount > 1) continue;

    const seen = new Set<string>();
    let best: { thread: PoolThread; decision: LinkDecision } | null = null;
    for (const t of [...(candidatesByStory.get(story.id) ?? []), ...batchThreads]) {
      if (t.removed || seen.has(ref(t))) continue;
      seen.add(ref(t));
      if (story.threadId && t.id === story.threadId) continue;
      const decision = decideLink(sig, t.signature, language, config);
      if (!decision.link) continue;
      if (!best || decision.score > best.decision.score) best = { thread: t, decision };
    }

    if (best) {
      const target = best.thread;
      plan.links.push({
        storyId: story.id,
        threadId: target.id,
        threadKey: target.key,
        score: Number(best.decision.score.toFixed(4)),
        method: 'signature',
        sharedTerms: best.decision.shared,
      });
      target.signature = mergeSignature(target.signature, sig.weights, config);
      target.storyCount += 1;
      updates.set(ref(target), target);
      if (!batchThreads.includes(target)) batchThreads.push(target);
      if (current) current.removed = true;
      else if (story.threadId) pool.set(`id:${story.threadId}`, { id: story.threadId, key: null, signature: new Map(), storyCount: 0, removed: true });
      continue;
    }

    if (story.threadId) {
      // Still a thread of one: refresh its signature now that the story has more articles.
      const own: PoolThread = current ?? { id: story.threadId, key: null, signature: sig.weights, storyCount: 1, removed: false };
      own.signature = sig.weights;
      pool.set(`id:${story.threadId}`, own);
      updates.set(ref(own), own);
      if (!batchThreads.includes(own)) batchThreads.push(own);
      continue;
    }

    const key = `t${plan.newThreads.length}`;
    const created: PoolThread = { id: null, key, signature: new Map(sig.weights), storyCount: 1, removed: false };
    plan.newThreads.push({ key, label: threadLabel(sig.weights), signature: signatureToJson(sig.weights) });
    plan.links.push({ storyId: story.id, threadId: null, threadKey: key, score: null, method: 'new_thread' });
    pool.set(`key:${key}`, created);
    updates.set(ref(created), created);
    batchThreads.push(created);
  }

  for (const t of updates.values()) {
    if (t.removed) continue;
    plan.threadUpdates.push({ threadId: t.id, threadKey: t.key, label: threadLabel(t.signature), signature: signatureToJson(t.signature) });
  }
  return plan;
}

export function buildSignatures(stories: ThreadingStory[], language: string, df: IdfModel): Map<string, StorySignature> {
  const out = new Map<string, StorySignature>();
  for (const s of stories) out.set(s.id, storySignature(s.texts, language, df));
  return out;
}
