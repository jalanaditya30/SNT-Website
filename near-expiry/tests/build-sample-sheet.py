#!/usr/bin/env python3
"""Build the representative near-expiry sheet the regression runs against.

The real 184-row distributor sheet the baseline in the brief came from is customer data and
is not in this repository, so the fixture is generated instead: master names put through the
manglings those sheets actually apply (bracketed pack text dropped, SYRUP -> SYP, (10'S) ->
10S, flavours left off, the odd typo), plus the two things the sheet has that the master does
not - products from companies SNT does not carry, and products that simply are not in the
catalogue.

It is deterministic: same master in, same CSV out, no randomness. Regenerate with

    python3 near-expiry/tests/build-sample-sheet.py
"""

import csv
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
MASTER = json.loads((HERE.parent / "product-master.json").read_text(encoding="utf-8"))
OUT = HERE / "sample-near-expiry.csv"

# Sheet company codes, as the distributor writes them, against the master's own spelling.
CODES = {
    "Alkem - Futura / NEXX": "ALKEM-FUT",
    "Alkem - Maxxio": "ALKEM-MAX",
    "Alkem - Novokem": "ALKEM-NOV",
    "Alkem Healthcare": "ALKEM",
    "Lupin": "LUPIN",
    "Torque": "TORQUE",
    "RANBAXY": "RANBAXY",
    "Shivayur": "SHIVAYUR",
    "Silver-cross": "SILVER CROSS",
}

FORM_SHORT = [
    (r"\bSYRUP\b", "SYP"), (r"\bSUSPENSION\b", "SUSP"), (r"\bTABLETS\b", "TAB"),
    (r"\bTABLET\b", "TAB"), (r"\bCAPSULES\b", "CAP"), (r"\bCAPSULE\b", "CAP"),
    (r"\bINJECTION\b", "INJ"), (r"\bOINTMENT\b", "OINT"), (r"\bPOWDER\b", "PWD"),
]


def mangle(name, style):
    """The five ways these sheets differ from the master, applied one at a time."""
    text = name
    if style == 0:                                   # drop the bracketed pack text
        text = re.sub(r"[\(\[][^\)\]]*[\)\]]", " ", text)
    elif style == 1:                                 # abbreviate the dosage form
        for pattern, short in FORM_SHORT:
            text = re.sub(pattern, short, text, flags=re.I)
        text = re.sub(r"[\(\[][^\)\]]*[\)\]]", " ", text)
    elif style == 2:                                 # pack written the sheet's way
        text = re.sub(r"[\(\[]\s*(\d+)\s*'?S\s*[\)\]]", r" \1S", text, flags=re.I)
    elif style == 3:                                 # apostrophes dropped, case flattened
        # Only the apostrophe: a dot inside a number is a dose, and a sheet that drops it
        # is a different medicine, which the matcher is right to refuse.
        text = text.replace("'", "").upper()
    elif style == 4:                                 # bracketed pack dropped and a shipper multiple added
        text = re.sub(r"[\(\[][^\)\]]*[\)\]]", " ", text) + " 20X10"
    return re.sub(r"\s+", " ", text).strip().upper()


# Products SNT does not stock, from companies the master has never heard of. These must come
# back with no suggestions at all — not with a similar-looking Alkem or Lupin product.
FOREIGN = [
    ("SUPERQUIN 500 MG TAB 20*5T", "ABBOTT"),
    ("ZERODOL SP TAB 10S", "IPCA"),
    ("MONTEK LC TABLETS 10S", "CIPLA"),
    ("DOLO 650 TAB 15S", "MICRO LABS"),
    ("PANTOCID DSR CAP 10S", "SUN PHARMA LTD"),
    ("AUGMENTIN 625 DUO TAB", "GLAXO SMITHKLINE"),
    ("SHELCAL 500 TAB 15S", "TORRENT"),
    ("LIV 52 DS TAB 60S", "HIMALAYA"),
    ("BECOSULES CAP 20S", "PFIZER"),
    ("CROCIN ADVANCE 500 TAB", "GSK"),
    ("THYRONORM 50MCG TAB 100S", "ABBOTT"),
    ("GLYCOMET GP2 TAB 15S", "USV"),
    ("ECOSPRIN AV 75 CAP 10S", "USV"),
    ("NEUROBION FORTE TAB 30S", "PROCTER GAMBLE"),
    ("OMEZ 20 CAP 20S", "DR REDDYS"),
    ("CALPOL 650 TAB 15S", "GSK"),
    ("ALLEGRA 120 TAB 10S", "SANOFI"),
    ("DUPHASTON 10MG TAB 10S", "ABBOTT"),
]

# Products the catalogue really does not have, offered under a company it does carry. There
# is nothing safe to match these to either.
UNSTOCKED = [
    ("ALKEM VITARICH PLUS CAP 10S", "ALKEM"),
    ("LUPIZOLID 600 TAB 10S", "LUPIN"),
    ("TORQ NIMULID MD 100 TAB", "TORQUE"),
    ("RANBAXY SPORIDEX AF 750 CAP", "RANBAXY"),
    ("ALKEM FLUCON EYE DROPS 5ML", "ALKEM-MAX"),
    ("SHIVAYUR AMLA CHURNA 100GM", "SHIVAYUR"),
]

# Names deliberately stripped of the thing that tells the variants apart. These are the rows
# a person has to settle: the catalogue has five and the sheet names none of them.
AMBIGUOUS = [
    ("ALZYME SYP", "ALKEM-FUT"),
    ("ALZYME + SYP 200 ML", "ALKEM-FUT"),
    ("ONE CLAV 625 TABLET", "LUPIN"),
    ("ALMOX CAPSULES 500MG", "ALKEM-FUT"),
]

rows = []
seen = set()

# Every ninth master product, so all nine companies and the whole alphabet are represented.
for position, item in enumerate(MASTER[::9]):
    company = item.get("company") or ""
    code = CODES.get(company)
    if not code:
        continue
    name = mangle(item["name"], position % 5)
    if not name or (name, code) in seen:
        continue
    seen.add((name, code))
    rows.append((name, code))
    if len(rows) >= 156:
        break

for name, code in AMBIGUOUS + UNSTOCKED + FOREIGN:
    if (name, code) in seen:
        continue
    seen.add((name, code))
    rows.append((name, code))

# A handful of rows are written without a company at all, which the sheet spells -BLANK-.
for position in range(4, len(rows), 37):
    rows[position] = (rows[position][0], "-BLANK-")

EXPIRIES = ["11/26", "Nov-26", "12/26", "01/27", "JAN27", "2027-02", "06.27", "Mar-27"]
BATCHES = ["A", "B", "C", "D", "E", "F"]

records = []
for position, (name, code) in enumerate(rows):
    quantity = str(12 + (position * 7) % 240)
    if position == 11:
        quantity = ""                 # blank — must be refused, not imported as sold
    elif position == 29:
        quantity = "n/a"              # not a number — must be refused
    elif position == 47:
        quantity = "-5"               # negative — must be refused
    elif position == 63:
        quantity = "18.6"             # decimal — imported as 18 with a warning
    elif position == 88:
        quantity = "0"                # a genuine zero — imported as sold
    records.append({
        "Product Name": name,
        "Company": code,
        "Batch No": f"{BATCHES[position % len(BATCHES)]}{2400 + position}",
        "Expiry": EXPIRIES[position % len(EXPIRIES)],
        "Qty": quantity,
        "MRP": f"{45 + (position * 13) % 900}.50",
    })

# The same product and batch listed twice, as a sheet does when two deliveries are recorded
# separately. The importer has to add them, not keep the last one.
records.append(dict(records[3]))
records[-1]["Qty"] = "25"

with OUT.open("w", encoding="utf-8", newline="") as handle:
    writer = csv.writer(handle)
    # The junk a real sheet opens with: a banner, a blank line and a report title. Reading
    # row 1 as the header is exactly the mistake the header scan exists to avoid.
    writer.writerow(["SHREE NARAYANI TRADERS", "", "", "", "", ""])
    writer.writerow(["", "", "", "", "", ""])
    writer.writerow(["NEAR EXPIRY PRODUCT LIST - AUGUST 2026", "", "", "", "", ""])
    writer.writerow(["", "", "", "", "", ""])
    fields = ["Product Name", "Company", "Batch No", "Expiry", "Qty", "MRP"]
    writer.writerow(fields)
    for record in records:
        writer.writerow([record[field] for field in fields])

print(f"{OUT.relative_to(HERE.parent.parent)}: {len(records)} data rows, 4 rows of preamble")
