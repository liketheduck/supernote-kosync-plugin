# Changelog

## 1.0.0 — 2026-10-14

First release.

- Syncs EPUB and PDF reading positions between the Supernote reader and KOReader through a KOSync
  server, talking to the server directly (no helper service).
- PDF: KOReader page locators. EPUB: Calibre-Web-NextGen text anchors, converted by the server into
  KOReader XPointers, and found on the reader's pages by text search; percentage fallback.
- Pull on open, on wake and on returning to the reader; *Go to page N / Stay* prompt; push after the
  page settles; offline positions kept and retried.
- Plain-HTTP and HTTPS servers, credentials encrypted with the Android keystore, *Remove login*.
- Qualified on 42 real books; see docs/QUALIFICATION.md.
