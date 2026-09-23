/**
 * HTML to clean text, plus the link graph the ranker needs.
 *
 * Deliberately cheerio and a structural walk, NOT Readability. Readability is
 * tuned for news articles and reliably mangles careers pages, handbooks and
 * hiring-process pages — which are precisely the pages this application cares
 * most about. It also drags in a full DOM implementation for no benefit here.
 *
 * Links carry their anchor text, their surrounding context and whether they sit
 * in site-wide chrome, because all three are signals the ranker uses: a link to
 * the careers page usually lives in a footer on every page, not in body copy.
 */
import * as cheerio from 'cheerio';
import { normaliseUrl } from '../net/urlGuard.js';

export interface PageLink {
  url: string;
  anchor: string;
  /** In <nav>, <header> or <footer> — i.e. site-wide chrome. */
  inChrome: boolean;
  /** Nearby text, used to spot "how we hire" phrasing around a bare "read more". */
  context: string;
  /** Path segments below the site root, for a depth penalty. */
  depth: number;
}

export interface CleanPage {
  url: string;
  title: string;
  metaDescription: string;
  siteName: string;
  headings: string[];
  /** Readable text, whitespace-collapsed and length-capped. */
  text: string;
  links: PageLink[];
  /** Parsed JSON-LD blocks; Organization and JobPosting are useful for free. */
  jsonLd: Record<string, unknown>[];
}

const MAX_TEXT_CHARS = 20_000;
const MAX_LINKS = 400;

/** Elements that never contain page content worth summarising. */
const STRIP = 'script, style, noscript, svg, iframe, template, form, [aria-hidden="true"]';

/** Candidate containers for the main content, most specific first. */
const MAIN_SELECTORS = ['main', 'article', '[role="main"]', '#content', '.content', 'body'];

/**
 * Node types derived from cheerio's own API rather than imported from domhandler,
 * which is only a transitive dependency here.
 */
type Selection = ReturnType<cheerio.CheerioAPI>;
type DomNode = Selection extends cheerio.Cheerio<infer N> ? N : never;

function tagNameOf(node: DomNode): string {
  const named = node as { tagName?: unknown };
  return typeof named.tagName === 'string' ? named.tagName.toLowerCase() : '';
}

function isTextNode(node: DomNode): node is DomNode & { data?: string } {
  return (node as { type?: unknown }).type === 'text';
}

function isTagNode(node: DomNode): boolean {
  return (node as { type?: unknown }).type === 'tag';
}

export function extractPage(html: string, baseUrl: string): CleanPage {
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim();
  const metaDescription = ($('meta[name="description"]').attr('content') ?? '').trim();
  const siteName = ($('meta[property="og:site_name"]').attr('content') ?? '').trim();

  const jsonLd: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) if (isRecord(item)) jsonLd.push(item);
      } else if (isRecord(parsed)) {
        jsonLd.push(parsed);
      }
    } catch {
      // A malformed JSON-LD block is not worth failing a page over.
    }
  });

  const links = extractLinks($, baseUrl);

  // Headings are read before stripping chrome, since some sites put the h1 in a header.
  const headings: string[] = [];
  $('h1, h2').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text !== '' && headings.length < 40) headings.push(text);
  });

  $(STRIP).remove();
  $('nav, header, footer, aside, [role="navigation"]').remove();

  let root: Selection = $('body');
  for (const selector of MAIN_SELECTORS) {
    const candidate = $(selector).first();
    if (candidate.length > 0 && candidate.text().trim().length > 0) {
      root = candidate;
      break;
    }
  }

  const text = readableText($, root);

  return {
    url: baseUrl,
    title,
    metaDescription,
    siteName,
    headings,
    text,
    links,
    jsonLd,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractLinks($: cheerio.CheerioAPI, baseUrl: string): PageLink[] {
  const seen = new Set<string>();
  const links: PageLink[] = [];

  $('a[href]').each((_, el) => {
    if (links.length >= MAX_LINKS) return;
    const node = $(el);
    const href = node.attr('href') ?? '';
    if (href === '' || href.startsWith('#')) return;
    if (/^(mailto|tel|javascript|data):/i.test(href.trim())) return;

    // Relative links resolve against the page's own URL, which is what makes
    // fixture sites served from a subdirectory work without special-casing.
    const resolved = normaliseUrl(href, baseUrl);
    if (resolved === null) return;
    const url = resolved.toString();
    if (seen.has(url)) return;
    seen.add(url);

    const anchor = node.text().replace(/\s+/g, ' ').trim().slice(0, 200);
    const inChrome = node.closest('nav, header, footer, [role="navigation"]').length > 0;
    const context = node.parent().text().replace(/\s+/g, ' ').trim().slice(0, 200);
    const depth = resolved.pathname.split('/').filter(Boolean).length;

    links.push({ url, anchor, inChrome, context, depth });
  });

  return links;
}

/**
 * Walk the retained DOM into text that reads like a document rather than a blob:
 * headings marked, list items bulleted, block boundaries preserved. Keeping that
 * structure matters because hiring-process pages express their stages as lists,
 * and flattening them loses the ordering the classifier looks for.
 */
function readableText($: cheerio.CheerioAPI, root: Selection): string {
  const parts: string[] = [];
  const BLOCK_TAGS = new Set(['p', 'div', 'section', 'tr', 'ul', 'ol', 'table', 'article']);

  const walk = (node: DomNode): void => {
    const el = $(node);
    const tag = tagNameOf(node);

    if (tag === 'br') {
      parts.push('\n');
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      parts.push(`\n\n## ${el.text().replace(/\s+/g, ' ').trim()}\n`);
      return;
    }
    if (tag === 'li') {
      parts.push(`\n- ${el.text().replace(/\s+/g, ' ').trim()}`);
      return;
    }

    const children = el.contents().toArray();
    if (children.length === 0) {
      const text = el.text();
      if (text.trim() !== '') parts.push(text);
      return;
    }

    for (const child of children) {
      if (isTextNode(child)) {
        const text = child.data ?? '';
        if (text.trim() !== '') parts.push(text);
      } else if (isTagNode(child)) {
        walk(child);
        if (BLOCK_TAGS.has(tagNameOf(child))) parts.push('\n');
      }
    }
  };

  for (const node of root.toArray()) walk(node);

  return parts
    .join(' ')
    .replace(/[​-‏‪-‮⁦-⁩]/g, '') // zero-width and bidi controls
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

/**
 * Company name, preferring structured data over guesswork.
 * Used to build search queries, so a wrong answer wastes the search budget.
 */
export function companyNameFrom(page: CleanPage, url: string): string {
  for (const block of page.jsonLd) {
    const type = block['@type'];
    const isOrg =
      type === 'Organization' ||
      type === 'Corporation' ||
      (Array.isArray(type) && type.some((t) => t === 'Organization' || t === 'Corporation'));
    if (isOrg && typeof block['name'] === 'string' && block['name'].trim() !== '') {
      return block['name'].trim();
    }
  }
  if (page.siteName !== '') return page.siteName;
  if (page.title !== '') {
    // "Acme Tools — Warehouse robotics" -> "Acme Tools"
    const head = page.title.split(/[|–—·:-]/)[0]?.trim() ?? '';
    if (head.length >= 2) return head;
  }
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const label = host.split('.')[0] ?? host;
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    return 'this company';
  }
}
