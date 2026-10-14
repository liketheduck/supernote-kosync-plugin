// KOSync wire format, as spoken by KOReader's kosync plugin and extended by
// Calibre-Web-NextGen (CWA). Pure functions only; HTTP lives in the native module.

import {type Anchor, parseAnchor} from './anchor.ts';

/** Server-side sentinel for a percentage without a locator (CWA). Never a position. */
export const PERCENTAGE_ONLY_LOCATOR = 'cwng:percentage';

/** Position kinds this client can act on, sent as `?position_kinds=` on GET. */
export const POSITION_KINDS = 'locator,percentage,anchor';

export type Format = 'epub' | 'pdf';

export interface RemotePosition {
  /** "locator": `progress` is an XPointer (EPUB) or page number (PDF). "percentage": only `percentage` is known. */
  kind: 'locator' | 'percentage';
  progress: string | null;
  /** Fraction 0..1. */
  percentage: number | null;
  anchor: Anchor | null;
  device: string;
  deviceId: string;
  /** Unix seconds. */
  timestamp: number;
  bookTitle: string | null;
}

export function formatOf(path: string): Format | null {
  if (/\.epub$/i.test(path)) {
    return 'epub';
  }
  if (/\.pdf$/i.test(path)) {
    return 'pdf';
  }
  return null;
}

/** A wire percentage is a fraction 0..1; anything else is ignored (SyncLogic.validWirePercentage). */
export function validPercentage(value: unknown): number | null {
  const p = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    return null;
  }
  return p;
}

/**
 * Interprets a GET /syncs/progress body. Returns null when it holds no usable
 * position. Mirrors CWNG's SyncLogic.resolveRemotePosition: the sentinel is
 * never a locator, and a body without a locator or a valid percentage is empty.
 */
export function parseRemote(body: unknown): RemotePosition | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const b = body as Record<string, unknown>;
  const percentage = validPercentage(b.percentage);
  const isSentinel = b.progress === PERCENTAGE_ONLY_LOCATOR;
  const progress =
    !isSentinel && typeof b.progress === 'string' && b.progress !== ''
      ? b.progress
      : !isSentinel && typeof b.progress === 'number' && Number.isFinite(b.progress)
        ? String(b.progress)
        : null;
  let kind: RemotePosition['kind'] | null = null;
  if (progress !== null && b.position_kind !== 'percentage') {
    kind = 'locator';
  } else if ((b.position_kind === 'percentage' || isSentinel || progress === null) && percentage !== null) {
    kind = 'percentage';
  }
  if (kind === null) {
    return null;
  }
  const timestamp = typeof b.timestamp === 'number' && Number.isFinite(b.timestamp) ? b.timestamp : 0;
  return {
    kind,
    progress: kind === 'locator' ? progress : null,
    percentage,
    anchor: parseAnchor(b.anchor),
    device: typeof b.device === 'string' ? b.device : '',
    deviceId: typeof b.device_id === 'string' ? b.device_id : '',
    timestamp,
    bookTitle: typeof b.calibre_book_title === 'string' ? b.calibre_book_title : null,
  };
}

/** True for a crengine XPointer such as /body/DocFragment[3]/body/p[4]/text().12 */
export function isXPointer(progress: string | null): boolean {
  return typeof progress === 'string' && progress.startsWith('/');
}

/** 0-based page for a PDF page-number locator ("57" → 56), or null. */
export function pdfLocatorPage(progress: string | null, total: number): number | null {
  if (progress === null || !/^\d+$/.test(progress.trim())) {
    return null;
  }
  const page = Number(progress.trim());
  if (!Number.isSafeInteger(page) || page < 1 || page > total) {
    return null;
  }
  return page - 1;
}

/**
 * 0-based page for a KOReader percentage. KOReader reports current_page /
 * page_count (1-based page), so the inverse is round(p * total) - 1.
 */
export function percentagePage(percentage: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.min(Math.max(Math.round(percentage * total) - 1, 0), total - 1);
}

/** KOReader's percentage for a 0-based page: (page + 1) / total. */
export function pagePercentage(page: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.min(Math.max((page + 1) / total, 0), 1);
}

export interface DeviceIdentity {
  device: string;
  deviceId: string;
}

/** PUT body for a PDF page, identical in shape to KOReader's own push. */
export function pdfPush(document: string, page: number, total: number, who: DeviceIdentity) {
  return {
    document,
    progress: String(page + 1),
    percentage: pagePercentage(page, total),
    device: who.device,
    device_id: who.deviceId,
  };
}

/**
 * PUT body for an EPUB page: a percentage plus the words that open the page.
 * CWA places the words in the library EPUB and stores KOReader's XPointer for
 * them; without a placeable anchor it keeps the percentage.
 */
export function epubPush(document: string, page: number, total: number, anchor: Anchor | null, who: DeviceIdentity) {
  const body: Record<string, unknown> = {
    document,
    percentage: pagePercentage(page, total),
    position_kind: 'percentage',
    device: who.device,
    device_id: who.deviceId,
  };
  if (anchor) {
    body.anchor = {text: anchor.text, before: anchor.before ?? '', after: anchor.after ?? ''};
  }
  return body;
}

export function progressPath(document: string): string {
  return `/syncs/progress/${encodeURIComponent(document)}?position_kinds=${POSITION_KINDS}`;
}

/** Human description of a server error body ({error, message}) or HTTP status. */
export function serverError(status: number, body: string): string {
  if (status === 401) {
    return 'Login rejected. Check the username and password (an app password works).';
  }
  if (status === 429) {
    return 'Too many failed logins. Wait a minute, then check the password.';
  }
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === 'string') {
      return `Server error ${status}: ${parsed.message}`;
    }
  } catch {
    // not JSON
  }
  return `Server error ${status}`;
}
