// Runs the plugin's own anchor code over page texts captured from a Supernote.
//
//   node tools/qualify/anchors.ts outbound <dump.json>            > anchors.json
//   node tools/qualify/anchors.ts inbound  <dump.json> <in.json>  > found.json
//
// <dump.json> comes from `tools/device.py read --pages all`. Used by qualify.py.
import {readFileSync} from 'node:fs';
import {anchorForPage, findAnchorPage, pageWords, ANCHOR_WORDS} from '../../plugin/src/core/anchor.ts';
import {percentagePage} from '../../plugin/src/core/kosync.ts';

const [mode, dumpPath, inputPath] = process.argv.slice(2);
const dump: any[] = JSON.parse(readFileSync(dumpPath, 'utf8'));
const books = new Map<string, string[]>();
for (const book of dump) {
  if (book.error) {
    continue;
  }
  const pages = new Array<string>(book.total).fill('');
  for (const sample of book.samples) {
    pages[sample.page] = sample.text ?? '';
  }
  books.set(book.path, pages);
}

if (mode === 'outbound') {
  const out: any[] = [];
  for (const [path, pages] of books) {
    pages.forEach((text, page) => {
      const next = pageWords(text).length <= ANCHOR_WORDS ? pages[page + 1] ?? '' : '';
      const anchor = anchorForPage(text, next, pages[page - 1] ?? '');
      if (anchor) {
        out.push({path, page, total: pages.length, anchor});
      }
    });
  }
  process.stdout.write(JSON.stringify(out));
} else if (mode === 'inbound') {
  const items: any[] = JSON.parse(readFileSync(inputPath, 'utf8'));
  const out: any[] = [];
  for (const item of items) {
    const pages = books.get(item.path)!;
    const reads: number[] = [];
    const source = {total: pages.length, read: async (i: number) => (reads.push(i), pages[i])};
    const estimate = percentagePage(item.percent / 100, pages.length);
    const found = await findAnchorPage(item.anchor, source, estimate);
    // Exhaustive search from the true page answers "is this anchor findable at all".
    const truth = await findAnchorPage(item.anchor, {total: pages.length, read: async i => pages[i]}, item.page ?? estimate, 1e9);
    out.push({...item, estimate, found: found?.page ?? null, reads: reads.length, truth: truth?.page ?? null});
  }
  process.stdout.write(JSON.stringify(out));
}
