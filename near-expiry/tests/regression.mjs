/* Run the matcher over the representative sheet and report what it decided.
   ============================================================================

       node near-expiry/tests/regression.mjs [path/to/sheet.csv]

   Prints the five totals the brief asks for, and exits non-zero if either non-negotiable is
   violated: a suggestion that crosses a company boundary, or a suggestion offered for a
   company the master does not carry. Those two are what stop a wrong medicine being
   published under a confident-looking name, so they fail the run rather than being reported
   as a number to read past.

   Pass a real distributor sheet as the argument to run the same report on it; with no
   argument it reads tests/sample-near-expiry.csv. */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const matching = require(path.join(HERE, "..", "matching.js"));
const sheet = require(path.join(HERE, "..", "sheet.js"));
const { readSheet } = require(path.join(HERE, "read-sheet.js"));

export function report(file, master) {
  const { headerRow, headers, columns, rows } = readSheet(file);
  const index = matching.buildIndex(master);

  /* Once per distinct product + company pair, not once per row: a sheet listing the same
     product in six batches is one decision, not six. */
  const decisions = new Map();
  const keyFor = (name, company) =>
    `${matching.normalizeName(name).compact}|${matching.companyKey(matching.normalizeCompany(company))}`;

  rows.forEach((row) => {
    const name = row[columns.product] || "";
    const company = row[columns.company] || "";
    const key = keyFor(name, company);
    if (decisions.has(key)) return;
    decisions.set(key, { name, company, result: matching.suggestMatches(index, name, company) });
  });

  const counts = { auto: 0, review: 0, none: 0, crossCompany: 0, unknownCompany: 0 };
  const rowCounts = { auto: 0, review: 0, none: 0, quantityRefused: 0, quantityRounded: 0 };
  const offences = [];
  const ambiguous = [];
  const unmatched = [];

  decisions.forEach(({ name, company, result }) => {
    const source = matching.normalizeCompany(company);
    if (result.decision === "auto") counts.auto += 1;
    else if (result.suggestions.length) { counts.review += 1; ambiguous.push({ name, company, result }); }
    else { counts.none += 1; unmatched.push({ name, company }); }

    result.suggestions.forEach((suggestion) => {
      if (!matching.companiesCompatible(source, suggestion.company)) {
        counts.crossCompany += 1;
        offences.push(`cross-company: "${name}" [${company}] -> "${suggestion.name}" [${suggestion.company.label}]`);
      }
      if (source.supplied && !index.byFamily.has(source.family)) {
        counts.unknownCompany += 1;
        offences.push(`unknown company: "${name}" [${company}] -> "${suggestion.name}"`);
      }
    });
  });

  rows.forEach((row) => {
    const decision = decisions.get(keyFor(row[columns.product] || "", row[columns.company] || ""));
    const outcome = decision?.result.decision === "auto" ? "auto"
      : decision?.result.suggestions.length ? "review" : "none";
    rowCounts[outcome] += 1;
    const quantity = sheet.parseQuantity(row[columns.quantity]);
    if (quantity.problem) rowCounts.quantityRefused += 1;
    if (quantity.warning) rowCounts.quantityRounded += 1;
  });

  return { headerRow, headers, columns, rows, decisions, counts, rowCounts, offences, ambiguous, unmatched };
}

/* ---- run it ------------------------------------------------------------- */

const argument = process.argv.slice(2).find((value) => !value.startsWith("--"));
const file = argument || path.join(HERE, "sample-near-expiry.csv");
const master = JSON.parse(fs.readFileSync(path.join(HERE, "..", "product-master.json"), "utf8"));
const outcome = report(file, master);

const pad = (value, width) => String(value).padStart(width);
console.log(`Sheet:  ${path.relative(process.cwd(), file)}`);
console.log(`Master: ${master.length} products`);
console.log(`Header found on sheet row ${outcome.headerRow + 1}: ${outcome.headers.filter(Boolean).join(" | ")}`);
console.log(`Columns: ${Object.entries(outcome.columns).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ")}`);
console.log(`Rows: ${outcome.rows.length}   distinct product+company pairs: ${outcome.decisions.size}`);
console.log("");
console.log("Outcome                                 rows   pairs");
console.log(`Safe automatic matches               ${pad(outcome.rowCounts.auto, 7)} ${pad(outcome.counts.auto, 7)}`);
console.log(`Ambiguous names left for review      ${pad(outcome.rowCounts.review, 7)} ${pad(outcome.counts.review, 7)}`);
console.log(`No safe match; source name retained  ${pad(outcome.rowCounts.none, 7)} ${pad(outcome.counts.none, 7)}`);
console.log(`Cross-company suggestions            ${pad(outcome.counts.crossCompany, 7)} ${pad(outcome.counts.crossCompany, 7)}`);
console.log(`Unknown-company suggestions          ${pad(outcome.counts.unknownCompany, 7)} ${pad(outcome.counts.unknownCompany, 7)}`);
console.log("");
console.log(`Quantities refused (blank/non-numeric/negative): ${outcome.rowCounts.quantityRefused}`);
console.log(`Quantities rounded down with a warning:          ${outcome.rowCounts.quantityRounded}`);

if (process.argv.includes("--detail")) {
  console.log("\nLeft for review:");
  outcome.ambiguous.forEach(({ name, company, result }) => {
    console.log(`  ${name} [${company}]  top ${(result.top.score * 100).toFixed(1)}% "${result.top.name}", lead ${(result.lead * 100).toFixed(1)}pp`);
  });
  console.log("\nNo safe match:");
  outcome.unmatched.forEach(({ name, company }) => console.log(`  ${name} [${company}]`));
}

if (outcome.offences.length) {
  console.log("\nSAFETY FAILURES:");
  outcome.offences.forEach((line) => console.log(`  ${line}`));
  process.exit(1);
}
console.log("\nNo cross-company and no unknown-company suggestions.");
