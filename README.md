# Supernote KOSync

A Supernote plugin that syncs your reading position for **any EPUB or PDF** between the Supernote's built-in reader and [KOReader](https://koreader.rocks) (or any other KOSync client) through a [KOSync](https://github.com/koreader/koreader-sync-server) server, with first-class support for [Calibre-Web-Automated](https://github.com/crocodilestick/Calibre-Web-Automated) / [Calibre-Web-NextGen](https://github.com/new-usemame/Calibre-Web-NextGen).

Open a book, read, and your position is saved. Open the same book on another device and it offers to continue where you left off. No per-book setup and no extra server.

## How it works

The plugin speaks the same KOSync protocol as KOReader, directly to your server:

| | PDF | EPUB |
| --- | --- | --- |
| **Book identity** | KOReader's partial-MD5 of the file, so KOReader and the Supernote agree on which book it is without any registration. | same |
| **Saving a position** | KOReader's own format: the page number. | The words that open the current page, plus a percentage. CWA's crengine-compatible mapper turns those words into the exact KOReader XPointer, so KOReader lands on the same passage. |
| **Applying a position** | Jump to that page. | CWA returns the words at the shared position; the plugin searches the reader's page text for them and jumps to that page. Positions shared only as a percentage (web reader, Kobo, books CWA can't map) go to the matching page approximately. |

Behaviour follows KOReader's sync plugin with CWA's defaults: the position is pulled when a book opens and when the device wakes; a newer position from another device is offered (*Go to page N / Stay*), never forced; an older one is ignored; the page you settle on is pushed a few seconds after you stop turning. Offline movement is kept and sent when Wi-Fi returns.

The plugin never modifies books, the server's database or the reader's own files.

## Requirements

- A Supernote with plugin support. Tested on a Manta (A5 X2), firmware `Chauvet.E103.2610091001`; other plugin-capable models should work but are untested.
- A KOSync server reachable from the Supernote's Wi-Fi:
  - **Calibre-Web-Automated (NextGen)**: full EPUB and PDF sync (needs its `percentage_push` and `anchor` capabilities, present in current releases).
  - **Any other KOSync server**: PDFs sync fully; EPUB positions can be received approximately but not sent (stock KOSync has no way to accept a position without a KOReader XPointer).
- Books in a folder plugins may read: anywhere on the SD card, or under `Document` on internal storage. (Supernote limits plugins to these places.)
- KOReader on your other devices pointed at the same server and account. With CWA, use CWA's KOReader plugin or KOReader's built-in sync with "Binary" document matching (the default).

## Install

1. Download `SupernoteKOSync-<version>.snplg` from [Releases](../../releases) (or [build it](#building)).
2. Copy it to the Supernote's `MyStyle` folder (USB, Supernote Partner app or cloud).
3. On the Supernote: **Settings → Apps → Plugins → Select Plugin Package**, pick the file, tap **Install**, and make sure it is switched on.
4. Open any EPUB or PDF, tap the plugin icon in the side toolbar and choose **KOSync**.
5. Enter your server address (for CWA: `http://<server>:8083`), username and password, then **Save and test**. A CWA app password works and is recommended.

Grant the file and network permissions when asked.

## Everyday use

- Just read. The Supernote KOSync panel (side toolbar → plugins → **KOSync**) shows what happened last: *Saved page 42 of 310*, *In sync with KOReader*, or a problem to fix.
- **Sync now** pulls immediately and pushes this page if it is the furthest.
- **Ask before jumping** (on by default): turn it off to follow other devices automatically.
- **Sync automatically while reading**: turn it off to sync only with **Sync now**.
- **Show log** displays the plugin's recent activity for troubleshooting.

## Good to know

- **Same file, same book.** Positions are shared between identical files. A different edition or a converted copy is a different document for KOReader too. With CWA, all files of a library book share one position, and CWA maps between them where it can.
- **Furthest position wins on CWA.** CWA keeps the position furthest into the book across devices (a device can always move its own position back). If you jump back on one device, other devices keep the further position; the panel tells you when that happens.
- **EPUB pages differ between readers.** Font and layout differ, so the plugin maps by text: you land on the page containing the same sentence. Pages without text (covers, full-page images) are saved by percentage.
- **PDF**: physical pages are synced; zoom and position within a page are not. The Supernote's page count matched the physical page count for every PDF tested.
- **How exact is EPUB sync?** Replaying 10,459 real pages from 26 library books, a Supernote position came back to the exact page 96.3% of the time and to the neighbouring page 0.7% of the time. In 3% (mostly an edition that makes every footnote its own page) the words could not be told apart and the page was taken from the percentage instead, which the prompt marks as approximate. A wrong page was chosen 0.05% of the time. Details: [docs/QUALIFICATION.md](docs/QUALIFICATION.md).
- **Some EPUBs won't open on the Supernote at all.** The built-in reader refuses EPUBs with Adobe-obfuscated fonts ("cannot open due to DRM"), even though they contain no DRM; 3 of 30 sampled library books did this. Re-converting the book in Calibre (EPUB to EPUB) rewrites the fonts and should fix it (not verified here). KOReader opens these files normally.
- **Plain http.** CWA is usually served over plain HTTP on a home network, like KOReader's own sync. Use an app password, or put CWA behind HTTPS (the plugin supports `https://` with a normally trusted certificate).

## Building

Requires Node 22+, a JDK 17+ and an Android SDK (platform 35, build-tools 35, NDK 27).

```bash
cd plugin && npm ci && cd ..
JAVA_HOME=/path/to/jdk ANDROID_HOME=/path/to/android-sdk tools/build.sh
```

The package is written to `dist/SupernoteKOSync-<version>.snplg` after the unit tests, the TypeScript check and a package content check pass. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the architecture, device testing tools and the real-book qualification pipeline.

## Credits

- [KOReader](https://github.com/koreader/koreader) defines the sync protocol, document identity and position formats this plugin follows.
- [Calibre-Web-NextGen](https://github.com/new-usemame/Calibre-Web-NextGen) provides the text-anchor protocol and the crengine-compatible XPointer mapping that make exact EPUB positions possible without running crengine on the Supernote.
- Built on Ratta's [Supernote plugin SDK](https://docs.supernote.com/en/first-plugin) (`sn-plugin-lib`).

## License

[MIT](LICENSE)
