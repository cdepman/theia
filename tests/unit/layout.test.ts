import { describe, expect, it } from 'vitest';
import { anyOverlap, type CloudInput, layoutCloud, MARK_GAP, markColumn, markGutter, markSizeFor, type Measure, STEP_COUNT, stepFor, stepThresholds, wrapText } from '../../src/lib/visualization/layout';

// A stand-in for canvas text measurement: Latin characters about half an em wide, CJK a full em.
const measure: Measure = (text, fontSize) => [...text].reduce((w, ch) => w + (/[぀-鿿]/.test(ch) ? 1 : 0.5) * fontSize, 0);

const HEADLINES = [
  'Two men killed after glider crashes into Scottish loch during training flight',
  'Danny Tommo jailed after slashing migrant dinghy in Channel',
  'Scotland’s weather: Coldest night of autumn so far with temperatures set to dip further',
  'Trio who duped pensioners out of £600,000 jailed for 20 years in total',
  '関文科相 2024年6月の政治資金パーティー“法的に問題なし”',
  'Woman shot in bed in targeted attack, police say',
  'Missing fishing boat Kilda recovered from sea off Orkney',
  'クマが住宅街にまた出没 前橋市は道路を封鎖、緊急銃猟を想定',
];

function inputs(n: number): CloudInput[] {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i}`, text: HEADLINES[i % HEADLINES.length]!, step: Math.max(0, 4 - Math.floor(i / 4)), leadEm: i % 3 === 0 ? 0.62 : 0 }));
}

describe('size steps', () => {
  it('uses one middle step when every item has the same value', () => {
    expect(stepFor(3, 3, 3)).toBe(1);
    expect(stepFor(1, null, null)).toBe(1);
  });

  it('is monotonic and bounded on a square-root scale', () => {
    const steps = [1, 2, 3, 4, 5, 8, 12, 20].map((v) => stepFor(v, 1, 20));
    expect(steps[0]).toBe(0);
    expect(steps.at(-1)).toBe(STEP_COUNT - 1);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    // The square root compresses the top of the range: 12 of 20 is already in the upper half.
    expect(stepFor(12, 1, 20)).toBeGreaterThanOrEqual(3);
  });

  it('reports the smallest value that reaches each step, for the legend', () => {
    const t = stepThresholds(1, 5);
    expect(t).toHaveLength(STEP_COUNT);
    expect(t[0]).toBe(1);
    expect(t.at(-1)).toBe(5);
    t.forEach((value, step) => expect(stepFor(value, 1, 5)).toBeGreaterThanOrEqual(step));
  });
});

describe('text wrapping', () => {
  it('wraps English on word boundaries within the width', () => {
    const lines = wrapText(HEADLINES[0]!, 20, 240, 4, measure);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe(HEADLINES[0]);
    lines.forEach((l) => expect(measure(l, 20)).toBeLessThanOrEqual(240));
  });

  it('wraps Japanese between characters and keeps closing punctuation off the start of a line', () => {
    const lines = wrapText('クマが住宅街にまた出没、前橋市は道路を封鎖。緊急銃猟を想定', 20, 130, 6, measure);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join('')).toBe('クマが住宅街にまた出没、前橋市は道路を封鎖。緊急銃猟を想定');
    lines.forEach((l) => expect(/^[、。]/.test(l)).toBe(false));
  });

  it('truncates with an ellipsis past the line limit', () => {
    const lines = wrapText(HEADLINES[2]!, 30, 200, 2, measure);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith('…')).toBe(true);
  });
});

describe('cloud layout', () => {
  for (const box of [{ width: 1376, height: 720 }, { width: 1008, height: 648 }, { width: 792, height: 600 }]) {
    it(`places headlines without overlap inside ${box.width}x${box.height}`, () => {
      const layout = layoutCloud(inputs(30), box, measure);
      expect(layout.overflow).toBe(false);
      expect(layout.items.length + layout.omitted).toBe(30);
      expect(layout.items.length).toBeGreaterThanOrEqual(10);
      expect(anyOverlap(layout.items)).toBe(false);
      for (const p of layout.items) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x + p.width).toBeLessThanOrEqual(box.width);
        expect(p.y + p.height).toBeLessThanOrEqual(box.height);
        // Type never drops below a legible size.
        expect(p.fontSize).toBeGreaterThanOrEqual(12.5);
      }
      // Only the lowest-ranked headlines are ever left out.
      expect(layout.items.map((p) => p.id)).toEqual(inputs(layout.items.length).map((i) => i.id));
    });
  }

  it('is deterministic', () => {
    const box = { width: 1200, height: 700 };
    expect(layoutCloud(inputs(24), box, measure)).toEqual(layoutCloud(inputs(24), box, measure));
  });

  it('reports overflow instead of colliding when the space is too small', () => {
    const layout = layoutCloud(inputs(30), { width: 300, height: 200 }, measure);
    expect(layout.overflow).toBe(true);
    expect(layout.items).toEqual([]);
  });

  it('handles an empty view', () => {
    expect(layoutCloud([], { width: 1000, height: 600 }, measure)).toMatchObject({ items: [], overflow: false, omitted: 0 });
  });
});

describe('count pills', () => {
  const m = (text: string, fontSize: number) => text.length * fontSize * 0.5;
  const inputs = Array.from({ length: 18 }, (_, i) => ({ id: `s${i}`, text: `Subject number ${i} with a longer name`, step: Math.max(0, 4 - Math.floor(i / 4)), badge: String(20 - i) }));

  it('reserves room for each pill past the end of the first line, inside the entry', () => {
    const layout = layoutCloud(inputs, { width: 1000, height: 700 }, m);
    expect(layout.items.length).toBeGreaterThan(10);
    expect(anyOverlap(layout.items)).toBe(false);
    for (const p of layout.items) {
      const b = p.badge!;
      expect(b.text).toBe(String(20 - Number(p.id.slice(1))));
      // Clear of the words on its own line, and never outside the block other entries are kept away from.
      expect(b.dx).toBeGreaterThanOrEqual(p.leadPx + m(p.lines[0]!, p.fontSize) + 5);
      expect(b.dx + b.width).toBeLessThanOrEqual(p.width);
      expect(b.width).toBeGreaterThan(b.height);
      expect(b.dy).toBeGreaterThanOrEqual(-3);
    }
  });

  it('leaves entries without a count untouched', () => {
    const layout = layoutCloud(inputs.map(({ badge: _b, ...rest }) => rest), { width: 1000, height: 700 }, m);
    expect(layout.items.every((p) => p.badge === undefined)).toBe(true);
  });
});

describe('source marks', () => {
  const m = (text: string, fontSize: number) => text.length * fontSize * 0.5;
  const base = Array.from({ length: 18 }, (_, i) => ({ id: `s${i}`, text: `Subject number ${i} with a longer name`, step: Math.max(0, 4 - Math.floor(i / 4)), badge: String(20 - i) }));
  const marked = base.map((b, i) => ({ ...b, marks: i % 4 === 0 ? 3 : i % 4 === 1 ? 1 : 0 }));

  it('stacks the marks in a one-mark-wide column to the left, inside the entry and clear of the words', () => {
    const layout = layoutCloud(marked, { width: 1000, height: 700 }, m);
    expect(layout.items.length).toBeGreaterThan(10);
    expect(anyOverlap(layout.items)).toBe(false);
    for (const p of layout.items) {
      const count = marked.find((x) => x.id === p.id)!.marks;
      if (count === 0) {
        expect(p.markPx).toBe(0);
        continue;
      }
      // One mark wide however many there are, ending at least 5px before the words begin.
      expect(p.markPx - p.markSize).toBeGreaterThanOrEqual(5);
      expect(p.markPx).toBe(markGutter(1, p.fontSize));
      // The whole column fits inside the block other entries are kept away from.
      expect(p.markTop).toBeGreaterThanOrEqual(0);
      expect(p.markTop + count * p.markSize + (count - 1) * MARK_GAP).toBeLessThanOrEqual(p.height);
      // The words and the pill both start after the gutter and still fit inside the block.
      const widest = Math.max(...p.lines.map((l) => m(l, p.fontSize)));
      expect(p.markPx + p.leadPx + widest).toBeLessThanOrEqual(p.width);
      expect(p.badge!.dx).toBeGreaterThanOrEqual(p.markPx + p.leadPx + m(p.lines[0]!, p.fontSize) + 5);
      expect(p.badge!.dx + p.badge!.width).toBeLessThanOrEqual(p.width);
    }
  });

  it('grows a short entry downward to hold a tall column, and takes no extra width for more marks', () => {
    const one = layoutCloud([{ id: 'a', text: 'Short label', step: 0, marks: 1 }], { width: 1000, height: 700 }, m).items[0]!;
    const four = layoutCloud([{ id: 'a', text: 'Short label', step: 0, marks: 4 }], { width: 1000, height: 700 }, m).items[0]!;
    expect(four.width).toBe(one.width);
    expect(four.height).toBeGreaterThan(one.height);
    expect(four.height).toBeGreaterThanOrEqual(four.markTop + markColumn(4, four.fontSize));
  });

  it('keeps the marks small beside any size of type', () => {
    for (const size of [12.5, 15, 19, 25, 33, 44, 59]) {
      expect(markSizeFor(size)).toBeGreaterThanOrEqual(9.5);
      expect(markSizeFor(size)).toBeLessThanOrEqual(13);
      expect(markSizeFor(size)).toBeLessThan(size);
    }
    expect(markGutter(0, 30)).toBe(0);
    expect(markGutter(4, 30)).toBe(markGutter(1, 30));
    expect(markColumn(2, 30)).toBeGreaterThan(markColumn(1, 30));
  });

  it('changes nothing for entries without marks', () => {
    const plain = layoutCloud(base, { width: 1000, height: 700 }, m);
    const zero = layoutCloud(base.map((b) => ({ ...b, marks: 0 })), { width: 1000, height: 700 }, m);
    expect(zero).toEqual(plain);
  });
});
