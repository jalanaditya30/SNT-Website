/* Tests for the import safeguards around the matcher.

       node --test near-expiry/tests/

   These are the protections that decide what the matcher is even shown and what reaches the
   database: which row is the header, whether a quantity is a quantity, and how two lines of
   the same batch are combined. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const sheet = require("../sheet.js");
const { readSheet } = require("./read-sheet.js");

/* ---- 7. header detection --------------------------------------------------- */

test("a banner, a blank line and a report title do not become the header", () => {
  const matrix = [
    ["SHREE NARAYANI TRADERS", "", "", "", ""],
    ["", "", "", "", ""],
    ["NEAR EXPIRY PRODUCT LIST - AUGUST 2026", "", "", "", ""],
    ["", "", "", "", ""],
    ["Product Name", "Company", "Batch No", "Expiry", "Qty"],
    ["ALCOXIB 120 10S", "ALKEM", "A1", "11/26", "40"]
  ];
  assert.equal(sheet.findHeaderRow(matrix), 4);
});

test("a title row containing the word product is still not a header", () => {
  /* One filled cell is a title however it reads; a header is several. */
  assert.equal(sheet.findHeaderRow([
    ["NEAR EXPIRY PRODUCT AND QUANTITY REPORT, EXPIRY TO MARCH 2027"],
    ["Product", "Expiry", "Qty"],
    ["ALCOXIB 120 10S", "11/26", "40"]
  ]), 1);
});

test("a header already on row 1 is left alone", () => {
  assert.equal(sheet.findHeaderRow([
    ["Product Name", "Expiry", "Qty"],
    ["ALCOXIB 120 10S", "11/26", "40"]
  ]), 0);
});

test("the real sheet's own header names all three concepts", () => {
  /* "Current Stock" rather than "Qty", and "EXP" rather than "Expiry" — a distributor
     header that only scored two of three was found by luck, on the fallback. */
  const matrix = [
    ["Product Name", "Current Stock", "M.R.P.", "Sales Price", "Company", "EXP"],
    ["", "", "", "", "", ""],
    ["SUPERQUIN 500 MG TAB 20*5T", "40", "943.8", "250", "ABBOTT", "1-Mar-27"]
  ];
  assert.equal(sheet.findHeaderRow(matrix), 0);
  assert.equal(sheet.headerConceptsIn(matrix[0]).size, 3);
  const columns = sheet.detectColumns(matrix[0]);
  assert.equal(columns.quantity, "Current Stock");
  assert.equal(columns.expiry, "EXP");
  assert.equal(columns.company, "Company");
  assert.equal(columns.batch, "", "that sheet has no batch column, and none is invented");
});

test("a header naming only two of the three concepts is a last resort", () => {
  const matrix = [
    ["Stock statement", ""],
    ["Item", "Closing Qty"],                  /* product + quantity, no expiry */
    ["ALCOXIB 120 10S", "40"]
  ];
  assert.equal(sheet.findHeaderRow(matrix), 1);
});

test("the scan gives up after thirty rows and assumes the first", () => {
  const matrix = Array.from({ length: 40 }, () => ["", ""]);
  matrix[35] = ["Product", "Expiry", "Qty"];
  assert.equal(sheet.findHeaderRow(matrix), 0);
  assert.equal(sheet.findHeaderRow(matrix, 40), 35);
});

test("the representative sheet's header is found under four rows of preamble", () => {
  const { headerRow, headers, columns, rows } = readSheet(path.join(__dirname, "sample-near-expiry.csv"));
  assert.equal(headerRow, 4);
  assert.deepEqual(headers, ["Product Name", "Company", "Batch No", "Expiry", "Qty", "MRP"]);
  assert.equal(columns.product, "Product Name");
  assert.equal(columns.company, "Company");
  assert.equal(columns.expiry, "Expiry");
  assert.equal(columns.quantity, "Qty");
  assert.equal(columns.batch, "Batch No");
  assert.equal(columns.price, "MRP");
  assert.ok(rows.length > 150);
  assert.equal(rows[0]["Product Name"], "ALCAL-D SYRUP");
});

/* ---- column detection ------------------------------------------------------ */

test("an exact header name beats a word buried in a longer one", () => {
  const columns = sheet.detectColumns(["Product Code", "Product", "Expiry Date", "Qty", "Manufacturer"]);
  assert.equal(columns.product, "Product");
  assert.equal(columns.expiry, "Expiry Date");
  assert.equal(columns.company, "Manufacturer");
});

test("a company column is found under any of the names these sheets use", () => {
  ["Company", "Manufacturer", "Mfr", "Division", "Supplier", "Marketed By"].forEach((header) => {
    assert.equal(sheet.detectColumns(["Product", "Exp", "Qty", header]).company, header, header);
  });
});

test("a column the sheet does not have comes back empty rather than guessed", () => {
  const columns = sheet.detectColumns(["Product", "Exp", "Qty"]);
  assert.equal(columns.company, "");
  assert.equal(columns.salt, "");
  assert.equal(columns.price, "");
});

/* ---- quantity -------------------------------------------------------------- */

test("a blank, a dash or a word is refused rather than imported as sold", () => {
  ["", "   ", "-", "n/a", "N.A.", "TBC", "few"].forEach((value) => {
    const parsed = sheet.parseQuantity(value);
    assert.ok(parsed.problem, `"${value}" should be refused`);
    assert.equal(parsed.quantity, null);
  });
});

test("a negative quantity is refused", () => {
  const parsed = sheet.parseQuantity("-5");
  assert.ok(parsed.problem.includes("negative"));
  assert.equal(parsed.quantity, null);
});

test("a genuine zero is a genuine answer", () => {
  assert.deepEqual(sheet.parseQuantity("0"), { quantity: 0, problem: "", warning: "" });
});

test("a decimal quantity is rounded down, and says so", () => {
  const parsed = sheet.parseQuantity("18.6");
  assert.equal(parsed.quantity, 18);
  assert.equal(parsed.problem, "");
  assert.ok(parsed.warning.includes("rounded down to 18"));
});

test("thousands separators and stray spaces are read, not refused", () => {
  assert.equal(sheet.parseQuantity("1,250").quantity, 1250);
  assert.equal(sheet.parseQuantity(" 42 ").quantity, 42);
  assert.equal(sheet.parseQuantity(96).quantity, 96);
});

/* ---- duplicate rows --------------------------------------------------------- */

test("two lines of the same batch are added, not overwritten", () => {
  const merged = sheet.mergeDuplicates([
    { key: "a", quantity: 40 }, { key: "b", quantity: 5 }, { key: "a", quantity: 60 }
  ], (row) => row.key);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((row) => row.key === "a").quantity, 100);
  assert.equal(merged.find((row) => row.key === "a").mergedRows, 2);
  assert.equal(merged.find((row) => row.key === "b").mergedRows, 1);
});

test("merging keeps the first row's other fields", () => {
  const merged = sheet.mergeDuplicates([
    { key: "a", quantity: 1, batch: "A1" }, { key: "a", quantity: 2, batch: "A1" }
  ], (row) => row.key);
  assert.deepEqual(merged, [{ key: "a", quantity: 3, batch: "A1", mergedRows: 2 }]);
});

test("the representative sheet's repeated line is summed", () => {
  const { rows, columns } = readSheet(path.join(__dirname, "sample-near-expiry.csv"));
  const keyFor = (row) => [row[columns.product], row[columns.batch], row[columns.expiry]].join("|").toLowerCase();
  const parsed = rows.map((row) => ({ ...row, quantity: sheet.parseQuantity(row[columns.quantity]).quantity || 0 }));
  const merged = sheet.mergeDuplicates(parsed, keyFor);
  const doubled = merged.filter((row) => row.mergedRows > 1);
  assert.equal(doubled.length, 1, "the fixture carries exactly one repeated line");
  assert.equal(merged.length, rows.length - 1);
  const source = parsed.filter((row) => keyFor(row) === keyFor(doubled[0]));
  assert.equal(doubled[0].quantity, source.reduce((sum, row) => sum + row.quantity, 0));
});
