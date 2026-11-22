import type { OriginKind } from '../../../shared/types';

/**
 * Small marks for the kinds of outside source that list an entry. These are our own
 * drawings of the kind of source, one per kind, on a 12 by 12 grid. They are not the
 * services' logos: the exact services are named in the tooltip and the label.
 */
const SHAPES: Partial<Record<OriginKind, string>> = {
  // A lens: something people searched for.
  search: 'M8.1 5.1a3 3 0 1 1-6 0a3 3 0 0 1 6 0z M7.4 7.4l3 3',
  // A speech bubble: something people are posting about.
  social: 'M2.4 2.4h7.2a.9.9 0 0 1 .9.9v3.9a.9.9 0 0 1-.9.9H6.4L4 10.2V8.1H2.4a.9.9 0 0 1-.9-.9V3.3a.9.9 0 0 1 .9-.9z',
  // An open book: a reference page people are reading.
  reference: 'M6 3.3C4.8 2.5 3.2 2.3 1.5 2.6v6.5c1.7-.3 3.3-.1 4.5.7c1.2-.8 2.8-1 4.5-.7V2.6C8.8 2.3 7.2 2.5 6 3.3z M6 3.3v6.5',
  // An upward point: something readers voted to the front page.
  community: 'M6 2.5l4.2 6.8H1.8z',
  // A short stack of lines: an edited roundup of links.
  aggregator: 'M1.8 3h8.4 M1.8 6h6.2 M1.8 9h4',
};

export function hasShape(kind: OriginKind): boolean {
  return SHAPES[kind] !== undefined;
}

/** The mark's strokes, for use inside an svg whose user space is the 12 by 12 grid. */
export function OriginGlyph({ kind }: { kind: OriginKind }) {
  const d = SHAPES[kind];
  if (!d) return null;
  return <path d={d} fill="none" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" />;
}

/** A mark for use in running text and headings. */
export function OriginMark({ kind, size = 12, title }: { kind: OriginKind; size?: number; title?: string }) {
  if (!hasShape(kind)) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" className="origin-mark inline-block shrink-0" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <OriginGlyph kind={kind} />
    </svg>
  );
}
