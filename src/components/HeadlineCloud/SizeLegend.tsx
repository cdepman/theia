import type { ViewPayload } from '../../../shared/types';
import { STEP_SIZES, stepThresholds } from '../../lib/visualization/layout';

/** Explains what headline size means in this view, using the view's own range. */
export function SizeLegend({ view }: { view: ViewPayload }) {
  const { min, max } = view.metricRange;
  const unit = view.metric === 'publisher_days' ? 'publisher-days' : 'publishers';
  const what =
    view.metric === 'publisher_days'
      ? 'Size shows publisher-days: each monitored outlet counted once for every day it covered the subject.'
      : 'Size shows how many distinct monitored publishers reported the story.';
  if (min === null || max === null) return null;
  if (min === max) {
    return (
      <p className="text-[0.85rem] text-ink-soft">
        Every item here has the same count ({min} {min === 1 && unit === 'publishers' ? 'publisher' : unit}), so all are set at one size. {what}
      </p>
    );
  }
  const thresholds = stepThresholds(min, max);
  const steps = thresholds
    .map((value, step) => ({ value, step }))
    .filter((s, i, all) => i === 0 || s.value !== all[i - 1]!.value);
  return (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[0.85rem] text-ink-soft">
      <span>{what}</span>
      <span className="flex items-baseline gap-3" aria-label={`Sizes range from ${min} to ${max} ${unit}`}>
        {steps.map((s) => (
          <span key={s.step} className="flex items-baseline gap-1">
            <span aria-hidden="true" className="text-ink leading-none" style={{ fontSize: Math.round(STEP_SIZES[s.step]! * 0.62) }}>
              Aa
            </span>
            <span className="tabular">{s.value}</span>
          </span>
        ))}
        <span>{unit}</span>
      </span>
    </div>
  );
}
