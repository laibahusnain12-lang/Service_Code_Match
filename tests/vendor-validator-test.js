const fs = require('fs');
const path = require('path');
const vv = require(path.join(__dirname, '..', 'vendor-validator.js'));
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vendor-reference.json'), 'utf8'));

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } }

const r1 = vv.validate('Ibnsina', ref);
assert(r1.status === 'verified_match' && r1.canonical === 'Ibnsina', 'Ibnsina exact');

const r2 = vv.validate('Ibnesina', ref);
assert(r2.status === 'likely_misspelling' && r2.suggestedCanonical === 'Ibnsina', 'Ibnesina flagged');

const r3 = vv.validate('IBN SINA', ref);
assert(r3.status === 'alias_match' && r3.canonical === 'Ibnsina', 'IBN SINA alias');

const r4 = vv.validate('Completely Unknown Vendor', ref);
assert(r4.status === 'not_in_directory' && r4.original === 'Completely Unknown Vendor', 'unknown retained');

const r5 = vv.validate('ibnsina', ref);
assert(r5.status === 'verified_match', 'case normalization');

console.log('PASS: vendor validation tests');