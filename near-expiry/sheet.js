/* Reading a distributor sheet safely.
   ============================================================================

   The protections around the import that the matcher must not know about: where the real
   header row is, whether a quantity is a quantity at all, which column is which, and how
   two lines for the same batch are combined. They are kept out of matching.js so product
   similarity stays a pure question about two names, and kept out of admin.js so they can be
   tested without a browser.

   Nothing here touches the DOM, the spreadsheet library or the database. */

(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.SNTSheet = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* How far down to look for a header before giving up and assuming the first row. Sheets
     from this trade routinely open with a company banner, a date, a blank line or two and a
     "NEAR EXPIRY STOCK STATEMENT" title; reading row 1 as the header turns the title into a
     column name and every real row into a mismatch. */
  const HEADER_SCAN_ROWS = 30;

  /* The three concepts a stock sheet has to carry to be importable at all. A row naming all
     three is the header; a row naming two is accepted only if nothing better turns up. */
  const HEADER_CONCEPTS = Object.freeze({
    product: [/^product/, /product\s*name/, /^item/, /^description/, /^brand/, /particular/, /product/],
    expiry: [/^exp\b/, /^exp$/, /expiry/, /expiration/, /^e\.?d\.?$/, /exp/],
    /* "Current Stock" and "Closing Qty" are both real headers from these sheets, so the
       word is looked for anywhere in the cell rather than only at the start. */
    quantity: [/qty/, /quantity/, /stock/, /^pcs$/, /^nos$/]
  });

  /* Column auto-detection, in priority order: an exact header name beats a word appearing
     somewhere in a longer one, so a sheet with both "Product" and "Product Code" picks the
     right one. */
  const COLUMN_PATTERNS = Object.freeze({
    product: [/^product( name)?s?$/, /^item( name)?$/, /^brand( name)?$/, /^description$/, /^particulars?$/, /product/],
    salt: [/^salt$/, /^composition$/, /^generic$/, /salt/, /composition/, /generic/],
    expiry: [/^exp$/, /^expiry( date)?$/, /^expiration$/, /expiry/, /expiration/, /^exp\b/],
    quantity: [/^qty$/, /^quantity$/, /^stock$/, /^pcs$/, /^nos$/, /quantity/, /stock/],
    batch: [/^batch( no\.?)?$/, /^b\.?no\.?$/, /^lot( no\.?)?$/, /batch/, /lot/],
    price: [/^price$/, /^rate$/, /^mrp$/, /^ptr$/, /^pts$/, /price/, /rate/],
    company: [/^company$/, /^companies$/, /^mfr\.?$/, /^manufacturer$/, /^division$/, /^supplier$/, /^marketed by$/, /manufacturer/, /company/, /division/]
  });

  function cellText(value) {
    return String(value ?? "").trim();
  }

  function headerConceptsIn(cells) {
    const lowered = cells.map((cell) => cell.toLowerCase());
    const found = new Set();
    Object.entries(HEADER_CONCEPTS).forEach(([concept, patterns]) => {
      if (lowered.some((cell) => patterns.some((pattern) => pattern.test(cell)))) found.add(concept);
    });
    return found;
  }

  /* `matrix` is the sheet as rows of raw cells. Returns the index of the row to read as the
     header.

     A title row is not a header even when it contains the word "product": "NEAR EXPIRY
     PRODUCT LIST - AUGUST 2026" is one cell, and a header is several. Requiring at least two
     filled cells plus all three concepts settles that; only if nothing in range names all
     three do we fall back to a row naming two, and only if nothing names two at all do we
     assume row 0, which is what a bare sheet with unusual headers deserves. */
  function findHeaderRow(matrix, limit = HEADER_SCAN_ROWS) {
    const rows = matrix || [];
    const scan = Math.min(rows.length, limit);
    let fallback = -1;
    for (let index = 0; index < scan; index += 1) {
      const cells = (rows[index] || []).map(cellText).filter(Boolean);
      if (cells.length < 2) continue;
      const found = headerConceptsIn(cells);
      if (found.size === 3) return index;
      if (found.size === 2 && fallback === -1) fallback = index;
    }
    return fallback === -1 ? 0 : fallback;
  }

  /* Pick a column for each field from the sheet's own header names. */
  function detectColumns(headers) {
    const available = (headers || []).map(cellText).filter(Boolean);
    const chosen = {};
    Object.entries(COLUMN_PATTERNS).forEach(([field, patterns]) => {
      let pick = "";
      for (const pattern of patterns) {
        pick = available.find((header) => pattern.test(header.toLowerCase())) || "";
        if (pick) break;
      }
      chosen[field] = pick;
    });
    return chosen;
  }

  /* Quantity is the one number that decides whether stock goes on the public site, so it is
     read strictly. A blank, a dash, "N/A" or a negative is a sheet that has to be corrected,
     not a row to import as zero - zero means sold, and quietly turning "n/a" into sold is a
     silent, wrong publication either way. A genuine zero is a genuine answer and passes.

     -> { quantity, problem, warning } */
  function parseQuantity(value) {
    const text = cellText(value);
    if (!text) return { quantity: null, problem: "quantity is blank", warning: "" };
    const cleaned = text.replace(/[,\s]/g, "");
    if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) {
      return { quantity: null, problem: `quantity "${text}" is not a number`, warning: "" };
    }
    const number = Number(cleaned);
    if (!Number.isFinite(number)) return { quantity: null, problem: `quantity "${text}" is not a number`, warning: "" };
    if (number < 0) return { quantity: null, problem: `quantity "${text}" is negative`, warning: "" };
    const quantity = Math.trunc(number);
    return {
      quantity,
      problem: "",
      warning: quantity === number ? "" : `quantity ${text} rounded down to ${quantity}`
    };
  }

  /* Two lines of the same batch of the same product are two deliveries of it, so they are
     added together. Keeping only the last is how a sheet listing 40 and then 60 imports as
     60 and the other 40 quietly stops existing. */
  function mergeDuplicates(rows, keyFor) {
    const merged = new Map();
    (rows || []).forEach((row) => {
      const key = keyFor(row);
      const current = merged.get(key);
      if (!current) {
        merged.set(key, { ...row, quantity: row.quantity, mergedRows: 1 });
        return;
      }
      current.quantity += row.quantity;
      current.mergedRows += 1;
    });
    return [...merged.values()];
  }

  return {
    HEADER_SCAN_ROWS, HEADER_CONCEPTS, COLUMN_PATTERNS,
    headerConceptsIn, findHeaderRow, detectColumns, parseQuantity, mergeDuplicates
  };
});
