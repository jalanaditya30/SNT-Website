#!/usr/bin/env python3
"""Stamp near-expiry's script and stylesheet links with a content hash.

GitHub Pages lets a browser hold on to a .js file while it re-fetches the .html that
loads it, so a deploy can land as new markup driving old code - the company mapping
dropdown rendering empty because the HTML had the field and the cached JS knew nothing
about it. A hash in the query string makes every changed file a new URL, so that mix
cannot happen.

Run it after changing any JS or CSS under near-expiry/, before committing:

    python3 tools/stamp-assets.py

Re-running with nothing changed rewrites nothing.
"""

import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGES = sorted((ROOT / "near-expiry").glob("*.html"))
ASSET = re.compile(r'(?P<attr>src|href)="(?P<file>[^"?:]+\.(?:js|css))(?:\?v=[0-9a-f]+)?"')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()[:8]


def stamp(page):
    text = page.read_text(encoding="utf-8")
    missing = []

    def replace(match):
        target = page.parent / match.group("file")
        if not target.exists():
            missing.append(match.group("file"))
            return match.group(0)
        return f'{match.group("attr")}="{match.group("file")}?v={digest(target)}"'

    stamped = ASSET.sub(replace, text)
    if stamped != text:
        page.write_text(stamped, encoding="utf-8")
    return stamped != text, missing


def main():
    if not PAGES:
        sys.exit("no pages found under near-expiry/")
    for page in PAGES:
        changed, missing = stamp(page)
        print(f"{page.relative_to(ROOT)}: {'updated' if changed else 'already current'}")
        for name in missing:
            print(f"  warning: {name} is referenced but not on disk")


if __name__ == "__main__":
    main()
