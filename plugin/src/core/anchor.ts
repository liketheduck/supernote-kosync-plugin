// Text anchors: a reading position named by the book's own words.
//
// Calibre-Web-NextGen accepts `{text, before, after}` on a percentage push and
// converts it into a KOReader XPointer in the library EPUB; on a pull it returns
// the anchor for the shared position. The Supernote reader exposes each page's
// text, so the device names its position by the words that open the current
// page, and finds an incoming anchor by searching page text.
//
// The search follows the server's own rules (text_anchor._find): try the
// anchor with both contexts, then with one, require a needle of at least
// MIN_NEEDLE folded characters, and accept the nearest of several matches only
// when every other one is further from the expected place by more than
// WINDOW of the book. Anything short of that is reported as not found.

import {fold, foldLetters} from './fold.ts';

export interface Anchor {
  text: string;
  before?: string;
  after?: string;
}

export const ANCHOR_WORDS = 8;
export const MAX_TEXT_CHARS = 200;
export const MAX_CONTEXT_CHARS = 600;
export const MIN_NEEDLE = 12;
export const WINDOW = 0.05;

/** Words of a page, keeping only tokens that contain something comparable. */
export function pageWords(text: string): string[] {
  return joinHyphenatedBreaks(text).split(/\s+/).filter(word => fold(word).length > 0);
}

/**
 * Rejoins words a reader split across a line break with a hyphen
 * ("posi-\ntion" \u2192 "position"). Real hyphenated compounds keep their hyphen
 * because they are not followed by a line break.
 */
export function joinHyphenatedBreaks(text: string): string {
  return text.replace(HYPHEN_BREAK, '$1$2');
}

const HYPHEN_BREAK: RegExp = (() => {
  try {
    return new RegExp('(\\p{L})[-\\u00ad\\u2010]\\s*\\n\\s*(\\p{Ll})', 'gu');
  } catch {
    return /([A-Za-z\u00c0-\u024f])[-\u00ad\u2010]\s*\n\s*([a-z\u00df-\u024f])/g;
  }
})();

function bounded(words: string[], fromEnd: boolean): string {
  const list = [...words];
  while (list.length && list.join(' ').length > MAX_CONTEXT_CHARS) {
    if (fromEnd) {
      list.shift();
    } else {
      list.pop();
    }
  }
  return list.join(' ');
}

/**
 * Offset in `page` where its first line of body text starts, skipping leading
 * short lines (a chapter heading, or the last line of a paragraph from the
 * previous page). A heading alone also appears in the table of contents, so
 * anchoring on it can place the position there. Pages whose lines are all
 * short (verse, lists) start at 0.
 */
export function bodyStart(page: string): number {
  const lines = page.split('\n');
  const lengths = lines.map(line => line.trim().length).filter(n => n > 0).sort((a, b) => a - b);
  if (lengths.length < 4) {
    return 0;
  }
  const typical = lengths[Math.floor(lengths.length * 0.75)];
  if (typical < 30) {
    return 0;
  }
  let offset = 0;
  for (let i = 0; i < Math.min(lines.length, 6); i++) {
    const length = lines[i].trim().length;
    if (length >= 0.6 * typical) {
      return offset;
    }
    offset += lines[i].length + 1;
  }
  return 0;
}

/**
 * Anchor for a page: the first word of its body text, the following words as
 * context (continuing onto `nextPage` when the page is short) and the words
 * before it (skipped heading lines, then the end of `previousPage`). Returns
 * null for a page without text.
 */
export function anchorForPage(page: string, nextPage = '', previousPage = ''): Anchor | null {
  const start = bodyStart(page);
  const words = pageWords(page.slice(start));
  if (!words.length) {
    return null;
  }
  const text = words[0].slice(0, MAX_TEXT_CHARS);
  let after = words.slice(1, 1 + ANCHOR_WORDS);
  if (after.length < ANCHOR_WORDS && nextPage) {
    after = after.concat(pageWords(nextPage).slice(0, ANCHOR_WORDS - after.length));
  }
  let before = pageWords(page.slice(0, start)).slice(-ANCHOR_WORDS);
  if (before.length < ANCHOR_WORDS && previousPage) {
    before = pageWords(previousPage).slice(-(ANCHOR_WORDS - before.length)).concat(before);
  }
  const anchor: Anchor = {text, after: bounded(after, false)};
  if (before.length) {
    anchor.before = bounded(before, true);
  }
  return anchor;
}

/** Validates an anchor received from the server. */
export function parseAnchor(raw: unknown): Anchor | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const text = value.text;
  const before = value.before ?? '';
  const after = value.after ?? '';
  if (typeof text !== 'string' || typeof before !== 'string' || typeof after !== 'string') {
    return null;
  }
  if (!fold(text)) {
    return null;
  }
  return {text, before, after};
}

export interface PageSource {
  total: number;
  /** Text of page `index` (0-based); may throw or return '' for pages without text. */
  read(index: number): Promise<string>;
}

export interface AnchorSearch {
  /** 0-based page where the anchor's first word starts. */
  page: number;
  /** How many pages were read to decide. */
  reads: number;
}

interface Needle {
  value: string;
  /** Offset of the anchor's first word inside `value`. */
  offset: number;
}

function needles(anchor: Anchor, form: (text: string) => string = fold): Needle[] {
  const before = form(anchor.before ?? '');
  const text = form(anchor.text);
  const after = form(anchor.after ?? '');
  return [
    {value: before + text + after, offset: before.length},
    {value: text + after, offset: 0},
    {value: before + text, offset: before.length},
  ].filter(needle => needle.value.length >= MIN_NEEDLE);
}

/** Pages in order of distance from `start`, ties broken forward first. */
function* outward(start: number, total: number): Generator<number> {
  yield start;
  for (let d = 1; start + d < total || start - d >= 0; d++) {
    if (start + d < total) {
      yield start + d;
    }
    if (start - d >= 0) {
      yield start - d;
    }
  }
}

/**
 * Finds the page holding `anchor`, searching outward from `estimate`.
 *
 * The anchor is matched with and without each side of its context, because
 * context words the reader does not display (navigation lists, hidden
 * headings) or shows differently make a long needle miss. The answer is the
 * matching page nearest the estimate, accepted only when every other matching
 * page is both further than WINDOW of the book beyond it and at least twice as
 * far from the estimate. Reading stops as soon as that is
 * certain, or after `maxReads` pages. Strict comparison is tried first; letters
 * only (ignoring digits and punctuation) only when nothing matched at all.
 */
export async function findAnchorPage(
  anchor: Anchor,
  source: PageSource,
  estimate: number,
  maxReads = 1500,
): Promise<AnchorSearch | null> {
  // Raw page texts are shared by both passes; the read budget covers both.
  const raw = new Map<number, string>();
  let reads = 0;
  const cached: PageSource = {
    total: source.total,
    read: async index => {
      const known = raw.get(index);
      if (known !== undefined) {
        return known;
      }
      if (reads >= maxReads) {
        throw new BudgetExhausted();
      }
      reads++;
      let text: string;
      try {
        text = await source.read(index);
      } catch {
        // The reader did not answer (or time ran out): stop rather than guess
        // from pages that were never read.
        reads = maxReads;
        throw new BudgetExhausted();
      }
      raw.set(index, text);
      return text;
    },
  };
  const strict = await searchPages(anchor, cached, estimate, fold);
  if (strict !== NO_MATCH) {
    return strict && {page: strict.page, reads};
  }
  const loose = await searchPages(anchor, cached, estimate, foldLetters);
  return loose && loose !== NO_MATCH ? {page: loose.page, reads} : null;
}

class BudgetExhausted extends Error {}
/** No needle matched anywhere that was read (as opposed to an ambiguous match). */
const NO_MATCH = Object.freeze({page: -1, reads: -1});

async function searchPages(
  anchor: Anchor,
  source: PageSource,
  estimate: number,
  form: (text: string) => string,
): Promise<AnchorSearch | null> {
  const total = source.total;
  if (total <= 0) {
    return null;
  }
  const candidates = needles(anchor, form);
  if (!candidates.length) {
    return null;
  }
  const start = Math.min(Math.max(Math.round(estimate), 0), total - 1);
  const window = Math.max(2, Math.ceil(WINDOW * total));
  const longest = Math.max(...candidates.map(n => n.value.length));
  const cache = new Map<number, string>();
  const reads = 0;
  const folded = async (index: number): Promise<string | null> => {
    if (index < 0 || index >= total) {
      return '';
    }
    const known = cache.get(index);
    if (known !== undefined) {
      return known;
    }
    try {
      const text = form(joinHyphenatedBreaks(await source.read(index)));
      cache.set(index, text);
      return text;
    } catch {
      return null; // read budget exhausted
    }
  };
  // hits[k]: pages (in reading order, so by distance) where needle k's word starts.
  const hits: number[][] = candidates.map(() => []);
  const distance = (page: number) => Math.abs(page - start);
  /**
   * The decision once every page within `reached` has been examined, or
   * undefined to keep reading. Matches of every needle are pooled: the reader's
   * text often differs from the book's right at the true place (footnote
   * markers, punctuation at a page break), so the most specific needle may only
   * match a quotation or a table of contents elsewhere. The nearest match to the
   * expected place wins, unless another lies within WINDOW of it.
   */
  const decide = (reached: number, finished: boolean): AnchorSearch | null | undefined => {
    const pages = [...new Set(hits.flat())].sort((a, b) => distance(a) - distance(b));
    if (!pages.length) {
      return finished ? NO_MATCH : undefined;
    }
    const nearest = distance(pages[0]);
    // Another match about as near the estimate (within WINDOW, or less than
    // twice as far) means the estimate cannot tell them apart.
    if (pages.length > 1 && (distance(pages[1]) - nearest <= window || distance(pages[1]) < 2 * nearest)) {
      return null;
    }
    if (finished || reached >= Math.max(nearest + window, 2 * nearest)) {
      return {page: pages[0], reads};
    }
    return undefined; // a close repeat could still appear
  };
  for (const index of outward(start, total)) {
    const page = await folded(index);
    const previous = await folded(index - 1);
    const next = await folded(index + 1);
    if (page === null || previous === null || next === null) {
      // Out of reads: answer only if what was read already settles it.
      return decide(distance(index) - 1, false) ?? (hits.every(found => !found.length) ? NO_MATCH : null);
    }
    const head = previous.slice(Math.max(0, previous.length - longest));
    const span = head + page + next.slice(0, longest);
    candidates.forEach((needle, k) => {
      let at = span.indexOf(needle.value);
      while (at >= 0) {
        const wordStart = at + needle.offset - head.length;
        if (wordStart >= 0 && wordStart < page.length && !hits[k].includes(index)) {
          hits[k].push(index);
        }
        at = span.indexOf(needle.value, at + 1);
      }
    });
    // Pages are visited in rings (start+d, then start-d); decide once a ring is complete.
    if (index <= start || start - distance(index) < 0) {
      const decision = decide(distance(index), false);
      if (decision !== undefined) {
        return decision;
      }
    }
  }
  return decide(total, true) ?? null;
}

