"""
Shree Narayani Traders - Data Converter
=======================================
Rebuilds data.js (read by index.html / catalogues.html / search.html) from
Master_File.xlsx plus the Photos/ folder.

Run this any time you:
  * Update Master_File.xlsx (products, PTS, MRP, ...)
  * Add a new company to the spreadsheet
  * Drop new photos into the Photos/ folder

Usage:
    python convert.py                     # rebuild data.js, short summary
    python convert.py --details           # list every affected row
    python convert.py --report            # also write convert_report.csv
    python convert.py --check             # validate only, write nothing
    python convert.py --fix-photo-names   # rename mismatched photos (asks first)
    python convert.py --file "C:/path/Master_File.xlsx"
    python convert.py --sheet "Table 1"
    python convert.py --strict            # exit code 1 if anything is broken

Excel column order (Master_File.xlsx):
    Company | PRODUCTS | PACK | Composition | In Boxes | Shipper Qty | PTS | MRP | Remark

Photo naming
------------
Photos live in "Photos/" next to the Excel file and are named after the product,
as produced by photo-namer.html. Windows forbids  / \\ : * ? " < > |  in
filenames, so matching uses a CANONICAL KEY rather than the raw name:

    NFKC normalise -> / \\ : * ? " < > |  become spaces
                   -> apostrophes (' and the curly ones) are dropped
                   -> runs of whitespace collapse to one space
                   -> trailing dots and spaces removed
                   -> lowercased

So Excel "ALMOX DRY SYRUP 125MG/5ML (30ML)" matches the file
"ALMOX DRY SYRUP 125MG 5ML (30ML).jpeg", and "ALDIGESIC MR (10'S)" matches
"ALDIGESIC MR (10S).jpeg".

IMPORTANT: photo_key() below must behave identically to sanitizePhotoName() in
search.html and clean() in photo-namer.html. Change one, change all three.
"""

import argparse
import csv
import difflib
import json
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime

try:
    import openpyxl
except ImportError:
    sys.exit(
        "openpyxl is not installed.\n"
        f"Run:  {sys.executable} -m pip install openpyxl\n"
        "then run this script again."
    )

PHOTO_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif")
EXT_PRIORITY = {ext: i for i, ext in enumerate(PHOTO_EXTS)}
HEADER_MARKERS = {"company", "sr.no.", "sr no", "sr. no.", "srno"}
RULE = "-" * 68


# --- canonical text handling -------------------------------------------------

_ILLEGAL = re.compile(r'[/\\:*?"<>|]')
_APOS = re.compile(r"['\u2019\u2018\u0060\u00b4]")
_WS = re.compile(r"\s+")
_TRAIL = re.compile(r"[.\s]+$")


def clean_text(value) -> str:
    """Tidy a spreadsheet cell: NFKC, no NBSP, single spaces, trimmed."""
    if value is None:
        return ""
    s = unicodedata.normalize("NFKC", str(value))
    s = s.replace("\u00a0", " ")
    return _WS.sub(" ", s).strip()


def photo_key(name) -> str:
    """Canonical key pairing a product name with its photo filename.

    Mirrors sanitizePhotoName() in search.html and clean() in photo-namer.html.
    """
    if name is None:
        return ""
    s = unicodedata.normalize("NFKC", str(name))
    s = _ILLEGAL.sub(" ", s)
    s = _APOS.sub("", s)
    s = _WS.sub(" ", s).strip()
    return _TRAIL.sub("", s).lower()


def photo_filename(product, ext=".jpg") -> str:
    """The filename photo-namer.html would give this product."""
    s = unicodedata.normalize("NFKC", str(product))
    s = _ILLEGAL.sub(" ", s)
    s = _APOS.sub("", s)
    s = _WS.sub(" ", s).strip()
    return _TRAIL.sub("", s) + ext


def parse_number(v):
    """Best-effort float. Returns (value, was_bad). Blank -> (None, False)."""
    if v is None:
        return None, False
    if isinstance(v, bool):
        return None, True
    if isinstance(v, (int, float)):
        return float(v), False
    s = clean_text(v).replace(",", "").replace("\u20b9", "")
    s = re.sub(r"^Rs\.?\s*", "", s, flags=re.I).strip()
    if not s or s in {"-", "--", "NA", "N/A", "na", "n/a"}:
        return None, False
    try:
        return float(s), False
    except ValueError:
        return None, True


def cell(row, i):
    return row[i] if i < len(row) else None


# --- reading the workbook ----------------------------------------------------

def read_rows(excel_path, only_sheet=None):
    """Return (records, issues). One record per product row, de-duplicated."""
    wb = openpyxl.load_workbook(excel_path, data_only=True, read_only=True)
    sheets = wb.sheetnames
    if only_sheet:
        if only_sheet not in sheets:
            sys.exit(f"ERROR: sheet {only_sheet!r} not found. Sheets: {sheets}")
        sheets = [only_sheet]

    issues = []
    records = []
    seen = {}

    def flag(level, code, where, msg):
        issues.append((level, code, where, msg))

    for sheet_name in sheets:
        ws = wb[sheet_name]
        for excel_row, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
            if not row:
                continue
            company_raw = cell(row, 0)
            if company_raw is None or not clean_text(company_raw):
                continue
            if clean_text(company_raw).lower() in HEADER_MARKERS:
                continue

            company = clean_text(company_raw)
            product = _TRAIL.sub("", clean_text(cell(row, 1)))
            pack = clean_text(cell(row, 2))
            composition = clean_text(cell(row, 3))
            in_boxes = clean_text(cell(row, 4))
            shipper = clean_text(cell(row, 5))
            pts, pts_bad = parse_number(cell(row, 6))
            mrp, mrp_bad = parse_number(cell(row, 7))
            remark = clean_text(cell(row, 8))

            where = f"{sheet_name}!{excel_row}"

            if not product:
                flag("error", "blank-product", where, "Product name is blank - row skipped")
                continue
            if pts_bad:
                flag("error", "bad-number", where, f"PTS is not a number: {cell(row, 6)!r}")
            if mrp_bad:
                flag("error", "bad-number", where, f"MRP is not a number: {cell(row, 7)!r}")
            if pts and mrp and pts > 0 and mrp > 0 and mrp < pts:
                flag("error", "mrp-below-pts", where,
                     f"{product} - MRP {mrp:g} is below PTS {pts:g}, values look swapped")
            if pts is None:
                flag("warn", "no-pts", where, product)
            if mrp is None:
                flag("warn", "no-mrp", where, product)
            if not pack:
                flag("info", "no-pack", where, product)
            if not composition:
                flag("info", "no-composition", where, product)

            sig = (company.lower(), photo_key(product), pack.lower(),
                   pts, mrp, composition.lower())
            if sig in seen:
                flag("warn", "duplicate-row", where, f"{product} ({pack}) - same as {seen[sig]}")
                continue
            seen[sig] = where

            records.append({
                "sheet": sheet_name, "excelRow": excel_row,
                "company": company, "product": product, "pack": pack,
                "composition": composition,
                "inBoxes": in_boxes or None, "shipperQty": shipper or None,
                "pts": pts, "mrp": mrp, "remark": remark,
            })

    wb.close()
    return records, issues


# --- reading the Photos folder ----------------------------------------------

def read_photos(photos_dir):
    """Return (photo_map, issues, skipped). photo_map: canonical key -> filename.

    When two files share one key (NAME.jpg and NAME.jpeg) they are usually two
    different shots of the same product, not copies. Keep the LARGEST file; the
    extension order only breaks an exact size tie so runs stay reproducible.
    """
    issues = []
    skipped = []
    if not os.path.isdir(photos_dir):
        return {}, issues, skipped

    buckets = defaultdict(list)
    for fname in sorted(os.listdir(photos_dir)):
        full = os.path.join(photos_dir, fname)
        if not os.path.isfile(full):
            continue
        stem, ext = os.path.splitext(fname)
        ext = ext.lower()
        if ext not in PHOTO_EXTS:
            skipped.append(fname)
            continue
        if not stem.strip():
            issues.append(("warn", "bad-filename", "Photos", f"Empty name: {fname}"))
            continue
        try:
            size = os.path.getsize(full)
        except OSError:
            size = 0
        if size == 0:
            issues.append(("error", "empty-file", "Photos", f"{fname} is 0 bytes - re-save it"))
            continue
        key = photo_key(stem)
        if key:
            buckets[key].append((-size, EXT_PRIORITY[ext], fname, size))

    photo_map = {}
    for key, entries in buckets.items():
        entries.sort()
        best = entries[0]
        photo_map[key] = best[2]
        if len(entries) > 1:
            stem = os.path.splitext(best[2])[0]
            bits = [f"{os.path.splitext(e[2])[1]} {e[3] // 1024} KB" for e in entries]
            issues.append(("warn", "several-files", "Photos",
                           f"{stem}   {bits[0]} (using)   " + "   ".join(bits[1:])))
    return photo_map, issues, skipped


# --- console report ----------------------------------------------------------

def print_report(records, issues, companies, by_co, photo_map, missing_photo,
                 orphan_files, photos_dir, output_path, updated_at,
                 details, check_only):
    by_code = defaultdict(list)
    for level, code, where, msg in issues:
        by_code[code].append((where, msg))
    errors = [i for i in issues if i[0] == "error"]

    n = len(records)
    with_photo = n - len(missing_photo)
    with_pts = sum(1 for r in records if r["pts"] is not None)
    with_mrp = sum(1 for r in records if r["mrp"] is not None)

    print(f"\n{RULE}")
    print(f"  SNT catalogue{' ' * 27}{updated_at}")
    print(RULE)
    print(f"  Products   {n}")
    print(f"  Prices     PTS {with_pts}, MRP {with_mrp}"
          f"   ({n - with_pts} and {n - with_mrp} missing)")
    if os.path.isdir(photos_dir):
        line = f"  Photos     {with_photo} of {n}   ({len(missing_photo)} still needed"
        line += f", {len(orphan_files)} file unmatched)" if orphan_files else ")"
        print(line)
    else:
        print("  Photos     no Photos folder next to the Excel file")

    print("\n  Companies   (in spreadsheet order - this is the order on the site)")
    width = max(len(c) for c in companies) + 1
    per_line = max(1, 60 // (width + 9))
    parts = [f"{i}. {c:<{width}}{by_co[c]:>4}" for i, c in enumerate(companies, start=1)]
    for i in range(0, len(parts), per_line):
        print("     " + "  ".join(parts[i:i + per_line]))

    def group(code, label, limit=5):
        items = by_code.get(code)
        if not items:
            return
        print(f"\n  {label}  ({len(items)})")
        shown = items if details else items[:limit]
        for where, msg in shown:
            loc = where.split("!")[-1] if "!" in where else where
            loc = f"row {loc:<6}" if loc.isdigit() else ""
            print(f"     {loc}{msg}" if loc else f"     {msg}")
        if len(items) > len(shown):
            print(f"     ... and {len(items) - len(shown)} more"
                  "   (use --details)")

    if errors:
        print(f"\n{RULE}")
        print(f"  NEEDS FIXING  ({len(errors)})")
        for level, code, where, msg in errors:
            loc = where.split("!")[-1] if "!" in where else where
            loc = f"row {loc:<6}" if loc.isdigit() else ""
            print(f"     {loc}{msg}" if loc else f"     {msg}")

    excel_codes = ("no-pts", "no-mrp", "duplicate-row", "no-pack", "no-composition")
    if any(by_code.get(c) for c in excel_codes):
        print(f"\n{RULE}")
        print("  In Master_File.xlsx")
        group("no-pts", "No PTS")
        group("no-mrp", "No MRP")
        group("duplicate-row", "Duplicate rows, skipped")
        if details:
            group("no-pack", "No pack size")
            group("no-composition", "No composition")
        else:
            minor = []
            if by_code.get("no-pack"):
                minor.append(f"{len(by_code['no-pack'])} with no pack size")
            if by_code.get("no-composition"):
                minor.append(f"{len(by_code['no-composition'])} with no composition")
            if minor:
                print(f"\n  Also  " + ", ".join(minor) + "   (use --details)")

    photo_codes = ("several-files", "bad-filename", "not-an-image")
    if missing_photo or any(by_code.get(c) for c in photo_codes):
        print(f"\n{RULE}")
        print("  In Photos")
        group("several-files", "Two files for one product, using the larger")
        group("bad-filename", "Unusable filename")
        group("not-an-image", "Ignored, not an image")
        if missing_photo:
            print(f"\n  No photo yet  ({len(missing_photo)})")
            if details:
                for r in missing_photo:
                    print(f"     {r['company']:<22} {photo_filename(r['product'])}")
            else:
                print("     use --details to list them, or --report for a spreadsheet")

    print(f"\n{RULE}")
    if check_only:
        print("  Checked only - data.js was not written.")
    else:
        print(f"  Written    {os.path.basename(output_path)}"
              f"   ({n} products, {with_photo} with photos)")
    print(RULE)


# --- main --------------------------------------------------------------------

def convert(excel_path, output_path, only_sheet=None, check_only=False,
            fix_names=False, assume_yes=False, details=False, write_report=False):
    excel_path = os.path.abspath(excel_path)
    if not os.path.exists(excel_path):
        sys.exit(f"ERROR: file not found -> {excel_path}")

    base_dir = os.path.dirname(excel_path) or os.getcwd()
    photos_dir = os.path.join(base_dir, "Photos")
    if not os.path.isabs(output_path):
        output_path = os.path.join(base_dir, output_path)

    records, issues = read_rows(excel_path, only_sheet)
    photo_map, photo_issues, skipped_files = read_photos(photos_dir)
    issues += photo_issues

    if not records:
        sys.exit("ERROR: no product rows found. Check the sheet and column order.")

    product_keys = {}
    for r in records:
        product_keys.setdefault(photo_key(r["product"]), r["product"])
    for r in records:
        r["photo"] = photo_map.get(photo_key(r["product"]))

    matched = {photo_map[k] for k in photo_map if k in product_keys}
    orphan_files = sorted(f for f in photo_map.values() if f not in matched)
    missing_photo = [r for r in records if not r["photo"]]

    all_keys = list(product_keys)
    suggestions = []
    for fname in orphan_files:
        near = difflib.get_close_matches(photo_key(os.path.splitext(fname)[0]),
                                         all_keys, n=1, cutoff=0.75)
        want = product_keys[near[0]] if near else ""
        suggestions.append((fname, want))
        issues.append(("error", "orphan-photo", "Photos",
                       f"{fname} matches no product"
                       + (f" - did you mean '{want}'?" if want else "")))
    for f in skipped_files:
        issues.append(("info", "not-an-image", "Photos", f))

    updated_at = datetime.now().strftime("%d %b %Y, %I:%M %p")
    # Companies keep the order they first appear in the spreadsheet, not A-Z.
    # This order drives the tab order, the colour each company gets and the
    # summary strip in search.html, so moving a company up in Excel moves it
    # up on the site. Lupin is row 2, so Lupin leads.
    companies = list(dict.fromkeys(r["company"] for r in records))
    by_co = Counter(r["company"] for r in records)

    payload = [{
        "sr": i, "company": r["company"], "product": r["product"],
        "pack": r["pack"], "composition": r["composition"],
        "inBoxes": r["inBoxes"], "shipperQty": r["shipperQty"],
        "pts": r["pts"], "mrp": r["mrp"], "remark": r["remark"],
        "photo": r["photo"],
    } for i, r in enumerate(records, start=1)]

    if not check_only:
        js = (
            "// Auto-generated by convert.py - DO NOT EDIT MANUALLY\n"
            f"// Last updated: {updated_at}\n"
            f"// Source: {os.path.basename(excel_path)}\n\n"
            f"const CATALOGUE_DATA = {json.dumps(payload, indent=2, ensure_ascii=False)};\n\n"
            "const CATALOGUE_META = {\n"
            f'  updatedAt: "{updated_at}",\n'
            f"  totalProducts: {len(payload)},\n"
            f"  withPhoto: {len(payload) - len(missing_photo)},\n"
            f"  companies: {json.dumps(companies, ensure_ascii=False)}\n"
            "};\n\n"
            "// Canonical product key -> photo filename inside Photos/\n"
            "// Prefer the per-product `photo` field above; this map is kept for\n"
            "// older pages that still look products up by name.\n"
            f"const PHOTO_MAP = {json.dumps(photo_map, indent=2, ensure_ascii=False, sort_keys=True)};\n"
        )
        tmp = output_path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(js)
            os.replace(tmp, output_path)  # atomic: never a half-written data.js
        except Exception:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise

    # near-expiry/ keeps its own copy of the catalogue for matching sheet rows
    # against real products. It used to be produced by hand and had drifted 21
    # products behind, so it is written here from the same rows as data.js.
    near_expiry_dir = os.path.join(base_dir, "near-expiry")
    master_written = False
    if not check_only and os.path.isdir(near_expiry_dir):
        master = [{"name": r["product"], "salt": r["composition"],
                   "pack": r["pack"], "company": r["company"]}
                  for co in companies for r in records if r["company"] == co]
        target = os.path.join(near_expiry_dir, "product-master.json")
        tmp = target + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(master, f, ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp, target)
            master_written = len(master)
        except Exception:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise

    if write_report:
        report_path = os.path.join(base_dir, "convert_report.csv")
        with open(report_path, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(["Level", "Issue", "Where", "Product / message"])
            for level, code, where, msg in issues:
                w.writerow([level, code, where, msg])
            for r in missing_photo:
                w.writerow(["info", "no-photo", f"{r['sheet']}!{r['excelRow']}",
                            f"{r['company']} | {r['product']} | "
                            f"expected: {photo_filename(r['product'])}"])

    print_report(records, issues, companies, by_co, photo_map, missing_photo,
                 orphan_files, photos_dir, output_path, updated_at,
                 details, check_only)

    if master_written:
        print(f"  Written    near-expiry/product-master.json   ({master_written} products)")
        print("             next: python tools/build-photo-map.py")
        print(RULE)

    if write_report:
        print(f"  Report     convert_report.csv")
        print(RULE)

    if fix_names and suggestions:
        rename_orphans(photos_dir, suggestions, assume_yes)

    print()
    return 1 if any(i[0] == "error" for i in issues) else 0


def rename_orphans(photos_dir, suggestions, assume_yes):
    """Rename unmatched photo files onto the product they most resemble."""
    plan = []
    for fname, want in suggestions:
        if not want:
            continue
        target = photo_filename(want, os.path.splitext(fname)[1].lower())
        if target != fname and not os.path.exists(os.path.join(photos_dir, target)):
            plan.append((fname, target))
    if not plan:
        print("  Nothing to rename.")
        return
    print("\n  Proposed renames")
    for a, b in plan:
        print(f"     {a}\n       -> {b}")
    if not assume_yes:
        if input("\n  Rename these files? [y/N] ").strip().lower() != "y":
            print("  Skipped.")
            return
    for a, b in plan:
        os.rename(os.path.join(photos_dir, a), os.path.join(photos_dir, b))
    print(f"  Renamed {len(plan)} file(s). Run convert.py again.")


def main():
    p = argparse.ArgumentParser(description="Master_File.xlsx -> data.js for the SNT catalogue")
    p.add_argument("--file", default="Master_File.xlsx", help="path to the Excel file")
    p.add_argument("--out", default="data.js", help="output JS file name")
    p.add_argument("--sheet", default=None, help="only read this worksheet")
    p.add_argument("--check", action="store_true", help="validate only, write nothing")
    p.add_argument("--strict", action="store_true", help="exit 1 when something is broken")
    p.add_argument("--details", action="store_true",
                   help="list every affected row instead of a summary")
    p.add_argument("--report", action="store_true",
                   help="also write convert_report.csv next to the Excel file")
    p.add_argument("--fix-photo-names", action="store_true",
                   help="rename unmatched photo files onto their closest product")
    p.add_argument("--yes", action="store_true", help="don't ask before renaming")
    a = p.parse_args()

    if not os.path.isabs(a.file) and not os.path.exists(a.file):
        here = os.path.join(os.path.dirname(os.path.abspath(__file__)), a.file)
        if os.path.exists(here):
            a.file = here

    code = convert(a.file, a.out, a.sheet, a.check, a.fix_photo_names, a.yes,
                   a.details, a.report)
    sys.exit(code if a.strict else 0)


if __name__ == "__main__":
    main()
