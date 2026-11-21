const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86_400), 'day');
}

const dateTime = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dateOnly = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const dayUtc = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : 'unknown';
}
export function formatDate(iso: string | null | undefined): string {
  return iso ? dateOnly.format(new Date(iso)) : 'unknown';
}
/** Formats a UTC calendar day such as "2026-11-20". */
export function formatDay(day: string | null | undefined): string {
  return day ? dayUtc.format(new Date(`${day}T00:00:00Z`)) : 'unknown';
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'unknown';
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)} h`;
  return `${Math.round(seconds / 86_400)} d`;
}

export function bytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', ja: 'Japanese' };
export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

const REASONS: Record<string, string> = {
  no_sources_enabled: 'No sources are enabled for this country yet.',
  below_publisher_floor: 'Fewer than ten publishers are monitored, so counts are small.',
  collection_not_started: 'Collection has not started for this country.',
  window_predates_collection: 'This window reaches back before collection began.',
  sources_failing: 'One or more sources are failing.',
  coverage_gaps: 'There are gaps where some sources were not observed.',
  not_computed: 'This view has not been computed yet.',
};
export function reasonText(code: string): string {
  return REASONS[code] ?? code;
}
