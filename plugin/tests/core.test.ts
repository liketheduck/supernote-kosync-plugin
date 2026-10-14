import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fold} from '../src/core/fold.ts';
import {anchorForPage, findAnchorPage, joinHyphenatedBreaks, pageWords} from '../src/core/anchor.ts';
import {
  PERCENTAGE_ONLY_LOCATOR,
  epubPush,
  parseRemote,
  pagePercentage,
  pdfLocatorPage,
  pdfPush,
  percentagePage,
  progressPath,
} from '../src/core/kosync.ts';

const who = {device: 'Supernote Manta', deviceId: 'ABC'};

test('fold removes spacing, accents, case and unifies punctuation variants', () => {
  assert.equal(fold('  Café — “Hello”\n'), 'cafe-"hello"');
  assert.equal(fold('soft­hyphen​'), 'softhyphen');
  assert.equal(fold('Não'), 'nao');
  assert.equal(fold('ＡＢ'), 'ab'); // full-width compatibility forms
  assert.equal(fold('’tis'), "'tis");
});

test('line-break hyphenation is rejoined, real compounds are kept', () => {
  assert.equal(joinHyphenatedBreaks('posi-\ntion and well-known'), 'position and well-known');
  assert.deepEqual(pageWords('  one\ttwo \n three '), ['one', 'two', 'three']);
});

test('anchor names the first word of the page with following context', () => {
  const anchor = anchorForPage('ment of the empire was slow and the roads were poor in winter');
  assert.deepEqual(anchor, {text: 'ment', after: 'of the empire was slow and the roads'});
  assert.equal(anchorForPage('   \n '), null);
  const short = anchorForPage('The end.', 'Chapter Two begins here with more words');
  assert.equal(short?.after, 'end. Chapter Two begins here with more words');
});

function book(pages: string[]) {
  const reads: number[] = [];
  return {
    reads,
    source: {
      total: pages.length,
      read: async (i: number) => {
        reads.push(i);
        return pages[i];
      },
    },
  };
}

const filler = (n: number) =>
  Array.from({length: n}, (_, i) => `Page ${i} talks about topic number ${i * 7919 % 1000} in some detail with words.`);

test('a page opening with a heading is anchored on its first body line', async () => {
  const page = 'THE LIGHTHOUSE KEEPER\nIN WINTER:\nThe best way to understand a small harbour town is to stay\nthrough a storm, and the long evenings are when the keeper\nfinally has time to write down what the sea has taught him.';
  assert.deepEqual(anchorForPage(page, '', 'previous page ends here'), {
    text: 'The',
    before: 'page ends here THE LIGHTHOUSE KEEPER IN WINTER:',
    after: 'best way to understand a small harbour town',
  });
  const verse = 'Grey gulls over\nthe harbour wall,\nthe tide comes in\nand takes it all';
  assert.equal(anchorForPage(verse)?.text, 'Grey');
});

test('finds the page holding an anchor near the estimate', async () => {
  const pages = filler(40);
  pages[23] = 'The quick brown fox jumps over the lazy dog while the farmer sleeps soundly.';
  const {source} = book(pages);
  const found = await findAnchorPage({text: 'quick', before: 'The', after: 'brown fox jumps over the lazy dog'}, source, 20);
  assert.equal(found?.page, 23);
});

test('anchor spanning a page break resolves to the page where its word starts', async () => {
  const pages = filler(10);
  pages[4] = 'Long paragraph text ends with the distinctive phrase that';
  pages[5] = 'continues onto the next page without interruption at all.';
  const {source} = book(pages);
  const found = await findAnchorPage({text: 'distinctive', before: 'ends with the', after: 'phrase that continues onto the next'}, source, 5);
  assert.equal(found?.page, 4);
  const second = await findAnchorPage({text: 'continues', before: 'distinctive phrase that', after: 'onto the next page'}, source, 3);
  assert.equal(second?.page, 5);
});

test('reader-side hyphenation and typography do not break matching', async () => {
  const pages = filler(6);
  pages[2] = 'He said “no” — the regi-\nment marched on toward the river.';
  const {source} = book(pages);
  const found = await findAnchorPage({text: 'said', before: 'He', after: '"no" - the regiment marched on'}, source, 0);
  assert.equal(found?.page, 2);
});

test('repeated passages close together are refused rather than guessed', async () => {
  const pages = filler(100);
  pages[50] = 'Chorus line: we sail at dawn and return by night across the bay.';
  pages[52] = 'Chorus line: we sail at dawn and return by night across the bay.';
  const {source} = book(pages);
  assert.equal(await findAnchorPage({text: 'Chorus', after: 'line: we sail at dawn and return'}, source, 51), null);
});

test('a repeat far away does not prevent choosing the near one', async () => {
  const pages = filler(100);
  pages[10] = 'Chorus line: we sail at dawn and return by night across the bay.';
  pages[90] = 'Chorus line: we sail at dawn and return by night across the bay.';
  const {source} = book(pages);
  assert.equal((await findAnchorPage({text: 'Chorus', after: 'line: we sail at dawn and return'}, source, 12))?.page, 10);
});

test('search stops at the read budget and reports not found', async () => {
  const pages = filler(300);
  pages[290] = 'Needle sentence that appears exactly once in this long book.';
  const {source, reads} = book(pages);
  assert.equal(await findAnchorPage({text: 'Needle', after: 'sentence that appears exactly once'}, source, 0, 50), null);
  assert.ok(reads.length <= 50);
});

test('context the reader does not display falls back to the shorter needle', async () => {
  const pages = filler(300);
  pages[200] = 'To the memory of Ada Penhallow. She was the first of many.';
  const {source, reads} = book(pages);
  // "before" holds navigation text that is not on any reader page.
  const anchor = {text: 'To', before: 'Select Bibliography Notes Navigation Table of Contents', after: 'the memory of Ada Penhallow. She was the'};
  assert.equal((await findAnchorPage(anchor, source, 0))?.page, 200);
  const near = book(pages);
  assert.equal((await findAnchorPage(anchor, near.source, 195))?.page, 200);
  assert.ok(near.reads.length < 60, `stops early (${near.reads.length} reads)`);
});

test('editions with inline line numbers match on letters when strict text differs', async () => {
  const pages = filler(50);
  pages[30] = 'KEEPER Our lanterns burned all night. Now the boats are home,\nAnd every rope is coiled upon the quay';
  const {source} = book(pages);
  const anchor = {text: 'Our', before: 'watched the water while the bell rang 7', after: 'lanterns burned all night. Now the boats are home, 8'};
  assert.equal((await findAnchorPage(anchor, source, 28))?.page, 30);
});

test('short anchors without enough text are not matched', async () => {
  const {source} = book(['a', 'b', 'c']);
  assert.equal(await findAnchorPage({text: 'b'}, source, 0), null);
});

test('parseRemote follows CWNG SyncLogic.resolveRemotePosition', () => {
  const locator = parseRemote({progress: '/body/DocFragment[3]/body/p[2]/text().4', percentage: 0.5, device: 'KOReader', device_id: 'X', timestamp: 10});
  assert.equal(locator?.kind, 'locator');
  assert.equal(locator?.progress, '/body/DocFragment[3]/body/p[2]/text().4');
  const pct = parseRemote({progress: null, position_kind: 'percentage', percentage: 0.25});
  assert.deepEqual([pct?.kind, pct?.progress, pct?.percentage], ['percentage', null, 0.25]);
  const sentinel = parseRemote({progress: PERCENTAGE_ONLY_LOCATOR, percentage: 0.3});
  assert.equal(sentinel?.kind, 'percentage');
  assert.equal(sentinel?.progress, null);
  assert.equal(parseRemote({progress: PERCENTAGE_ONLY_LOCATOR}), null);
  assert.equal(parseRemote({}), null);
  assert.equal(parseRemote({progress: '', percentage: 2}), null);
  assert.equal(parseRemote({progress: '7', percentage: -1})?.percentage, null);
  const anchored = parseRemote({progress: '/body/x', percentage: 0.9, anchor: {text: 'quiet', before: 'a', after: 'b'}});
  assert.deepEqual(anchored?.anchor, {text: 'quiet', before: 'a', after: 'b'});
  assert.equal(parseRemote({progress: '/body/x', percentage: 0.9, anchor: {text: '  '}})?.anchor, null);
});

test('PDF locators and percentages match KOReader paging', () => {
  assert.equal(pdfLocatorPage('57', 100), 56);
  assert.equal(pdfLocatorPage('0', 100), null);
  assert.equal(pdfLocatorPage('101', 100), null);
  assert.equal(pdfLocatorPage('/body/p', 100), null);
  assert.equal(pagePercentage(56, 100), 0.57);
  assert.equal(percentagePage(0.57, 100), 56);
  assert.equal(percentagePage(0, 100), 0);
  assert.equal(percentagePage(1, 100), 99);
  assert.deepEqual(pdfPush('d', 4, 8, who), {document: 'd', progress: '5', percentage: 0.625, device: 'Supernote Manta', device_id: 'ABC'});
});

test('EPUB push is a CWA percentage push with an anchor', () => {
  assert.deepEqual(epubPush('d', 9, 20, {text: 'quiet', after: 'reading journey'}, who), {
    document: 'd',
    percentage: 0.5,
    position_kind: 'percentage',
    device: 'Supernote Manta',
    device_id: 'ABC',
    anchor: {text: 'quiet', before: '', after: 'reading journey'},
  });
  assert.equal('anchor' in epubPush('d', 0, 1, null, who), false);
  assert.equal(progressPath('abc'), '/syncs/progress/abc?position_kinds=locator,percentage,anchor');
});
