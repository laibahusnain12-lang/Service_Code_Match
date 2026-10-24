const fs = require('fs');
const vm = require('vm');
const path = require('path');
const workerPath = path.join(__dirname, '..', 'matcher-worker.js');
const workerCode = fs.readFileSync(workerPath, 'utf8');

function runWorker(payload) {
  return new Promise((resolve, reject) => {
    const context = { setTimeout, Uint16Array, Map, Set, Math, JSON, String, Number, Object, Array, Date, Intl, RegExp, Promise };
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

function getReviewRows(rows) {
  const context = { setTimeout, Uint16Array, Map, Set, Math, JSON, String, Number, Object, Array, Date, Intl, RegExp, Promise };
  context.self = context;
  context.postMessage = () => {};
  vm.createContext(context);
  vm.runInContext(workerCode, context, { filename: 'matcher-worker.js' });
  return vm.runInContext(`collectReviewRows(${JSON.stringify(rows)})`, context);
}

function getReadyRows(rows) {
  const context = { setTimeout, Uint16Array, Map, Set, Math, JSON, String, Number, Object, Array, Date, Intl, RegExp, Promise };
  context.self = context;
  context.postMessage = () => {};
  vm.createContext(context);
  vm.runInContext(workerCode, context, { filename: 'matcher-worker.js' });
  return vm.runInContext(`collectReadyRows(${JSON.stringify(rows)})`, context);
}

(async () => {
  const result = await runWorker({
    type: 'MATCH',
    masterRecords: [
      { code: 'C001', display: 'General Consultation', standard: 'Consultation General', group: 'Consultation', subgroup: 'General', status: 'Active' },
      { code: 'C002', display: 'Chest X Ray', standard: 'X-ray chest', group: 'Radiology', subgroup: 'X-Ray', status: 'Active' },
      { code: 'C003', display: 'Electrocardiogram', standard: 'Electrocardiogram tracing', group: 'Cardiology', subgroup: 'Diagnostic', status: 'Active' },
      { code: 'C004', display: 'Conflicted Service', standard: 'Conflicted Service', group: 'Group A', subgroup: 'Sub A', status: 'Active' },
      { code: 'C005', display: 'Conflicted Service', standard: 'Conflicted Service', group: 'Group B', subgroup: 'Sub B', status: 'Active' }
    ],
    historicalMappings: [
      { sourceName: 'Cardiac tracing', code: 'C003', display: 'Electrocardiogram', standard: 'Electrocardiogram tracing', group: 'Cardiology', subgroup: 'Diagnostic' },
      { sourceName: 'Legacy ambiguous test', code: 'C004', display: 'Conflicted Service', group: 'Group A' },
      { sourceName: 'Legacy ambiguous test', code: 'C005', display: 'Conflicted Service', group: 'Group B' }
    ],
    sourceRows: [
      { rawName: 'General Consultation', standardizedName: '', existingCode: 'C001' },
      { rawName: 'General Consult', standardizedName: '', existingCode: '' },
      { rawName: 'ECG', standardizedName: '', existingCode: '' },
      { rawName: 'General Consultation', standardizedName: '', existingCode: 'OTHER' },
      { rawName: 'Cardiac tracing', standardizedName: '', existingCode: '' },
      { rawName: 'Legacy ambiguous test', standardizedName: '', existingCode: '' },
      { rawName: 'Conflicted Service', standardizedName: '', existingCode: 'C004' },
      { rawName: 'General Consulttion', standardizedName: '', existingCode: '' },
      { rawName: '', standardizedName: '', existingCode: '' }
    ],
    thresholds: { high: 95, review: 80 }
  });
  const rows = result.results;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  assert(rows.length === 9, 'Expected nine processed test rows');
  assert(rows[0]['Auto Candidate Service Code'] === 'C001', 'Exact code should be assigned');
  assert(rows[0]['Auto Existing Code Check'] === 'Existing South code agrees with candidate', 'Existing-code comparison should be reported');
  assert(rows[1]['Auto Candidate Service Code'] === 'C001', 'A fuzzy candidate should be returned for the misspelled/truncated name');
  assert(rows[1]['Auto Match Status / Review Required'].startsWith('FUZZY CANDIDATE'), 'A truncated service name should remain in manual review');
  assert(rows[2]['Auto Candidate Service Code'] === 'C003', 'A recognized medical abbreviation should find its catalogue term');
  assert(rows[2]['Auto Match Status / Review Required'].startsWith('MEDICAL TERM VARIANT'), 'A medical abbreviation match must require review');
  assert(rows[3]['Auto Match Status / Review Required'].includes('EXISTING CODE DISAGREEMENT'), 'A candidate that differs from the existing code must require review');
  assert(rows[4]['Auto Candidate Service Code'] === 'C003', 'A unique historical service mapping should return its prior code');
  assert(rows[4]['Auto Match Status / Review Required'].startsWith('HISTORICAL MAPPING'), 'Historical mappings must remain review-required');
  assert(rows[5]['Auto Candidate Service Code'] === '', 'Conflicting historical mappings must not auto-assign a code');
  assert(rows[5]['Auto Match Status / Review Required'].startsWith('AMBIGUOUS HISTORICAL MAPPING'), 'Conflicting historical mappings must remain ambiguous');
  assert(rows[6]['Auto Candidate Service Code'] === '', 'Ambiguous exact matches must not auto-assign a code');
  assert(rows[6]['Auto Match Status / Review Required'].startsWith('AMBIGUOUS'), 'Ambiguous row should be flagged');
  assert(rows[7]['Auto Match Status / Review Required'].startsWith('HIGH-CONFIDENCE FUZZY CANDIDATE'), 'High-confidence fuzzy row should be treated as ready');
  assert(rows[8]['Auto Match Status / Review Required'].startsWith('BLANK SERVICE NAME'), 'Blank names must be flagged');
  const reviewRows = getReviewRows(rows);
  const readyRows = getReadyRows(rows);
  assert(reviewRows.length === 7, 'Expected truncated, medical variant, historical, disagreement, ambiguous, and blank rows flagged for manual review');
  assert(readyRows.length === 2, 'Expected only non-conflicting exact and typo-level fuzzy rows to stay out of review');
  console.log('PASS: exact match, fuzzy candidate, existing-code comparison, ambiguous code protection, blank-name handling.');
  console.log(`PASS: ${result.stats.total} sample rows processed; ${result.stats.candidateCodes} candidate codes assigned; ${readyRows.length} ready rows; ${reviewRows.length} review rows identified.`);
})().catch((error) => { console.error('FAIL:', error.message); process.exit(1); });
