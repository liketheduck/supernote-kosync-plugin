// Developer harness for qualifying the reader side on real books.
//
// Only compiled in by `tools/build.sh --harness`. Inactive unless tools/device.py places a request at <SD card>/REQUEST with a new id.
// Results stream to logcat (tag KOSyncHarness) because PluginHost cannot write
// shared storage. Sync is paused for the whole run, so opening test copies never
// reads or writes the server, and the document that was open before is reopened
// at its page afterwards.

import {PluginCommAPI, PluginDocAPI, PluginFileAPI} from 'sn-plugin-lib';
import {dismissPrompt, engine, log, native, sleep} from './device.ts';

// Plugins may read removable storage, and it is not cloud-synced.
const REQUEST = 'kosync-test/harness.json';
const CHUNK = 3000;

/** Emits one JSON record, split into logcat-sized pieces. */
function emit(record: unknown) {
  const text = JSON.stringify(record);
  const id = Math.random().toString(36).slice(2, 10);
  const count = Math.max(1, Math.ceil(text.length / CHUNK));
  for (let i = 0; i < count; i++) {
    native.harnessOut(`${id} ${i} ${count} ${text.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
}

interface Request {
  id: string;
  files: string[];
  /** Page indexes to read, or "all" (bounded by maxPages). Default: a spread of 12. */
  pages?: number[] | 'all';
  maxPages?: number;
  /** Page indexes to navigate to with jumpToPage, verifying the reader lands there. */
  jumps?: number[];
}

let running = false;
let lastProblemLog = 0;

async function call<T>(work: () => Promise<any>): Promise<T> {
  const response = await Promise.race([work(), sleep(20000).then(() => ({success: false, error: {message: 'timeout'}}))]);
  if (response?.success !== true) {
    throw new Error(response?.error?.message ?? 'failed');
  }
  return response.result as T;
}

/** Waits until the reader shows `path` with a stable page count; records how the count evolved. */
async function waitForFile(path: string, timeline: {ms: number; total: number}[]): Promise<{page: number; total: number}> {
  const started = Date.now();
  let last = -1;
  let stableSince = 0;
  while (Date.now() - started < 180000) {
    await sleep(500);
    try {
      if ((await native.currentFile()) !== path) {
        continue;
      }
      const total = await call<number>(() => PluginDocAPI.getCurrentTotalPages());
      const page = await call<number>(() => PluginCommAPI.getCurrentPageNum());
      if (total !== last) {
        timeline.push({ms: Date.now() - started, total});
        last = total;
        stableSince = Date.now();
      } else if (total > 0 && Date.now() - stableSince >= 3000) {
        return {page, total};
      }
    } catch (error) {
      if (timeline.length < 20) {
        timeline.push({ms: Date.now() - started, total: -1});
      }
    }
  }
  throw new Error(`file did not open (page counts seen: ${timeline.map(t => t.total).join(',')})`);
}

function spread(total: number, count: number): number[] {
  const pages = new Set<number>([0, Math.min(1, total - 1), total - 1]);
  for (let i = 1; i <= count; i++) {
    pages.add(Math.floor((i * (total - 1)) / (count + 1)));
  }
  return [...pages].sort((a, b) => a - b);
}

async function runFile(path: string, request: Request) {
  const started = Date.now();
  await call<boolean>(() => PluginFileAPI.openFile(path, 0));
  const timeline: {ms: number; total: number}[] = [];
  const opened = await waitForFile(path, timeline);
  const total = opened.total;
  const wanted =
    request.pages === 'all'
      ? Array.from({length: Math.min(total, request.maxPages ?? 3000)}, (_, i) => i)
      : (request.pages ?? spread(total, 12)).filter(p => p >= 0 && p < total);
  const samples: {page: number; ms: number; text?: string; error?: string}[] = [];
  for (const page of wanted) {
    const t0 = Date.now();
    try {
      const text = await call<string>(() => PluginDocAPI.getCurrentDocText(page));
      samples.push({page, ms: Date.now() - t0, text});
    } catch (error) {
      samples.push({page, ms: Date.now() - t0, error: (error as Error).message});
    }
  }
  const jumps: {page: number; ms: number; landed: number}[] = [];
  for (const page of request.jumps ?? []) {
    if (page < 0 || page >= total) {
      continue;
    }
    const t0 = Date.now();
    await call<boolean>(() => PluginCommAPI.jumpToPage(page));
    let landed = -1;
    for (let i = 0; i < 20 && landed !== page; i++) {
      await sleep(250);
      landed = await call<number>(() => PluginCommAPI.getCurrentPageNum());
    }
    jumps.push({page, ms: Date.now() - t0, landed});
  }
  const digest = await native.digest(path);
  return {path, digest: digest.digest, total, openMs: Date.now() - started, timeline, samples, jumps};
}

/** Runs a pending harness request, if any. Returns true when one ran. */
export async function checkHarness(): Promise<boolean> {
  if (running) {
    return false;
  }
  let raw: string | null = null;
  const problems: string[] = [];
  const volumes = [...((await native.storageVolumes()) as string[]), '/sdcard/Document'];
  for (const volume of volumes) {
    raw = await native.readTextFile(`${volume}/${volume.endsWith('Document') ? 'kosync-harness.json' : REQUEST}`).catch((error: Error) => {
      problems.push(`${volume}: ${error.message}`);
      return null;
    });
    if (raw) {
      break;
    }
  }
  if (problems.length && Date.now() - lastProblemLog > 600000) {
    lastProblemLog = Date.now();
    log(`harness lookup: ${problems.join('; ')}`);
  }
  if (!raw) {
    return false;
  }
  let id: string;
  try {
    id = String(JSON.parse(raw).id);
  } catch {
    return false;
  }
  if ((await native.loadState('harness_last')) === id) {
    return false;
  }
  running = true;
  const results: any[] = [];
  let request: Request | null = null;
  let previous: {path: string; page: number} | null = null;
  try {
    await native.saveState('harness_last', id);
    engine.stop();
    dismissPrompt();
    await engine.whenIdle();
    request = JSON.parse(raw) as Request;
    const path = await native.currentFile();
    if (path) {
      previous = {path, page: await call<number>(() => PluginCommAPI.getCurrentPageNum()).catch(() => 0)};
    }
    log(`harness ${request.id}: ${request.files.length} files`);
    for (const file of request.files) {
      let result: any;
      try {
        result = await runFile(file, request);
      } catch (error) {
        result = {path: file, error: (error as Error).message};
      }
      results.push(result.path);
      emit({id: request.id, kind: 'file', ...result});
    }
  } catch (error) {
    emit({id: request?.id ?? null, kind: 'error', error: (error as Error).message});
  } finally {
    if (previous) {
      try {
        await call<boolean>(() => PluginFileAPI.openFile(previous!.path, previous!.page));
      } catch {
        // best effort
      }
    }
    emit({id: request?.id ?? null, kind: 'done', files: results});
    running = false;
    engine.resume();
  }
  return true;
}
