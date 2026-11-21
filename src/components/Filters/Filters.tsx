import {
  CATEGORIES, CATEGORY_LABELS, type Category, COUNTRIES, COUNTRY_NAMES, type CountryCode, WINDOW_LABELS, WINDOWS, type WindowCode,
} from '../../../shared/constants';

interface Props {
  country: CountryCode;
  category: Category;
  window: WindowCode;
  onChange: (changes: { country?: CountryCode; category?: Category; window?: WindowCode }) => void;
}

function Choice({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`cursor-pointer whitespace-nowrap rounded-sm px-2 py-1 leading-tight ${
        active ? 'bg-ink text-sea' : 'text-ink-soft hover:text-ink hover:bg-sea-deep'
      }`}
    >
      {children}
    </button>
  );
}

export function Filters({ country, category, window, onChange }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[0.95rem]">
      <div role="group" aria-label="Country" className="flex gap-1">
        {COUNTRIES.map((c) => (
          <Choice key={c} active={c === country} onClick={() => onChange({ country: c })}>
            {COUNTRY_NAMES[c]}
          </Choice>
        ))}
      </div>
      <div role="group" aria-label="Time window" className="flex gap-1">
        {WINDOWS.map((w) => (
          <Choice key={w} active={w === window} onClick={() => onChange({ window: w })}>
            {WINDOW_LABELS[w]}
          </Choice>
        ))}
      </div>
      <div role="group" aria-label="Category" className="hidden flex-wrap gap-1 lg:flex">
        {CATEGORIES.map((c) => (
          <Choice key={c} active={c === category} onClick={() => onChange({ category: c })}>
            {CATEGORY_LABELS[c]}
          </Choice>
        ))}
      </div>
      <label className="flex items-center gap-2 lg:hidden">
        <span className="text-ink-soft">Category</span>
        <select
          value={category}
          onChange={(e) => onChange({ category: e.target.value as Category })}
          className="rounded-sm border border-shore bg-paper px-2 py-1 text-ink"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
