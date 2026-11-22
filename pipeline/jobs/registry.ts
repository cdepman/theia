import { sectionToCategory } from '../classify/categorize';
import { canonicalDomain } from '../normalize/url';

/** One publisher in config/source-candidates.json (written during the Phase 0 source review). */
export interface CandidatePublisher {
  id: string;
  country: string;
  name: string;
  domain: string;
  language: string;
  format?: string;
  termsUrl?: string;
  termsStatus?: string;
  countryAttributionMethod?: string;
  feeds: { url: string; section: string }[];
}

/** config/source-activation.json: which candidates are polled. The owner controls this file. */
export interface Activation {
  enabledPublishers: string[];
  excludedFeeds?: { url: string; reason?: string }[];
  cadenceSeconds?: number;
  /** Optional per-publisher weight and tags, keyed by publisher id. Stored, not yet used in ranking. */
  publisherAttributes?: Record<string, { weight?: number; tags?: string[] }>;
}

export interface RegistryPayload {
  dataSource: { name: string; licenseNotes: string };
  publishers: {
    slug: string;
    name: string;
    domain: string;
    country: string;
    languages: string[];
    isWire: boolean;
    termsStatus: string | null;
    termsUrl: string | null;
    attributionMethod: string;
    enabled: boolean;
    feeds: {
      sourceKey: string;
      url: string;
      language: string;
      section: string;
      defaultCategory: string | null;
      enabled: boolean;
      cadenceSeconds: number;
    }[];
  }[];
}

/**
 * Builds the registry payload for `theia_sync_registry`.
 * A publisher is polled only if the owner lists it in the activation file. Every other
 * candidate is still recorded, disabled, so the monitored set and its limits are visible.
 */
export function buildRegistry(candidates: { publishers: CandidatePublisher[] }, activation: Activation): RegistryPayload {
  const enabled = new Set(activation.enabledPublishers);
  const excluded = new Set((activation.excludedFeeds ?? []).map((f) => f.url));
  const cadence = activation.cadenceSeconds ?? 10800;
  const unknown = [...enabled].filter((id) => !candidates.publishers.some((p) => p.id === id));
  if (unknown.length) throw new Error(`source-activation.json enables unknown publishers: ${unknown.join(', ')}`);

  const keys = new Set<string>();
  return {
    dataSource: {
      name: 'Curated RSS registry',
      licenseNotes: 'Publisher RSS feeds. Headline, link, date and feed summary only; no article bodies. Terms are recorded per publisher.',
    },
    publishers: candidates.publishers.map((p) => {
      const publisherEnabled = enabled.has(p.id);
      return {
        slug: p.id,
        name: p.name,
        domain: canonicalDomain(p.domain),
        country: p.country,
        languages: [p.language],
        isWire: (p.format ?? '').toLowerCase().includes('wire'),
        termsStatus: p.termsStatus ?? null,
        termsUrl: p.termsUrl ?? null,
        attributionMethod: 'curated outlet association (publisher country, not audience or event location)',
        enabled: publisherEnabled,
        feeds: p.feeds.map((f) => {
          let key = `rss:${p.id}:${f.section}`;
          for (let i = 2; keys.has(key); i++) key = `rss:${p.id}:${f.section}:${i}`;
          keys.add(key);
          return {
            sourceKey: key,
            url: f.url,
            language: p.language,
            section: f.section,
            defaultCategory: sectionToCategory(f.section),
            enabled: publisherEnabled && !excluded.has(f.url),
            cadenceSeconds: cadence,
          };
        }),
      };
    }),
  };
}
