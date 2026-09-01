/* Read a CSV distributor sheet the way the admin reads a workbook.

   The browser reads .xlsx through SheetJS, which is not a dependency a test run should need,
   so the fixture is a CSV and this is the reader for it. What matters is that it goes
   through the same sheet.js header scan and column detection the admin does, so a test of
   "the header is found on row 5" is a test of the code that actually runs. */

"use strict";

const fs = require("node:fs");
const sheet = require("../sheet.js");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at];
    if (quoted) {
      if (character !== '"') { field += character; continue; }
      if (text[at + 1] === '"') { field += '"'; at += 1; continue; }
      quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === ",") { row.push(field); field = ""; continue; }
    if (character === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (character === "\r") continue;
    field += character;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* -> { matrix, headerRow, headers, columns, rows } with rows keyed by header name, exactly
   the shape admin.js works in. */
function readSheet(file) {
  const matrix = parseCsv(fs.readFileSync(file, "utf8"));
  const headerRow = sheet.findHeaderRow(matrix);
  const headers = (matrix[headerRow] || []).map((cell) => String(cell ?? "").trim());
  const columns = sheet.detectColumns(headers);
  const rows = matrix.slice(headerRow + 1)
    .filter((cells) => cells.some((cell) => String(cell ?? "").trim()))
    .map((cells) => Object.fromEntries(headers.map((header, at) => [header, String(cells[at] ?? "").trim()])));
  return { matrix, headerRow, headers, columns, rows };
}

module.exports = { parseCsv, readSheet };
