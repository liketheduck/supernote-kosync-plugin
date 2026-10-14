// Supernote implementation of the sync engine's Host: reader SDK calls (with
// timeouts, because host callbacks can fail to arrive), the native module for
// identity/HTTP/storage, and the plugin view for jump questions.

import {DeviceEventEmitter, NativeModules} from 'react-native';
import {PluginCommAPI, PluginDocAPI, PluginManager} from 'sn-plugin-lib';
import {SyncEngine, type BookState, type Host, type JumpPrompt, type Settings} from './core/engine.ts';

export const native = NativeModules.KosyncNative;

const TICK_MS = 3000;
const SDK_TIMEOUT_MS = 15000;

/** Native-scheduled wait; JavaScript timers stop while the plugin view is hidden. */
export const sleep = (ms: number): Promise<void> => native.sleep(ms).then(() => undefined);

function withTimeout<T>(name: string, work: () => Promise<T>, ms = SDK_TIMEOUT_MS): Promise<T> {
  let settled = false;
  return Promise.race([
    Promise.resolve()
      .then(work)
      .finally(() => {
        settled = true;
      }),
    sleep(ms).then(() => {
      if (!settled) {
        throw new Error(`The reader did not answer (${name}).`);
      }
      return new Promise<T>(() => {});
    }),
  ]);
}

function unwrap<T>(name: string, response: any, valid: (value: any) => boolean): T {
  if (response?.success !== true || !valid(response.result)) {
    throw new Error(`Reader ${name} unavailable${response?.error?.message ? `: ${response.error.message}` : ''}`);
  }
  return response.result as T;
}

const isPage = (x: any) => Number.isInteger(x) && x >= 0;

// ---- Jump questions shown in the plugin view ---------------------------------

type PromptListener = (prompt: JumpPrompt | null) => void;
let currentPrompt: JumpPrompt | null = null;
let promptResolve: ((answer: boolean | null) => void) | null = null;
let promptGeneration = 0;
/** Unanswered questions close after this long. */
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
const promptListeners = new Set<PromptListener>();

export function onPrompt(listener: PromptListener): () => void {
  promptListeners.add(listener);
  listener(currentPrompt);
  return () => promptListeners.delete(listener);
}

function setPrompt(prompt: JumpPrompt | null) {
  currentPrompt = prompt;
  for (const listener of promptListeners) {
    listener(prompt);
  }
}

/** Answers the open question. The view closes so the reader is visible again. */
export async function answerPrompt(yes: boolean) {
  const resolve = promptResolve;
  promptResolve = null;
  setPrompt(null);
  try {
    await PluginManager.closePluginView();
  } catch {
    // already closed
  }
  resolve?.(yes);
}

/** The view was closed without answering: stay, but do not count it as declining. */
export function dismissPrompt() {
  if (promptResolve) {
    const resolve = promptResolve;
    promptResolve = null;
    setPrompt(null);
    resolve(null);
  }
}

// ---- Host ------------------------------------------------------------------

export function log(line: string) {
  try {
    native?.log(line);
  } catch {
    // logging must never fail sync
  }
}

export const host: Host = {
  now: () => Date.now(),
  sleep,
  settings: async () => (await native.settings()) as Settings,
  currentFile: async () => (await native.currentFile()) ?? null,
  pageInfo: async () => {
    const page = unwrap<number>('page', await withTimeout('page', () => PluginCommAPI.getCurrentPageNum()), isPage);
    const total = unwrap<number>('page count', await withTimeout('page count', () => PluginDocAPI.getCurrentTotalPages()), x => isPage(x) && x > 0);
    if (page >= total) {
      throw new Error('Reader page out of range');
    }
    return {page, total};
  },
  pageText: async page => {
    const text = unwrap<string>('text', await withTimeout('page text', () => PluginDocAPI.getCurrentDocText(page)), x => typeof x === 'string');
    return text.length > 200000 ? text.slice(0, 200000) : text;
  },
  digest: async path => (await native.digest(path)).digest,
  online: async () => Boolean(await native.wifi()),
  request: async (method, path, body) => {
    const result = await native.request(method, path, body === undefined ? null : JSON.stringify(body));
    return {status: result.status, body: result.body ?? ''};
  },
  loadState: async key => {
    const raw = await native.loadState(key);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as BookState;
    } catch {
      return null;
    }
  },
  saveState: async (key, state) => {
    await native.saveState(key, JSON.stringify(state));
  },
  jump: async page => {
    unwrap<boolean>('jump', await withTimeout('jump', () => PluginCommAPI.jumpToPage(page)), x => x !== false);
  },
  ask: prompt =>
    new Promise<boolean | null>(resolve => {
      dismissPrompt();
      promptResolve = resolve;
      const generation = ++promptGeneration;
      setPrompt(prompt);
      PluginManager.showPluginView().catch(() => dismissPrompt());
      sleep(PROMPT_TIMEOUT_MS).then(() => {
        if (generation === promptGeneration && promptResolve === resolve) {
          dismissPrompt();
          PluginManager.closePluginView().catch(() => {});
        }
      });
    }),
  log,
};

export const engine = new SyncEngine(host);

// ---- Background ticking ----------------------------------------------------------

let tickSubscription: {remove(): void} | null = null;
let touchGeneration = 0;

export async function startSync() {
  if (!native) {
    throw new Error('KOSync native module is missing from this build.');
  }
  for (const permission of ['plugin.permission.FILE:READ', 'plugin.permission.INTERNET']) {
    if ((await PluginManager.hasPermission(permission)) !== 1) {
      const result = await PluginManager.requestPermission(permission, 'Identify the open book and sync its reading position with your KOSync server.');
      if (result !== 1 && result !== 2) {
        throw new Error('Permission not granted');
      }
    }
  }
  engine.resume();
  if (!tickSubscription) {
    tickSubscription = DeviceEventEmitter.addListener('kosync_tick', () => {
      engine.tick();
    });
  }
  await native.startTicker(TICK_MS);
  engine.tick();
}

/** A finger lifted from the screen: check the page soon instead of waiting for the next tick. */
export function onTouch() {
  const generation = ++touchGeneration;
  sleep(800).then(() => {
    if (generation === touchGeneration) {
      engine.tick();
    }
  });
}

export function stopSync() {
  engine.stop();
  dismissPrompt();
  native?.stopTicker().catch(() => {});
  tickSubscription?.remove();
  tickSubscription = null;
  touchGeneration++;
}
