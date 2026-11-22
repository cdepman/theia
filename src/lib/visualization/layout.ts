// Deterministic headline-cloud layout: measure each headline, place the largest first,
// search outward along a spiral for the first position that collides with nothing.
// No randomness, so the same data in the same viewport always lays out the same way.

export interface CloudInput {
  id: string;
  text: string;
  /** 0 (smallest) to STEP_COUNT - 1 (largest). */
  step: number;
  /** Space reserved before the first line for a status mark, in em. */
  leadEm?: number;
  /** Short text for a pill set after the first line, raised to its top: the count the size stands for. */
  badge?: string;
  /** How many small source marks to stack in a narrow column to the left of the entry. */
  marks?: number;
}

export interface PlacedBadge {
  text: string;
  /** Top-left corner of the pill, measured from the top-left corner of its entry. */
  dx: number;
  dy: number;
  width: number;
  height: number;
  fontSize: number;
}

export interface PlacedItem {
  id: string;
  lines: string[];
  fontSize: number;
  lineHeight: number;
  /** Top-left corner of the text block. */
  x: number;
  y: number;
  width: number;
  height: number;
  leadPx: number;
  /** Width of the gutter on the left that holds the column of source marks, including the gap before the words. 0 when there are none. */
  markPx: number;
  /** Side of one square source mark. */
  markSize: number;
  /** Top of the first mark, measured from the top of the entry. The rest follow below it, MARK_GAP apart. */
  markTop: number;
  badge?: PlacedBadge;
}

export interface CloudLayout {
  items: PlacedItem[];
  scale: number;
  /** How many of the lowest-ranked inputs were left out because they did not fit legibly. */
  omitted: number;
  /** True when too few headlines fit to make a useful cloud; the caller should use the ranked list. */
  overflow: boolean;
}

export type Measure = (text: string, fontSize: number) => number;

export const STEP_COUNT = 5;
/** Base font sizes for the five steps, before viewport scaling. A modular scale, ratio about 1.31. */
export const STEP_SIZES = [15, 19, 25, 33, 44] as const;
/**
 * Progressively flatter scales, tried in order when the full contrast does not fit: many
 * headlines at the top step need room. Order is always preserved, only the spread narrows.
 */
const SIZE_LADDER: readonly (readonly number[])[] = [STEP_SIZES, [14.5, 17.5, 21.5, 27, 35], [14, 16.5, 19.5, 23.5, 28.5], [13.5, 15.5, 17.5, 20, 23.5]];

/**
 * Maps a metric value to a size step using a square-root scale across the range seen in
 * the current view. When every item has the same value there is no hierarchy to show,
 * so every item gets the same middle step.
 */
export function stepFor(value: number, min: number | null, max: number | null): number {
  if (min === null || max === null || max <= min) return 1;
  const t = (Math.sqrt(value) - Math.sqrt(min)) / (Math.sqrt(max) - Math.sqrt(min));
  return Math.max(0, Math.min(STEP_COUNT - 1, Math.round(t * (STEP_COUNT - 1))));
}

/** The smallest metric value that reaches each step, for the size legend. */
export function stepThresholds(min: number, max: number): number[] {
  const out: number[] = [];
  for (let step = 0; step < STEP_COUNT; step++) {
    let found = max;
    for (let v = min; v <= max; v++) {
      if (stepFor(v, min, max) >= step) {
        found = v;
        break;
      }
    }
    out.push(found);
  }
  return out;
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯　-〿]/;
// Characters that must not begin a line in Japanese text.
const NO_LINE_START = /^[、。，．・：；？！）」』】〕〉》ー々っゃゅょァィゥェォッャュョ,.!?)]/;

/** Breakable units: words for space-delimited text, single characters for CJK. */
function units(text: string): { text: string; space: boolean }[] {
  const out: { text: string; space: boolean }[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!CJK.test(word)) {
      out.push({ text: word, space: out.length > 0 });
      continue;
    }
    let first = true;
    let latin = '';
    const flush = () => {
      if (latin) {
        out.push({ text: latin, space: first && out.length > 0 });
        first = false;
        latin = '';
      }
    };
    for (const ch of word) {
      if (CJK.test(ch)) {
        flush();
        if (NO_LINE_START.test(ch) && out.length > 0 && !first) out[out.length - 1]!.text += ch;
        else out.push({ text: ch, space: first && out.length > 0 });
        first = false;
      } else {
        latin += ch;
      }
    }
    flush();
  }
  return out;
}

export function wrapText(text: string, fontSize: number, maxWidth: number, maxLines: number, measure: Measure): string[] {
  const lines: string[] = [];
  let current = '';
  for (const u of units(text)) {
    const candidate = current ? current + (u.space ? ' ' : '') + u.text : u.text;
    if (!current || measure(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = u.text;
    }
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1]!;
  while (last.length > 1 && measure(`${last}…`, fontSize) > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}…`;
  return kept;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Rect, b: Rect, pad: number): boolean {
  return a.x < b.x + b.width + pad && a.x + a.width + pad > b.x && a.y < b.y + b.height + pad && a.y + a.height + pad > b.y;
}

/** Clear space between the end of the first line and its pill. */
export function badgeGap(fontSize: number): number {
  return Math.max(5, fontSize * 0.2);
}

/** Side of one source mark: small beside any size of type, never below what stays legible. */
export function markSizeFor(fontSize: number): number {
  return Math.min(13, Math.max(9.5, Math.round(fontSize * 0.4 * 2) / 2));
}

/** Space between two source marks in the column. */
export const MARK_GAP = 2.5;

/**
 * Width of the gutter that holds the source marks. They stack in a single column, so the
 * gutter is one mark wide however many there are, plus the gap that keeps them off the words.
 */
export function markGutter(count: number, fontSize: number): number {
  if (count <= 0) return 0;
  return Math.ceil(markSizeFor(fontSize) + Math.max(5, fontSize * 0.2));
}

/** Height of a column of `count` source marks. */
export function markColumn(count: number, fontSize: number): number {
  return count <= 0 ? 0 : count * markSizeFor(fontSize) + (count - 1) * MARK_GAP;
}

function attempt(inputs: CloudInput[], box: { width: number; height: number }, measure: Measure, scale: number, sizes: readonly number[] = STEP_SIZES): PlacedItem[] | null {
  const placed: PlacedItem[] = [];
  const cx = box.width / 2;
  const cy = box.height / 2;
  const aspect = box.width / Math.max(box.height, 1);
  const pad = Math.max(10, 16 * scale);

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    const fontSize = Math.round(sizes[input.step]! * scale * 10) / 10;
    const lineHeight = Math.round(fontSize * (input.step >= 3 ? 1.1 : 1.22) * 10) / 10;
    const leadPx = (input.leadEm ?? 0) * fontSize;
    // Source marks stack in a one-mark-wide gutter to the left, so every line of the entry keeps
    // one clean left edge and the marks cost the same little width however many there are.
    const markCount = input.marks ?? 0;
    const markSize = markSizeFor(fontSize);
    const markPx = markGutter(markCount, fontSize);
    // The first mark sits level with the first line; the column runs down from there.
    const markTop = Math.max(0, Math.round((fontSize * 0.56 - markSize / 2) * 10) / 10);
    const maxWidth = Math.min(box.width - 8 - markPx, Math.max(150, fontSize * (input.step >= 3 ? 11 : 13))) - leadPx;
    const lines = wrapText(input.text, fontSize, maxWidth, input.step >= 3 ? 4 : 3, measure);
    let width = Math.ceil(Math.max(...lines.map((l) => measure(l, fontSize))) + leadPx) + markPx;
    // A tall column beside a short entry makes the block taller, never an overlap.
    const height = Math.ceil(Math.max(lines.length * lineHeight, markCount > 0 ? markTop + markColumn(markCount, fontSize) : 0));
    // The pill sits clear of the end of the first line, and the block is widened to hold it,
    // so it can never touch this entry's words or a neighbour's.
    let badge: PlacedBadge | null = null;
    if (input.badge) {
      const badgeFont = Math.min(15, Math.max(10, Math.round(fontSize * 0.42 * 10) / 10));
      const badgeHeight = Math.round(badgeFont * 1.5);
      // Always wider than tall, so a single digit still reads as a pill, not a dot.
      const badgeWidth = Math.ceil(Math.max(badgeHeight * 1.55, measure(input.badge, badgeFont) + badgeFont * 1.2));
      const dx = Math.ceil(markPx + leadPx + measure(lines[0] ?? '', fontSize) + badgeGap(fontSize));
      badge = { text: input.badge, width: badgeWidth, height: badgeHeight, fontSize: badgeFont, dx, dy: Math.max(-3, Math.round(fontSize * 0.24 - badgeHeight / 2)) };
      width = Math.max(width, dx + badgeWidth);
    }
    if (width > box.width || height > box.height) return null;

    let found: PlacedItem | null = null;
    // Each item starts its spiral at a different angle (the golden angle apart) so the cloud fills evenly.
    const start = i * 2.39996;
    for (let step = 0; step < 2400 && !found; step++) {
      const angle = start + step * 0.18;
      const radius = step * 1.15;
      const x = Math.round(cx + Math.cos(angle) * radius * aspect - width / 2);
      const y = Math.round(cy + Math.sin(angle) * radius - height / 2);
      if (x < 0 || y < 0 || x + width > box.width || y + height > box.height) continue;
      const rect = { x, y, width, height };
      if (placed.every((p) => !overlaps(rect, p, pad))) {
        found = { id: input.id, lines, fontSize, lineHeight, x, y, width, height, leadPx, markPx, markSize, markTop };
        if (badge) found.badge = badge;
      }
    }
    if (!found) return null;
    placed.push(found);
  }
  return placed;
}

/** The smallest type we will set in the cloud, in px. Below this a headline is not comfortably readable. */
const MIN_FONT_PX = 12.5;
/** A cloud with fewer headlines than this is not worth drawing; use the list. */
const MIN_ITEMS = 10;

/**
 * Lays out the cloud. Inputs must already be in rank order (most prominent first).
 *
 * Type is scaled to the viewport. If everything cannot fit at a legible size, the
 * lowest-ranked headlines are left out (and reported in `omitted`) so the rest stay
 * readable and never collide. The full ranking is always available as a list.
 */
export function layoutCloud(inputs: CloudInput[], box: { width: number; height: number }, measure: Measure): CloudLayout {
  if (inputs.length === 0) return { items: [], scale: 1, omitted: 0, overflow: false };
  if (box.width < 320 || box.height < 220) return { items: [], scale: 1, omitted: inputs.length, overflow: true };
  // Start from a scale suited to the viewport: bigger type on bigger canvases.
  const preferred = Math.min(1.35, Math.round(Math.sqrt((box.width * box.height) / (1180 * 640)) * 20) / 20);
  const scalesFor = (sizes: readonly number[]): number[] => {
    const minScale = MIN_FONT_PX / sizes[0]!;
    const out: number[] = [];
    for (let sc = Math.max(preferred, minScale); sc > minScale + 1e-9; sc = Math.round((sc - 0.07) * 100) / 100) out.push(sc);
    out.push(minScale);
    return out;
  };

  // Everything, with the fullest contrast and the largest scale that works.
  for (const sizes of SIZE_LADDER) {
    for (const scale of scalesFor(sizes)) {
      const placed = attempt(inputs, box, measure, scale, sizes);
      if (placed) return { items: recenter(placed, box), scale, omitted: 0, overflow: false };
    }
  }
  // Otherwise the most headlines that fit at the flattest, smallest legible setting.
  const flattest = SIZE_LADDER[SIZE_LADDER.length - 1]!;
  const floor = MIN_FONT_PX / flattest[0]!;
  for (let n = inputs.length - 1; n >= Math.min(MIN_ITEMS, inputs.length); n--) {
    const placed = attempt(inputs.slice(0, n), box, measure, floor, flattest);
    if (placed) return { items: recenter(placed, box), scale: floor, omitted: inputs.length - n, overflow: false };
  }
  return { items: [], scale: floor, omitted: inputs.length, overflow: true };
}

/** Centers the cloud's bounding box in the available space. */
function recenter(items: PlacedItem[], box: { width: number; height: number }): PlacedItem[] {
  const minX = Math.min(...items.map((i) => i.x));
  const maxX = Math.max(...items.map((i) => i.x + i.width));
  const minY = Math.min(...items.map((i) => i.y));
  const maxY = Math.max(...items.map((i) => i.y + i.height));
  const dx = Math.round((box.width - (maxX - minX)) / 2 - minX);
  const dy = Math.round((box.height - (maxY - minY)) / 2 - minY);
  return items.map((i) => ({ ...i, x: i.x + dx, y: i.y + dy }));
}

export function anyOverlap(items: PlacedItem[]): boolean {
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      if (overlaps(items[a]!, items[b]!, 0)) return true;
    }
  }
  return false;
}
