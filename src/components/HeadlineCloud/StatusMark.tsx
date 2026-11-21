import type { ThreadStatus } from '../../../shared/types';

export const STATUS_TEXT: Record<ThreadStatus, string> = {
  active: 'Still being covered',
  fading: 'Coverage is fading',
  quiet: 'No coverage in the last three days',
  dormant: 'Dormant',
  unknown: 'Not enough history yet',
};

/**
 * A small mark for a thread's coverage status: a full disc while coverage sustains,
 * a half disc as it fades, a ring once it has gone quiet. Shape carries the meaning,
 * so it does not depend on colour.
 */
export function StatusGlyph({ status, cx, cy, r }: { status: ThreadStatus; cx: number; cy: number; r: number }) {
  if (status === 'unknown') return null;
  const stroke = Math.max(1, r * 0.3);
  if (status === 'active') return <circle cx={cx} cy={cy} r={r} fill="var(--cobalt)" />;
  if (status === 'fading') {
    return (
      <g>
        <circle cx={cx} cy={cy} r={r - stroke / 2} fill="none" stroke="var(--cobalt)" strokeWidth={stroke} />
        <path d={`M ${cx} ${cy - r} A ${r} ${r} 0 0 0 ${cx} ${cy + r} Z`} fill="var(--cobalt)" />
      </g>
    );
  }
  return (
    <circle
      cx={cx}
      cy={cy}
      r={r - stroke / 2}
      fill="none"
      stroke="var(--ink-faint)"
      strokeWidth={stroke}
      strokeDasharray={status === 'dormant' ? `${stroke} ${stroke}` : undefined}
    />
  );
}

export function StatusMark({ status, size = 12 }: { status: ThreadStatus; size?: number }) {
  if (status === 'unknown') return null;
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" className="inline-block shrink-0">
      <StatusGlyph status={status} cx={6} cy={6} r={5} />
    </svg>
  );
}
