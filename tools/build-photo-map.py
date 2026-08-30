#!/usr/bin/env python3
"""Extract PHOTO_MAP out of data.js into near-expiry/photo-map.json.

data.js is regenerated wholesale by convert.py, so the near-expiry pages cannot
import it without pulling half a megabyte onto a phone for a lookup table. This
writes just the table, in the compact shape those pages read:

    {"files": [...], "exact": {name: index}, "loose": {name: index}}

Run it whenever convert.py rebuilds data.js:

    python3 tools/build-photo-map.py

"exact" is keyed the way search.html already keys photos - the product name with
the characters Windows forbids in a filename stripped, lowercased. "loose" also
drops bracketed text, so "ALKOF + COUGH SYRUP (100ML)" finds a photo filed as
"ALKOF + COUGH SYRUP". A loose key that more than one photo answers to is left
out entirely: the 60 ml and 100 ml bottles of a syrup collapse onto the same key
but have different pack shots, and a placeholder beats the wrong bottle.
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "data.js"
TARGET = ROOT / "near-expiry" / "photo-map.json"


def read_photo_map(text):
    """Read the PHOTO_MAP object literal out of data.js by brace matching."""
    start = text.find("const PHOTO_MAP")
    if start == -1:
        sys.exit("data.js no longer defines PHOTO_MAP - check what convert.py emits.")
    body = text[text.index("{", start):]
    depth = 0
    for end, character in enumerate(body):
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return json.loads(body[:end + 1])
    sys.exit("PHOTO_MAP in data.js is not closed - the file looks truncated.")


def exact_key(name):
    """Product name reduced to what a filename can hold, on both sides.

    search.html's sanitizePhotoName simply deletes the characters Windows forbids,
    which loses a match whenever whoever saved the photo substituted instead of
    deleting - "125MG/5ML" was filed as "125MG-5ML", and one name carries a double
    space. Slashes become the hyphen they were saved as, runs of whitespace
    collapse, and the rest is dropped. Bracketed pack text is deliberately kept, so
    the 30 ml and 60 ml bottles still key apart.
    """
    key = re.sub(r"[/\\]", "-", str(name or "").lower())
    key = re.sub(r'[:*?"<>|]', "", key)
    return re.sub(r"\s+", " ", key).strip()


def loose_key(name):
    """shared.js's normalise(): bracketed text dropped, then squeezed to words."""
    return re.sub(r"[^a-z0-9]+", " ", re.sub(r"\([^)]*\)", " ", str(name).lower())).strip()


def build(photo_map):
    files = sorted(set(photo_map.values()))
    index = {name: position for position, name in enumerate(files)}

    # A tightened key can, in principle, bring two different photos together; when it
    # does, drop it rather than pick one, the same way ambiguous loose keys are dropped.
    tight = {}
    for key, filename in photo_map.items():
        tight.setdefault(exact_key(key), set()).add(filename)
    exact = {key: index[next(iter(names))] for key, names in tight.items() if len(names) == 1}

    candidates = {}
    for key, filename in photo_map.items():
        candidates.setdefault(loose_key(key), set()).add(filename)
    loose = {key: index[next(iter(names))] for key, names in candidates.items() if len(names) == 1}

    return ({"files": files, "exact": exact, "loose": loose},
            len(candidates) - len(loose), len(tight) - len(exact))


def main():
    photo_map = read_photo_map(SOURCE.read_text(encoding="utf-8"))

    # A couple of PHOTO_MAP entries name a file that was renamed or never landed in
    # Photos/. Carrying them over would put a broken <img> on the near-expiry page,
    # which is worse than the placeholder, so they are dropped and reported instead.
    missing = sorted({name for name in photo_map.values() if not (ROOT / "Photos" / name).exists()})
    photo_map = {key: name for key, name in photo_map.items() if name not in missing}

    table, ambiguous, collided = build(photo_map)
    TARGET.write_text(json.dumps(table, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"{TARGET.relative_to(ROOT)}: {len(table['files'])} photos, "
          f"{len(table['exact'])} exact keys, {len(table['loose'])} loose keys "
          f"({collided} exact and {ambiguous} loose keys dropped as ambiguous), "
          f"{TARGET.stat().st_size // 1024} KB")
    if missing:
        print(f"skipped {len(missing)} entr{'y' if len(missing) == 1 else 'ies'} naming a file "
              f"that is not in Photos/ - fix these in convert.py so the main site stops "
              f"linking them too: {missing}")


if __name__ == "__main__":
    main()
