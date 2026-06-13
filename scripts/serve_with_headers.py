#!/usr/bin/env python3
import argparse
import functools
import http.server
import json
import mimetypes
import os
import pathlib
import re
import threading
import time
from urllib.parse import parse_qs, urlparse


RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
STATS_LOCK = threading.Lock()
RANGE_STATS = {}
LOG_LOCK = threading.Lock()
BROWSER_LOG_LINES = []
MAX_BROWSER_LOG_LINES = 4000
MAX_BROWSER_LOG_CHARS = 600000
MAX_BROWSER_LOG_POST_BYTES = 1024 * 1024


def is_tracked_path(url_path):
    return url_path.startswith("/qemu-lazy/") and (
        url_path.endswith(".img") or url_path.endswith(".data")
    )


def record_request(url_path, method, status, byte_range, size):
    if not is_tracked_path(url_path):
        return

    with STATS_LOCK:
        entry = RANGE_STATS.setdefault(url_path, {
            "path": url_path,
            "size": size,
            "head": 0,
            "get": 0,
            "rangeGet": 0,
            "rangeBytes": 0,
            "lastStatus": 0,
            "lastAt": 0,
            "lastRanges": [],
        })
        entry["size"] = size
        entry["lastStatus"] = int(status)
        entry["lastAt"] = time.time()

        if method == "HEAD":
            entry["head"] += 1
        elif method == "GET" and byte_range:
            start, end = byte_range
            entry["rangeGet"] += 1
            entry["rangeBytes"] += end - start + 1
            entry["lastRanges"].append({"start": start, "end": end})
            entry["lastRanges"] = entry["lastRanges"][-8:]
        elif method == "GET":
            entry["get"] += 1


def range_stats_payload(reset=False):
    if reset:
        with STATS_LOCK:
            RANGE_STATS.clear()

    with STATS_LOCK:
        entries = [
            {**entry, "lastAtMs": int(entry["lastAt"] * 1000)}
            for entry in RANGE_STATS.values()
        ]

    entries.sort(key=lambda item: item["path"])
    return {
        "generatedAtMs": int(time.time() * 1000),
        "entries": entries,
    }


def append_browser_log(lines):
    accepted = 0
    cleaned = []
    for line in lines:
        text = str(line).replace("\x00", "")
        if not text:
            continue
        cleaned.append(text[:8000])
        accepted += 1

    if not cleaned:
        return 0

    with LOG_LOCK:
        BROWSER_LOG_LINES.extend(cleaned)
        total_chars = 0
        trim_at = 0
        for index in range(len(BROWSER_LOG_LINES) - 1, -1, -1):
            total_chars += len(BROWSER_LOG_LINES[index]) + 1
            if len(BROWSER_LOG_LINES) - index > MAX_BROWSER_LOG_LINES or total_chars > MAX_BROWSER_LOG_CHARS:
                trim_at = index + 1
                break
        if trim_at:
            del BROWSER_LOG_LINES[:trim_at]

    return accepted


def browser_log_payload(reset=False):
    with LOG_LOCK:
        if reset:
            BROWSER_LOG_LINES.clear()
        lines = list(BROWSER_LOG_LINES)

    return {
        "generatedAtMs": int(time.time() * 1000),
        "count": len(lines),
        "lines": lines,
    }


class IsolationHandler(http.server.SimpleHTTPRequestHandler):
    range = None

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/__range-stats.json":
            reset = parse_qs(parsed.query).get("reset") == ["1"]
            self.send_json(range_stats_payload(reset=reset))
            return
        if parsed.path == "/__browser-log.json":
            reset = parse_qs(parsed.query).get("reset") == ["1"]
            self.send_json(browser_log_payload(reset=reset))
            return
        if parsed.path == "/__exists.json":
            self.send_json(self.exists_payload(parsed))
            return
        super().do_GET()

    def do_HEAD(self):
        parsed = urlparse(self.path)
        if parsed.path == "/__range-stats.json":
            self.send_json(range_stats_payload(), include_body=False)
            return
        if parsed.path == "/__browser-log.json":
            self.send_json(browser_log_payload(), include_body=False)
            return
        if parsed.path == "/__exists.json":
            self.send_json(self.exists_payload(parsed), include_body=False)
            return
        super().do_HEAD()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/__browser-log":
            self.send_error(http.HTTPStatus.NOT_FOUND, "File not found")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(http.HTTPStatus.BAD_REQUEST, "Invalid Content-Length")
            return

        if length > MAX_BROWSER_LOG_POST_BYTES:
            self.send_error(http.HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Browser log payload too large")
            return

        body = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "")
        lines = []

        if "application/json" in content_type:
            try:
                payload = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.send_error(http.HTTPStatus.BAD_REQUEST, "Invalid JSON")
                return
            if isinstance(payload, dict) and isinstance(payload.get("lines"), list):
                lines = payload["lines"]
            elif isinstance(payload, dict) and "line" in payload:
                lines = [payload["line"]]
            elif isinstance(payload, list):
                lines = payload
            else:
                self.send_error(http.HTTPStatus.BAD_REQUEST, "Expected line or lines")
                return
        else:
            lines = body.decode("utf-8", "replace").splitlines()

        accepted = append_browser_log(lines)
        self.send_json({
            "ok": True,
            "accepted": accepted,
            "generatedAtMs": int(time.time() * 1000),
        })

    def exists_payload(self, parsed):
        requested = parse_qs(parsed.query).get("path", [""])[0]
        if not requested.startswith("/"):
            requested = "/" + requested

        translated = self.translate_path(requested)
        exists = os.path.isfile(translated)
        size = os.path.getsize(translated) if exists else 0
        return {
            "ok": exists,
            "path": requested,
            "size": size,
            "acceptRanges": "bytes" if exists else "",
            "generatedAtMs": int(time.time() * 1000),
        }

    def send_json(self, payload, include_body=True):
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(http.HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_head(self):
        self.range = None
        url_path = urlparse(self.path).path
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()

        ctype = self.guess_type(path)
        try:
            file = open(path, "rb")
        except OSError:
            self.send_error(http.HTTPStatus.NOT_FOUND, "File not found")
            return None

        size = os.fstat(file.fileno()).st_size
        start = 0
        end = size - 1
        status = http.HTTPStatus.OK
        range_header = self.headers.get("Range")

        if range_header:
            match = RANGE_RE.match(range_header.strip())
            if not match:
                file.close()
                self.send_error(http.HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return None

            first, last = match.groups()
            if first:
                start = int(first)
                end = int(last) if last else size - 1
            elif last:
                suffix = int(last)
                start = max(size - suffix, 0)
                end = size - 1
            else:
                file.close()
                self.send_error(http.HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return None

            if start >= size or end < start:
                file.close()
                self.send_response(http.HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                return None

            end = min(end, size - 1)
            status = http.HTTPStatus.PARTIAL_CONTENT
            self.range = (start, end)

        self.send_response(status)
        self.send_header("Content-type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Last-Modified", self.date_time_string(os.fstat(file.fileno()).st_mtime))
        if status == http.HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(end - start + 1))
        else:
            self.send_header("Content-Length", str(size))
        self.end_headers()
        record_request(url_path, self.command, status, self.range, size)
        return file

    def copyfile(self, source, outputfile):
        if not self.range:
            return super().copyfile(source, outputfile)

        start, end = self.range
        source.seek(start)
        remaining = end - start + 1
        while remaining:
            chunk = source.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default="public")
    parser.add_argument("port", nargs="?", default=8088, type=int)
    args = parser.parse_args()

    root = pathlib.Path(args.root).resolve()
    mimetypes.add_type("application/wasm", ".wasm")
    handler = functools.partial(IsolationHandler, directory=str(root))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)

    print(f"Serving {root} at http://127.0.0.1:{args.port}/")
    print("Headers: COOP=same-origin, COEP=require-corp, CORP=same-origin")
    server.serve_forever()


if __name__ == "__main__":
    main()
