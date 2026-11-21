import { XMLParser } from 'fast-xml-parser';

export interface FeedItem {
  title: string;
  link: string | null;
  guid: string | null;
  published: string | null;
  summary: string | null;
  categories: string[];
}

export interface ParsedFeed {
  format: 'rss' | 'atom' | 'rdf';
  title: string | null;
  items: FeedItem[];
}

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedParseError';
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => name === 'item' || name === 'entry',
});

type Node = unknown;

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(node: Node): string | null {
  if (node === undefined || node === null) return null;
  if (typeof node === 'string') return node.trim() || null;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) {
    for (const n of node) {
      const t = text(n);
      if (t) return t;
    }
    return null;
  }
  if (typeof node === 'object') {
    const o = node as Record<string, Node>;
    if (o['#text'] !== undefined) return text(o['#text']);
    if (o['@_href'] !== undefined) return text(o['@_href']);
    if (o['@_term'] !== undefined) return text(o['@_term']);
  }
  return null;
}

function atomLink(node: Node): string | null {
  const links = asArray(node) as Node[];
  let fallback: string | null = null;
  for (const l of links) {
    if (typeof l === 'string') {
      fallback ??= l.trim();
      continue;
    }
    if (l && typeof l === 'object') {
      const o = l as Record<string, Node>;
      const href = text(o['@_href']);
      const rel = text(o['@_rel']) ?? 'alternate';
      if (href && rel === 'alternate') return href;
      if (href) fallback ??= href;
    }
  }
  return fallback;
}

function categories(node: Node): string[] {
  const out: string[] = [];
  for (const c of asArray(node) as Node[]) {
    const t = text(c);
    if (t) out.push(t);
  }
  return out;
}

function rssItem(it: Record<string, Node>): FeedItem {
  const guidNode = it.guid;
  const guid = text(guidNode);
  let link = text(it.link);
  if (!link && it['atom:link']) link = atomLink(it['atom:link']);
  if (!link && guid && /^https?:\/\//i.test(guid)) {
    const isPermalink =
      typeof guidNode === 'object' && guidNode !== null
        ? text((guidNode as Record<string, Node>)['@_isPermaLink']) !== 'false'
        : true;
    if (isPermalink) link = guid;
  }
  return {
    title: text(it.title) ?? '',
    link,
    guid,
    published: text(it.pubDate) ?? text(it['dc:date']) ?? text(it.date) ?? text(it.published) ?? text(it.updated),
    summary: text(it.description) ?? text(it.summary) ?? text(it['content:encoded']),
    categories: [...categories(it.category), ...categories(it['dc:subject'])],
  };
}

export function parseFeed(xml: string): ParsedFeed {
  let doc: Record<string, Node>;
  try {
    doc = parser.parse(xml) as Record<string, Node>;
  } catch (e) {
    throw new FeedParseError(`XML could not be parsed: ${(e as Error).message}`);
  }

  const rss = doc.rss as Record<string, Node> | undefined;
  if (rss && rss.channel) {
    const channel = (Array.isArray(rss.channel) ? rss.channel[0] : rss.channel) as Record<string, Node>;
    const items = (asArray(channel.item) as Record<string, Node>[]).map(rssItem);
    return { format: 'rss', title: text(channel.title), items };
  }

  const rdf = (doc['rdf:RDF'] ?? doc.RDF) as Record<string, Node> | undefined;
  if (rdf) {
    const channel = (Array.isArray(rdf.channel) ? rdf.channel[0] : rdf.channel) as Record<string, Node> | undefined;
    const items = (asArray(rdf.item) as Record<string, Node>[]).map(rssItem);
    return { format: 'rdf', title: channel ? text(channel.title) : null, items };
  }

  const feed = doc.feed as Record<string, Node> | undefined;
  if (feed) {
    const items = (asArray(feed.entry) as Record<string, Node>[]).map((e) => ({
      title: text(e.title) ?? '',
      link: atomLink(e.link),
      guid: text(e.id),
      published: text(e.published) ?? text(e.updated) ?? text(e['dc:date']),
      summary: text(e.summary) ?? text(e.content),
      categories: categories(e.category),
    }));
    return { format: 'atom', title: text(feed.title), items };
  }

  throw new FeedParseError('Document is not an RSS, RDF, or Atom feed.');
}

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}
