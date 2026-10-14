import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SyncEngine, SETTLE_MS, RESUME_GAP_MS, STABLE_MS, type Host, type JumpPrompt, type BookState} from '../src/core/engine.ts';

/** Minimal CWA KOSync: furthest position wins across devices, a device may rewind its own. */
class FakeServer {
  record: any = null;
  puts: any[] = [];
  capabilities = ['position_kinds', 'percentage_push', 'anchor'];
  down = false;
  clock = 1000;
  portal = false;
  handle(method: string, path: string, body?: any) {
    if (this.down) {
      throw new Error('ECONNREFUSED');
    }
    if (this.portal) {
      return {status: 200, body: '<html>Sign in to the hotel Wi-Fi</html>'};
    }
    if (path === '/users/auth') {
      return {status: 200, body: JSON.stringify({authorized: 'OK', capabilities: this.capabilities})};
    }
    if (method === 'GET') {
      return {status: 200, body: JSON.stringify(this.record ?? {})};
    }
    this.puts.push(body);
    const incoming = body.percentage;
    const current = this.record;
    const accepted = !current || incoming >= current.percentage || current.device_id === body.device_id;
    if (accepted) {
      this.record = {
        document: body.document,
        progress: body.position_kind === 'percentage' ? (body.anchor ? '/body/DocFragment[1]/body/p[1]' : 'cwng:percentage') : body.progress,
        position_kind: body.position_kind === 'percentage' && !body.anchor ? 'percentage' : 'locator',
        percentage: incoming,
        device: body.device,
        device_id: body.device_id,
        timestamp: ++this.clock,
        anchor: body.anchor,
      };
    }
    return {status: 200, body: JSON.stringify({document: body.document, timestamp: this.clock})};
  }
}

class FakeReader implements Host {
  t = 1_000_000;
  path: string | null;
  page = 0;
  pages: string[];
  wifi = true;
  answers: (boolean | null)[] = [];
  prompts: JumpPrompt[] = [];
  state = new Map<string, BookState>();
  logs: string[] = [];
  autoSync = true;
  askBeforeJump = true;
  server: FakeServer;
  constructor(server: FakeServer, path: string, pages: string[]) {
    this.server = server;
    this.path = path;
    this.pages = pages;
  }
  now() { return this.t; }
  async sleep(ms: number) { this.t += ms; }
  async settings() {
    return {url: 'http://cwa:8083', username: 'u', hasPassword: true, deviceId: 'SUPERNOTE', deviceName: 'Supernote Manta', autoSync: this.autoSync, askBeforeJump: this.askBeforeJump};
  }
  async currentFile() { return this.path; }
  async pageInfo() { return {page: this.page, total: this.pages.length}; }
  async pageText(i: number) { return this.pages[i]; }
  async digest(path: string) { return path.endsWith('.pdf') ? 'pdfdigest' : 'epubdigest'; }
  async online() { return this.wifi; }
  async request(method: 'GET' | 'PUT', path: string, body?: unknown) { return this.server.handle(method, path, body); }
  async loadState(key: string) { return this.state.get(key) ?? null; }
  async saveState(key: string, s: BookState) { this.state.set(key, JSON.parse(JSON.stringify(s))); }
  async jump(page: number) { this.page = page; }
  async ask(prompt: JumpPrompt) { this.prompts.push(prompt); const a = this.answers.shift(); return a === undefined ? false : a; }
  log(line: string) { this.logs.push(line); }
}

const words = (n: number) =>
  Array.from({length: n}, (_, i) => `Leaf ${i} recounts event ${(i * 7919) % 997} beside landmark ${(i * 104729) % 991} quite plainly.`);

async function open(engine: SyncEngine, reader: FakeReader) {
  await engine.tick();
  reader.t += STABLE_MS;
  await engine.tick();
}

async function settle(engine: SyncEngine, reader: FakeReader) {
  await engine.tick();
  reader.t += SETTLE_MS + 1;
  await engine.tick();
}

test('a page turn on a PDF pushes KOReader\'s page locator once', async () => {
  const server = new FakeServer();
  const reader = new FakeReader(server, '/sdcard/Books/a.pdf', words(8));
  const engine = new SyncEngine(reader);
  await open(engine, reader); // open + pull (nothing shared)
  assert.equal(server.puts.length, 0, 'opening never pushes');
  reader.page = 4;
  await settle(engine, reader);
  assert.deepEqual(server.puts, [{document: 'pdfdigest', progress: '5', percentage: 0.625, device: 'Supernote Manta', device_id: 'SUPERNOTE'}]);
  reader.t += 60000;
  await engine.tick();
  assert.equal(server.puts.length, 1, 'no duplicate push for an unchanged page');
});

test('an unsettled page is not pushed until it stops changing', async () => {
  const server = new FakeServer();
  const reader = new FakeReader(server, '/b.pdf', words(20));
  const engine = new SyncEngine(reader);
  await open(engine, reader);
  for (const page of [1, 2, 3]) {
    reader.page = page;
    reader.t += 1000;
    await engine.tick();
  }
  assert.equal(server.puts.length, 0);
  reader.t += SETTLE_MS;
  await engine.tick();
  assert.equal(server.puts.length, 1);
  assert.equal(server.puts[0].progress, '4');
});

test('a shared PDF position ahead of the reader is offered and applied without echo', async () => {
  const server = new FakeServer();
  server.record = {progress: '6', percentage: 0.75, device: 'KOReader', device_id: 'KO', timestamp: 500};
  const reader = new FakeReader(server, '/c.pdf', words(8));
  reader.page = 1;
  reader.answers = [true];
  const engine = new SyncEngine(reader);
  await open(engine, reader);
  assert.equal(reader.prompts.length, 1);
  assert.deepEqual([reader.prompts[0].targetPage, reader.prompts[0].method], [5, 'page']);
  assert.equal(reader.page, 5);
  reader.t += SETTLE_MS * 3;
  await engine.tick();
  assert.equal(server.puts.length, 0, 'the jump itself is not pushed back');
});

test('declining is remembered for that shared position only', async () => {
  const server = new FakeServer();
  server.record = {progress: '6', percentage: 0.75, device: 'KOReader', device_id: 'KO', timestamp: 500};
  const reader = new FakeReader(server, '/d.pdf', words(8));
  reader.answers = [false];
  const engine = new SyncEngine(reader);
  await open(engine, reader);
  assert.equal(reader.page, 0);
  reader.t += RESUME_GAP_MS + 1; // wake: pull again
  await engine.tick();
  assert.equal(reader.prompts.length, 1, 'same shared position is not offered twice');
  server.record = {...server.record, progress: '7', percentage: 0.875, timestamp: 600};
  reader.answers = [true];
  reader.t += RESUME_GAP_MS + 1;
  await engine.tick();
  assert.equal(reader.prompts.length, 2);
  assert.equal(reader.page, 6);
});

test('a shared position behind the reader is not applied', async () => {
  const server = new FakeServer();
  server.record = {progress: '2', percentage: 0.25, device: 'KOReader', device_id: 'KO', timestamp: 500};
  const reader = new FakeReader(server, '/e.pdf', words(8));
  reader.page = 6;
  const engine = new SyncEngine(reader);
  await open(engine, reader);
  assert.equal(reader.prompts.length, 0);
  assert.equal(reader.page, 6);
  assert.match(engine.status.message, /ahead/);
});

test('a push behind another device is reported, not claimed as saved', async () => {
  const server = new FakeServer();
  server.record = {progress: '9', percentage: 0.9, device: 'KOReader', device_id: 'KO', timestamp: 5};
  const reader = new FakeReader(server, '/q.pdf', words(10));
  reader.answers = [false];
  const engine = new SyncEngine(reader);
  await open(engine, reader);
  reader.page = 2;
  await settle(engine, reader);
  assert.equal(server.puts.length, 1);
  assert.match(engine.status.message, /keeps KOReader's position further ahead/);
});

test('the device\'s own record never prompts', async () => {
  const server = new FakeServer();
  server.record = {progress: '6', percentage: 0.75, device: 'Supernote Manta', device_id: 'SUPERNOTE', timestamp: 500};
  const reader = new FakeReader(server, '/f.pdf', words(8));
  const engine = new SyncEngine(reader);
  await open(engine, reader);
  assert.equal(reader.prompts.length, 0);
});

test('EPUB pushes carry the words that open the page and come back as an anchor', async () => {
  const server = new FakeServer();
  const pages = words(30);
  const reader = new FakeReader(server, '/g.epub', pages);
  const engine = new SyncEngine(reader);
  await open(engine, reader);
  reader.page = 17;
  await settle(engine, reader);
  assert.equal(server.puts.length, 1);
  assert.equal(server.puts[0].position_kind, 'percentage');
  assert.deepEqual(server.puts[0].anchor, {
    text: 'Leaf',
    before: pages[16].split(' ').slice(-8).join(' '),
    after: pages[17].split(' ').slice(1, 9).join(' '),
  });
  // Another device now reads that record; the anchor finds the exact page even with a skewed percentage.
  server.record = {...server.record, device: 'KOReader', device_id: 'KO', percentage: 0.4};
  const other = new FakeReader(server, '/g.epub', pages);
  other.answers = [true];
  await open(new SyncEngine(other), other);
  assert.equal(other.prompts[0]?.method, 'anchor');
  assert.equal(other.page, 17);
});

test('an EPUB position without an anchor falls back to the percentage', async () => {
  const server = new FakeServer();
  server.record = {progress: null, position_kind: 'percentage', percentage: 0.5, device: 'Web reader', device_id: 'W', timestamp: 9};
  const reader = new FakeReader(server, '/h.epub', words(40));
  reader.answers = [true];
  await open(new SyncEngine(reader), reader);
  assert.equal(reader.prompts[0].method, 'percentage');
  assert.equal(reader.page, 19);
});

test('offline movement is kept and sent after the connection returns', async () => {
  const server = new FakeServer();
  const reader = new FakeReader(server, '/i.pdf', words(10));
  const engine = new SyncEngine(reader);
  await open(engine, reader);
  reader.page = 3;
  server.down = true;
  await settle(engine, reader);
  assert.equal(server.puts.length, 0);
  assert.deepEqual(reader.state.get('pdfdigest')?.pending, {page: 3, total: 10});
  server.down = false;
  reader.t += 400000;
  await engine.tick();
  assert.equal(server.puts.length, 1);
  assert.equal(server.puts[0].progress, '4');
  assert.equal(reader.state.get('pdfdigest')?.pending, undefined);
});

test('a pending position from a previous session is sent when the book reopens there', async () => {
  const server = new FakeServer();
  const reader = new FakeReader(server, '/j.pdf', words(10));
  reader.state.set('pdfdigest', {pending: {page: 7, total: 10}});
  reader.page = 7;
  await open(new SyncEngine(reader), reader);
  assert.equal(server.puts.length, 1);
  assert.equal(server.puts[0].progress, '8');
});

test('a page turned just before leaving the reader is sent on the next open', async () => {
  const server = new FakeServer();
  const reader = new FakeReader(server, '/s.pdf', words(10));
  const engine = new SyncEngine(reader);
  await open(engine, reader);
  reader.page = 4;
  reader.t += 1000;
  await engine.tick(); // moved, not yet settled
  reader.path = null; // reader closed
  await engine.tick();
  assert.equal(server.puts.length, 0);
  reader.path = '/s.pdf';
  await open(engine, reader);
  assert.equal(server.puts.length, 1);
  assert.equal(server.puts[0].progress, '5');
});

test('reopening further than this device last reported pushes when the server is behind', async () => {
  const server = new FakeServer();
  const reader = new FakeReader(server, '/t.pdf', words(10));
  reader.state.set('pdfdigest', {lastPushed: {page: 2, total: 10, at: 1}});
  server.record = {progress: '3', percentage: 0.3, device: 'Supernote Manta', device_id: 'OTHER', timestamp: 5};
  reader.page = 6;
  await open(new SyncEngine(reader), reader);
  assert.equal(server.puts.length, 1);
  assert.equal(server.puts[0].progress, '7');
});

test('opening a book for the first time never pushes', async () => {
  const server = new FakeServer();
  server.record = {progress: '3', percentage: 0.3, device: 'KOReader', device_id: 'KO', timestamp: 5};
  const reader = new FakeReader(server, '/u.pdf', words(10));
  reader.page = 6;
  await open(new SyncEngine(reader), reader);
  assert.equal(server.puts.length, 0);
});

test('a layout change (font size) is not treated as reading', async () => {
  const server = new FakeServer();
  const reader = new FakeReader(server, '/k.epub', words(50));
  const engine = new SyncEngine(reader);
  await open(engine, reader);
  reader.pages = words(70);
  reader.page = 13;
  await settle(engine, reader);
  assert.equal(server.puts.length, 0);
});

test('nothing is compared while the reader is still paginating', async () => {
  const server = new FakeServer();
  server.record = {progress: '6', percentage: 0.75, device: 'KOReader', device_id: 'KO', timestamp: 500};
  const reader = new FakeReader(server, '/r.pdf', words(4));
  const engine = new SyncEngine(reader);
  await engine.tick();
  reader.pages = words(8);
  reader.t += 3000;
  await engine.tick();
  assert.equal(reader.prompts.length, 0, 'no prompt while the page count is changing');
  reader.answers = [true];
  reader.t += STABLE_MS;
  await engine.tick();
  assert.equal(reader.prompts.length, 1);
  assert.equal(reader.page, 5);
});

test('switching books opens the new one and does not push for the old one', async () => {
  const server = new FakeServer();
  const reader = new FakeReader(server, '/l.pdf', words(10));
  const engine = new SyncEngine(reader);
  await open(engine, reader);
  reader.path = '/m.epub';
  reader.page = 5;
  await settle(engine, reader);
  assert.equal(server.puts.length, 0);
  assert.equal(engine.status.book, 'm');
});

test('without asking, a shared position ahead is applied directly', async () => {
  const server = new FakeServer();
  server.record = {progress: '3', percentage: 0.3, device: 'KOReader', device_id: 'KO', timestamp: 5};
  const reader = new FakeReader(server, '/n.pdf', words(10));
  reader.askBeforeJump = false;
  await open(new SyncEngine(reader), reader);
  assert.equal(reader.prompts.length, 0);
  assert.equal(reader.page, 2);
});

test('Sync now pushes when this device is ahead', async () => {
  const server = new FakeServer();
  server.record = {progress: '2', percentage: 0.2, device: 'KOReader', device_id: 'KO', timestamp: 5};
  const reader = new FakeReader(server, '/o.pdf', words(10));
  reader.page = 6;
  const engine = new SyncEngine(reader);
  await engine.syncNow();
  assert.equal(server.puts.length, 1);
  assert.equal(server.record.progress, '7');
});

test('servers without percentage push leave EPUBs unsynced with an explanation', async () => {
  const server = new FakeServer();
  server.capabilities = [];
  const reader = new FakeReader(server, '/p.epub', words(10));
  const engine = new SyncEngine(reader);
  await open(engine, reader);
  reader.page = 2;
  await settle(engine, reader);
  assert.equal(server.puts.length, 0);
  assert.match(engine.status.message, /cannot store EPUB/);
});

test('a captive portal page is not mistaken for a saved position', async () => {
  const server = new FakeServer();
  const reader = new FakeReader(server, '/v.pdf', words(10));
  const engine = new SyncEngine(reader);
  server.portal = true;
  await open(engine, reader);
  assert.match(engine.status.message, /did not answer like a KOSync server/);
  server.portal = false;
  reader.t += 400000;
  await engine.tick();
  reader.page = 3;
  server.portal = true;
  await settle(engine, reader);
  assert.equal(server.puts.length, 0);
  assert.deepEqual(reader.state.get('pdfdigest')?.pending, {page: 3, total: 10});
});

test('changing the server pulls its position before pushing', async () => {
  const server = new FakeServer();
  const reader = new FakeReader(server, '/w.pdf', words(10));
  const engine = new SyncEngine(reader);
  await open(engine, reader);
  server.record = {progress: '9', percentage: 0.9, device: 'KOReader', device_id: 'KO', timestamp: 77};
  engine.reloadSettings();
  reader.page = 2;
  reader.answers = [false];
  await settle(engine, reader);
  assert.equal(reader.prompts.length, 1, 'the new server position is offered first');
});

test('closing the question without answering does not count as declining', async () => {
  const server = new FakeServer();
  server.record = {progress: '6', percentage: 0.75, device: 'KOReader', device_id: 'KO', timestamp: 500};
  const reader = new FakeReader(server, '/x.pdf', words(8));
  reader.answers = [null];
  await open(new SyncEngine(reader), reader);
  assert.equal(reader.state.get('pdfdigest')?.declined, undefined);
});

test('a long question does not look like the device waking up', async () => {
  const server = new FakeServer();
  server.record = {progress: '6', percentage: 0.75, device: 'KOReader', device_id: 'KO', timestamp: 500};
  const reader = new FakeReader(server, '/y.pdf', words(8));
  const engine = new SyncEngine(reader);
  const ask = reader.ask.bind(reader);
  reader.ask = async prompt => {
    reader.t += RESUME_GAP_MS * 3; // the user takes a while
    return ask(prompt);
  };
  reader.answers = [false];
  await open(engine, reader);
  reader.t += 3000;
  await engine.tick();
  assert.equal(reader.prompts.length, 1);
});
