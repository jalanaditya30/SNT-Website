// Run with: node --test "salt-finder/tests/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const M = require('../matcher.js');

const src = fs.readFileSync(path.join(__dirname, '../../data.js'), 'utf8');
const D = new Function(src + '; return CATALOGUE_DATA;')();
const idx = M.buildIndex(D);
const read = (...texts) => M.mergeReads(texts.map(t => M.readSaltsFromText(idx, t)), idx);
const cores = salts => salts.map(s => s.core).sort();

test('compositions split into salts with strengths', () => {
  const s = M.parseComposition('Aceclofenac IP 100 mg + Paracetamol IP 325 mg + Chlorzoxazone USP 250 mg');
  assert.deepStrictEqual(s.map(x => x.core), ['aceclofenac', 'paracetamol', 'chlorzoxazone']);
  assert.strictEqual(s[0].strength.value, 100);
  const e = M.parseComposition('Levofloxacin Hemihydrate IP Eq. to Levofloxacin 500 mg Excipients q.s.');
  assert.deepStrictEqual(e.map(x => x.core), ['levofloxacin']);
});

test('spelling variants count as the same salt', () => {
  for (const [a, b] of [['montelucast', 'montelukast'], ['amoxycillin', 'amoxicillin'], ['pracetamol', 'paracetamol']])
    assert.ok(M.saltScore(M.coreOf(M.cleanName(a)), M.coreOf(M.cleanName(b))) >= 0.82, a + ' vs ' + b);
  for (const v of ['potassium clavulanate', 'clavulanate potassium', 'calvulanate potassium', 'potassium clavunate'])
    assert.strictEqual(M.coreOf(v), 'clavulanic acid', v);
});

test('vitamin codes never cross', () => {
  assert.strictEqual(M.saltScore('vitamin b12', 'vitamin b2'), 0);
  assert.strictEqual(M.saltScore('vitamin d3', 'vitamin b3'), 0);
});

test('salt search tiers', () => {
  const r = M.findProducts(idx, [{ text: 'aceclofenac', strength: '100' }, { text: 'paracetamol', strength: '325' }]);
  assert.ok(r.exact.length > 0);
  assert.ok(r.exact.every(x => x.item.salts.length === 2));
});

test('a garbled thin-font box is recognised by its brand (Azento XL 100)', () => {
  const m = read("Rs | 4\nSu zitomyci Cg y\nEE SUspension P\nwo | AZENTO'XL\na | Suspension 100\nF For Paediatric Use od\n30ml",
    'b Aaitvomycn Ord\nALKEM\n| AZENTO-XL |\n| Suspension 100 h');
  const q = M.photoQuery(m);
  assert.strictEqual(q.from, 'brand');
  assert.strictEqual(m.brands[0].best.p.product, 'AZENTO XL 100MG SUSPENSION (30ML)');
  assert.ok(!m.salts.some(s => /paediatric/.test(s.core)));
});

test('a clear composition panel is read', () => {
  const m = read('ACECLOGEN-P\nEach film coated tablet contains:\nAceclofenac IP 100 mg\nParacetamol IP 325 mg\nExcipients q.s.\nColour: Titanium Dioxide IP');
  assert.deepStrictEqual(cores(m.salts), ['aceclofenac', 'paracetamol']);
  const mo = read('Montelukast Sodium IP\neq. to Montelukast 10 mg\nLevocetirizine Dihydrochloride IP 5 mg');
  assert.deepStrictEqual(cores(mo.salts), ['levocetirizine', 'montelukast']);
  assert.strictEqual(mo.salts.find(s => s.core === 'montelukast').strength.value, 10);
});

test('company names, generic words and salt names are not brands', () => {
  const m = read('ALKEM\nFor Paediatric Use\nDexamethasone Injection');
  assert.ok(!m.brands.some(b => /ALKEM PARA|DEXAMETHASONE INJECTION/.test(b.best.p.product)));
});
