import { describe, expect, it } from 'vitest';
import { anyOverlap, type CloudInput, layoutCloud, type Measure, STEP_COUNT, stepFor, stepThresholds, wrapText } from '../../src/lib/visualization/layout';

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
