import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeHeadline } from '../../pipeline/normalize/headline';

interface ProbeFeed {
  publisherId: string;
  language: string;
  articles?: { headline: string; publishedAt: string | null; futureDated: boolean }[];
}

const ROOT = join(import.meta.dirname, '../..');

/**
 * Normalized headlines from the Phase 0 probe (real feed metadata, one snapshot). Used only
 * to give evaluation tests realistic term statistics. It is never loaded into a database.
 */
export function probeCorpus(language: string): string[] {
  const ev = JSON.parse(readFileSync(join(ROOT, 'docs/evidence/rss-probe-final.json'), 'utf8')) as { feeds: ProbeFeed[] };
  const candidates = JSON.parse(readFileSync(join(ROOT, 'config/source-candidates.json'), 'utf8')) as { publishers: { id: string; name: string }[] };
  const names = new Map(candidates.publishers.map((p) => [p.id, p.name]));
  const out = new Set<string>();
  for (const f of ev.feeds) {
    if (f.language !== language) continue;
    for (const a of f.articles ?? []) {
      if (!a.publishedAt || a.futureDated) continue;
      if (new Date(a.publishedAt).getTime() < Date.parse('2026-11-18T09:45:00Z')) continue;
      out.add(normalizeHeadline(a.headline, [names.get(f.publisherId) ?? '']));
    }
  }
  return [...out];
}

export function publisherNames(): Map<string, string> {
  const candidates = JSON.parse(readFileSync(join(ROOT, 'config/source-candidates.json'), 'utf8')) as { publishers: { id: string; name: string }[] };
  return new Map(candidates.publishers.map((p) => [p.id, p.name]));
}
