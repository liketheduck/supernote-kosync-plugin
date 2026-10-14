#!/usr/bin/env python3
"""Drive the plugin's developer harness on a USB-connected Supernote.

    tools/device.py read --out pages.json /storage/XXXX-XXXX/kosync-test/a.epub /storage/XXXX-XXXX/kosync-test/b.pdf
    tools/device.py read --pages all --max-pages 400 --out all.json /storage/XXXX-XXXX/kosync-test/a.epub
    tools/device.py read --jumps 5,40 --out jumps.json /storage/XXXX-XXXX/kosync-test/a.epub

The plugin must be installed and enabled with the reader (DOC) in the foreground.
Sync is paused while the harness runs; the previously open document is reopened.
Results arrive over logcat (tag KOSyncHarness) and are written as JSON.
"""
import argparse
import json
import subprocess
import sys
import tempfile
import time
import uuid

# Plugins may only read a few internal folders (Document, Note, ...) and those are
# cloud-synced, so the harness request and test copies live on the SD card.
REQUEST_NAME = "kosync-test/harness.json"


def sd_card():
    volumes = [v for v in adb("shell", "ls", "/storage").split() if v not in ("emulated", "self")]
    if not volumes:
        sys.exit("No SD card found: the harness needs removable storage")
    return f"/storage/{volumes[0]}"


def adb(*args, **kwargs):
    return subprocess.run(["adb", *args], check=True, capture_output=True, text=True, **kwargs).stdout


def run(files, pages, max_pages, jumps, timeout, internal=False):
    request_id = uuid.uuid4().hex[:12]
    request = {"id": request_id, "files": files, "maxPages": max_pages}
    if pages == "all":
        request["pages"] = "all"
    elif pages:
        request["pages"] = [int(p) for p in pages.split(",")]
    if jumps:
        request["jumps"] = [int(p) for p in jumps.split(",")]
    # Start listening before the request lands; records carry the request id.
    proc = subprocess.Popen(["adb", "logcat", "-v", "raw", "-T", "1", "-s", "KOSyncHarness:I"],
                            stdout=subprocess.PIPE, text=True, errors="replace")
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(request, handle)
    if internal:
        # Fallback when SD-card files are not readable by plugins: Document is
        # readable (but cloud-synced, so the request is removed afterwards).
        target = "/sdcard/Document/kosync-harness.json"
    else:
        adb("shell", "mkdir", "-p", f"{sd_card()}/kosync-test")
        target = f"{sd_card()}/{REQUEST_NAME}"
    adb("push", handle.name, target)
    pieces, records, deadline = {}, [], time.time() + timeout
    try:
        for line in proc.stdout:
            if time.time() > deadline:
                raise TimeoutError("harness did not finish")
            parts = line.rstrip("\n").split(" ", 3)
            if len(parts) < 4 or not parts[1].isdigit() or not parts[2].isdigit():
                continue
            key, index, count, data = parts[0], int(parts[1]), int(parts[2]), parts[3]
            pieces.setdefault(key, {})[index] = data
            if any(i not in pieces[key] for i in range(count)):
                continue
            try:
                chunk = pieces.pop(key)
                record = json.loads("".join(chunk[i] for i in range(count)))
            except json.JSONDecodeError:
                continue
            if record.get("id") != request_id:
                continue
            if record["kind"] == "file":
                records.append(record)
                print(f"  {record['path']}: {record.get('total', record.get('error'))}", file=sys.stderr)
            elif record["kind"] == "error":
                raise RuntimeError(record["error"])
            elif record["kind"] == "done":
                return records
    finally:
        proc.kill()
        if internal:
            subprocess.run(["adb", "shell", "rm", "-f", target])
    raise RuntimeError("logcat ended before the harness finished")


def collect(request_id):
    """Assembles a finished (or partial) run from the current logcat buffer."""
    lines = adb("logcat", "-d", "-v", "raw", "-s", "KOSyncHarness:I").splitlines()
    pieces, records, done = {}, [], False
    for line in lines:
        parts = line.split(" ", 3)
        if len(parts) < 4 or not parts[1].isdigit() or not parts[2].isdigit():
            continue
        key, index, count = parts[0], int(parts[1]), int(parts[2])
        pieces.setdefault(key, {})[index] = parts[3]
        if any(i not in pieces[key] for i in range(count)):
            continue
        try:
            chunk = pieces.pop(key)
            record = json.loads("".join(chunk[i] for i in range(count)))
        except json.JSONDecodeError:
            continue
        if record.get("id") == request_id:
            if record["kind"] == "file":
                records.append(record)
            done = done or record["kind"] == "done"
    return records, done


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    read = sub.add_parser("read", help="read page counts and page texts")
    read.add_argument("files", nargs="+")
    read.add_argument("--pages", help='"all" or comma-separated page indexes (default: a spread)')
    read.add_argument("--max-pages", type=int, default=3000)
    read.add_argument("--jumps", help="comma-separated page indexes to navigate to")
    read.add_argument("--timeout", type=int, default=3600)
    read.add_argument("--out", required=True)
    read.add_argument("--internal-request", action="store_true", help="place the request in Document instead of the SD card")
    gather = sub.add_parser("collect", help="assemble results of a run from the logcat buffer")
    gather.add_argument("id")
    gather.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.command == "collect":
        records, done = collect(args.id)
        with open(args.out, "w") as handle:
            json.dump(records, handle, ensure_ascii=False)
        print(f"{len(records)} results ({'finished' if done else 'partial'})", file=sys.stderr)
        return
    records = run(args.files, args.pages, args.max_pages, args.jumps, args.timeout, args.internal_request)
    with open(args.out, "w") as handle:
        json.dump(records, handle, ensure_ascii=False)
    print(f"wrote {len(records)} results to {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
