#!/usr/bin/env python3
"""Qualify EPUB sync on real books, end to end, without touching the server.

For every page the Supernote displayed (captured with tools/device.py), this
replays what happens in production:

  outbound  plugin anchor for the page  ->  CWA places it as a KOReader XPointer
  roundtrip that XPointer  ->  CWA's anchor for it  ->  plugin finds the page again
  inbound   random KOReader positions in the book  ->  CWA anchor  ->  plugin page

CWA's placement code is Calibre-Web-NextGen's own cps/services/text_anchor.py and
koreader_xpointer.py (GPL-3.0, not vendored here): pass a directory containing
cps/__init__.py and those two modules with --cwa. Requires lxml and html5lib.

    qualify.py --dump epub_all.json --corpus DIR --map index.txt --cwa DIR --out report.json
"""
import argparse
import json
import os
import random
import subprocess
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))


def node(*args, stdin=None):
    out = subprocess.run(["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", os.path.join(HERE, "anchors.ts"), *args],
                         check=True, capture_output=True, text=True)
    return json.loads(out.stdout)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dump", required=True)
    ap.add_argument("--corpus", required=True, help="local copies of the device files")
    ap.add_argument("--cwa", required=True)
    ap.add_argument("--random", type=int, default=40, help="random inbound positions per book")
    ap.add_argument("--out", required=True)
    ap.add_argument("--reuse", help="reuse placements from an earlier run's <out>.in.json (only re-runs the plugin search)")
    args = ap.parse_args()
    sys.path.insert(0, args.cwa)
    from cps.services import text_anchor as ta, koreader_xpointer as kx  # noqa: E402

    local = lambda device_path: os.path.join(args.corpus, os.path.basename(device_path))
    anchors = node("outbound", args.dump)
    if args.reuse:
        with open(args.reuse) as handle:
            saved = json.load(handle)
        placed = defaultdict(lambda: [0, 0], {k: v for k, v in saved["placed"].items()})
        roundtrip, inbound = saved["roundtrip"], saved["inbound"]
    else:
        placed, roundtrip, inbound = place_all(args, ta, kx, anchors, local)
    with open(args.out + ".in.json", "w") as handle:
        json.dump({"placed": placed, "roundtrip": roundtrip, "inbound": inbound}, handle)
    with open(args.out + ".items.json", "w") as handle:
        json.dump(roundtrip + inbound, handle)
    results = node("inbound", args.dump, args.out + ".items.json")
    write_report(args, anchors, placed, results)


def place_all(args, ta, kx, anchors, local):
    placed, roundtrip = defaultdict(lambda: [0, 0]), []
    for item in anchors:
        epub = local(item["path"])
        pct = (item["page"] + 1) / item["total"] * 100
        found = ta.place(epub, item["anchor"], pct)
        placed[item["path"]][1] += 1
        if not found:
            continue
        placed[item["path"]][0] += 1
        xpointer, percent = found
        back = ta.anchor_at(epub, xpointer)
        if back:
            roundtrip.append({"path": item["path"], "page": item["page"], "percent": percent, "anchor": back,
                              "xpointer": xpointer, "kind": "roundtrip"})

    rng = random.Random(1)
    inbound = []
    for path in {i["path"] for i in anchors}:
        epub = local(path)
        book = ta._book(epub)
        if not book or not book.text:
            continue
        for _ in range(args.random):
            at = rng.randrange(len(book.text))
            m, j = book.source(at)
            xpointer = kx.xpointer_at_solid_index(epub, book.members[m], j, book.solids[m])
            back = ta.anchor_at(epub, xpointer) if xpointer else None
            if back:
                inbound.append({"path": path, "page": None, "percent": at / len(book.text) * 100, "anchor": back,
                                "xpointer": xpointer, "kind": "random"})

    return placed, roundtrip, inbound


def write_report(args, anchors, placed, results):
    report = {}
    for path in sorted({i["path"] for i in anchors}):
        rt = [r for r in results if r["path"] == path and r["kind"] == "roundtrip"]
        rd = [r for r in results if r["path"] == path and r["kind"] == "random"]
        report[os.path.basename(path)] = {
            "pages_with_text": placed[path][1],
            "outbound_placed": placed[path][0],
            "roundtrip": len(rt),
            "roundtrip_exact": sum(r["found"] == r["page"] for r in rt),
            "roundtrip_adjacent": sum(r["found"] is not None and abs(r["found"] - r["page"]) == 1 for r in rt),
            "roundtrip_missed": sum(r["found"] is None for r in rt),
            "roundtrip_wrong": sum(r["found"] is not None and abs(r["found"] - r["page"]) > 1 for r in rt),
            "random": len(rd),
            "random_found": sum(r["found"] is not None for r in rd),
            "random_agrees_with_exhaustive": sum(r["found"] == r["truth"] for r in rd if r["found"] is not None),
            "random_findable": sum(r["truth"] is not None for r in rd),
            "random_mean_reads": round(sum(r["reads"] for r in rd) / max(1, len(rd)), 1),
        }
    with open(args.out, "w") as handle:
        json.dump({"books": report, "failures": [r for r in results if r["found"] is None
                                                  or (r["page"] is not None and abs(r["found"] - r["page"]) > 1)
                                                  or (r["truth"] is not None and r["found"] != r["truth"])]},
                  handle, indent=1, ensure_ascii=False)
    for name, row in report.items():
        print(name, row)


if __name__ == "__main__":
    main()
