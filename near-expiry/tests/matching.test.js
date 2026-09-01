/* Acceptance tests for the near-expiry product matcher.
   ============================================================================

       node --test near-expiry/tests/

   Run against the real product master rather than a fixture: these thresholds are only worth
   anything against the catalogue they will actually meet, and a master that drifts should
   fail here rather than in the admin.

   The safety cases - the company gate, the dose penalty, the ambiguity gate - are the point
   of the file. Nothing here should be relaxed to make a number go up; the brief's rule is
   that a row left for a person to look at is always cheaper than a wrong medicine. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const matching = require("../matching.js");
const { THRESHOLDS } = matching;

const master = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "product-master.json"), "utf8"));
const index = matching.buildIndex(master);

const suggest = (name, company) => matching.suggestMatches(index, name, company);
const names = (result) => result.suggestions.map((suggestion) => suggestion.name);

/* ---- 1. unknown company protection --------------------------------------- */

test("a company the master does not carry produces no suggestions", () => {
  const result = suggest("SUPERQUIN 500 MG TAB 20*5T", "ABBOTT");
  assert.equal(result.suggestions.length, 0);
  assert.equal(result.decision, "none");
  assert.equal(result.auto, null);
});

test("a familiar-looking product from an unknown company is still refused", () => {
  /* The name is an exact catalogue name. Only the company stops it, which is the whole
     job: without the gate this scores 1.0 and is published as an Alkem product. */
  assert.equal(suggest("ALCOXIB 120 (10'S)", "ABBOTT").suggestions.length, 0);
  assert.equal(suggest("RABALKEM-D TABLETS (10'S)", "CIPLA").suggestions.length, 0);
});

test("an unknown company is never folded into an existing family", () => {
  const abbott = matching.normalizeCompany("ABBOTT INDIA LIMITED");
  assert.equal(abbott.supplied, true);
  assert.equal(abbott.known, false);
  assert.equal(abbott.family, "abbott");
  assert.equal(index.byFamily.has(abbott.family), false);
});

/* ---- 2. safe known-company matches --------------------------------------- */

test("ALZYME CARDAMOM SYP finds the cardamom bottle", () => {
  const result = suggest("ALZYME CARDAMOM SYP", "ALKEM-FUT");
  assert.equal(result.top.name, "ALZYME + SYP 200 ml (CARDAMOM FLAVOUR)");
});

test("RABALKEM-D finds the D tablets, not the DSR or the 20", () => {
  const result = suggest("RABALKEM-D", "ALKEM-FUT");
  assert.equal(result.top.name, "RABALKEM-D TABLETS (10'S)");
});

test("ONE CLAV DRY SYP finds the glass bottle", () => {
  const result = suggest("ONE CLAV DRY SYP", "LUPIN");
  assert.equal(result.top.name, "ONE CLAV DRY SYRUP 30 ML-GLASS BOTTLE");
});

test("an abbreviated dosage form still matches the spelled-out one", () => {
  /* SYP/SYRUP, TAB/TABLETS, 10S/(10'S) are the three differences these sheets are made of. */
  assert.equal(suggest("ALCOXIB 120 10S", "ALKEM").top.name, "ALCOXIB 120 (10'S)");
  assert.equal(suggest("ALKEM COLD + SUS", "ALKEM").top.name, "NEW ALKEM COLD + SUSPENSION");
  assert.equal(suggest("ALDIGESIC 100 TAB 20X10", "ALKEM").top.name, "ALDIGESIC 100 Tab");
});

/* ---- 3. dose protection --------------------------------------------------- */

test("ALMOX 125MG picks the 125 mg tablet over the 250 mg one", () => {
  const result = suggest("ALMOX 125MG 15S", "ALKEM-FUT");
  assert.equal(result.top.name, "ALMOX DT 125 MG TABLETS [ 15S ]");
  assert.equal(names(result).includes("ALMOX DT 250 MG TABLETS (15S)"), false);
});

test("the 250 mg variant is penalised rather than merely out-ranked", () => {
  const source = matching.prepareSource("ALMOX 125MG 15S", "ALKEM-FUT");
  const wrong = index.entries.find((entry) => entry.name === "ALMOX DT 250 MG TABLETS (15S)");
  const scored = matching.scoreCandidate(index, source, wrong);
  assert.ok(scored.reasons.includes("dose disagrees"));
  assert.ok(scored.score < THRESHOLDS.SUGGEST_FLOOR, `expected below the floor, got ${scored.score}`);
});

test("a dose conflict needs a unit — a pack size is not a dose", () => {
  const withUnit = matching.doseFigures(matching.tokenize("ALMOX 125 MG 15S"));
  assert.deepEqual([...withUnit.keys()], ["mg"]);
  assert.equal(matching.doseConflict(
    matching.doseFigures(matching.tokenize("TAB 10'S")),
    matching.doseFigures(matching.tokenize("TAB 15'S"))
  ), false);
});

test("gm and g are the same unit", () => {
  const a = matching.doseFigures(matching.tokenize("ALDIGESIC MAX GEL (30GM)"));
  const b = matching.doseFigures(matching.tokenize("ALDIGESIC MAX GEL 30 G"));
  assert.equal(matching.doseConflict(a, b), false);
  assert.deepEqual([...a.keys()], ["g"]);
});

/* ---- form protection ------------------------------------------------------ */

test("an injection does not win over a tablet on a shared brand", () => {
  const source = matching.prepareSource("RABALKEM-D TABLETS", "ALKEM");
  const injection = index.entries.find((entry) => entry.name === "RABALKEM INJECTION (20MG) VIAL");
  assert.ok(matching.scoreCandidate(index, source, injection).reasons.includes("dosage form disagrees"));
});

test("a name that states no form is not penalised for staying quiet", () => {
  const quiet = matching.formSet(matching.tokenize("RABALKEM-D"));
  const stated = matching.formSet(matching.tokenize("RABALKEM-D TABLETS (10'S)"));
  assert.equal(quiet.size, 0);
  assert.equal(matching.formConflict(quiet, stated), false);
});

/* ---- 4. exact selection --------------------------------------------------- */

test("an exact catalogue name scores 1.0 and is selected automatically", () => {
  const result = suggest("RABALKEM-D TABLETS (10'S)", "ALKEM-FUT");
  assert.equal(result.top.score, 1);
  assert.equal(result.top.exact, true);
  assert.equal(result.decision, "auto");
  assert.equal(result.auto.name, "RABALKEM-D TABLETS (10'S)");
});

/* ---- 5. ambiguity protection ---------------------------------------------- */

test("ALZYME SYP has suggestions but is left for a person", () => {
  const result = suggest("ALZYME SYP", "ALKEM-FUT");
  assert.ok(result.suggestions.length > 1);
  assert.equal(result.decision, "review");
  assert.equal(result.auto, null);
  /* Not because the best is bad, but because the flavours are indistinguishable from a
     name that names no flavour. */
  assert.ok(result.lead < THRESHOLDS.AUTO_LEAD, `lead was ${result.lead}`);
});

test("the automatic gate needs the score AND the lead", () => {
  const auto = (score, lead) => score >= THRESHOLDS.AUTO_SCORE && lead >= THRESHOLDS.AUTO_LEAD;
  assert.equal(auto(0.99, 0.02), false, "a high score with no daylight is not safe");
  assert.equal(auto(0.79, 0.40), false, "a big lead over nothing much is not safe");
  assert.equal(auto(0.81, 0.08), true);
});

/* Only identity skips the lead, and only when it is unique. A score threshold near 1 cannot
   stand in for identity: scores are clamped to 1 and the leading-word and company bonuses
   carry a merely close candidate over any such threshold, which on a real sheet auto-selected
   CEFKEM 200 for CEFKEM CV-200 and the 30 ml ALMOX syrup for the 60 ml, both at a zero
   lead. */
test("a near-miss inflated to a perfect score is not treated as exact", () => {
  const result = suggest("CEFKEM CV -200 TAB 10S", "ALKEM-FUT");
  assert.equal(result.top.score, 1, "bonuses and the clamp do take it to 1.0");
  assert.equal(result.top.exact, false);
  assert.equal(result.decision, "review", "which is exactly why 1.0 must not mean exact");
  /* And the product the sheet actually names is there to be picked. */
  assert.ok(names(result).includes("CEFKEM CV- 200 TABLETS"));
});

test("an exact name is ranked above anything merely scoring 1.0, and is selected", () => {
  /* Both the 30 ml and the 60 ml bottle reach a clamped 1.0; only one reduces to the
     sheet's own normalised name. Sorting on the score alone published the wrong bottle. */
  const result = suggest("ALMOX DRY SYP 125MG/5ML WIFI 60ML", "ALKEM-FUT");
  assert.equal(result.top.name, "ALMOX DRY SYRUP 125MG/5ML (60ML W.C.)");
  assert.equal(result.top.exact, true);
  assert.equal(result.decision, "auto");
  assert.equal(result.lead, 0, "with no lead at all — identity is what carried it");
});

test("two candidates that are both exact are left for a person", () => {
  /* A sheet naming only the family can reach the same normalised name in two divisions.
     Identity stops being evidence the moment two products share it. */
  const built = matching.buildIndex([
    { name: "ZZTEST TABLETS (10'S)", company: "Alkem - Maxxio" },
    { name: "ZZTEST TABLETS 10S", company: "Alkem - Novokem" }
  ]);
  const result = matching.suggestMatches(built, "ZZTEST TAB 10S", "ALKEM");
  assert.equal(result.suggestions.length, 2);
  assert.ok(result.suggestions.every((suggestion) => suggestion.exact));
  assert.equal(result.decision, "review");
});

test("the thresholds are the documented ones", () => {
  assert.equal(THRESHOLDS.AUTO_SCORE, 0.80);
  assert.equal(THRESHOLDS.AUTO_LEAD, 0.07);
  assert.equal(THRESHOLDS.SUGGEST_FLOOR, 0.42);
  assert.equal(THRESHOLDS.MAX_SUGGESTIONS, 4);
  assert.equal(THRESHOLDS.FUZZY_SIMILARITY, 0.72);
  assert.equal(THRESHOLDS.FUZZY_MIN_LENGTH, 5);
  assert.equal(THRESHOLDS.FUZZY_CANDIDATE_LENGTH, 4);
});

/* ---- what a real distributor sheet turned up ------------------------------
   These all come from the 184-row NEAR_EXP sheet, and each one was wrong before it was a
   test. */

test("SYP, SUSPENSION and ORAL SOLUTION are one form, not three", () => {
  /* The master writes all three for the same kind of liquid; the sheet writes SYP for all
     of them. Treating them as conflicting hid five real products below the 42% floor, where
     the operator could not see them to accept. */
  assert.equal(suggest("ALCAL-D SUSPENSION 200ML", "ALKEM-FUT").top.name, "ALCAL-D SYRUP (200 ML)");
  assert.equal(suggest("LACTUDOS-SYP 100ML (25X1)", "ALKEM-NOV").top.name, "LACTUDOS ORAL SOLUTION (100ML)");
  assert.equal(suggest("ULTIVIT-SYP 200ML (5X1)", "ALKEM-NOV").top.name, "ULTIVIT SUSPENSION (200ML)");
  assert.equal(matching.formConflict(
    matching.formSet(matching.tokenize("LCM-SYP 60ML")),
    matching.formSet(matching.tokenize("LCM SUSPENSION (60ML)"))
  ), false);
});

test("but drops, tablets and injections stay apart", () => {
  const conflicts = (a, b) => matching.formConflict(
    matching.formSet(matching.tokenize(a)), matching.formSet(matching.tokenize(b)));
  assert.equal(conflicts("ULTIVIT-SYP 200ML", "ULTIVIT DROPS (15 ML)"), true);
  assert.equal(conflicts("ALMOX SYRUP", "ALMOX DT 125 MG TABLETS"), true);
  assert.equal(conflicts("RABALKEM-D TABLETS", "RABALKEM INJECTION (20MG) VIAL"), true);
  /* A softgel is a capsule by definition. */
  assert.equal(conflicts("VPLEX GOLD SOFTGEL CAP", "VPLEX GOLD SOFT GEL CAP"), false);
});

test("a word matches one a letter shorter, so FORTE reaches the master's FORT", () => {
  const result = suggest("ALMOX-CV FORTE DRY SYRUP 30 ML", "ALKEM-FUT");
  assert.ok(names(result).includes("ALMOX-CV FORT DRY SYP. (WITH WFI)"));
  /* It does not win — the other candidate matches the pack exactly — but it is close
     enough now that the row is not decided without a person. */
  assert.equal(result.decision, "review");
});

test("flavours and strengths on the real sheet are told apart", () => {
  assert.equal(suggest("OMEE-G POW(GUAVA) 60X5GM", "ALKEM-NOV").top.name, "OMEE-G POWDER (GUAVA FLAVOUR) (5GM)");
  assert.equal(suggest("OMEE-G POW(ORANGE) 60X5GM", "ALKEM-NOV").top.name, "OMEE-G POWDER (ORANGE FLAVOUR) (5GM)");
  assert.equal(suggest("ORS INSTA-LIQ(APPLE) (30X200ML)", "ALKEM-NOV").top.name, "ORS INSTA LIQUID (APPLE) (200ML)");
  assert.equal(suggest("CIPROKEM-250 TAB (20X10)", "ALKEM-NOV").top.name, "CIPROKEM 250 MG TABLETS (10S)");
  /* A misspelled flavour still lands, because the word is long enough to guess at. */
  assert.equal(suggest("ALZYME + SYP (STRAWBERY)3 200ML", "ALKEM-FUT").top.name, "ALZYME + SYP 200 ml (STRAWBERRY FLAVOUR)");
});

test("products that differ only inside brackets keep separate identities", () => {
  /* The importer merges rows on this normalisation, and the catalogue distinguishes a great
     many products by bracketed text alone. All three of these pairs are on one real sheet,
     in the same expiry month; an identity that dropped the brackets merged each pair into a
     single row, publishing one flavour carrying both flavours' stock and losing the other. */
  const distinct = (a, b) =>
    assert.notEqual(matching.normalizeName(a).compact, matching.normalizeName(b).compact, `${a} vs ${b}`);
  distinct("ALZYME + SYP 200 ml (ORANGE FLAVOUR)", "ALZYME + SYP 200 ml (STRAWBERRY FLAVOUR)");
  distinct("ALMOX DRY SYRUP 125MG/5ML (30ML)", "ALMOX DRY SYRUP 125MG/5ML (60ML W.C.)");
  distinct("ORS INSTA LIQUID (APPLE) (200ML)", "ORS INSTA LIQUID (ORANGE) (200ML)");
  distinct("ALCOXIB 120 (10'S)", "ALCOXIB 90 (10'S)");

  /* And no two products the master carries under one company share an identity, so merging
     on it can never combine two different medicines. */
  const identities = new Map();
  index.entries.forEach((entry) => {
    const key = `${entry.compact}|${matching.companyKey(entry.company)}`;
    assert.equal(identities.has(key), false, `${entry.name} and ${identities.get(key)} share an identity`);
    identities.set(key, entry.name);
  });
});

test("but the same product spelled two ways keeps one identity", () => {
  /* Which is the other half of it: two sheet lines for one product have to merge. */
  const same = (a, b) =>
    assert.equal(matching.normalizeName(a).compact, matching.normalizeName(b).compact, `${a} vs ${b}`);
  same("ONE CLAV DRY SYP GLASS 30ML", "ONE CLAV DRY SYRUP 30 ML-GLASS BOTTLE");
  same("ALCOXIB 120 10S", "ALCOXIB 120 (10'S)");
  same("STANCEF-O 200MG TAB ALU 10's", "STANCEF-O 200MG TAB ALU 10S");
});

test("the real sheet's unknown companies get nothing at all", () => {
  /* Eight manufacturers on that sheet are not SNT stock. Every one of their products has a
     plausible-looking Alkem or Lupin neighbour, and none of them may be offered it. */
  ["ERIS LIFE", "IND-SWIFT", "WINGS", "NOVITA", "ABBOTT", "ALCO", "GALPHA", "MEDLEY"]
    .forEach((company) => {
      assert.equal(index.byFamily.has(matching.normalizeCompany(company).family), false, company);
      assert.equal(suggest("RABALKEM-D TABLETS (10'S)", company).suggestions.length, 0, company);
    });
});

test("no more than four suggestions come back, best first", () => {
  const result = suggest("ALZYME SYP", "ALKEM-FUT");
  assert.ok(result.suggestions.length <= THRESHOLDS.MAX_SUGGESTIONS);
  const scores = result.suggestions.map((suggestion) => suggestion.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  result.suggestions.forEach((suggestion) => assert.ok(suggestion.score >= THRESHOLDS.SUGGEST_FLOOR));
});

/* ---- 6. the company boundary ---------------------------------------------- */

test("a division sheet code never reaches another division", () => {
  const result = suggest("RABALKEM-DSR CAPSULES", "ALKEM-NOV");
  /* The DSR capsules are Futura and Maxxio products; Novokem has none. */
  assert.equal(result.suggestions.length, 0);
  assert.equal(suggest("RABALKEM-DSR CAPSULES", "ALKEM-MAX").top.name, "RABALKEM-DSR CAPSULES 15'S (ALU-ALU)");
});

test("a sheet naming only the family reaches every division of it", () => {
  const source = matching.normalizeCompany("ALKEM");
  assert.equal(source.division, "");
  const divisions = new Set(matching.candidatesFor(index, source).map((entry) => entry.company.division));
  assert.deepEqual([...divisions].sort(), ["futura", "healthcare", "maxxio", "novokem"]);
});

test("a blank or -BLANK- company allows the whole master and adds no bonus", () => {
  ["", "   ", "-BLANK-", "-blank-", "BLANK"].forEach((value) => {
    assert.equal(matching.normalizeCompany(value).supplied, false, `"${value}" should read as no company`);
  });
  const blank = matching.normalizeCompany("-BLANK-");
  assert.equal(matching.candidatesFor(index, blank).length, index.entries.length);
  assert.equal(matching.companyBonus(blank, index.entries[0].company), 0);
});

test("the master's own company spellings all resolve to a known family", () => {
  const companies = [...new Set(master.map((item) => item.company).filter(Boolean))];
  companies.forEach((company) => {
    const resolved = matching.normalizeCompany(company);
    assert.equal(resolved.known, true, `"${company}" is not in the alias table`);
  });
});

test("the sheet codes SNT actually receives map to the right division", () => {
  const expected = {
    "ALKEM-FUT": ["alkem", "futura"], "ALKEM-MAX": ["alkem", "maxxio"],
    "ALKEM-NOV": ["alkem", "novokem"], ALKEM: ["alkem", ""],
    "Alkem - Futura / NEXX": ["alkem", "futura"], "Alkem Healthcare": ["alkem", "healthcare"],
    LUPIN: ["lupin", ""], "Lupin Limited": ["lupin", ""],
    TORQUE: ["torque", ""], RANBAXY: ["sun", ""], "SUN PHARMA": ["sun", ""],
    SHIVAYUR: ["shivayur", ""], "SILVER CROSS": ["silver cross", ""], "Silver-cross": ["silver cross", ""]
  };
  Object.entries(expected).forEach(([value, [family, division]]) => {
    const resolved = matching.normalizeCompany(value);
    assert.deepEqual([resolved.family, resolved.division], [family, division], `"${value}"`);
  });
});

test("compatibility is refused across families and across named divisions", () => {
  const futura = matching.normalizeCompany("ALKEM-FUT");
  const maxxio = matching.normalizeCompany("ALKEM-MAX");
  const alkem = matching.normalizeCompany("ALKEM");
  const lupin = matching.normalizeCompany("LUPIN");
  assert.equal(matching.companiesCompatible(futura, maxxio), false);
  assert.equal(matching.companiesCompatible(futura, lupin), false);
  assert.equal(matching.companiesCompatible(futura, alkem), true, "a family-only candidate is still Alkem");
  assert.equal(matching.companiesCompatible(alkem, maxxio), true);
  assert.equal(matching.companiesCompatible(matching.normalizeCompany(""), lupin), true);
});

test("every suggestion for every row of the representative sheet is company-compatible", () => {
  const { readSheet } = require("./read-sheet.js");
  const { rows, columns } = readSheet(path.join(__dirname, "sample-near-expiry.csv"));
  assert.ok(rows.length > 150, `expected a representative sheet, got ${rows.length} rows`);
  let offences = 0;
  let suggested = 0;
  rows.forEach((row) => {
    const company = matching.normalizeCompany(row[columns.company]);
    suggest(row[columns.product], row[columns.company]).suggestions.forEach((suggestion) => {
      suggested += 1;
      if (!matching.companiesCompatible(company, suggestion.company)) offences += 1;
      if (company.supplied && !index.byFamily.has(company.family)) offences += 1;
    });
  });
  assert.ok(suggested > 100, "the sheet should produce suggestions to check");
  assert.equal(offences, 0);
});

/* ---- 8. determinism -------------------------------------------------------- */

test("the same input and master always give the same ranking and scores", () => {
  const once = suggest("ALZYME SYP", "ALKEM-FUT").suggestions.map((s) => [s.name, s.score]);
  const twice = matching.suggestMatches(matching.buildIndex(master), "ALZYME SYP", "ALKEM-FUT")
    .suggestions.map((s) => [s.name, s.score]);
  assert.deepEqual(once, twice);

  /* And the master's order must not decide anything either: reversing it reverses the tie
     order, which is exactly what the name tie-break is there to stop. */
  const reversed = matching.buildIndex([...master].reverse());
  assert.deepEqual(
    matching.suggestMatches(reversed, "ALZYME SYP", "ALKEM-FUT").suggestions.map((s) => [s.name, s.score]),
    once
  );
});

test("narrowing the candidate pool is a speed-up, not a decision", () => {
  /* Whatever the narrowing keeps, the winner has to be the winner of the full pool. */
  ["ALZYME CARDAMOM SYP", "RABALKEM-D", "ALMOX 125MG 15S", "ALCOXIB 120 10S"].forEach((name) => {
    const source = matching.prepareSource(name, "ALKEM");
    const everything = matching.candidatesFor(index, source.company)
      .map((entry) => ({ name: entry.name, score: matching.scoreCandidate(index, source, entry).score }))
      .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
    assert.equal(suggest(name, "ALKEM").top.name, everything[0].name, name);
  });
});

/* ---- normalisation --------------------------------------------------------- */

test("normalisation flattens exactly what the brief lists", () => {
  assert.deepEqual(matching.tokenize("ALCOXIB 120 (10'S)"), ["alcoxib", "120", "10", "s"]);
  assert.deepEqual(matching.tokenize("ALCOXIB 120 10S"), ["alcoxib", "120", "10", "s"]);
  assert.deepEqual(matching.tokenize("VITAMIN 5% W/W"), ["vitamin", "5", "percent", "w", "w"]);
  assert.deepEqual(matching.tokenize("CALCIUM & D3"), ["calcium", "plus", "d", "3"]);
  assert.deepEqual(matching.tokenize("ALKEMERO 0.5 Gm INJ"), ["alkemero", "0.5", "gm", "injection"]);
  assert.equal(matching.tokenize("SYP").join(""), "syrup");
  assert.equal(matching.tokenize("ONITMENT").join(""), "ointment");
  assert.deepEqual(matching.tokenize(null), []);
  assert.deepEqual(matching.tokenize(undefined), []);
});

test("packaging noise is dropped and the compact form joins what is left", () => {
  /* "W.C." is one packaging word, not the letters w and c. */
  assert.deepEqual(matching.tokenize("ALMOX DRY SYRUP (60ML W.C.)"), ["almox", "dry", "syrup", "60", "ml"]);
  assert.deepEqual(matching.tokenize("ALMOX-CV DRY SYRUP (WITH WFI) (30ML)"), ["almox", "cv", "dry", "syrup", "30", "ml"]);
  /* "NEW" is packaging, SUS is SUSPENSION, and a bare + is punctuation (only & becomes
     "plus"), so the sheet's name and the master's reduce to the same string. */
  assert.equal(matching.normalizeName("NEW ALKEM COLD + SUSPENSION").compact, "alkemcoldsuspension");
  assert.equal(matching.normalizeName("ALKEM COLD + SUS").compact, "alkemcoldsuspension");
});

test("bigram Dice is symmetric, bounded and exact on equality", () => {
  assert.equal(matching.dice("alcoxib", "alcoxib"), 1);
  assert.equal(matching.dice("", "alcoxib"), 0);
  assert.equal(matching.dice("a", "b"), 0);
  assert.equal(matching.dice("alcoxib", "alcoxib120"), matching.dice("alcoxib120", "alcoxib"));
  const value = matching.dice("almox", "amlox");
  assert.ok(value > 0 && value < 1);
});

test("a typo counts, at a discount, and only for a long enough word", () => {
  const short = matching.weightedTokenScore(index, ["dsr"], ["dst"]);
  assert.equal(short, 0, "three letters is too short to guess at");
  const exact = matching.weightedTokenScore(index, ["cardamom"], ["cardamom"]);
  const typo = matching.weightedTokenScore(index, ["cardamon"], ["cardamom"]);
  assert.ok(typo > 0, "a misspelling of a long word should still count");
  assert.ok(typo < exact, "a typo must never be worth as much as the word spelled right");

  /* And the bar is a real bar: two letters swapped in the middle of a short-ish brand takes
     the similarity under 0.72, and the matcher would rather show nothing than guess. */
  assert.ok(matching.dice("alcoxib", "alcoxbi") < matching.THRESHOLDS.FUZZY_SIMILARITY);
  assert.equal(matching.weightedTokenScore(index, ["alcoxib"], ["alcoxbi"]), 0);
});

/* ---- index hygiene ---------------------------------------------------------- */

test("the index skips nameless records and de-duplicates the master", () => {
  const built = matching.buildIndex([
    { name: "ALCOXIB 120 (10'S)", company: "Alkem Healthcare" },
    { name: "ALCOXIB 120 10S", company: "ALKEM-HC" },       /* same product, same division */
    { name: "  ", company: "Lupin" },
    { name: null, company: "Lupin" },
    { name: "ALCOXIB 120 (10'S)", company: "Lupin" }        /* same name, another company */
  ]);
  assert.deepEqual(built.entries.map((entry) => entry.name), ["ALCOXIB 120 (10'S)", "ALCOXIB 120 (10'S)"]);
  assert.equal(built.entries[0].company.family, "alkem");
  assert.equal(built.entries[1].company.family, "lupin");
});

test("a rare word outweighs a common one", () => {
  assert.ok(index.weight("alcoxib") > index.weight("tablet"));
  assert.ok(index.weight("tablet") >= THRESHOLDS.WEIGHT_FLOOR);
  /* A word the master has never seen is treated as maximally rare rather than free. */
  assert.ok(index.weight("qqqqqqq") > index.weight("alcoxib"));
});

test("an empty or nameless query asks nothing of the master", () => {
  assert.equal(suggest("", "ALKEM").suggestions.length, 0);
  assert.equal(suggest(null, "ALKEM").suggestions.length, 0);
  assert.equal(suggest("   ", "").decision, "none");
});
