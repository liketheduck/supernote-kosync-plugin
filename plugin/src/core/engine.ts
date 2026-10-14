// Reading-position sync for the document open in the Supernote reader.
//
// Behaviour follows KOReader's kosync plugin with CWA's defaults:
//   * on opening a book (and on waking the device) pull the shared position;
//     if it is ahead of the reader, offer to jump there;
//   * after the reader settles on a new page, push it;
//   * a position behind the reader is never applied automatically.
// The engine is driven by `tick()` calls and talks to the device and server only
// through `Host`, so it runs unchanged under tests.

import {type Anchor, anchorForPage, findAnchorPage, pageWords, ANCHOR_WORDS} from './anchor.ts';
import {
  type Format,
  type RemotePosition,
  epubPush,
  formatOf,
  parseRemote,
  pdfLocatorPage,
  pdfPush,
  percentagePage,
  progressPath,
  serverError,
} from './kosync.ts';

export interface Settings {
  url: string;
  username: string;
  hasPassword: boolean;
  deviceId: string;
  deviceName: string;
  autoSync: boolean;
  askBeforeJump: boolean;
}

export interface HttpResult {
  status: number;
  body: string;
}

export interface JumpPrompt {
  book: string;
  device: string;
  /** 0-based target and current pages. */
  targetPage: number;
  currentPage: number;
  total: number;
  /** How the target was found: exact words, exact page, or an approximate percentage. */
  method: 'anchor' | 'page' | 'percentage';
  percentage: number | null;
  /** Unix seconds of the shared position. */
  timestamp: number;
}

export interface BookState {
  /** Remote timestamp the user declined to jump to; not offered again automatically. */
  declined?: number;
  /** A position that could not be sent yet. */
  pending?: {page: number; total: number};
  lastPushed?: {page: number; total: number; at: number};
}

export interface Host {
  now(): number;
  /** Waits `ms`. Must not rely on JavaScript timers (frozen while the plugin view is hidden). */
  sleep(ms: number): Promise<void>;
  settings(): Promise<Settings>;
  currentFile(): Promise<string | null>;
  pageInfo(): Promise<{page: number; total: number}>;
  pageText(page: number): Promise<string>;
  digest(path: string): Promise<string>;
  online(): Promise<boolean>;
  request(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<HttpResult>;
  loadState(key: string): Promise<BookState | null>;
  saveState(key: string, state: BookState): Promise<void>;
  jump(page: number): Promise<void>;
  /** true = go, false = stay, null = closed without answering. */
  ask(prompt: JumpPrompt): Promise<boolean | null>;
  log(line: string): void;
}

export interface Status {
  /** File name of the open document, if any. */
  book: string | null;
  title: string | null;
  message: string;
  error: boolean;
  lastPull: string | null;
  lastPush: string | null;
}

interface OpenBook {
  path: string;
  name: string;
  format: Format;
  digest: string;
  total: number;
  page: number;
  /** Page known to match the server (pushed, jumped to, or the page the book opened on). */
  syncedPage: number;
  /** When the reader last moved to `page`, or null when there is nothing new to push. */
  movedAt: number | null;
  /** When the page count last changed (opening, pagination, font change). */
  totalChangedAt: number;
  pulled: boolean;
  nextPullAt: number;
  pullFailures: number;
  nextPushAt: number;
  pushFailures: number;
  title: string | null;
  state: BookState;
}

/** Time a page must stay unchanged before it is pushed. */
export const SETTLE_MS = 4000;
/** The page count must be unchanged this long before positions are compared. */
export const STABLE_MS = 5000;
/** A pause in ticks longer than this means the device slept; pull again on wake. */
export const RESUME_GAP_MS = 120000;
const MAX_BACKOFF_MS = 300000;
/** Longest time spent searching a book's pages for a shared position. */
export const SEARCH_LIMIT_MS = 60000;

const backoff = (failures: number) => Math.min(MAX_BACKOFF_MS, 5000 * 2 ** Math.min(failures, 6));

function fileName(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name.replace(/\.(epub|pdf)$/i, '');
}

function describeTime(seconds: number, now: number): string {
  if (!seconds) {
    return '';
  }
  const minutes = Math.max(0, Math.round((now / 1000 - seconds) / 60));
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours} h ago`;
  }
  return `${Math.round(hours / 24)} days ago`;
}

export class SyncEngine {
  status: Status = {book: null, title: null, message: 'Starting…', error: false, lastPull: null, lastPush: null};
  private book: OpenBook | null = null;
  private settingsCache: Settings | null = null;
  private capabilities: Set<string> | null = null;
  private running = false;
  private again = false;
  private lastTickAt = 0;
  private listeners = new Set<() => void>();
  private stopped = false;

  private host: Host;

  constructor(host: Host) {
    this.host = host;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(message: string, error = false) {
    this.status = {...this.status, message, error};
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // UI listeners must not break sync
      }
    }
  }

  /** Forget cached settings and server capabilities (after the user edits them). */
  reloadSettings() {
    this.settingsCache = null;
    this.capabilities = null;
    if (this.book) {
      // A different server or account: its position must be read before anything is sent.
      this.book.pulled = false;
      this.book.nextPullAt = 0;
    }
  }

  stop() {
    this.stopped = true;
  }

  /** Resolves once no sync step is running. */
  async whenIdle(): Promise<void> {
    while (this.running) {
      await this.host.sleep(100);
    }
  }

  resume() {
    this.stopped = false;
  }

  /** Runs one sync step; overlapping calls are coalesced. */
  async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.step();
      } while (this.again && !this.stopped);
    } catch (error) {
      this.host.log(`tick failed: ${(error as Error)?.message}`);
    } finally {
      this.running = false;
      // Measured from the end of a step, so a long search or prompt is not mistaken for sleep.
      this.lastTickAt = this.host.now();
    }
  }

  /** User-requested sync: pull, offer a jump if the shared position is ahead, otherwise push. */
  async syncNow(): Promise<void> {
    await this.exclusive(async () => {
      let book = await this.refreshBook();
      for (let waited = 0; book && this.host.now() - book.totalChangedAt < STABLE_MS && waited < 20; waited++) {
        this.setStatus('Waiting for the reader to finish laying out the book…');
        await this.host.sleep(1000);
        book = await this.refreshBook();
      }
      if (!book) {
        return;
      }
      if (this.host.now() - book.totalChangedAt < STABLE_MS) {
        this.setStatus('The reader is still laying out this book. Try again in a moment.');
        return;
      }
      const outcome = await this.pull(book, true);
      // Nothing newer elsewhere: make sure this page is what the server holds.
      if (outcome === 'behind' || outcome === 'none' || outcome === 'own') {
        if (book.state.lastPushed?.page !== book.page || book.state.lastPushed?.total !== book.total || outcome !== 'own') {
          await this.push(book, true);
        } else {
          this.setStatus(`Up to date at page ${book.page + 1}.`);
        }
      }
    });
  }

  private async exclusive(work: () => Promise<void>) {
    while (this.running) {
      await this.host.sleep(100);
    }
    this.running = true;
    try {
      await work();
    } catch (error) {
      this.setStatus((error as Error)?.message || 'Sync failed', true);
    } finally {
      this.running = false;
    }
  }

  private async settings(): Promise<Settings> {
    if (!this.settingsCache) {
      this.settingsCache = await this.host.settings();
    }
    return this.settingsCache;
  }

  private configured(s: Settings) {
    return Boolean(s.url && s.username && s.hasPassword);
  }

  /** Reads the reader's current document and page, opening the book when it changed. */
  private async refreshBook(): Promise<OpenBook | null> {
    const s = await this.settings();
    if (!this.configured(s)) {
      this.book = null;
      this.status = {...this.status, book: null, title: null};
      this.setStatus('Enter your KOSync server details below.');
      return null;
    }
    const path = await this.host.currentFile();
    const format = path ? formatOf(path) : null;
    // The host remembers the last file after the reader closes it; the page
    // query then fails, which means no document is open.
    let info: {page: number; total: number} | null = null;
    if (path && format) {
      try {
        info = await this.host.pageInfo();
      } catch {
        info = null;
      }
    }
    if (!path || !format || !info) {
      if (this.book) {
        await this.keepUnsentMovement(this.book);
        this.book = null;
        this.status = {...this.status, book: null, title: null, lastPull: null, lastPush: null};
      }
      this.setStatus('Open an EPUB or PDF to sync its reading position.');
      return null;
    }
    if (this.book && this.book.path !== path) {
      await this.keepUnsentMovement(this.book);
    }
    if (this.book && this.book.path === path) {
      const {page, total} = info;
      const book = this.book;
      if (total !== book.total) {
        // Font or layout change: page numbers moved but the reader did not.
        this.host.log(`layout changed ${book.total} -> ${total} pages`);
        book.total = total;
        book.page = page;
        book.syncedPage = page;
        book.movedAt = null;
        book.totalChangedAt = this.host.now();
      } else if (page !== book.page) {
        book.page = page;
        book.movedAt = this.host.now();
      }
      return book;
    }
    let digest: string;
    try {
      digest = await this.host.digest(path);
    } catch (error) {
      this.book = null;
      this.status = {...this.status, book: fileName(path), title: null};
      const message = (error as Error)?.message ?? '';
      this.setStatus(
        /whitelist|not allowed/i.test(message)
          ? 'Plugins cannot read books in this folder. Keep books in Document or on the SD card.'
          : `Cannot read this book (${message || 'unknown error'}).`,
        true,
      );
      return null;
    }
    const {page, total} = info;
    const state = (await this.host.loadState(digest)) ?? {};
    this.book = {
      path,
      name: fileName(path),
      format,
      digest,
      total,
      page,
      syncedPage: page,
      movedAt: null,
      totalChangedAt: this.host.now(),
      pulled: false,
      nextPullAt: 0,
      pullFailures: 0,
      nextPushAt: 0,
      pushFailures: 0,
      title: null,
      state,
    };
    this.host.log(`opened ${format} ${digest} page ${page + 1}/${total}`);
    this.status = {...this.status, book: this.book.name, title: null, lastPull: null, lastPush: null};
    this.setStatus('Checking the shared position…');
    return this.book;
  }

  /**
   * The reader's page if it still shows `book` with the same layout, else null.
   * Used before acting on anything computed earlier (a search, a question, page text).
   */
  private async stillOn(book: OpenBook): Promise<number | null> {
    if (this.book !== book || (await this.host.currentFile()) !== book.path) {
      return null;
    }
    try {
      const {page, total} = await this.host.pageInfo();
      return total === book.total ? page : null;
    } catch {
      return null;
    }
  }

  /** A book is closing with a page that was never sent: keep it for the next open. */
  private async keepUnsentMovement(book: OpenBook) {
    if (book.movedAt !== null && book.page !== book.syncedPage) {
      book.state = {...book.state, pending: {page: book.page, total: book.total}};
      await this.saveState(book);
      this.host.log(`kept unsent page ${book.page + 1} for later`);
    }
  }

  private async step() {
    const previousTick = this.lastTickAt;
    const now = this.host.now();
    const openedBefore = this.book?.path;
    const book = await this.refreshBook();
    if (!book) {
      return;
    }
    const s = await this.settings();
    if (!s.autoSync) {
      if (!this.status.message.startsWith('Auto')) {
        this.setStatus('Automatic sync is off. Use Sync now.');
      }
      return;
    }
    const woke = previousTick > 0 && now - previousTick > RESUME_GAP_MS && openedBefore === book.path;
    if (woke) {
      this.host.log('resumed; pulling again');
      book.pulled = false;
      book.nextPullAt = 0;
    }
    if (now - book.totalChangedAt < STABLE_MS) {
      return; // still paginating: page numbers are not final yet
    }
    if (!book.pulled) {
      if (now >= book.nextPullAt) {
        await this.pull(book, false);
      }
      return;
    }
    const settled = book.movedAt !== null && now - book.movedAt >= SETTLE_MS;
    if (settled && book.page !== book.syncedPage && now >= book.nextPushAt) {
      await this.push(book, false);
    }
  }

  private async ensureCapabilities(): Promise<Set<string>> {
    if (!this.capabilities) {
      const result = await this.host.request('GET', '/users/auth');
      if (result.status !== 200) {
        throw new Error(serverError(result.status, result.body));
      }
      let names: string[] = [];
      try {
        const parsed = JSON.parse(result.body);
        names = Array.isArray(parsed?.capabilities) ? parsed.capabilities.filter((x: unknown) => typeof x === 'string') : [];
      } catch {
        names = [];
      }
      this.capabilities = new Set(names);
      this.host.log(`server capabilities: ${names.join(',') || 'none'}`);
    }
    return this.capabilities;
  }

  /** Checks the server address and login; returns the capabilities it reports. */
  async testConnection(): Promise<string[]> {
    this.capabilities = null;
    this.settingsCache = null;
    return [...(await this.ensureCapabilities())];
  }

  private async pull(
    book: OpenBook,
    manual: boolean,
  ): Promise<'ahead-jumped' | 'declined' | 'behind' | 'same' | 'none' | 'own' | 'failed' | 'unplaceable'> {
    const now = this.host.now();
    if (!(await this.host.online())) {
      book.nextPullAt = now + 15000;
      this.setStatus('Waiting for Wi-Fi…');
      return 'failed';
    }
    let result: HttpResult;
    try {
      result = await this.host.request('GET', progressPath(book.digest));
    } catch (error) {
      book.pullFailures++;
      book.nextPullAt = now + backoff(book.pullFailures);
      this.host.log(`pull failed: ${(error as Error)?.message}`);
      this.setStatus('Cannot reach the sync server. Will retry.', true);
      return 'failed';
    }
    if (result.status !== 200) {
      book.pullFailures++;
      book.nextPullAt = now + backoff(book.pullFailures + 3);
      this.setStatus(serverError(result.status, result.body), true);
      return 'failed';
    }
    let body: unknown = null;
    try {
      body = JSON.parse(result.body);
    } catch {
      body = null;
    }
    if (!body || typeof body !== 'object') {
      // A captive portal or proxy page, not a KOSync reply.
      book.pullFailures++;
      book.nextPullAt = now + backoff(book.pullFailures + 3);
      this.setStatus('The server address did not answer like a KOSync server.', true);
      return 'failed';
    }
    book.pulled = true;
    book.pullFailures = 0;
    if (body && typeof body === 'object' && typeof (body as any).calibre_book_title === 'string') {
      book.title = (body as any).calibre_book_title;
      this.status = {...this.status, title: book.title};
    }
    const remote = parseRemote(body);
    const s = await this.settings();
    this.status = {...this.status, lastPull: new Date(now).toISOString()};
    if (!remote) {
      this.setStatus('No shared position yet. Turning a page will save one.');
      await this.flushPending(book);
      return 'none';
    }
    const who = remote.device || 'another device';
    if (remote.deviceId === s.deviceId) {
      this.setStatus(`Up to date (last saved from this Supernote ${describeTime(remote.timestamp, now)}).`);
      await this.flushPending(book);
      return 'own';
    }
    const target = await this.resolveTarget(book, remote);
    const current = await this.stillOn(book);
    if (current === null) {
      book.pulled = false; // the reader changed while searching; check again on the next step
      return 'failed';
    }
    if (current !== book.page) {
      book.page = current;
      book.movedAt = this.host.now();
    }
    if (!target) {
      this.setStatus(`${who} has a position this file cannot show (different format?).`);
      return 'unplaceable';
    }
    this.host.log(`remote ${remote.kind} from ${who}: page ${target.page + 1} via ${target.method}; reader on ${book.page + 1}`);
    if (target.page === book.page) {
      book.syncedPage = book.page;
      this.setStatus(`In sync with ${who}.`);
      return 'same';
    }
    if (target.page < book.page) {
      this.setStatus(`You are ahead of ${who} (page ${target.page + 1}).`);
      const pushedBefore = book.state.lastPushed;
      if (pushedBefore && (pushedBefore.page !== book.page || pushedBefore.total !== book.total)) {
        // This Supernote read further than it last reported (offline, or closed before the push).
        await this.push(book, false);
      } else {
        await this.flushPending(book);
      }
      return 'behind';
    }
    if (!manual && remote.timestamp > 0 && book.state.declined === remote.timestamp) {
      this.setStatus(`${who} is at page ${target.page + 1}. Use Sync now to jump there.`);
      return 'declined';
    }
    const prompt: JumpPrompt = {
      book: book.title || book.name,
      device: who,
      targetPage: target.page,
      currentPage: book.page,
      total: book.total,
      method: target.method,
      percentage: remote.percentage,
      timestamp: remote.timestamp,
    };
    const answer = s.askBeforeJump ? await this.host.ask(prompt) : true;
    if (this.book !== book) {
      return 'declined';
    }
    if (answer !== true) {
      if (answer === false && remote.timestamp > 0) {
        book.state = {...book.state, declined: remote.timestamp};
        await this.saveState(book);
      }
      this.setStatus(`Stayed on page ${book.page + 1}. ${who} is at page ${target.page + 1}.`);
      return 'declined';
    }
    const now2 = await this.stillOn(book);
    if (now2 === null || now2 >= target.page) {
      this.setStatus(now2 === null ? 'The reader changed; not jumping.' : `Already at page ${now2 + 1}.`);
      return 'declined';
    }
    await this.jumpTo(book, target.page, who);
    return 'ahead-jumped';
  }

  private async resolveTarget(
    book: OpenBook,
    remote: RemotePosition,
  ): Promise<{page: number; method: JumpPrompt['method']} | null> {
    const estimate = remote.percentage !== null ? percentagePage(remote.percentage, book.total) : book.page;
    if (remote.anchor) {
      this.setStatus(`Finding the position from ${remote.device || 'another device'} in this book…`);
      const deadline = this.host.now() + SEARCH_LIMIT_MS;
      const found = await findAnchorPage(remote.anchor, {
        total: book.total,
        read: page => {
          if (this.host.now() > deadline) {
            throw new Error('search time limit');
          }
          return this.host.pageText(page);
        },
      }, estimate);
      this.host.log(`anchor search: ${found ? `page ${found.page + 1}` : 'not found'} after ${found?.reads ?? '?'} reads`);
      if (found) {
        return {page: found.page, method: 'anchor'};
      }
    }
    if (book.format === 'pdf' && remote.kind === 'locator') {
      const page = pdfLocatorPage(remote.progress, book.total);
      if (page !== null) {
        return {page, method: 'page'};
      }
    }
    if (remote.percentage !== null) {
      return {page: estimate, method: 'percentage'};
    }
    return null;
  }

  private async jumpTo(book: OpenBook, page: number, who: string) {
    const path = await this.host.currentFile();
    if (path !== book.path) {
      return;
    }
    await this.host.jump(page);
    let actual = -1;
    for (let attempt = 0; attempt < 15; attempt++) {
      await this.host.sleep(200);
      actual = (await this.host.pageInfo()).page;
      if (actual === page) {
        break;
      }
    }
    book.page = actual >= 0 ? actual : page;
    book.syncedPage = book.page;
    book.movedAt = null;
    if (actual === page) {
      this.setStatus(`Jumped to page ${page + 1} from ${who}.`);
    } else {
      this.setStatus(`Asked the reader to open page ${page + 1}; it shows page ${actual + 1}.`, true);
    }
  }

  /** Sends a position saved while offline, if the reader is still on it. */
  private async flushPending(book: OpenBook) {
    const pending = book.state.pending;
    if (pending && pending.page === book.page && pending.total === book.total) {
      await this.push(book, false);
    }
  }

  /**
   * Words that open the page, with the end of the previous page as context: a
   * heading alone is also in the table of contents, but what precedes it is not.
   */
  private async anchorFor(book: OpenBook): Promise<Anchor | null> {
    let text: string;
    try {
      text = await this.host.pageText(book.page);
    } catch {
      return null; // no words for this page: the percentage is sent alone
    }
    let next = '';
    if (pageWords(text).length <= ANCHOR_WORDS && book.page + 1 < book.total) {
      next = await this.host.pageText(book.page + 1).catch(() => '');
    }
    const previous = book.page > 0 ? await this.host.pageText(book.page - 1).catch(() => '') : '';
    return anchorForPage(text, next, previous);
  }

  private async push(book: OpenBook, manual: boolean) {
    const now = this.host.now();
    const s = await this.settings();
    const page = book.page;
    const total = book.total;
    const record = async (pending: boolean) => {
      book.state = pending ? {...book.state, pending: {page, total}} : book.state;
      await this.saveState(book);
    };
    if (!(await this.host.online())) {
      book.nextPushAt = now + 15000;
      await record(true);
      this.setStatus(`Page ${page + 1} will sync when Wi-Fi is back.`);
      return;
    }
    let body: unknown;
    try {
      if (book.format === 'pdf') {
        body = pdfPush(book.digest, page, total, {device: s.deviceName, deviceId: s.deviceId});
      } else {
        const capabilities = await this.ensureCapabilities();
        if (!capabilities.has('percentage_push')) {
          book.syncedPage = page;
          this.setStatus('This server cannot store EPUB positions from Supernote. Use Calibre-Web-Automated (NextGen).', true);
          return;
        }
        const anchor = capabilities.has('anchor') ? await this.anchorFor(book) : null;
        body = epubPush(book.digest, page, total, anchor, {device: s.deviceName, deviceId: s.deviceId});
      }
    } catch (error) {
      book.pushFailures++;
      book.nextPushAt = now + backoff(book.pushFailures);
      this.setStatus((error as Error)?.message || 'Could not read the page', true);
      return;
    }
    if ((await this.stillOn(book)) !== page) {
      return; // the reader moved or changed book while the page was read; the next step handles it
    }
    let result: HttpResult;
    try {
      result = await this.host.request('PUT', '/syncs/progress', body);
    } catch (error) {
      book.pushFailures++;
      book.nextPushAt = now + backoff(book.pushFailures);
      await record(true);
      this.host.log(`push failed: ${(error as Error)?.message}`);
      this.setStatus(`Page ${page + 1} not sent yet (server unreachable). Will retry.`, true);
      return;
    }
    let reply: any = null;
    try {
      reply = JSON.parse(result.body);
    } catch {
      reply = null;
    }
    if (result.status !== 200 || !reply || typeof reply !== 'object') {
      book.pushFailures++;
      book.nextPushAt = now + backoff(book.pushFailures + 3);
      await record(true);
      this.setStatus(
        result.status === 200 ? 'The server address did not answer like a KOSync server.' : serverError(result.status, result.body),
        true,
      );
      return;
    }
    book.pushFailures = 0;
    book.syncedPage = page;
    if (book.page === page) {
      book.movedAt = null;
    }
    const {pending, ...rest} = book.state;
    book.state = {...rest, lastPushed: {page, total, at: now}};
    await this.saveState(book);
    this.host.log(`pushed page ${page + 1}/${total}${manual ? ' (manual)' : ''}`);
    this.status = {...this.status, lastPush: new Date(now).toISOString()};
    // CWA keeps the furthest position across devices and still answers 200 when
    // it keeps another device's; read back to report what the server holds.
    const kept = await this.readBack(book);
    if (kept && kept.deviceId !== s.deviceId) {
      this.setStatus(`Page ${page + 1} sent, but the server keeps ${kept.device || 'another device'}'s position further ahead.`);
      return;
    }
    this.setStatus(`Saved page ${page + 1} of ${total}.`);
  }

  private async readBack(book: OpenBook): Promise<RemotePosition | null> {
    try {
      const result = await this.host.request('GET', progressPath(book.digest));
      return result.status === 200 ? parseRemote(JSON.parse(result.body)) : null;
    } catch {
      return null;
    }
  }

  private async saveState(book: OpenBook) {
    try {
      await this.host.saveState(book.digest, book.state);
    } catch (error) {
      this.host.log(`state save failed: ${(error as Error)?.message}`);
    }
  }
}
