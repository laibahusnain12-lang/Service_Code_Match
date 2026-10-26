const fs = require('fs');
const vm = require('vm');
const path = require('path');
const workerPath = path.join(__dirname, '..', 'matcher-worker.js');
const workerCode = fs.readFileSync(workerPath, 'utf8');

function runWorker(payload) {
  return new Promise((resolve, reject) => {
    const context = { setTimeout, clearTimeout, Uint16Array, Map, Set, Math, JSON, String, Number, Object, Array, Date, Intl, RegExp, Promise, AbortController, fetch: async () => { throw new Error('no fetch'); } };
    context.self = context;
    context.postMessage = (message) => {
      if (message.type === 'done') resolve(message);
      if (message.type === 'error') reject(new Error(message.error));
    };
    vm.createContext(context);
    vm.runInContext(workerCode, context, { filename: 'matcher-worker.js' });
    context.onmessage({ data: payload });
  });
}

(async () => {
  // Exact contrast-specific CT match should be exact and auto-approved eligible.
  const exact = await runWorker({
    type: 'MATCH',
    masterRecords: [
      { code: 'CT001', display: 'CT Chest with contrast', standard: 'Computed Tomography Chest With Contrast', group: 'Radiology', subgroup: 'CT', status: 'Active' }
    ],
    sourceRows: [{ rawName: 'CT Chest with contrast', standardizedName: '', existingCode: '' }],
    thresholds: { high: 95, review: 80 }
  });
  const r0 = exact.results[0];
  console.log('Exact decision:', r0['Decision'], '| Critical:', r0['Critical Differences']);
  if (r0['Decision'] !== 'Exact match') throw new Error('Expected exact match decision');
  if (r0['Critical Differences'] !== '') throw new Error('Expected no critical differences for exact match');

  // Contrast conflict must block auto-approval.
  const conflict = await runWorker({
    type: 'MATCH',
    masterRecords: [
      { code: 'CT002', display: 'CT Chest without contrast', standard: 'Computed Tomography Chest Without Contrast', group: 'Radiology', subgroup: 'CT', status: 'Active' }
    ],
    sourceRows: [{ rawName: 'CT Chest with contrast', standardizedName: '', existingCode: '' }],
    thresholds: { high: 95, review: 80 }
  });
  const r1 = conflict.results[0];
  console.log('Conflict decision:', r1['Decision'], '| Critical:', r1['Critical Differences']);
  if (r1['Decision'] !== 'Manual review') throw new Error('Expected manual review for contrast conflict');
  if (!String(r1['Critical Differences']).toLowerCase().includes('contrast')) throw new Error('Expected contrast critical difference');

  // Lab specimen/method conflict.
  const lab = await runWorker({
    type: 'MATCH',
    masterRecords: [
      { code: 'LAB001', display: 'Urine culture', standard: 'Urine Culture', group: 'Laboratory', subgroup: 'Microbiology', status: 'Active' }
    ],
    sourceRows: [{ rawName: 'Blood culture', standardizedName: '', existingCode: '' }],
    thresholds: { high: 95, review: 80 }
  });
  const r2 = lab.results[0];
  console.log('Lab decision:', r2['Decision'], '| Critical:', r2['Critical Differences'], '| Missing:', r2['Missing Attributes']);
  if (r2['Decision'] !== 'Manual review') throw new Error('Expected manual review for lab specimen conflict');
  if (!String(r2['Critical Differences']).toLowerCase().includes('specimen')) throw new Error('Expected specimen critical difference');

  // Missing attributes should require review when one side lacks a clinical attribute.
  const missingCase = await runWorker({
    type: 'MATCH',
    masterRecords: [
      { code: 'CT003', display: 'CT chest with contrast', standard: 'Computed Tomography Chest With Contrast', group: 'Radiology', subgroup: 'CT', status: 'Active' }
    ],
    sourceRows: [{ rawName: 'CT scan', standardizedName: '', existingCode: '' }],
    thresholds: { high: 95, review: 80 }
  });
  const r3 = missingCase.results[0];
  console.log('Missing-case missing:', r3['Missing Attributes']);
  if (!r3['Missing Attributes']) throw new Error('Expected missing attributes when clinical details are absent');

  // New fields present.
  for (const field of ['Original Service Name','Input Clinical Attributes','Clinical Equivalence Explanation','Decision','Decision Reason','Clinical AI/Model Version']) {
    if (!(field in r0)) throw new Error('Missing new field: ' + field);
  }
  console.log('PASS: clinical intelligence fields and conflict handling.');
})().catch((error) => { console.error('FAIL:', error.message); process.exit(1); });