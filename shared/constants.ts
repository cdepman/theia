export const COUNTRIES = ['US', 'GB', 'JP'] as const;
export type CountryCode = (typeof COUNTRIES)[number];

export const ARTICLE_CATEGORIES = [
  'politics',
  'business',
  'technology',
  'science',
  'health',
  'entertainment',
  'sports',
  'environment',
  'other',
] as const;
export type ArticleCategory = (typeof ARTICLE_CATEGORIES)[number];

export const CATEGORIES = ['all', ...ARTICLE_CATEGORIES] as const;
export type Category = (typeof CATEGORIES)[number];

export const WINDOWS = ['24h', '7d', '30d'] as const;
export type WindowCode = (typeof WINDOWS)[number];

export const COUNTRY_NAMES: Record<CountryCode, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  JP: 'Japan',
};

export const CATEGORY_LABELS: Record<Category, string> = {
  all: 'All',
  politics: 'Politics',
  business: 'Business',
  technology: 'Technology',
  science: 'Science',
  health: 'Health',
  entertainment: 'Entertainment',
  sports: 'Sports',
  environment: 'Environment',
  other: 'Other',
};

export const WINDOW_LABELS: Record<WindowCode, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

export function isCountry(v: unknown): v is CountryCode {
  return typeof v === 'string' && (COUNTRIES as readonly string[]).includes(v);
}
export function isCategory(v: unknown): v is Category {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
}
export function isWindow(v: unknown): v is WindowCode {
  return typeof v === 'string' && (WINDOWS as readonly string[]).includes(v);
}

export const DEFAULT_COUNTRY: CountryCode = 'US';
export const DEFAULT_CATEGORY: Category = 'all';
export const DEFAULT_WINDOW: WindowCode = '24h';
