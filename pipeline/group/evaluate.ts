export interface LabeledPair {
  language: string; publisherA?: string; publisherB?: string; a: string; b: string; label: string;
}

/** Match the labeled publisher as well as the title, and skip ambiguous/missing inputs. */
export function scoreLabeledPairs(
  eventOf: Map<string, string>,
  articles: { id: string; publisher: string; headline: string }[],
  pairs: LabeledPair[],
) {
  const titles = new Map<string, typeof articles>();
  for (const article of articles) {
    if (eventOf.has(article.id)) titles.set(article.headline, [...(titles.get(article.headline) ?? []), article]);
  }
  const lookup = (headline: string, publisher?: string): string | undefined => {
    const found = (titles.get(headline) ?? []).filter((article) => !publisher || article.publisher === publisher);
    return found.length === 1 ? eventOf.get(found[0]!.id) : undefined;
  };
  let sameTotal = 0, sameHit = 0, diffTotal = 0, diffHit = 0, unavailable = 0;
  const misses: string[] = [];
  for (const pair of pairs) {
    if (pair.label !== 'same' && pair.label !== 'different') continue;
    const a = lookup(pair.a, pair.publisherA), b = lookup(pair.b, pair.publisherB);
    if (!a || !b) { unavailable++; continue; }
    if (pair.label === 'same') {
      sameTotal++;
      if (a === b) sameHit++;
      else misses.push(`   split:  ${pair.a.slice(0, 62)}  <>  ${pair.b.slice(0, 62)}`);
    } else {
      diffTotal++;
      if (a !== b) diffHit++;
      else misses.push(`   merged: ${pair.a.slice(0, 62)}  ==  ${pair.b.slice(0, 62)}`);
    }
  }
  return { sameTotal, sameHit, diffTotal, diffHit, unavailable, misses };
}
