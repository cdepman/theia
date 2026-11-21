import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { ViewItem, ViewPayload } from '../../../shared/types';
import { type CloudLayout, layoutCloud, type Measure, stepFor } from '../../lib/visualization/layout';
import { OUTLINES } from '../../lib/visualization/outlines';
import { itemMeta, RankedList } from './RankedList';
import { STATUS_TEXT, StatusGlyph } from './StatusMark';

const FONT_FAMILY = "'Newsreader Variable', 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif";
const FONT_WEIGHT = 500;
const NARROW = 760;

let canvas: HTMLCanvasElement | null = null;
const measureCache = new Map<string, number>();
const measure: Measure = (text, fontSize) => {
  const key = `${fontSize}|${text}`;
  const hit = measureCache.get(key);
  if (hit !== undefined) return hit;
  canvas ??= document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `${FONT_WEIGHT} ${fontSize}px ${FONT_FAMILY}`;
  // Tight tracking at display sizes is applied in CSS; measure a little generously so text never touches.
  const width = ctx.measureText(text).width * 1.02;
  if (measureCache.size > 5000) measureCache.clear();
  measureCache.set(key, width);
  return width;
};

const layoutCache = new Map<string, CloudLayout>();

function useBox() {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      // Ignore sub-step changes so small resizes do not reshuffle the cloud.
      const width = Math.floor(el.clientWidth / 24) * 24;
      const height = Math.floor(el.clientHeight / 24) * 24;
      setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, box] as const;
}

function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const done = () => {
      if (!cancelled) {
        measureCache.clear();
        layoutCache.clear();
        setReady(true);
      }
    };
    // Lay out only once the headline face is loaded, so measurements match what is drawn.
    Promise.all([document.fonts.load(`${FONT_WEIGHT} 20px 'Newsreader Variable'`), document.fonts.ready]).then(done, done);
    return () => {
      cancelled = true;
    };
  }, []);
  return ready;
}

interface Props {
  view: ViewPayload;
  selectedId: string | null;
  onSelect: (item: ViewItem) => void;
  /** Show the ranked list even where the cloud would fit. */
  asList: boolean;
  /** Reports how the view was drawn, so the page can say when some headlines are only in the list. */
  onLayout?: (info: { mode: 'cloud' | 'list'; shown: number; total: number }) => void;
}

export function HeadlineCloud({ view, selectedId, onSelect, asList, onLayout }: Props) {
  const [ref, box] = useBox();
  const fontsReady = useFontsReady();
  const narrow = box.width > 0 && box.width < NARROW;

  const layout = useMemo(() => {
    if (!fontsReady || narrow || asList || box.width === 0) return null;
    const key = `${view.country}|${view.category}|${view.window}|${view.observationCutoff}|${box.width}x${box.height}|${view.stories.map((s) => s.id).join(',')}`;
    const cached = layoutCache.get(key);
    if (cached) return cached;
    const result = layoutCloud(
      view.stories.map((s) => ({
        id: s.id,
        text: s.headline,
        step: stepFor(s.metricValue, view.metricRange.min, view.metricRange.max),
        leadEm: s.unit === 'thread' && s.status && s.status !== 'unknown' ? 0.62 : 0,
      })),
      box,
      measure,
    );
    if (layoutCache.size > 60) layoutCache.clear();
    layoutCache.set(key, result);
    return result;
  }, [fontsReady, narrow, asList, box, view]);

  const byId = useMemo(() => new Map(view.stories.map((s) => [s.id, s])), [view]);
  const outline = OUTLINES[view.country];
  const useList = asList || narrow || (layout?.overflow ?? false);
  const shown = useList ? view.stories.length : (layout?.items.length ?? 0);

  useEffect(() => {
    if (useList || layout) onLayout?.({ mode: useList ? 'list' : 'cloud', shown, total: view.stories.length });
  }, [onLayout, useList, layout, shown, view.stories.length]);

  const onKey = (e: KeyboardEvent<SVGGElement>, item: ViewItem) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(item);
    }
  };

  return (
    <div ref={ref} className="relative h-full w-full">
      {useList ? (
        <div className="absolute inset-0 overflow-y-auto pr-1">
          <RankedList view={view} selectedId={selectedId} onSelect={onSelect} />
        </div>
      ) : (
        box.width > 0 && (
          <svg
            width={box.width}
            height={box.height}
            className="cloud absolute left-0 top-0 block"
            data-has-selection={selectedId !== null && byId.has(selectedId)}
            role="group"
            aria-label={`${shown} ${view.unit === 'thread' ? 'subjects' : 'stories'}, most widely covered first`}
          >
            {/* The country itself, as subdued land on the water. Headlines are not forced into its shape. */}
            <svg
              x={box.width * 0.06}
              y={box.height * 0.04}
              width={box.width * 0.88}
              height={box.height * 0.92}
              viewBox={outline.viewBox.join(' ')}
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
            >
              <path d={outline.d} fill="var(--land)" stroke="var(--shore)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" opacity={0.85} />
            </svg>
            {layout?.items.map((p) => {
              const item = byId.get(p.id);
              if (!item) return null;
              const status = item.unit === 'thread' ? item.status : undefined;
              const label = `${item.headline}. ${itemMeta(item)}.${status && status !== 'unknown' ? ` ${STATUS_TEXT[status]}.` : ''}`;
              return (
                <g
                  key={p.id}
                  className="cloud-item"
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  aria-pressed={item.id === selectedId}
                  data-selected={item.id === selectedId}
                  data-testid="cloud-item"
                  onClick={() => onSelect(item)}
                  onKeyDown={(e) => onKey(e, item)}
                >
                  <rect className="focus-ring" x={p.x - 7} y={p.y - 5} width={p.width + 14} height={p.height + 10} rx={3} />
                  {/* A transparent hit area so the gaps between lines are clickable too. */}
                  <rect x={p.x} y={p.y} width={p.width} height={p.height} fill="transparent" />
                  {status && p.leadPx > 0 && <StatusGlyph status={status} cx={p.x + p.fontSize * 0.2} cy={p.y + p.fontSize * 0.58} r={p.fontSize * 0.17} />}
                  <text
                    lang={item.language}
                    fontSize={p.fontSize}
                    fontWeight={FONT_WEIGHT}
                    fontFamily={FONT_FAMILY}
                    letterSpacing={p.fontSize >= 28 ? '-0.015em' : p.fontSize >= 20 ? '-0.008em' : undefined}
                  >
                    {p.lines.map((line, i) => (
                      <tspan key={i} x={p.x + (i === 0 ? p.leadPx : 0)} y={p.y + p.fontSize * 0.86 + i * p.lineHeight}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              );
            })}
          </svg>
        )
      )}
    </div>
  );
}
