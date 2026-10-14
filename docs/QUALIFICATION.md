# Qualification on real books

Version 1.0.0 was qualified on a Supernote Manta (A5 X2, firmware `Chauvet.E103.2610091001`)
against Calibre-Web-NextGen v4.1.47, using a size-stratified sample of a personal library:
30 EPUBs (4 KB to 98 MB) and 12 PDFs (3 KB to 40 MB). Titles are replaced by descriptions.

## Hardware acceptance (KOReader v2026.07.1 with the CWA NextGen sync plugin, same server and account)

| Direction | Format | Result |
| --- | --- | --- |
| CWA → Supernote | PDF | Offered "Go to page 6"; the reader showed physical page 6. |
| Supernote → KOReader | PDF | Page turn pushed page 7; KOReader offered 88% and showed physical page 7. |
| KOReader → Supernote | PDF | KOReader at page 8; returning to the Supernote reader pulled automatically and showed page 8. |
| KOReader XPointer → Supernote | EPUB | The anchor search found page 41 of 44 in 8 page reads; the page opens with the anchor word. |
| Supernote → KOReader | EPUB | Page 42 pushed as words; CWA stored an XPointer (94%); KOReader showed the page containing that sentence. |

Plain-HTTP CWA on the LAN, credentials in the Android keystore, background ticking with the
plugin view closed, the automatic pull on returning to the reader, and upgrading the installed
plugin in place (settings kept) were exercised on the device.

## PDFs

All 12 PDFs (8 to 672 pages) reported a page count equal to the file's physical page count, and
`jumpToPage` landed exactly. KOReader's PDF locator is the physical page number, so PDF
positions map one to one.

## EPUBs

Three of the 30 EPUBs cannot be opened by the Supernote reader at all ("cannot open due to DRM
copyright restraint"): they use Adobe font obfuscation (`http://ns.adobe.com/pdf/enc#RC`) on
embedded fonts. One is a synthetic sync-test book made of repeated sentences and is excluded. The
remaining 26 were captured in full (every page's text, 10,697 page reads, median 10 ms, 95th
percentile 16 ms) and replayed with `tools/qualify/qualify.py`:

- **Placed by CWA**: the plugin's anchor for the page is turned into a KOReader XPointer by CWA's
  own code. Unplaced pages are pushed as a percentage.
- **Exact / Adjacent / Percentage fallback / Wrong**: CWA's anchor for that XPointer, searched by
  the plugin in the reader's pages, lands on the original page, the neighbouring page, no page
  (the plugin then uses the percentage and says so), or a page more than one away.
- **KOReader positions found**: random positions anywhere in the book, as KOReader would report
  them, located on a reader page. The rest have text the reader does not show (footnote bodies,
  line numbers, alt text) and use the percentage.

| Book | Pages | Placed by CWA | Exact | Adjacent | Percentage fallback | Wrong | KOReader positions found |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Short nonfiction | 71 | 69/69 | 68 | 1 | 0 | 0 | 40/40 |
| Young-adult novel | 243 | 241/242 | 239 | 1 | 1 | 0 | 39/40 |
| Business nonfiction | 368 | 361/366 | 354 | 2 | 4 | 1 | 38/40 |
| Thriller | 293 | 285/288 | 283 | 0 | 2 | 0 | 38/40 |
| Annotated play (edition A) | 256 | 253/254 | 252 | 0 | 1 | 0 | 39/40 |
| Crime novel | 397 | 395/396 | 393 | 2 | 0 | 0 | 39/40 |
| Political nonfiction | 624 | 615/619 | 604 | 10 | 1 | 0 | 40/40 |
| Language-course booklet | 64 | 64/64 | 63 | 0 | 1 | 0 | 39/40 |
| Young-adult novel | 298 | 292/292 | 292 | 0 | 0 | 0 | 40/40 |
| Literary criticism | 552 | 527/544 | 513 | 7 | 7 | 0 | 38/40 |
| Psychology nonfiction | 225 | 217/217 | 211 | 4 | 2 | 0 | 38/40 |
| Urbanism nonfiction | 245 | 236/244 | 232 | 1 | 3 | 0 | 40/40 |
| Translated novel | 188 | 186/186 | 184 | 2 | 0 | 0 | 39/40 |
| Translated novel | 389 | 383/387 | 382 | 1 | 0 | 0 | 40/40 |
| Literary novel | 131 | 126/127 | 124 | 0 | 2 | 0 | 40/40 |
| Long literary novel | 860 | 849/856 | 839 | 10 | 0 | 0 | 40/40 |
| Annotated play (edition B, footnotes as pages) | 1462 | 1451/1459 | 1243 | 0 | 207 | 1 | 37/40 |
| French textbook (exercises) | 105 | 100/101 | 95 | 1 | 1 | 2 | 12/38 |
| Translated novel | 189 | 185/186 | 185 | 0 | 0 | 0 | 38/40 |
| Short stories | 146 | 141/142 | 137 | 2 | 2 | 0 | 38/40 |
| Annotated play | 211 | 192/202 | 191 | 0 | 1 | 0 | 29/37 |
| Annotated sonnets | 405 | 234/399 | 230 | 2 | 1 | 1 | 29/38 |
| Annotated play | 210 | 184/198 | 183 | 1 | 0 | 0 | 26/40 |
| Annotated play | 232 | 214/229 | 211 | 1 | 2 | 0 | 29/40 |
| Illustrated health reference (46 MB) | 704 | 660/677 | 645 | 2 | 13 | 0 | 39/40 |
| Illustrated cookbook (98 MB) | 1829 | 1200/1715 | 1145 | 14 | 41 | 0 | 30/31 |
| **Total (26 books)** | | **9660/10459** (92.4%) | **9298** (96.3%) | **64** (0.7%) | **292** (3.0%) | **5** (0.05%) | **934/1024** (91.2%) |

### Reading the results

- Ordinary prose lands on the exact page 98–100% of the time.
- Most percentage fallbacks come from one edition that renders every footnote as its own one-line
  page; those pages hold too few words to identify.
- Annotated plays and sonnets interleave line numbers with the verse. Outbound placement drops to
  60–90% there (the rest sync by percentage) and the letters-only matching pass finds the verse
  despite the numbers.
- The 5 wrong pages are chapter headings that also appear in a table of contents or answer key,
  where the reader's text around the true place differs from the book's.
- Searches stop early: most positions are found within 20–150 page reads. The worst case, the
  1,462-page footnote edition, reads most of the book (about 30 s, with a status message).

## Reproducing

See [DEVELOPMENT.md](DEVELOPMENT.md#real-book-qualification). The pipeline needs the device (for
page texts), local copies of the same files and CWA's `text_anchor.py`/`koreader_xpointer.py`.
