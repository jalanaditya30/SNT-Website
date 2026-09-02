/* Product matching for the near-expiry importer.
   ============================================================================

   A distributor sheet names a medicine differently from the SNT master - "ALCOXIB 120 10S"
   against "ALCOXIB 120 (10'S)", "ONE CLAV DRY SYP" against "ONE CLAV DRY SYRUP 30 ML-GLASS
   BOTTLE" - and both the salt and the pack photo hang off the master name, so exact matching
   throws almost the whole catalogue away. Guessing is worse: this is inventory for medicines,
   and a confident wrong match is more dangerous than no match at all.

   Everything here is therefore deterministic and explainable. No model, no embedding, no
   network call: the same sheet and the same master always produce the same scores, in the
   browser and under `node --test` alike. Nothing in this file touches the DOM, Supabase or
   the spreadsheet reader, so the whole of it is testable.

   The decision runs in layers, each of which can only ever refuse:

     normalise  -> spelling, punctuation, dosage abbreviations and packaging noise
     company    -> a hard gate: a candidate from another manufacturer never gets scored
     weigh      -> rare words identify a product, common ones do not
     penalise   -> a dose or a dosage form that disagrees is close to fatal
     gate       -> a top score that is not clear of its runner-up is left for a person

   Exported through `window.SNTMatching` in the browser and `module.exports` under Node. */

(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.SNTMatching = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MATCHER_VERSION = "2026-09-01.2";

  /* ---- thresholds ----------------------------------------------------------
     Every number the matcher leans on is named here rather than buried in the code, so the
     effect of moving one is arguable rather than mysterious. They are covered by the tests
     in tests/matching.test.js; lowering one without a regression run is how a wrong medicine
     gets published. */

  const THRESHOLDS = Object.freeze({
    /* A suggestion below this is not worth showing at all. */
    SUGGEST_FLOOR: 0.42,
    /* An automatic match needs both of these: a high score AND daylight behind it. */
    AUTO_SCORE: 0.80,
    AUTO_LEAD: 0.07,
    /* A word has to be this long before a spelling-distance match is allowed at all, and
       that similar. Shorter words are too easy to confuse: "d" and "o" are different drugs. */
    FUZZY_MIN_LENGTH: 5,
    /* The word it is compared against may be one shorter - FORTE against the master's FORT,
       which is the same medicine. It cannot go below four: at three characters or fewer a
       word has too few bigrams to clear the similarity bar against a five-character one
       anyway, so this is the floor that actually does something rather than an arbitrary
       one. */
    FUZZY_CANDIDATE_LENGTH: 4,
    FUZZY_SIMILARITY: 0.72,
    /* A typo is never worth as much as the word spelled correctly. */
    FUZZY_DISCOUNT: 0.72,
    /* How the two views of the name are blended. */
    TOKEN_WEIGHT: 0.72,
    TEXT_WEIGHT: 0.28,
    /* The leading word is the brand. Same word helps; a very different one is decisive. */
    FIRST_TOKEN_BONUS: 0.08,
    FIRST_TOKEN_SIMILARITY: 0.55,
    FIRST_TOKEN_PENALTY: 0.55,
    /* 125 mg is not 250 mg, and an injection is not a tablet. */
    DOSE_CONFLICT: 0.32,
    FORM_CONFLICT: 0.42,
    /* A named flavour or formulation suffix is part of the medicine identity. These
       multipliers keep an unsafe candidate visible for review when it is otherwise very
       close, but prevent the disagreement from winning merely because it is the only row
       under that company. */
    FLAVOUR_CONFLICT: 0.55,
    VARIANT_CONFLICT: 0.45,
    SINGLE_CANDIDATE_AUTO_SCORE: 0.90,
    /* Same manufacturer is corroboration, not proof, so the nudge is small. */
    COMPANY_DIVISION_BONUS: 0.06,
    COMPANY_FAMILY_BONUS: 0.03,
    /* Inverse-frequency weighting: log((entries + 1) / (frequency + 1)) + FLOOR. */
    WEIGHT_FLOOR: 0.35,
    /* Candidate-pool narrowing. A purely mechanical speed-up: it may only ever be applied
       when it still leaves enough candidates to rank. */
    RARE_TOKEN_CUTOFF: 80,
    NARROW_MIN_POOL: 3,
    /* How many suggestions an operator is asked to choose between. */
    MAX_SUGGESTIONS: 4
  });

  /* ---- normalisation -------------------------------------------------------
     Sheets and the master disagree on punctuation ("10S" / "(10'S)"), on abbreviation
     ("SYP" / "SYRUP"), and on packaging words that identify nothing ("GLASS BOTTLE",
     "W.C."). All three are flattened here so the scoring only ever sees what distinguishes
     one medicine from another. */

  /* Every spelling of a dosage form collapses to one token, so a form comparison is a set
     comparison rather than a list of string tests. */
  const FORM_ALIASES = new Map(Object.entries({
    tab: "tablet", tabs: "tablet", tablet: "tablet", tablets: "tablet", dt: "tablet",
    cap: "capsule", caps: "capsule", capsule: "capsule", capsules: "capsule",
    sg: "softgel", softgel: "softgel", softgels: "softgel",
    syp: "syrup", syr: "syrup", syrup: "syrup", syrups: "syrup",
    sus: "suspension", susp: "suspension", suspension: "suspension",
    inj: "injection", injection: "injection", injections: "injection",
    soln: "solution", sol: "solution", solution: "solution",
    drop: "drops", drops: "drops",
    crm: "cream", cream: "cream",
    oint: "ointment", onitment: "ointment", ointment: "ointment",
    pwd: "powder", pow: "powder", powder: "powder",
    gel: "gel", lotion: "lotion", spray: "spray"
  }));

  /* The normalised forms themselves, for the conflict test. */
  const FORMS = new Set(FORM_ALIASES.values());

  /* Which forms are different enough to be a refusal.

     The penalty exists for the difference that matters: an injection is not a tablet, and a
     shared brand word must never make one out of the other. Some of these words are not that
     kind of difference at all. A liquid in a bottle is written SYP, SUSP or ORAL SOLUTION by
     turns, by the same manufacturer, for the same medicine - the SNT master itself carries
     ALCAL-D SYRUP (200 ML), PAMAGIN DS SUSPENSION (60ML) and LACTUDOS ORAL SOLUTION (100ML)
     side by side, and the distributor sheet writes SYP for all three. Treating those as
     conflicting hid five real products on a 184-row sheet behind the 42% floor, where the
     operator could not even see them to accept. A softgel is a capsule by definition.

     Drops stay separate: a dropper bottle is a different pack and a different dose from a
     syrup, not another word for it. Tablet and capsule stay separate: the master carries
     both for the same brand. So the grouping is only where the words are synonyms, and the
     specific word still costs on the token score - it is just no longer multiplied by 0.42.

     Adding to this table is a safety decision. It needs a reason of this kind, and a test. */
  const FORM_FAMILIES = new Map(Object.entries({
    syrup: "oral liquid", suspension: "oral liquid", solution: "oral liquid",
    capsule: "capsule", softgel: "capsule"
  }));

  function formFamily(form) {
    return FORM_FAMILIES.get(form) || form;
  }

  /* Words that describe the packaging rather than the medicine. "NEW ALKEM COLD +
     SUSPENSION" and "ALKEM COLD + SUS" are the same product; "(60ML W.C.)" and "(60 ML WITH
     CAP)" are the same bottle. Keeping them would let a shared "BOTTLE" stand in for a
     shared brand.

     WFI and NOVO deliberately are not noise. The real master contains same-company products
     where those are the only words separating two catalogue rows. Removing either word made
     an exact-looking automatic match select a different SKU. */
  const NOISE_TOKENS = new Set([
    "new", "wc", "with", "bottle", "glass", "pack", "packing"
  ]);

  /* Common sheet/OCR spelling variants that are meaningful after correction. */
  const TOKEN_ALIASES = new Map(Object.entries({ wifi: "wfi" }));

  /* Commercial suffixes and formulation qualifiers that distinguish products carrying the
     same brand. This is intentionally conservative: disagreements block automatic matching
     but do not prevent an operator from choosing the candidate. "MORE TIME" and the MARG
     abbreviation "M.T" are reduced to the same token below. */
  const VARIANT_ALIASES = new Map(Object.entries({
    fort: "forte", forte: "forte", mt: "mt",
    cv: "cv", dsr: "dsr", sr: "sr", cr: "cr", er: "er", xr: "xr", mr: "mr",
    ds: "ds", dt: "dt", md: "md", od: "od", oz: "oz", tz: "tz", lb: "lb",
    d: "d", l: "l", nf: "nf", novo: "novo", wfi: "wfi",
    max: "max", gold: "gold"
  }));

  const FLAVOUR_ALIASES = new Map(Object.entries({
    cardamom: "cardamom", elaichi: "cardamom", elachi: "cardamom",
    orange: "orange", apple: "apple", guava: "guava", strawberry: "strawberry",
    strawerry: "strawberry", mix: "mixed fruit", mixed: "mixed fruit",
    fruit: "mixed fruit", fruite: "mixed fruit",
    mango: "mango", lemon: "lemon", pineapple: "pineapple", cola: "cola",
    chocolate: "chocolate", vanilla: "vanilla", banana: "banana"
  }));

  /* Units that make a number mean something. A bare "10" is a pack size and proves little;
     "10 mg" is a dose and proves a great deal. */
  const UNITS = new Set(["mg", "mcg", "gm", "g", "ml", "iu", "percent"]);

  /* gm and g are the same unit written two ways; compare doses in one of them. */
  function canonicalUnit(token) {
    return token === "gm" ? "g" : token;
  }

  /* The normalisation contract, in order:
       NFKD, lowercase, apostrophes dropped, % -> percent, & -> plus, everything else
       non-alphanumeric to space, then decimal numbers and words tokenised separately,
       dosage forms canonicalised and packaging noise dropped.

     A dot is two different characters here. Between digits it is a decimal point and has to
     survive, because ALKEMERO 0.5 Gm and 1.5 Gm are different medicines. Anywhere else it
     abbreviates - "W.C.", "SYP.", "NO." - and closing it up rather than splitting on it is
     what makes "(60ML W.C.)" carry the one packaging word "wc" instead of the two letters
     "w" and "c", neither of which means anything on its own. */
  const DECIMAL_MARK = "\u0001";

  function semanticPlus(text) {
    return text.replace(/\+/g, (_match, offset, whole) => {
      const left = whole.slice(0, offset).match(/([a-z])\s*$/)?.[1] || "";
      const right = whole.slice(offset + 1).match(/^\s*([a-z])/)?.[1] || "";
      /* 900g+100g and 1+4 describe pack arithmetic. A plus between words (or a branded
         trailing plus) distinguishes names such as PAMAGIN + GEL. */
      return left && (right || !whole.slice(offset + 1).trim()) ? " plus " : " ";
    });
  }

  function tokenize(value) {
    const text = semanticPlus(String(value ?? "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/['‘’ʼ]/g, "")
      .replace(/(\d)\.(\d)/g, `$1${DECIMAL_MARK}$2`)
      .replace(/\./g, "")
      .split(DECIMAL_MARK).join(".")
      .replace(/%/g, " percent ")
      .replace(/&/g, " plus "))
      .replace(/[^a-z0-9.]+/g, " ");
    const raw = text.match(/\d+(?:\.\d+)?|[a-z]+/g) || [];
    const tokens = [];
    for (let index = 0; index < raw.length; index += 1) {
      let token = raw[index];
      if (token === "more" && raw[index + 1] === "time") {
        token = "mt";
        index += 1;
      }
      const canonical = FORM_ALIASES.get(token) || TOKEN_ALIASES.get(token) || token;
      if (NOISE_TOKENS.has(canonical)) continue;
      tokens.push(canonical);
    }
    return tokens;
  }

  /* Both views of a name: the token list the weighted score works on, and the tokens run
     together, which is what catches a word split or joined differently ("ONECLAV" against
     "ONE CLAV") without any special case for it. */
  function normalizeName(value) {
    const tokens = tokenize(value);
    return { tokens, compact: tokens.join("") };
  }

  /* ---- Sørensen-Dice on character bigrams ---------------------------------
     Cheap, symmetric, and forgiving of exactly the errors that appear in these sheets - a
     dropped letter, a transposition, a plural. Multiset intersection rather than set, so a
     repeated bigram cannot be counted more often than it occurs. */

  function bigrams(value) {
    const counts = new Map();
    for (let index = 0; index < value.length - 1; index += 1) {
      const pair = value.slice(index, index + 2);
      counts.set(pair, (counts.get(pair) || 0) + 1);
    }
    return counts;
  }

  function dice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    /* Under two characters there are no bigrams to compare, and equality was just ruled
       out, so there is nothing this can honestly report but "different". */
    if (a.length < 2 || b.length < 2) return 0;
    const left = bigrams(a);
    const right = bigrams(b);
    let shared = 0;
    left.forEach((count, pair) => { shared += Math.min(count, right.get(pair) || 0); });
    return (2 * shared) / ((a.length - 1) + (b.length - 1));
  }

  /* ---- companies ----------------------------------------------------------
     The safety boundary, and the reason this file exists in the shape it does. A sheet says
     ALKEM-FUT, ALKEM, LUPIN or a literal -BLANK-; the master says "Alkem - Futura / NEXX".
     Both are reduced to a family and, where one is named, a division, and a candidate from
     another family is refused before it is ever scored - so a brand that looks similar can
     never be suggested across a manufacturer boundary.

     Aliases are a table on purpose. A company the table does not know keeps its own name as
     its family, which means it matches only itself: an unrecognised manufacturer therefore
     yields no suggestions rather than being quietly folded into whichever family looks
     closest. Adding a company is an edit here plus a test, deliberately. */

  const COMPANY_ALIASES = Object.freeze([
    /* Divisions first: "Alkem - Futura / NEXX" also contains the word "alkem", and the more
       specific reading is the right one. */
    { family: "alkem", division: "futura", patterns: [/\bfutura\b/, /\bfut\b/, /\bnexx\b/] },
    { family: "alkem", division: "maxxio", patterns: [/\bmaxxio\b/, /\bmaxx\b/, /\bmax\b/] },
    { family: "alkem", division: "novokem", patterns: [/\bnovokem\b/, /\bnovokem\b/, /\bnov\b/] },
    { family: "alkem", division: "healthcare", patterns: [/\bhealthcare\b/, /\bhealth care\b/, /\bhc\b/] },
    { family: "alkem", division: "", patterns: [/\balkem\b/] },
    { family: "lupin", division: "", patterns: [/\blupin\b/] },
    { family: "sun", division: "", patterns: [/\branbaxy\b/, /\bsun pharma\b/, /\bsun\b/] },
    { family: "torque", division: "", patterns: [/\btorque\b/] },
    { family: "shivayur", division: "", patterns: [/\bshivayur\b/] },
    { family: "silver cross", division: "", patterns: [/\bsilver cross\b/, /\bsilvercross\b/] }
  ]);

  /* Suffixes that say what kind of business it is rather than which one. Stripped only
     after the alias table has had its look, because "Healthcare" is a generic word for most
     companies and the name of an Alkem division for this one. */
  const COMPANY_GENERIC = /\b(?:private|pvt|limited|ltd|llp|inc|incorporated|company|co|corp|corporation|laboratories|laboratory|labs|lab|pharmaceuticals?|pharma|healthcare|health\s?care|lifesciences?|life\s+sciences?|sciences?|remedies|drugs?|india|indian)\b/g;

  /* A sheet writes "-BLANK-" where it means "no company". */
  const BLANK_COMPANY = /^-*\s*blank\s*-*$/;

  function companyText(value) {
    return String(value ?? "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/['‘’ʼ]/g, "")
      .replace(/&/g, " plus ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  /* -> { supplied, family, division, known, label }
     `supplied: false` means the sheet said nothing, which is not the same as saying
     something unrecognised: the first allows every candidate, the second allows none. */
  function normalizeCompany(value) {
    const label = String(value ?? "").trim();
    const text = companyText(value);
    if (!text || BLANK_COMPANY.test(text)) {
      return { supplied: false, family: "", division: "", known: false, label: "" };
    }
    const padded = ` ${text} `;
    for (const alias of COMPANY_ALIASES) {
      if (alias.patterns.some((pattern) => pattern.test(padded))) {
        return { supplied: true, family: alias.family, division: alias.division, known: true, label };
      }
    }
    /* Unknown to the table: it becomes its own family, so it can only ever match itself. */
    const stripped = text.replace(COMPANY_GENERIC, " ").replace(/\s+/g, " ").trim();
    return { supplied: true, family: stripped || text, division: "", known: false, label };
  }

  function companyKey(company) {
    return company.supplied ? `${company.family}/${company.division}` : "";
  }

  function aliasKey(name, companyValue) {
    return `${normalizeName(name).compact}|${companyKey(normalizeCompany(companyValue))}`;
  }

  function buildAliasIndex(rows) {
    const aliases = new Map();
    (rows || []).forEach((row) => {
      if (!String(row?.status || "").startsWith("approved")
          || (!row.product_id && !row.canonical_product_name)) return;
      const key = `${String(row.source_name_key || "")}|${String(row.source_company_key || "")}`;
      if (key !== "|") aliases.set(key, row);
    });
    return aliases;
  }

  /* The gate itself. Nothing but this decides whether a candidate is scored at all. */
  function companiesCompatible(source, candidate) {
    if (!source.supplied) return true;
    if (source.family !== candidate.family) return false;
    /* Two named divisions of one family are as separate as two companies: an Alkem-Maxxio
       sheet line is not an Alkem-Novokem product. A sheet that names only the family still
       reaches all of them. */
    if (source.division && candidate.division && source.division !== candidate.division) return false;
    return true;
  }

  function companyBonus(source, candidate) {
    if (!source.supplied) return 0;
    if (source.division && source.division === candidate.division) return THRESHOLDS.COMPANY_DIVISION_BONUS;
    if (source.family === candidate.family) return THRESHOLDS.COMPANY_FAMILY_BONUS;
    return 0;
  }

  /* ---- doses and forms -----------------------------------------------------
     A number is only a dose when a unit follows it, so "10'S" stays a pack size. Values are
     collected per unit: a conflict is a unit both names quantify, differently. */

  function doseFigures(tokens) {
    const figures = new Map();
    for (let index = 0; index < tokens.length - 1; index += 1) {
      const value = tokens[index];
      const unit = canonicalUnit(tokens[index + 1]);
      if (!/^\d+(\.\d+)?$/.test(value) || !UNITS.has(unit)) continue;
      if (!figures.has(unit)) figures.set(unit, new Set());
      /* Number, not string: "500" and "500.0" are the same dose. */
      figures.get(unit).add(Number(value));
    }
    return figures;
  }

  function doseConflict(a, b) {
    for (const [unit, values] of a) {
      const other = b.get(unit);
      if (!other) continue;
      if (![...values].some((value) => other.has(value))) return true;
    }
    return false;
  }

  function formSet(tokens) {
    const forms = new Set();
    tokens.forEach((token) => { if (FORMS.has(token)) forms.add(token); });
    return forms;
  }

  /* Only a stated disagreement counts. A sheet that never says which form it is has not
     contradicted anything, and must not be penalised for staying quiet. */
  function formConflict(a, b) {
    if (!a.size || !b.size) return false;
    const families = new Set([...b].map(formFamily));
    return ![...a].some((form) => families.has(formFamily(form)));
  }

  /* Some masters omit the unit from a strength (ALKEM-POD 50/100). A number before the
     dosage form is treated as identity unless it is visibly part of 10X1X10 pack arithmetic.
     Unit-bearing strengths are harmlessly included here as well as in doseFigures. */
  function strengthFigures(tokens) {
    const firstForm = tokens.findIndex((token) => FORMS.has(token));
    const limit = firstForm === -1 ? Math.min(tokens.length, 4) : firstForm;
    const figures = new Set();
    for (let index = 0; index < limit; index += 1) {
      if (!/^\d+(?:\.\d+)?$/.test(tokens[index])) continue;
      if (tokens[index - 1] === "x" || tokens[index + 1] === "x") continue;
      figures.add(Number(tokens[index]));
    }
    return figures;
  }

  function strengthConflict(a, b) {
    return Boolean(a.size && b.size && ![...a].some((value) => b.has(value)));
  }

  function canonicalSet(tokens, aliases) {
    const values = new Set();
    tokens.forEach((token) => {
      const canonical = aliases.get(token);
      if (canonical) values.add(canonical);
    });
    return values;
  }

  function flavourSet(tokens) {
    return canonicalSet(tokens, FLAVOUR_ALIASES);
  }

  function variantSet(tokens) {
    return canonicalSet(tokens, VARIANT_ALIASES);
  }

  function setsEqual(a, b) {
    return a.size === b.size && [...a].every((value) => b.has(value));
  }

  /* Any explicit difference is review-only. In particular, a generic source may not be
     auto-expanded into a flavoured or modified catalogue product, and a specific source may
     not have that qualifier silently removed. */
  function attributeConflicts(source, candidate) {
    const blockers = [];
    if (!setsEqual(source.flavours, candidate.flavours)) {
      blockers.push(source.flavours.size && candidate.flavours.size
        ? "flavour disagrees"
        : source.flavours.size ? "candidate omits flavour" : "candidate adds flavour");
    }
    if (!setsEqual(source.variants, candidate.variants)) {
      blockers.push(source.variants.size && candidate.variants.size
        ? "formulation variant disagrees"
        : source.variants.size ? "candidate omits formulation variant" : "candidate adds formulation variant");
    }
    return blockers;
  }

  /* The brand: the first word that is not a number, a unit or a dosage form. */
  function firstMeaningfulToken(tokens) {
    return tokens.find((token) =>
      !/^\d/.test(token) && !UNITS.has(canonicalUnit(token)) && !FORMS.has(token)) || "";
  }

  /* ---- the master index ----------------------------------------------------
     Built once per master, because token frequencies are a property of the catalogue rather
     than of any one sheet, and because 184 sheet names against 1554 products is not
     something to recompute per keystroke. */

  function buildIndex(master) {
    const entries = [];
    const frequency = new Map();
    const byIdentity = new Map();

    (master || []).forEach((item) => {
      const name = String(item?.name ?? "").trim();
      if (!name) return;
      const { tokens, compact } = normalizeName(name);
      if (!compact) return;
      const company = normalizeCompany(item.company);
      const identityKey = `${compact}|${companyKey(company)}`;
      const entry = {
        item, name, tokens, compact, company,
        identityKey, identitySize: 1,
        forms: formSet(tokens), doses: doseFigures(tokens), first: firstMeaningfulToken(tokens),
        flavours: flavourSet(tokens), variants: variantSet(tokens),
        strengths: strengthFigures(tokens)
      };
      entries.push(entry);
      if (!byIdentity.has(identityKey)) byIdentity.set(identityKey, []);
      byIdentity.get(identityKey).push(entry);
    });

    /* Never discard a collision. Even rows that look like harmless duplicate spellings are
       kept because their composition or pack data can differ. Every member is marked so an
       exact-looking query can be forced to review rather than silently taking the first row. */
    const identityCollisions = [];
    byIdentity.forEach((group, identityKey) => {
      group.forEach((entry) => { entry.identitySize = group.length; });
      if (group.length > 1) identityCollisions.push({ identityKey, entries: group });
    });

    entries.forEach((entry) => {
      new Set(entry.tokens).forEach((token) => frequency.set(token, (frequency.get(token) || 0) + 1));
    });

    const total = entries.length;
    /* A word in two products all but names one; a word in half the catalogue names nothing.
       The floor keeps a very common word worth a little rather than nothing, so a name made
       only of common words still scores. */
    const weights = new Map();
    frequency.forEach((count, token) => {
      weights.set(token, Math.log((total + 1) / (count + 1)) + THRESHOLDS.WEIGHT_FLOOR);
    });
    const weight = (token) =>
      weights.has(token) ? weights.get(token) : Math.log(total + 1) + THRESHOLDS.WEIGHT_FLOOR;

    /* Candidates grouped by manufacturer, so the company gate is a lookup rather than a
       scan, and by token, for the rare-token narrowing. */
    const byFamily = new Map();
    const byToken = new Map();
    entries.forEach((entry) => {
      const family = entry.company.supplied ? entry.company.family : "";
      if (!byFamily.has(family)) byFamily.set(family, []);
      byFamily.get(family).push(entry);
      new Set(entry.tokens).forEach((token) => {
        if (!byToken.has(token)) byToken.set(token, []);
        byToken.get(token).push(entry);
      });
    });

    return {
      entries, frequency, weight, total, byFamily, byToken, byIdentity, identityCollisions,
      vocabulary: [...frequency.keys()].sort(),
      /* Spelling neighbours of a token across the whole vocabulary, worked out once. */
      fuzzyCache: new Map()
    };
  }

  function totalWeight(index, tokens) {
    return tokens.reduce((sum, token) => sum + index.weight(token), 0);
  }

  /* ---- the weighted token score -------------------------------------------
     Dice over tokens rather than characters, with each token worth its rarity. Exact matches
     are taken first and removed from the pool, so a name repeating a word cannot match it
     twice; only what is left over is offered to the spelling comparison. */

  function weightedTokenScore(index, sourceTokens, candidateTokens) {
    if (!sourceTokens.length || !candidateTokens.length) return 0;
    const pool = [...candidateTokens];
    const unmatched = [];
    let shared = 0;

    for (const token of sourceTokens) {
      const at = pool.indexOf(token);
      if (at === -1) { unmatched.push(token); continue; }
      pool.splice(at, 1);
      shared += index.weight(token);
    }

    /* A typo is allowed to count, at a discount and only for a word long enough that the
       resemblance means something. Ties go to the alphabetically first candidate token, so
       the result cannot depend on the order the master happens to be in. */
    for (const token of unmatched) {
      if (token.length < THRESHOLDS.FUZZY_MIN_LENGTH) continue;
      let best = -1;
      let bestScore = 0;
      for (let at = 0; at < pool.length; at += 1) {
        const other = pool[at];
        if (other.length < THRESHOLDS.FUZZY_CANDIDATE_LENGTH) continue;
        const similarity = dice(token, other);
        if (similarity > bestScore || (similarity === bestScore && best !== -1 && other < pool[best])) {
          bestScore = similarity;
          best = at;
        }
      }
      if (best === -1 || bestScore < THRESHOLDS.FUZZY_SIMILARITY) continue;
      const pair = (index.weight(token) + index.weight(pool[best])) / 2;
      shared += pair * bestScore * THRESHOLDS.FUZZY_DISCOUNT;
      pool.splice(best, 1);
    }

    const denominator = totalWeight(index, sourceTokens) + totalWeight(index, candidateTokens);
    return denominator > 0 ? (2 * shared) / denominator : 0;
  }

  /* ---- scoring one candidate ----------------------------------------------
     Returns the score and the reasons for it, so the review dialog and a failing test can
     both say why a number came out the way it did. */

  function scoreCandidate(index, source, entry) {
    const reasons = [];

    const blockers = attributeConflicts(source, entry);
    const dosesDisagree = doseConflict(source.doses, entry.doses);
    const formsDisagree = formConflict(source.forms, entry.forms);
    const strengthsDisagree = strengthConflict(source.strengths, entry.strengths);
    if (dosesDisagree) blockers.push("dose disagrees");
    if (formsDisagree) blockers.push("dosage form disagrees");
    if (strengthsDisagree) blockers.push("strength number disagrees");

    if (source.compact && source.compact === entry.compact) {
      return { score: 1, reasons: ["exact name"], blockers, exact: true };
    }

    const tokenScore = weightedTokenScore(index, source.tokens, entry.tokens);
    const textScore = dice(source.compact, entry.compact);
    let score = (THRESHOLDS.TOKEN_WEIGHT * tokenScore) + (THRESHOLDS.TEXT_WEIGHT * textScore);

    /* The brand word carries the identity. Sharing it is corroboration; a leading word that
       is nothing like the other one is close to a refusal, whatever else the names share. */
    if (source.first && entry.first) {
      if (source.first === entry.first) {
        score += THRESHOLDS.FIRST_TOKEN_BONUS;
        reasons.push("same leading word");
      } else if (dice(source.first, entry.first) < THRESHOLDS.FIRST_TOKEN_SIMILARITY) {
        score *= THRESHOLDS.FIRST_TOKEN_PENALTY;
        reasons.push("different leading word");
      }
    }

    /* The two penalties that keep this honest. 125 mg is not 250 mg however alike the rest
       of the name reads, and a brand shared with an injection does not make a tablet. */
    if (dosesDisagree) {
      score *= THRESHOLDS.DOSE_CONFLICT;
      reasons.push("dose disagrees");
    }
    if (formsDisagree) {
      score *= THRESHOLDS.FORM_CONFLICT;
      reasons.push("dosage form disagrees");
    }
    if (strengthsDisagree && !dosesDisagree) {
      score *= THRESHOLDS.DOSE_CONFLICT;
      reasons.push("strength number disagrees");
    }

    /* A generic source may still be shown all specific flavours for a person to choose;
       it is the automatic gate, not the suggestion floor, that refuses that expansion. A
       source that did name a flavour must rank a different/unspecified one lower. */
    if (source.flavours.size && blockers.some((reason) => reason.includes("flavour"))) {
      score *= THRESHOLDS.FLAVOUR_CONFLICT;
    }
    if (blockers.some((reason) => reason.includes("formulation variant"))) {
      score *= THRESHOLDS.VARIANT_CONFLICT;
    }
    blockers.forEach((reason) => { if (!reasons.includes(reason)) reasons.push(reason); });

    const bonus = companyBonus(source.company, entry.company);
    if (bonus) {
      score += bonus;
      reasons.push(bonus === THRESHOLDS.COMPANY_DIVISION_BONUS ? "same division" : "same company");
    }

    return { score: Math.min(1, Math.max(0, score)), reasons, blockers, exact: false };
  }

  /* ---- candidate pool ------------------------------------------------------ */

  /* Which master entries this sheet line is even allowed to be. */
  function candidatesFor(index, company) {
    if (!company.supplied) return index.entries;
    const family = index.byFamily.get(company.family) || [];
    if (!company.division) return family;
    /* A sheet naming a division still reaches that family's undivided entries. */
    return family.filter((entry) => !entry.company.division || entry.company.division === company.division);
  }

  function fuzzyVocabulary(index, token) {
    if (index.fuzzyCache.has(token)) return index.fuzzyCache.get(token);
    const near = [];
    if (token.length >= THRESHOLDS.FUZZY_MIN_LENGTH) {
      for (const other of index.vocabulary) {
        if (other === token || other.length < THRESHOLDS.FUZZY_MIN_LENGTH) continue;
        if (dice(token, other) >= THRESHOLDS.FUZZY_SIMILARITY) near.push(other);
      }
    }
    index.fuzzyCache.set(token, near);
    return near;
  }

  /* Scoring every company-compatible product against every sheet line is affordable but not
     free, and most of those comparisons are between names sharing nothing. Narrowing to the
     products that carry one of the source's rare words - or a close spelling of one - skips
     them. It is applied only when it still leaves enough candidates to rank, so it can
     change how long the match takes and not what it decides. */
  function narrowPool(index, source, pool) {
    const rare = source.tokens.filter((token) =>
      (index.frequency.get(token) || 0) <= THRESHOLDS.RARE_TOKEN_CUTOFF);
    if (!rare.length) return pool;

    const wanted = new Set();
    rare.forEach((token) => {
      wanted.add(token);
      fuzzyVocabulary(index, token).forEach((near) => wanted.add(near));
    });

    const narrowed = pool.filter((entry) => entry.tokens.some((token) => wanted.has(token)));
    return narrowed.length >= THRESHOLDS.NARROW_MIN_POOL ? narrowed : pool;
  }

  /* ---- the public call -----------------------------------------------------
     One sheet line in, a ranked shortlist and a verdict out. */

  function prepareSource(name, company) {
    const { tokens, compact } = normalizeName(name);
    return {
      name: String(name ?? "").trim(), tokens, compact,
      company: normalizeCompany(company),
      forms: formSet(tokens), doses: doseFigures(tokens), first: firstMeaningfulToken(tokens),
      flavours: flavourSet(tokens), variants: variantSet(tokens),
      strengths: strengthFigures(tokens)
    };
  }

  function suggestMatches(index, name, companyValue, options) {
    const limit = options?.limit ?? THRESHOLDS.MAX_SUGGESTIONS;
    const source = prepareSource(name, companyValue);
    const empty = {
      source, suggestions: [], top: null, runnerUp: null, lead: 0,
      exactCount: 0, catalogueCollision: false, auto: null, decision: "none"
    };
    if (!index || !source.tokens.length) return empty;

    /* An explicitly reviewed MARG mapping outranks fuzzy evidence, but it does not bypass
       the company boundary or survive a catalogue rename silently. A stale or incompatible
       alias simply falls through to the deterministic matcher. */
    const approvedAlias = options?.aliases?.get(aliasKey(name, companyValue));
    if (approvedAlias) {
      const aliasedEntry = index.entries.find((entry) => {
        const stableIdMatches = approvedAlias.product_id != null
          && String(entry.item?.product_id) === String(approvedAlias.product_id);
        const rolloutNameMatches = approvedAlias.product_id == null
          && entry.name === approvedAlias.canonical_product_name;
        const sameCatalogueVersion = !approvedAlias.product_source_hash
          || !entry.item?.source_hash
          || approvedAlias.product_source_hash === entry.item.source_hash;
        const supportedMatcher = approvedAlias.status === "approved_human"
          || !approvedAlias.matcher_version
          || approvedAlias.matcher_version === MATCHER_VERSION;
        return (stableIdMatches || rolloutNameMatches) && sameCatalogueVersion && supportedMatcher
          && companiesCompatible(source.company, entry.company);
      });
      if (aliasedEntry) {
        const aliased = {
          name: aliasedEntry.name, item: aliasedEntry.item, company: aliasedEntry.company,
          score: 1, reasons: ["approved MARG alias"], exact: false, alias: true, blockers: [],
          identityKey: aliasedEntry.identityKey, identitySize: aliasedEntry.identitySize
        };
        return {
          source, suggestions: [aliased], top: aliased, runnerUp: null, lead: 0,
          exactCount: 0, catalogueCollision: false, autoBlockedReasons: [],
          auto: aliased, decision: "auto", alias: approvedAlias
        };
      }
    }

    /* The company gate. A manufacturer the master has never heard of leaves nothing to
       score, which is exactly the intended answer: no suggestions, sheet name retained. */
    const allowed = candidatesFor(index, source.company);
    if (!allowed.length) return empty;

    const pool = narrowPool(index, source, allowed);
    const scored = [];
    for (const entry of pool) {
      const result = scoreCandidate(index, source, entry);
      if (result.score < THRESHOLDS.SUGGEST_FLOOR) continue;
      scored.push({
        name: entry.name, item: entry.item, company: entry.company, score: result.score,
        reasons: result.reasons, exact: result.exact,
        blockers: result.blockers, strongIdentity: source.first === entry.first,
        identityKey: entry.identityKey, identitySize: entry.identitySize
      });
    }

    /* A candidate whose normalised name is identical to the sheet's ranks above one that
       merely scores 1.0 after bonuses and clamping, so "the top result" and "the exact
       result" cannot come apart. Name breaks the remaining ties, so identical scores rank
       the same way on every machine and in every run. */
    scored.sort((a, b) =>
      (Number(b.exact) - Number(a.exact)) || (b.score - a.score) || a.name.localeCompare(b.name));
    const exactCount = scored.reduce((count, candidate) => count + Number(candidate.exact), 0);
    const suggestions = scored.slice(0, limit);
    if (!suggestions.length) return empty;

    const top = suggestions[0];
    /* The display limit is not a safety limit. The runner-up and lead always come from the
       complete ranked pool, otherwise limit:1 would hide the rival and manufacture a lead. */
    const runnerUp = scored[1] || null;
    const lead = runnerUp ? top.score - runnerUp.score : 0;

    /* The whole point of the exercise. "Best" is not "safe": a top candidate its runner-up
       is breathing down the neck of is exactly the flavour/strength/pack ambiguity a person
       has to settle, and it is left for them.

       Exactness is the one thing that excuses a small lead, and it has to mean exactness:
       the sheet's normalised name and the candidate's are the same string, and no other
       candidate can say that. A score threshold cannot stand in for it. Scores are clamped
       to 1, and the leading-word and company bonuses push a merely close candidate over any
       threshold near 1, so "score >= 0.995" collapsed distinct candidates into ties and then
       auto-selected whichever sorted first. On a real 184-row sheet that published CEFKEM
       200 for CEFKEM CV-200, ALDIGESIC-TH for ALDIGESIC-TH 8, the 30 ml ALMOX dry syrup for
       the 60 ml, and KEMOPRAZ-D for KEMOPRAZ - every one of them with a lead of two points
       or less. Identity is a fact about the strings; only that is allowed to skip the lead. */
    /* Count against the full scored pool, not the displayed slice. A caller asking for one
       suggestion must not turn a hidden second exact identity into an automatic match. */
    const uniquelyExact = top.exact && exactCount === 1;
    const hasSafetyBlocker = Boolean(top.blockers?.length);
    const competitiveAuto = runnerUp
      ? top.score >= THRESHOLDS.AUTO_SCORE && lead >= THRESHOLDS.AUTO_LEAD
      : top.strongIdentity && top.score >= THRESHOLDS.SINGLE_CANDIDATE_AUTO_SCORE;
    const auto = (uniquelyExact || competitiveAuto) && !hasSafetyBlocker;

    /* A collision is a hard refusal even if score/lead would otherwise clear the fuzzy gate.
       All colliding catalogue records are retained, so this can never depend on master order. */
    const catalogueCollision = top.exact && exactCount > 1;
    const safeAuto = auto && !catalogueCollision;

    return {
      source, suggestions, top, runnerUp, lead, exactCount, catalogueCollision,
      autoBlockedReasons: top.blockers || [],
      auto: safeAuto ? top : null,
      decision: safeAuto ? "auto" : "review"
    };
  }

  return {
    MATCHER_VERSION, THRESHOLDS, FORM_ALIASES, TOKEN_ALIASES, VARIANT_ALIASES, FLAVOUR_ALIASES,
    NOISE_TOKENS, UNITS, COMPANY_ALIASES,
    FORM_FAMILIES, formFamily,
    tokenize, normalizeName, normalizeCompany, companyKey, aliasKey, buildAliasIndex,
    companiesCompatible, companyBonus,
    bigrams, dice, doseFigures, doseConflict, strengthFigures, strengthConflict,
    formSet, formConflict, flavourSet, variantSet,
    attributeConflicts, firstMeaningfulToken,
    buildIndex, weightedTokenScore, scoreCandidate, prepareSource, candidatesFor, suggestMatches
  };
});
