const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', pound: '£',
  euro: '€', yen: '¥', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Display-safe plain text: tags removed, entities decoded, whitespace collapsed. Wording is untouched. */
export function cleanText(input: unknown): string {
  if (input === null || input === undefined) return '';
  let s = String(input);
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<[^>]{0,2000}>/g, ' ');
  s = decodeEntities(decodeEntities(s));
  s = s.replace(/<[^>]{0,2000}>/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SEPARATORS = '[-|–—―:｜：]';

/**
 * The comparison form of a headline: NFKC, lowercase, publisher prefixes and suffixes
 * and bracketed labels removed, punctuation collapsed to spaces.
 */
export function normalizeHeadline(raw: string, publisherNames: string[] = []): string {
  let s = cleanText(raw).normalize('NFKC');
  for (const name of publisherNames) {
    const n = name.trim().normalize('NFKC');
    if (n.length < 2) continue;
    const e = escapeRegExp(n);
    s = s.replace(new RegExp(`\\s*${SEPARATORS}\\s*${e}\\s*$`, 'i'), '');
    s = s.replace(new RegExp(`^\\s*${e}\\s*${SEPARATORS}\\s*`, 'i'), '');
  }
  // Leading or trailing bracketed labels such as 【速報】, [Video], (写真あり).
  for (let i = 0; i < 3; i++) {
    s = s.replace(/^\s*[\[【［〈《<(（][^\]】］〉》>)）]{1,20}[\]】］〉》>)）]\s*/u, '');
    s = s.replace(/\s*[\[【［〈《(（][^\]】］〉》)）]{1,20}[\]】］〉》)）]\s*$/u, '');
  }
  s = s.toLowerCase();
  s = s.replace(/[‘’']/g, '');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
