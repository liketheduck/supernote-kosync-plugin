# Development

## Layout

```
plugin/                     React Native project packaged as a Supernote plugin
  index.js                  registers the DOC side-toolbar button, touch listener and ticker
  App.tsx                   the KOSync panel: status, jump question, settings
  src/core/                 platform-free logic, unit-tested with Node
    fold.ts                 text comparison form (mirrors CWA's text_anchor._fold)
    anchor.ts               page anchors and anchor search across reader pages
    kosync.ts               KOSync wire format (KOReader + CWA extensions)
    engine.ts               the sync state machine (open, pull, prompt, jump, push)
  src/device.ts             Supernote host: SDK calls, native module, prompts, ticking
  src/harness.ts            developer harness (inactive unless a request file exists)
  android/.../KosyncModule.kt  native services: KOReader digest, credentials, HTTP, state, timer
  tests/                    node:test suites for core and engine
tools/
  build.sh                  tests, typecheck, package build and package verification
  device.py                 drives the harness over USB (page counts, texts, jumps)
  qualify/                  real-book qualification against CWA's own mapping code
docs/                       this file and the qualification report
```

## Design

The plugin is a KOSync client. It holds no book index and runs no rendering engine; the two
hard problems are delegated to the components that already solve them:

- **Document identity** is KOReader's binary partial MD5 (`util.partialMD5`), computed natively
  from the open file. KOReader, CWA and this plugin therefore name the same file the same way.
- **EPUB positions.** KOReader stores a crengine XPointer. The Supernote reader exposes only
  page numbers and page text. Calibre-Web-NextGen's text-anchor protocol bridges the two: the
  plugin sends `{text, before, after}` words from the top of the page with
  `position_kind: "percentage"`, and CWA places them in the library EPUB with its
  crengine-compatible `koreader_xpointer` module, storing a real XPointer for KOReader. On pull,
  `?position_kinds=locator,percentage,anchor` makes CWA return the words at the shared position,
  and the plugin searches the reader's page text for them (`findAnchorPage`). The search uses
  the server's own rules: longest needle first, minimum 12 folded characters, and the nearest
  of several matches only when no other lies within 5% of the book of the expected place.
- **PDF positions** are KOReader's page-number locator and `page / page_count` percentage.

Sync policy (`engine.ts`) follows KOReader's kosync plugin: pull on open and on wake, offer a
newer position (`askBeforeJump`) and never apply an older one, push the page after it has been
stable for 4 s, keep unsent movement across restarts, never push a page change caused by a jump
or by a font/layout change. Responses follow CWNG's `SyncLogic.resolveRemotePosition`.

### Platform constraints found on the device

These are not documented by Ratta; each was observed on a Manta (Chauvet 3.30.45) and
shaped the code:

- **JavaScript timers stop while the plugin view is hidden.** Only native events and native
  promise resolutions wake the JS thread. All waiting therefore goes through
  `KosyncNative.sleep` and the native `kosync_tick` event; nothing in the plugin uses
  `setTimeout`.
- **Plugin file access is whitelisted.** On internal storage plugins may read only `Document`,
  `Note`, `EXPORT`, `INBOX`, `MyStyle` and `SCREENSHOT` (`android.os.PluginSecurityManager`).
  Removable storage is not restricted. Books elsewhere get an explanatory status.
- **Plugins cannot write shared storage**, so the log lives in the app's private files and is
  mirrored to logcat (tag `KOSync`); the panel's *Show log* displays it.
- **Cleartext HTTP is blocked** for PluginHost's HTTP stack (target SDK 35, no exemption).
  `http://` requests use a minimal HTTP/1.1 client over a socket; `https://` uses the system
  TLS stack and trust store.
- `getCurrentDocText(page)` works for any page (10–50 ms each) and returns plain text with
  line breaks; image-only pages return an empty string. `jumpToPage` lands exactly in ~0.3 s.
- PluginHost lifecycle messages: state 1 = started, 4/5 = stopping.

## Tests

```bash
cd plugin
npm test            # core + engine suites (node:test, no device needed)
npx tsc --noEmit    # typecheck
```

The engine suite runs the real `SyncEngine` against a fake reader and a fake CWA server with
furthest-wins semantics.

## Device harness

The harness is compiled only into developer packages (`tools/build.sh --harness`). With such a
package installed and DOC in the foreground, `tools/device.py` asks the plugin to open
files, read page counts and texts and perform jumps, and collects the results from logcat.
Sync is paused during a run and the previously open book is reopened afterwards. Keep test
copies on the SD card outside synced folders (internal `Document` is cloud-synced).

```bash
tools/device.py read --pages all --out pages.json /storage/XXXX-XXXX/kosync-test/book.epub
```

## Real-book qualification

`tools/qualify/qualify.py` replays production behaviour for every page the Supernote displayed,
using Calibre-Web-NextGen's own `text_anchor.py` and `koreader_xpointer.py` (copy them from your
CWA container; they are GPL-3.0 and not vendored here):

1. **outbound**: the plugin's anchor for each page is placed by CWA (XPointer for KOReader);
2. **round trip**: CWA's anchor for that XPointer is found again by the plugin's search;
3. **inbound**: random positions across each book (as KOReader would report them) are found by
   the plugin and compared with an exhaustive search.

```bash
tools/device.py read --pages all --out dump.json /storage/XXXX-XXXX/kosync-test/*.epub
python3 tools/qualify/qualify.py --dump dump.json --corpus ./copies --cwa ./cwa-src --out report.json
```

Results for a 42-book sample of a real library are in [QUALIFICATION.md](QUALIFICATION.md).

## Building and installing

`tools/build.sh` (see the README) produces `dist/SupernoteKOSync-<version>.snplg`. Install it through
**Settings → Apps → Plugins → Select Plugin Package**; installing a new version over an old one
keeps settings. Keep the plugin ID (`supernotekosync1` in `plugin/PluginConfig.json`) unchanged so upgrades replace the installed plugin.
