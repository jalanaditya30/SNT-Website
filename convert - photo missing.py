"""
Shree Narayani Traders — Data Converter
========================================
Run this any time you:
  • Update Master_File.xlsx (add/edit/remove products, including MRP values)
  • Add a new company to the spreadsheet
  • Drop new photos into the Photos/ folder

It regenerates data.js which the website reads.

Usage:
    python convert.py
    python convert.py --file "C:/path/to/Master_File.xlsx"

Excel column order (Master_File.xlsx):
    Company | PRODUCTS | PACK | Composition | In Boxes | Shipper Qty | PTS | MRP | Remark

Photo naming:
    Save product photos in a "Photos/" folder next to this script.
    Name each file exactly after the product name in Excel.
    All of these work for a product called "AMOXYCLAV 625":
        Photos/AMOXYCLAV 625.jpg
        Photos/AMOXYCLAV 625.png
        Photos/AMOXYCLAV 625.webp
    Supported extensions: jpg, jpeg, png, webp, gif
"""

import json, sys, os, re, argparse
from datetime import datetime
from collections import Counter
from difflib import SequenceMatcher

try:
    import openpyxl
except ImportError:
    print("Installing openpyxl...")
    os.system(f"{sys.executable} -m pip install openpyxl")
    import openpyxl


# ── Sanitize function ────────────────────────────────────────────────────────
# IMPORTANT: This must produce identical output to sanitizePhotoName() in
# SNT.html so that PHOTO_MAP keys match the JS lookups.
def sanitize_photo_name(name: str) -> str:
    """Strip Windows/Linux illegal filename chars, trim whitespace, lowercase."""
    return re.sub(r'[/\\:*?"<>|]', '', name).strip().lower()


def parse_float(v):
    """Best-effort float parse. Returns None for blank / unparseable cells."""
    if v is None: return None
    if isinstance(v, (int, float)): return float(v)
    s = str(v).strip().replace(',', '').replace('₹', '')
    if not s: return None
    try:
        return float(s)
    except ValueError:
        return None


# ── Near-duplicate detection ─────────────────────────────────────────────────
def dup_key(name: str) -> str:
    """Aggressive normalisation to catch typo/spacing/plural duplicates.
    'TOREX-DX COUGH SYRUP  100ML' and 'TOREX DX COUGH SYRUP 100ML' → same key."""
    s = name.lower()
    s = s.replace("\n", " ").replace("’", "'")
    s = re.sub(r"[^a-z0-9]+", " ", s)          # drop punctuation/hyphens/brackets
    s = re.sub(r"\s+", " ", s).strip()
    # crude singularise on the last token so TABLET/TABLETS collapse
    toks = s.split()
    if toks and len(toks[-1]) > 3 and toks[-1].endswith("s"):
        toks[-1] = toks[-1][:-1]
    return " ".join(toks)


def write_missing_xlsx(uniq, all_rows, script_dir):
    """Write missing_photos.xlsx — one sheet to work from, one summary."""
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    out_path = os.path.join(script_dir, "missing_photos.xlsx")

    # Flag near-duplicates across the WHOLE master, not just missing rows
    # Pass 1: exact match after aggressive normalisation (spacing/punct/plural)
    dup_groups = {}
    for d in all_rows:
        dup_groups.setdefault(dup_key(d["product"]), []).append(d)
    dup_flag = {}
    for k, grp in dup_groups.items():
        if len(grp) > 1:
            names = sorted({g["product"] for g in grp})
            if len(names) > 1:                  # differing spellings = real typo dup
                for g in grp:
                    dup_flag[id(g)] = " | ".join(n for n in names if n != g["product"])

    # Pass 2: fuzzy match within each company — catches transposed letters
    # (PINEAPLLE vs PINEAPPLE) that pass 1 misses. O(n^2) per company, fine at this size.
    by_co = {}
    for d in all_rows:
        by_co.setdefault(d["company"], []).append(d)
    for co, grp in by_co.items():
        keys = [(d, dup_key(d["product"])) for d in grp]
        for i in range(len(keys)):
            for j in range(i + 1, len(keys)):
                a, ka = keys[i]
                b, kb = keys[j]
                if ka == kb or abs(len(ka) - len(kb)) > 4:
                    continue
                if SequenceMatcher(None, ka, kb).ratio() >= 0.93:
                    for x, y in ((a, b), (b, a)):
                        prev = dup_flag.get(id(x), "")
                        if y["product"] not in prev:
                            dup_flag[id(x)] = (prev + " | " if prev else "") + y["product"]

    ordered = sorted(uniq, key=lambda x: (x["company"], x["product"]))

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Missing Photos"

    headers = ["Company", "Product", "Pack", "Composition", "PTS", "MRP",
               "Expected filename", "Priority", "Shot?", "Possible duplicate of"]
    ws.append(headers)

    hdr_fill = PatternFill("solid", fgColor="1F3864")
    hdr_font = Font(name="Arial", size=10, bold=True, color="FFFFFF")
    thin     = Side(style="thin", color="D9D9D9")
    border   = Border(left=thin, right=thin, top=thin, bottom=thin)
    dup_fill = PatternFill("solid", fgColor="FFF2CC")
    input_fill = PatternFill("solid", fgColor="FFFFCC")

    for c in ws[1]:
        c.fill, c.font, c.border = hdr_fill, hdr_font, border
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

    for d in ordered:
        dup = dup_flag.get(id(d), "")
        ws.append([
            d["company"],
            d["product"],
            d["pack"],
            d["composition"],
            d["pts"],
            d["mrp"],
            f'{sanitize_photo_name(d["product"])}.jpg',
            "",                       # Priority — you fill
            "",                       # Shot? — tick as you go
            dup,
        ])

    body_font = Font(name="Arial", size=10)
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, max_col=len(headers)):
        for c in row:
            c.font, c.border = body_font, border
            c.alignment = Alignment(vertical="top", wrap_text=(c.column in (4, 10)))
        row[4].number_format = '#,##0.00'   # PTS
        row[5].number_format = '#,##0.00'   # MRP
        row[7].fill = input_fill            # Priority
        row[8].fill = input_fill            # Shot?
        if row[9].value:
            for c in row:
                c.fill = dup_fill

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{ws.max_row}"
    for col, w in zip("ABCDEFGHIJ", [22, 46, 14, 40, 10, 10, 46, 10, 8, 46]):
        ws.column_dimensions[col].width = w
    ws.row_dimensions[1].height = 30

    # ── Summary sheet ────────────────────────────────────────────────────────
    s = wb.create_sheet("Summary")
    s.append(["Company", "Missing photos", "Total SKUs", "% covered"])
    for c in s[1]:
        c.fill, c.font, c.border = hdr_fill, hdr_font, border
        c.alignment = Alignment(horizontal="center")

    totals = Counter(d["company"] for d in all_rows)
    companies = sorted(totals)
    for i, co in enumerate(companies, start=2):
        s.cell(i, 1, co)
        s.cell(i, 2, f"=COUNTIF('Missing Photos'!$A:$A,$A{i})")
        s.cell(i, 3, totals[co])
        s.cell(i, 4, f"=IFERROR(1-B{i}/C{i},0)")
    last = len(companies) + 1
    s.cell(last + 1, 1, "TOTAL").font = Font(name="Arial", size=10, bold=True)
    s.cell(last + 1, 2, f"=SUM(B2:B{last})")
    s.cell(last + 1, 3, f"=SUM(C2:C{last})")
    s.cell(last + 1, 4, f"=IFERROR(1-B{last+1}/C{last+1},0)")

    for row in s.iter_rows(min_row=2, max_row=last + 1, max_col=4):
        for c in row:
            if not c.font.bold:
                c.font = body_font
            c.border = border
        row[3].number_format = '0.0%'
    for col, w in zip("ABCD", [26, 16, 14, 12]):
        s.column_dimensions[col].width = w

    n_dup = sum(1 for d in ordered if dup_flag.get(id(d)))
    s.cell(last + 3, 1, "Legend").font = Font(name="Arial", size=10, bold=True)
    s.cell(last + 4, 1, "Yellow columns (Priority, Shot?) are for you to fill in.")
    s.cell(last + 5, 1, f"Cream rows = product name near-matches another row in Master_File "
                        f"({n_dup} rows). Likely a duplicate/typo — fix the Excel before shooting.")
    s.cell(last + 6, 1, "Expected filename = save the photo in Photos/ under exactly this name.")
    for r in range(last + 4, last + 7):
        s.cell(r, 1).font = body_font

    wb.save(out_path)
    print(f"   ✓ Written: {out_path}   ({len(ordered)} rows, {n_dup} flagged as possible duplicates)")


# ── Main convert ─────────────────────────────────────────────────────────────
def convert(excel_path="Master_File.xlsx", output_path="data.js"):

    if not os.path.exists(excel_path):
        print(f"ERROR: File not found → {excel_path}")
        sys.exit(1)

    print(f"\nReading: {excel_path}")
    wb   = openpyxl.load_workbook(excel_path, data_only=True)
    data = []
    sr   = 0

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        for row in ws.iter_rows(min_row=2, values_only=True):
            # Column order: Company | Product | Pack | Composition | InBoxes | ShipperQty | PTS | MRP | Remark
            if row[0] is None or str(row[0]).strip() == "":
                continue
            # Skip repeated header rows
            if str(row[0]).strip().lower() in ("company", "sr.no.", "sr no"):
                continue
            sr += 1
            pts = parse_float(row[6])
            # Tolerate older files without MRP column (length 8)
            mrp = parse_float(row[7]) if len(row) >= 8 else None
            remark = row[8] if len(row) >= 9 else (row[7] if len(row) >= 8 and not isinstance(row[7], (int, float)) else None)
            # Heuristic: if row has 8 cols and row[7] is text (not numeric), treat as remark (backward compat)
            if len(row) == 8:
                # Old format — column 8 is remark
                mrp = None
                remark = row[7]

            data.append({
                "sr":          sr,
                "company":     str(row[0]).strip(),
                "product":     str(row[1]).strip()                    if row[1] else "",
                "pack":        str(row[2]).strip()                    if row[2] else "",
                "composition": str(row[3]).replace("\n", " ").strip() if row[3] else "",
                "inBoxes":     str(row[4])   if row[4] else None,
                "shipperQty":  str(row[5])   if row[5] else None,
                "pts":         pts,
                "mrp":         mrp,
                "remark":      str(remark).strip() if remark else "",
            })

    updated_at = datetime.now().strftime("%d %b %Y, %I:%M %p")
    # Companies list — sorted; order defines which color each company gets in the UI
    companies  = sorted(set(d["company"] for d in data if d["company"]))

    # ── Scan Photos/ folder ──────────────────────────────────────────────────
    photo_exts  = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}
    script_dir  = os.path.dirname(os.path.abspath(__file__))
    photos_dir  = os.path.join(script_dir, "Photos")

    # photo_map: sanitized_product_name → actual_filename_with_extension
    # SNT.html looks up sanitizePhotoName(product) → "Photos/" + photo_map[key]
    photo_map = {}
    if os.path.isdir(photos_dir):
        for fname in os.listdir(photos_dir):
            name_part, ext = os.path.splitext(fname)
            if ext.lower() in photo_exts and name_part.strip():
                key = sanitize_photo_name(name_part)
                if key:
                    photo_map[key] = fname  # last-write wins for same key

    # ── Write data.js ────────────────────────────────────────────────────────
    js = f"""// Auto-generated by convert.py — DO NOT EDIT MANUALLY
// Last updated: {updated_at}

const CATALOGUE_DATA = {json.dumps(data, indent=2, ensure_ascii=False)};

const CATALOGUE_META = {{
  updatedAt: "{updated_at}",
  totalProducts: {len(data)},
  companies: {json.dumps(companies, ensure_ascii=False)}
}};

// Maps sanitized product name → actual photo filename in Photos/
// Lookup: PHOTO_MAP[sanitizePhotoName(product)] → filename
const PHOTO_MAP = {json.dumps(photo_map, indent=2, ensure_ascii=False)};
"""

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(js)

    # ── Console report ───────────────────────────────────────────────────────
    by_co = Counter(d["company"] for d in data)
    print(f"\n✓ {len(data)} products · {len(companies)} companies\n")
    for i, c in enumerate(companies):
        print(f"    [{i+1}] {c}: {by_co[c]} products")

    print(f"\n✓ Output  : {output_path}")
    print(f"✓ Updated : {updated_at}")

    # ── MRP coverage report ──────────────────────────────────────────────────
    with_mrp    = [d for d in data if d["mrp"] is not None]
    without_mrp = [d for d in data if d["mrp"] is None]
    print(f"\n💰 MRP coverage: {len(with_mrp)} / {len(data)} products")
    if without_mrp:
        print(f"   Missing MRP for {len(without_mrp)} products:")
        for d in without_mrp:
            print(f"      → [{d['company']}] {d['product']}")

    # Average margin where both PTS and MRP exist
    margins = []
    for d in data:
        if d['pts'] and d['mrp'] and d['pts'] > 0:
            margins.append((d['mrp'] - d['pts']) / d['pts'] * 100)
    if margins:
        avg_margin = sum(margins) / len(margins)
        print(f"   Average trade margin: {avg_margin:.1f}%  (across {len(margins)} priced products)")

    # ── Photo coverage report ────────────────────────────────────────────────
    print()
    if not os.path.isdir(photos_dir):
        print("📷 No 'Photos' folder found.")
        print("   Create one next to this script and add product images named")
        print("   exactly after the product (e.g.  AMOXYCLAV 625.jpg)")
    else:
        rows           = [d for d in data if d["product"]]
        has_photo      = [d for d in rows if sanitize_photo_name(d["product"]) in photo_map]
        missing_rows   = [d for d in rows if sanitize_photo_name(d["product"]) not in photo_map]

        print(f"📷 Photo coverage: {len(has_photo)} / {len(rows)} products")

        if not missing_rows:
            print("   ✓ All products have photos!")
        else:
            # Unique (company, product) pairs — a product listed twice needs one photo
            seen, uniq = set(), []
            for d in missing_rows:
                k = (d["company"], sanitize_photo_name(d["product"]))
                if k not in seen:
                    seen.add(k)
                    uniq.append(d)

            by_company = {}
            for d in uniq:
                by_company.setdefault(d["company"], []).append(d["product"])

            print(f"\n   Missing photos — {len(uniq)} products across {len(by_company)} companies:\n")
            for co in sorted(by_company):
                prods = sorted(by_company[co])
                print(f"   ── {co}  ({len(prods)})")
                for p in prods:
                    print(f"      → {p}.jpg")
                print()

            # Full list to Excel — the working file for the photo shoot
            write_missing_xlsx(uniq, rows, script_dir)

        # Warn about unmatched photo files (typos in filenames)
        product_keys = {sanitize_photo_name(d["product"]) for d in rows}
        unmatched = [v for k, v in photo_map.items() if k not in product_keys]
        if unmatched:
            print(f"\n   ⚠ Unmatched photo files (check for typos):")
            for f in sorted(unmatched):
                print(f"      ! Photos/{f}")

        # Shared-photo collisions: same product name under >1 company
        name_to_cos = {}
        for d in rows:
            name_to_cos.setdefault(sanitize_photo_name(d["product"]), set()).add(d["company"])
        collisions = {k: v for k, v in name_to_cos.items() if len(v) > 1 and k in photo_map}
        if collisions:
            print(f"\n   ⚠ {len(collisions)} product names shared across companies — "
                  f"one photo file serves all of them:")
            for k in sorted(collisions):
                print(f"      ! {photo_map[k]}  ←  {', '.join(sorted(collisions[k]))}")

    print(f"\n→ Open SNT.html in your browser.\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert Master_File.xlsx → data.js for SNT catalogue")
    parser.add_argument("--file", default="Master_File.xlsx", help="Path to Excel file")
    parser.add_argument("--out",  default="data.js",          help="Output JS file name")
    args = parser.parse_args()
    convert(args.file, args.out)
