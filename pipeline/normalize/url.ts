// Conservative URL normalization: enough to make retries and re-polls idempotent,
// without collapsing URLs that differ in a meaningful query parameter.

const TRACKING_EXACT = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', 'ocid', 'cmpid', 'cmp', 'cid',
  'ito', 'smid', 'smtyp', 'sref', 'srnd', 'ref_src', 'ref_url', 'traffic_source', 'rss', 'rssfeed', 'partner',
  'emc', 'feedtype', 'feedname', 'source', 'taid', 'spm', 'guccounter', 'guce_referrer', 'guce_referrer_sig',
]);
const TRACKING_PREFIXES = ['utm_', 'at_', 'ns_', 'pk_', 'mtm_', 'wt.', 'wt_', 'ga_', 'hsa_', 'vero_', 'oly_'];

export function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return TRACKING_EXACT.has(n) || TRACKING_PREFIXES.some((p) => n.startsWith(p));
}

export function normalizeUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.protocol = 'https:';
  url.hash = '';
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase();
  if (url.port === '80' || url.port === '443') url.port = '';
  const kept: [string, string][] = [];
  for (const [k, v] of url.searchParams) {
    if (!isTrackingParam(k)) kept.push([k, v]);
  }
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);
  let out = url.toString();
  // A bare trailing slash on a path carries no meaning; a trailing slash on the root is kept by URL itself.
  if (url.pathname.length > 1 && url.pathname.endsWith('/') && !url.search) out = out.slice(0, -1);
  return out;
}

export function canonicalDomain(hostOrUrl: string): string {
  let host = hostOrUrl.trim().toLowerCase();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      /* fall through with the raw value */
    }
  }
  host = host.replace(/\.$/, '');
  return host.replace(/^(www\d?|m|mobile|amp|feeds|rss)\./, '');
}
