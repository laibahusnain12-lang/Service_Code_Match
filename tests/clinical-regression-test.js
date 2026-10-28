const fs = require('fs');
const path = require('path');
const vm = require('vm');
const clinicalCode = fs.readFileSync(path.join(__dirname, '..', 'clinical-interpreter.js'), 'utf8');
const workerCode = fs.readFileSync(path.join(__dirname, '..', 'matcher-worker.js'), 'utf8');
const combined = clinicalCode + '\n' + workerCode;

function run(payload) {
  return new Promise((resolve, reject) => {
    const ctx = { setTimeout, clearTimeout, Uint16Array, Map, Set, Math, JSON, String, Number, Object, Array, Date, Intl, RegExp, Promise, AbortController, fetch: async () => { throw new Error('no fetch'); } };
    ctx.self = ctx;
    ctx.postMessage = (m) => { if (m.type === 'done') resolve(m); if (m.type === 'error') reject(new Error(m.error)); };
    vm.createContext(ctx);
    vm.runInContext(combined, ctx, { filename: 'matcher-worker.js' });
    ctx.onmessage({ data: payload });
  });
}

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } }

(async () => {
  // Laser therapy should not be auto-approved against wax therapy.
  const laserVsWax = await run({
    type: 'MATCH',
    masterRecords: [{ code: 'WAX001', display: 'Wax therapy', standard: 'Wax Therapy', group: 'Therapy', subgroup: 'Wax', status: 'Active' }],
    sourceRows: [{ rawName: 'Laser therapy', standardizedName: '', existingCode: '' }],
    thresholds: { high: 95, review: 80 }
  });
  const r0 = laserVsWax.results[0];
  console.log('Laser vs wax:', r0['Decision'], '|', r0['Critical Differences']);
  assert(r0['Decision'] !== 'VERIFIED_CANDIDATE', 'Laser therapy must not be auto-approved against wax therapy');

  // Exact clinical synonym/normalization remains matchable.
  const exact = await run({
    type: 'MATCH',
    masterRecords: [{ code: 'CT001', display: 'CT Chest with contrast', standard: 'Computed Tomography Chest With Contrast', group: 'Radiology', subgroup: 'CT', status: 'Active' }],
    sourceRows: [{ rawName: 'CT Chest with contrast', standardizedName: '', existingCode: '' }],
    thresholds: { high: 95, review: 80 }
  });
  const r1 = exact.results[0];
  console.log('Exact:', r1['Decision']);
  assert(r1['Decision'] === 'VERIFIED_CANDIDATE', 'Exact match should be verified');

  // Ambiguous candidates are not auto-approved.
  const ambiguous = await run({
    type: 'MATCH',
    masterRecords: [
      { code: 'C004', display: 'Conflicted Service', standard: 'Conflicted Service', group: 'Group A', subgroup: 'Sub A', status: 'Active' },
      { code: 'C005', display: 'Conflicted Service', standard: 'Conflicted Service', group: 'Group B', subgroup: 'Sub B', status: 'Active' }
    ],
    sourceRows: [{ rawName: 'Conflicted Service', standardizedName: '', existingCode: '' }],
    thresholds: { high: 95, review: 80 }
  });
  const r2 = ambiguous.results[0];
  console.log('Ambiguous:', r2['Decision'], '|', r2['Auto Candidate Service Code']);
  assert(r2['Decision'] !== 'VERIFIED_CANDIDATE', 'Ambiguous candidate must not be auto-approved');
  assert(!r2['Auto Match Status / Review Required'].includes('AUTO-APPROVED'), 'Ambiguous candidate must not be auto-approved status');

  console.log('PASS: clinical regression tests');
})().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
