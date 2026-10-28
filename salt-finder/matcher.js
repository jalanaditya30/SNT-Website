/* Salt Finder matching engine.
   Turns the free-text compositions in data.js into salts, matches typed salts
   (or text read off a photo) against them, and ranks catalogue products.
   Plain script for the browser (window.SaltMatcher); also loads in Node for tests. */
(function (root) {
  'use strict';

  /* ── Small text helpers ─────────────────────────────── */
  function clean(s) {
    return String(s == null ? '' : s)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* Common spelling variants folded to one form, so they count as the same salt. */
  const ALIASES = [
    [/amoxycillin/g, 'amoxicillin'],
    [/gentamycin/g, 'gentamicin'],
    [/montelucast/g, 'montelukast'],
    [/guaifenesin/g, 'guaiphenesin'],
    [/chlorphenamine/g, 'chlorpheniramine'],
    [/acetaminophen/g, 'paracetamol'],
    [/sulfate/g, 'sulphate'],
    [/cephalexin/g, 'cefalexin'],
    [/levocetrizine/g, 'levocetirizine'],
    [/cetrizine/g, 'cetirizine'],
    [/rabeprazol\b/g, 'rabeprazole'],
    [/pantoprazol\b/g, 'pantoprazole'],
    [/vit\.?\s/g, 'vitamin '],
    [/\bhc[li]\b/g, 'hydrochloride'],
    [/\bhbr\b/g, 'hydrobromide'],
  ];
  function alias(s) {
    for (const [re, to] of ALIASES) s = s.replace(re, to);
    return s;
  }

  /* Words that only describe the salt form; dropped from the end of a name to
     get its core ("montelukast sodium" → "montelukast"). */
  const FORM_WORDS = new Set([
    'hydrochloride', 'dihydrochloride', 'hydrobromide', 'maleate', 'sodium', 'potassium',
    'tromethamine', 'hemihydrate', 'monohydrate', 'trihydrate', 'dihydrate', 'anhydrous',
    'besylate', 'besilate', 'mesylate', 'mesilate', 'succinate', 'tartrate', 'bitartrate',
    'sulphate', 'phosphate', 'acetate', 'propionate', 'dipropionate', 'valerate',
    'fumarate', 'disodium', 'diethylamine', 'diethylammonium', 'magnesium', 'calcium',
    'axetil', 'proxetil', 'pivoxil', 'dihydrate', 'trihydrate', 'nitrate', 'butyrate',
    'furoate', 'palmitate', 'decanoate', 'bromide', 'citrate', 'hyclate', 'lactate',
    'dimesylate', 'oxalate', 'gluconate', 'sesquihydrate', 'trihydrate',
  ]);
  /* Names whose first word is a mineral: keep the whole name, the form word is the point. */
  const MINERALS = new Set([
    'ferrous', 'ferric', 'zinc', 'magnesium', 'calcium', 'sodium', 'potassium', 'aluminium',
    'aluminum', 'copper', 'manganese', 'chromium', 'selenium', 'disodium', 'dried', 'light',
    'heavy', 'colloidal', 'ammonium', 'silver', 'lithium', 'cupric',
  ]);
  /* Product-type words that sometimes ride along in the composition column. */
  const TAIL_NOISE = /\b(gel|cream|ointment|lotion|syrup|suspension|tablets?|capsules?|injection|infusion|drops|nasal solution|solution|powder|dispersible|oral|eye|ear|soft gelatin|softgel|emulsion|sr|er|dr|mr|per|diluted|tabs|syp|lozenges?|mouth wash)\b/g;

  function cleanName(raw) {
    let s = clean(raw);
    s = s.replace(/\(.*?\)/g, ' ');                       // "(as trihydrate)"
    s = s.replace(/^.*?\bcontains?\s*:?/, ' ');           // "each tablet contains :"
    s = s.replace(/\beq[a-z]*\.?\s*to\b.*$/, ' '); // keep the part before "eq. to"
    s = s.replace(/\b(i\.?\s?p\.?|b\.?p\.?|u\.?s\.?p\.?|e\.?p\.?|ph\.?\s?eur\.?|nf)\b/g, ' ');
    s = s.replace(/\b(in an?|in the) .*$/, ' ');
    s = s.replace(/\b(q\.?s\.?|excipients?|base|propellant|n\.?f\.?)(?![a-z])/g, ' ');
    s = s.replace(/\b[wv]\s*\/\s*[wv]\b/g, ' ');
    s = s.replace(TAIL_NOISE, ' ');
    s = s.replace(/[^a-z0-9\- ]/g, ' ').replace(/-/g, ' ');
    s = s.replace(/\b\d+(\.\d+)?\b/g, ' ');
    s = alias(s.replace(/\s+/g, ' ').trim());
    s = s.replace(/^(each|contains|of|and|with|to|the|a|anhydrous|dried|purified)\s+(?=[a-z]{5})/, '');
    s = s.replace(/\s+(each|and|with|of|to)$/, '');
    return s.trim();
  }

  const SAME_AS = { 'potassium clavulanate': 'clavulanic acid', 'clavulanate potassium': 'clavulanic acid', 'clavulanate': 'clavulanic acid' };
  function coreOf(name) {
    if (SAME_AS[name]) return SAME_AS[name];
    if (/\b(clav|calv)[a-z]*\b/.test(name) && /potassium|(clav|calv)[a-z]*(nate|nic)\b/.test(name)) return 'clavulanic acid';
    const words = name.split(' ').filter(Boolean);
    if (!words.length) return '';
    if (MINERALS.has(words[0])) return words.join(' ');
    while (words.length > 1 && FORM_WORDS.has(words[words.length - 1])) words.pop();
    return words.join(' ');
  }

  /* Strength like "100 mg", "1.16% w/w", "162.5 mg/5 ml". */
  const STRENGTH_RE = /(\d+(?:\.\d+)?)\s*(mg|mcg|µg|μg|gm|g|iu|i\.u\.|lac|lakh|million|%|ml)(?![a-z])(?:\s*[wv]\s*\/\s*[wv](?![a-z]))?(?:\s*\/\s*(?:\d+(?:\.\d+)?\s*)?(?:ml|g|gm|tab))?/gi;

  function normStrength(num, unit) {
    let n = parseFloat(num);
    let u = unit.toLowerCase().replace(/\./g, '');
    if (u === 'gm' || u === 'g') { n = n * 1000; u = 'mg'; }
    if (u === 'µg' || u === 'μg') u = 'mcg';
    return { value: n, unit: u };
  }
  function strengthText(st) {
    if (!st) return '';
    return (st.unit === '%' ? st.value + '%' : st.value + ' ' + st.unit);
  }

  /* ── Composition → salts ────────────────────────────── */
  const DROP_AFTER = /\b(colou?rs?|preservatives?|flavou?rs?|excipients?)\s*:.*$/i;
  const NOT_A_SALT = /^(water\b.*|per|excipients?|q s|qs|water|water for injection|purified water|sterile water|colou?rs?|flavou?rs?|sugar|sucrose base|base|propellant|gel|cream|in|each|ml|tablet|capsule|contains|sorbitol solution|alcohol|wfi|with)$/;

  function parseComposition(comp) {
    let text = String(comp || '').normalize('NFKC').replace(DROP_AFTER, '');
    text = text.replace(/^.*?\bcontains?\s*:/i, '');
    // Split points: "+", commas before a word, " and ", " with ", ";", and right after each strength.
    const marked = text.replace(STRENGTH_RE, m => m + ' ⟂ ');
    const parts = marked.split(/\s*(?:\+|⟂|;|&|,(?=\s*[a-zA-Z])|\band\b|\bwith\b|\bcombination of\b)\s*/i);
    const salts = [];
    const seen = new Set();
    // Re-attach each strength to the name before it.
    for (const part of parts) {
      if (!part || !part.trim()) continue;
      let st = null;
      STRENGTH_RE.lastIndex = 0;
      const m = STRENGTH_RE.exec(part);
      if (m) st = normStrength(m[1], m[2]);
      const name = cleanName(part.replace(STRENGTH_RE, ' '));
      if (!name || name.length < 3 || NOT_A_SALT.test(name) || !/[a-z]{3}/.test(name)) continue;
      const core = coreOf(name);
      if (!core || seen.has(core)) continue;
      seen.add(core);
      salts.push({ name, core, strength: st });
    }
    return salts;
  }

  /* ── Similarity ─────────────────────────────────────── */
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const c = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }
  /* Letter-order similarity: shared letters in sequence, against both lengths. */
  function looseScore(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    return (2 * dp[m][n]) / (m + n);
  }
  function sim(a, b) {
    if (a === b) return 1;
    const L = Math.max(a.length, b.length);
    if (!L) return 0;
    return 1 - lev(a, b) / L;
  }
  /* How closely a typed/read salt matches a catalogue salt core (0..1). */
  /* strict: reading a photo. Every word must be accounted for, short names must be exact,
     and a cheap length check skips names that cannot possibly be close. */
  function saltScore(q, core, strict) {
    if (!q || !core) return 0;
    if (q === core) return 1;
    const qs = q.replace(/ /g, ''), cs = core.replace(/ /g, '');
    if (qs === cs) return 1;
    // Codes like "b12", "d3", "c" must match exactly: vitamin b12 is not vitamin b2.
    const codes = t => t.split(' ').filter(w => w.length <= 3 || /\d/.test(w)).sort().join(' ');
    if (codes(q) !== codes(core)) return 0;
    // Short names must match exactly — "zinc" must not match "zincovit".
    if (Math.min(qs.length, cs.length) <= (strict ? 5 : 4)) return 0;
    if (Math.abs(qs.length - cs.length) > 0.2 * Math.max(qs.length, cs.length) + (strict ? 0 : 3)) {
      if (strict) return 0;
    }
    let best = sim(qs, cs);
    if (strict) return best;
    // "levosalbutamol" vs "levosalbutamol sulphate": compare against the first word too.
    const qw = q.split(' '), cw = core.split(' ');
    if (cw.length > 1 && qw.length === 1 && cw[0].length >= 6 && !MINERALS.has(cw[0])) best = Math.max(best, sim(qs, cw[0]) - 0.02);
    if (qw.length > 1 && cw.length === 1 && qw[0].length >= 6 && !MINERALS.has(qw[0])) best = Math.max(best, sim(qw[0], cs) - 0.02);
    return best;
  }
  const MATCH_AT = 0.82;

  /* ── Index ──────────────────────────────────────────── */
  function buildIndex(products) {
    const items = [];
    const dict = new Map(); // core → { core, label, count }
    products.forEach((p, i) => {
      const salts = parseComposition(p.composition);
      items.push({ p, i, salts });
      for (const s of salts) {
        const d = dict.get(s.core);
        if (d) d.count++;
        else dict.set(s.core, { core: s.core, label: s.name, count: 1 });
      }
    });
    // Fold spelling variants ("pracetamol", "paracetamole") into the most common spelling,
    // so suggestions and photo reading show one clean name each.
    const all = [...dict.values()].sort((a, b) => b.count - a.count);
    const salts = [];
    for (const s of all) {
      const home = salts.find(c => c.core[0] === s.core[0] && Math.abs(c.core.length - s.core.length) <= 3 &&
        (s.core.startsWith(c.core + ' ') || saltScore(s.core, c.core) >= 0.86));
      if (home) { home.count += s.count; home.variants.push(s.core); }
      else salts.push({ ...s, variants: [] });
    }
    salts.sort((a, b) => b.count - a.count);
    // Brand words: the first word of each product name, for spotting our own products in a photo.
    const brands = new Map();
    const saltWords = new Set(salts.flatMap(s => [s.core, ...s.variants]).filter(c => !c.includes(' ')));
    const addBrand = (w, it) => {
      if (!w || w.length < 4 || !/[a-z]/.test(w) || saltWords.has(w)) return;
      if (!brands.has(w)) brands.set(w, []);
      if (!brands.get(w).includes(it)) brands.get(w).push(it);
    };
    items.forEach(it => {
      const ws = clean(it.p.product).replace(/^lupin['’]?s\s+/, '').split(/[^a-z0-9]+/).filter(Boolean);
      addBrand(ws[0], it);
      // "XONE CEFF" is also printed "XONECEFF": index the joined form too.
      if (ws[0] && ws[1] && ws[0].length <= 5 && /^[a-z]{3,}$/.test(ws[1])) addBrand(ws[0] + ws[1], it);
    });
    // Packs named "XONECEFF - S" belong with "XONE CEFF" for ranking.
    for (const [w, its] of brands) {
      for (const [w2, its2] of brands) if (w2 !== w && w2.replace(/\s/g, '') === w) its2.forEach(it => { if (!its.includes(it)) its.push(it); });
    }
    return { items, salts, brands };
  }

  /* Autocomplete suggestions for a salt box. */
  function suggest(index, typed, limit) {
    const q = alias(clean(typed).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim());
    if (q.length < 2) return [];
    const out = [];
    for (const s of index.salts) {
      let score;
      if (s.core.startsWith(q) || s.label.startsWith(q)) score = 3;
      else if (s.core.includes(q) || s.label.includes(q)) score = 2;
      else if (q.length >= 4) {
        const sc = Math.max(saltScore(q, s.core.slice(0, Math.max(q.length, 5))), saltScore(q, s.core));
        score = sc >= 0.75 ? sc : 0;
      } else score = 0;
      if (score) out.push({ s, score });
    }
    out.sort((a, b) => b.score - a.score || b.s.count - a.s.count);
    return out.slice(0, limit || 8).map(x => x.s);
  }

  /* Parse what someone typed in a strength box: "500", "500mg", "1%". */
  function parseStrengthInput(t) {
    const s = String(t || '').trim();
    if (!s) return null;
    STRENGTH_RE.lastIndex = 0;
    const m = STRENGTH_RE.exec(s);
    if (m) return normStrength(m[1], m[2]);
    const n = parseFloat(s);
    return isNaN(n) ? null : { value: n, unit: 'mg' };
  }
  function sameStrength(a, b) {
    if (!a || !b) return null; // unknown
    if (a.unit !== b.unit && !(a.unit === 'mg' && b.unit === 'mg')) return a.value === b.value;
    return Math.abs(a.value - b.value) < 1e-6;
  }

  /* ── Product search ─────────────────────────────────
     query: [{ text, strength? }]. Returns tiers:
       exact    – same salts, same strengths (where given)
       strength – same salts, a strength differs
       more     – has all these salts plus others
       partial  – has some of these salts                         */
  function findProducts(index, query, opts) {
    opts = opts || {};
    const qs = query
      .map(q => ({
        text: alias(clean(q.text).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()),
        strength: q.strength ? (typeof q.strength === 'string' ? parseStrengthInput(q.strength) : q.strength) : null,
      }))
      .filter(q => q.text.length >= 2)
      .map(q => ({ ...q, core: coreOf(q.text) }));
    const tiers = { exact: [], strength: [], more: [], partial: [] };
    if (!qs.length) return tiers;

    for (const it of index.items) {
      if (opts.company && it.p.company !== opts.company) continue;
      if (!it.salts.length) continue;
      const used = new Set();
      let matched = 0, strengthOk = true, strengthKnown = false, scoreSum = 0;
      const hits = [], pairs = [];
      for (let qi = 0; qi < qs.length; qi++) {
        const q = qs[qi];
        let best = -1, bestScore = 0;
        it.salts.forEach((s, k) => {
          if (used.has(k)) return;
          const sc = Math.max(saltScore(q.core, s.core), saltScore(q.text, s.name));
          if (sc > bestScore) { bestScore = sc; best = k; }
        });
        if (best >= 0 && bestScore >= MATCH_AT) {
          used.add(best);
          matched++;
          scoreSum += bestScore;
          hits.push(best);
          pairs.push([qi, best]);
          if (q.strength) {
            const same = sameStrength(q.strength, it.salts[best].strength);
            if (same !== null) { strengthKnown = true; if (!same) strengthOk = false; }
          }
        }
      }
      if (!matched) continue;
      const row = { item: it, hits, pairs, matched, total: it.salts.length, score: scoreSum / qs.length, strengthKnown };
      if (matched === qs.length && it.salts.length === qs.length) {
        (strengthOk ? tiers.exact : tiers.strength).push(row);
      } else if (matched === qs.length) {
        tiers.more.push(row);
      } else if (matched >= 2) {
        tiers.partial.push(row);
      }
    }
    const byScore = (a, b) => b.matched - a.matched || b.score - a.score || (b.strengthKnown - a.strengthKnown) || a.total - b.total || a.item.p.product.localeCompare(b.item.p.product);
    Object.values(tiers).forEach(t => t.sort(byScore));
    return tiers;
  }

  /* ── Reading salts out of photo text ─────────────────
     OCR text is noisy. Every 1–3 word window is compared with the known salt
     list; close-enough hits are kept, overlapping hits resolved by score. */
  const OCR_STOP = new Set(['tablets', 'tablet', 'capsules', 'capsule', 'contains', 'manufactured', 'marketed', 'excipients', 'composition', 'dosage', 'storage', 'protect', 'children', 'physician', 'prescription', 'directed', 'schedule', 'warning', 'colour', 'coated', 'uncoated', 'equivalent', 'limited', 'pharmaceuticals', 'healthcare', 'india', 'gujarat', 'batch', 'expiry', 'retail', 'price', 'inclusive', 'taxes', 'light', 'moisture', 'temperature', 'store',
    'paediatric', 'pediatric', 'suspension', 'syrup', 'drops', 'oral', 'sterile', 'solution', 'injection', 'adult', 'flavoured',
    'dispersible', 'chewable', 'sugar', 'free', 'shake', 'well', 'before', 'reconstitution', 'reach', 'keep', 'registered', 'trademark']);
  /* Company names on the box are not product brands. */
  const COMPANY_WORDS = new Set(['alkem', 'lupin', 'torque', 'novita', 'ranbaxy', 'shivayur', 'silver', 'cross', 'futura', 'nexx', 'maxxio', 'novokem', 'healthcare', 'cipla', 'pharma', 'laboratories', 'limited', 'sun', 'mankind', 'cadila', 'zydus', 'abbott', 'pfizer', 'glaxo', 'intas', 'macleods', 'alembic', 'torrent', 'micro', 'labs']);

  /* Salts in the list that are really packaging or form words — never reported from a photo. */
  const OCR_JUNK = /^(sodium|potassium|calcium|magnesium|titanium dioxide|sustained release|extended release|enteric coated|film coated|sugar|sucrose|lactose|starch|talc|purified talc|colloidal silicon dioxide|iron oxide|red iron oxide|yellow iron oxide|sunset yellow|tartrazine|brilliant blue|water|alcohol|ethanol|glycerin|sorbitol|methyl paraben|propyl paraben|benzyl alcohol|benzalkonium chloride|flavour|colour|paediatric|pediatric|paediatric drops|suspension|oral suspension|syrupy|flavoured|flavoured syrupy|vitamins|minerals|multivitamins|reconstitute|aqueous|aqueous vehicle|sterile aqueous buffered vehicle|spores|enzyme|enzymes|shampoo|soap noodles|mouth paint|ayurvedic|honey|vaginal|aluminium|energy|preservative|preservatives|propellent|propellant|carbohydrate|carbohydrates|protein|dispersible|disersible|pain oil|elemental zinc|absolute alcohol|propylene glycol|chlorocresol|propylparaben|propyl paraben|methylparaben|sodium propyl paraben|plastic tray.*|pregnancy.*|derived.*|colour.*|.*\bkit\b.*|.*\btest\b.*|.*\bcard\b.*)$/;

  /* Pack-name words that say what kind of product it is. */
  const FORM_OF = {
    tab: 'tab', tabs: 'tab', tablet: 'tab', tablets: 'tab', cap: 'cap', caps: 'cap', capsule: 'cap', capsules: 'cap',
    syrup: 'syrup', syp: 'syrup', suspension: 'syrup', susp: 'syrup', sus: 'syrup', drops: 'drops', drop: 'drops',
    cream: 'cream', ointment: 'oint', oint: 'oint', gel: 'gel', lotion: 'lotion', spray: 'spray', soap: 'soap',
    injection: 'inj', inj: 'inj', infusion: 'inj', vial: 'inj', ampoule: 'inj', gargle: 'gargle', wash: 'wash', powder: 'powder', sachet: 'powder', shampoo: 'shampoo',
  };
  const PACK_WORDS = new Set(['s', 'x', 'ml', 'gm', 'gms', 'mg', 'g', 'with', 'wfi', 'alu', 'box', 'pack', 'strip', 'the', 'of', 'and', 'new', 'iv', 'i', 'v', 'pet', 'glass', 'bottle', 'loose', 'tray']);

  /* Multi-word names a single garbled word may still stand for. */
  const SINGLE_OK = /^(folic acid|clavulanic acid|mefenamic acid|tranexamic acid|ursodeoxycholic acid|salicylic acid|fusidic acid|valproic acid)$/;

  function readSaltsFromText(index, rawText) {
    // Drop colouring/manufacturer lines, and "(as ... pellets)" asides, before reading.
    const lines = String(rawText || '').split(/\n/).map(l => l
      .replace(/\b(colou?rs?|flavou?rs?|excipients?|preservatives?|mfd|manufactured|marketed|mkt)\b.*$/i, ' ')
      .replace(/\(\s*as\b[^)]*\)?/gi, ' ')
      .replace(/(\d)\s*m[9qgs]\b/gi, '$1 mg'));
    const text = alias(clean(lines.join(' \n ')).replace(/[|\\_~`"“”‘’€]/g, ' '));
    const tokens = [];
    const re = /[a-z][a-z0-9\-]*|\d+(?:\.\d+)?/g;
    let m;
    while ((m = re.exec(text))) tokens.push({ w: m[0].replace(/-/g, ''), at: m.index, end: m.index + m[0].length });
    const words = tokens.map(t => t.w);
    const cands = [];
    const saltList = index.salts.filter(s => !OCR_JUNK.test(s.core) && !FORM_WORDS.has(s.core));
    for (let i = 0; i < words.length; i++) {
      if (!/^[a-z]/.test(words[i]) || words[i].length < 4 || OCR_STOP.has(words[i])) continue;
      for (let n = 1; n <= 3 && i + n <= words.length; n++) {
        const span = words.slice(i, i + n);
        if (span.some(w => !/^[a-z]/.test(w))) break;
        const phrase = span.join(' ');
        if (phrase.replace(/ /g, '').length < 5) continue;
        // Only the single best salt for each stretch of text.
        let best = null;
        for (const s of saltList) {
          const sc = Math.max(saltScore(phrase, s.core, true), saltScore(phrase, s.label, true));
          if (sc >= 0.8 && (!best || sc > best.sc || (sc === best.sc && s.count > best.s.count))) best = { i, n, s, sc, phrase };
        }
        if (best) cands.push(best);
        else if (n === 1 && phrase.length >= 7) {
          // Thin or condensed print often loses letters ("Aathromycn"). Compare letter order
          // instead; accept only a clear winner, and mark it as a guess.
          let b1 = null, b2 = 0;
          for (const s of saltList) {
            const w = s.core.split(' ')[0];
            if (w.length < 7 || s.core.includes(' ') && !SINGLE_OK.test(s.core)) continue;
            const r = Math.min(w.length, phrase.length) / Math.max(w.length, phrase.length);
            if (r < 0.64) continue;
            const sc = looseScore(phrase, w);
            if (!b1 || sc > b1.sc) { if (b1) b2 = Math.max(b2, b1.sc); b1 = { i, n, s, sc: sc, phrase, loose: true }; }
            else if (sc > b2) b2 = sc;
          }
          if (b1 && b1.sc >= 0.78 && b1.sc - b2 >= 0.05) { b1.sc = Math.min(b1.sc, 0.79); cands.push(b1); }
        }
      }
    }
    // Keep best non-overlapping hits; prefer higher score, then longer spans.
    cands.sort((a, b) => b.sc - a.sc || b.n - a.n || b.s.count - a.s.count);
    const taken = new Array(words.length).fill(false);
    const out = [];
    const byCore = new Map();
    for (const c of cands) {
      let free = true;
      for (let k = c.i; k < c.i + c.n; k++) if (taken[k]) { free = false; break; }
      if (!free) continue;
      for (let k = c.i; k < c.i + c.n; k++) taken[k] = true;
      // Strength: the first amount within the next few words, unless another name sits in between.
      const after = text.slice(tokens[c.i + c.n - 1].end, tokens[c.i + c.n - 1].end + 34);
      STRENGTH_RE.lastIndex = 0;
      const sm = STRENGTH_RE.exec(after);
      const gap = sm ? after.slice(0, sm.index).replace(/\b(ip|i p|bp|usp|ep|eq|equivalent|to|hydrochloride|dihydrochloride|hydrobromide|sodium|potassium|sulphate|maleate|anhydrous|trihydrate|monohydrate)\b/g, '') : '';
      const st = sm && !/[a-z]{4,}/.test(gap) ? normStrength(sm[1], sm[2]) : null;
      // Same salt read twice ("Montelukast Sodium eq. to Montelukast 10 mg"): keep one, keep the strength.
      const key = c.s.core;
      const prev = byCore.get(key) || out.find(o => o.core.split(' ')[0] === key.split(' ')[0] && key.split(' ')[0].length >= 6);
      if (prev) { if (!prev.strength && st) prev.strength = st; continue; }
      const row = { core: c.s.core, label: c.s.label, read: c.phrase, score: c.sc, sure: !c.loose, strength: st, pos: tokens[c.i].at };
      byCore.set(key, row);
      out.push(row);
    }
    out.sort((a, b) => a.pos - b.pos);
    // Our own brands seen in the photo; the other words and numbers on the box pick the pack.
    const brandHits = [];
    const seenBrand = new Set();
    const wordSet = new Set([...words, ...text.split(/[^a-z0-9]+/).filter(Boolean)]);
    const boxForms = new Set([...wordSet].map(t => FORM_OF[t]).filter(Boolean));
    for (const w of wordSet) {
      if (w.length < 4 || OCR_STOP.has(w) || COMPANY_WORDS.has(w)) continue;
      for (const [b, its] of index.brands) {
        if (seenBrand.has(b) || COMPANY_WORDS.has(b)) continue;
        if (Math.min(w.length, b.length) < 6) { if (w !== b) continue; }
        else if (sim(w, b) < 0.86) continue;
        seenBrand.add(b);
        // Score every pack of this brand on what else the box shows.
        const near = new RegExp(b.split('').join('[\\s\\-]?') + "[\\s\\-'’®]*([a-z0-9]{1,4})\\b", 'g');
        const after = new Set(); let mm;
        while ((mm = near.exec(text))) after.add(mm[1]);
        const scores = its.map(it => {
          const rest = clean(it.p.product).split(/[^a-z0-9]+/).filter(t => t && t !== b && !(t.length >= 3 && b.includes(t)));
          let sc = 0, miss = 0;
          for (const t of rest) {
            // One- and two-letter variants (CANAZOLE-B, OFLUP-O) only count right after the brand,
            // because stray single letters are everywhere in photo text.
            const seen = t.length <= 2 && /^[a-z]+$/.test(t) ? after.has(t) : wordSet.has(t);
            if (seen) sc += /^\d{1,2}$/.test(t) ? 0.5 : /\d/.test(t) ? 2 : 1;
            else {
              const num = t.match(/^(\d+)(mg|ml|g|gm|gms)$/);
              if (num && wordSet.has(num[1])) sc += 2;
              else if (/^[a-z]{1,5}$/.test(t) && !PACK_WORDS.has(t) && !FORM_OF[t]) miss++;
            }
          }
          // Dosage form: cream vs lotion vs tablets is decisive.
          const pf = new Set(rest.map(t => FORM_OF[t]).filter(Boolean));
          if (pf.size && boxForms.size) sc += [...pf].some(f => boxForms.has(f)) ? 1.5 : -2;
          return { it, sc: sc - 0.75 * miss };
        });
        brandHits.push({ brand: b, exact: w === b, scores });
      }
    }
    return { salts: out, brands: brandHits };
  }

  function saltAgrees(a, b) {
    if (a === b || saltScore(a, b) >= MATCH_AT) return true;
    const wa = a.split(' '), wb = b.split(' ');
    return wa.some(w => w.length >= 5 && wb.includes(w));
  }

  /* What to search for after reading a photo. The brand's own composition wins when a brand
     was recognised and nothing read from the box contradicts it; otherwise the salts read. */
  function photoQuery(found) {
    const brand = found.brands[0];
    const salts = found.salts;
    if (brand && brand.best.salts.length) {
      const agree = salts.filter(s => brand.best.salts.some(b => saltAgrees(s.core, b.core))).length;
      if (!salts.length || agree >= Math.max(1, salts.length - 1)) return { from: 'brand', salts: brand.best.salts, brand };
    }
    if (salts.length) return { from: 'photo', salts };
    return null;
  }

  /* Pick the pack: what the box shows, plus agreement with the salts that were read. */
  function rankBrand(brand, scoreLists, salts) {
    const sum = new Map();
    for (const list of scoreLists) for (const x of list) {
      const p = sum.get(x.it);
      sum.set(x.it, (p == null ? 0 : p) + x.sc);
    }
    const n = scoreLists.length || 1;
    const sure = salts.filter(s => s.sure);
    const ranked = [...sum].map(([it, sc]) => {
      let bonus = 0;
      for (const s of sure) bonus += it.salts.some(x => saltAgrees(s.core, x.core)) ? 1.5 : -1;
      if (sure.length) for (const x of it.salts) if (!sure.some(s => saltAgrees(s.core, x.core))) bonus -= 1;
      return { it, sc: sc / n + bonus };
    }).sort((a, b) => b.sc - a.sc || a.it.p.product.length - b.it.p.product.length);
    // Short brand words ("cold", "cach") turn up by chance; trust them only with a matching pack detail.
    const need = brand.length >= 6 ? 0 : brand.length === 5 ? 1 : 2;
    if (!ranked.length || ranked[0].sc < need) return null;
    return { brand, items: ranked.map(x => x.it), best: ranked[0].it, fit: ranked[0].sc };
  }


  /* Combine several reads of the same photo. A loose guess must turn up in two reads to stay;
     a salt that is just part of another one read alongside it is dropped. */
  const SHARED_OK = new Set(['chloride', 'hydroxide', 'carbonate', 'oxide', 'acid', 'oil', 'extract', 'phosphate', 'citrate', 'sulphate', 'acetate', 'gluconate', 'lactate', 'vitamin', 'calcium', 'magnesium', 'sodium', 'potassium', 'zinc', 'ferrous']);
  function mergeReads(reads, index) {
    const byCore = new Map(), brandLists = new Map(), exact = new Map();
    for (const r of reads) {
      for (const s of r.salts) {
        const p = byCore.get(s.core);
        if (!p) byCore.set(s.core, { ...s, seen: 1 });
        else {
          p.seen++;
          if (s.score > p.score) { p.score = s.score; p.read = s.read; }
          p.sure = p.sure || s.sure;
          if (!p.strength && s.strength) p.strength = s.strength;
        }
      }
      for (const b of r.brands) {
        if (!brandLists.has(b.brand)) brandLists.set(b.brand, []);
        brandLists.get(b.brand).push(b.scores);
        exact.set(b.brand, exact.get(b.brand) || b.exact);
      }
    }
    let salts = [...byCore.values()].filter(s => s.sure || s.seen >= 2).map(s => ({ ...s, sure: true }));
    const count = c => { const d = index && index.salts.find(x => x.core === c); return d ? d.count : 0; };
    salts = salts.filter(s => !salts.some(o => o !== s &&
      o.core.split(' ').some(w => w.length >= 6 && !SHARED_OK.has(w) && s.core.split(' ').includes(w)) &&
      (count(o.core) > count(s.core) || (count(o.core) === count(s.core) && o.core < s.core))));
    salts = salts.filter(s => !salts.some(o => o !== s && o.core.length > s.core.length + 1 && !o.core.includes(' ') && o.core.endsWith(s.core)));
    salts.sort((a, b) => a.pos - b.pos);
    const brands = [...brandLists].map(([b, lists]) => {
      const r = rankBrand(b, lists, salts);
      return r && { ...r, exact: exact.get(b), seen: lists.length };
    }).filter(Boolean).sort((a, b) => b.exact - a.exact || b.seen - a.seen || b.fit - a.fit).slice(0, 3);
    return { salts, brands };
  }

  const api = { photoQuery, saltAgrees, mergeReads, parseComposition, buildIndex, suggest, findProducts, readSaltsFromText, parseStrengthInput, strengthText, saltScore, coreOf, cleanName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SaltMatcher = api;
})(typeof window !== 'undefined' ? window : globalThis);
