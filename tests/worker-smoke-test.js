const fs = require('fs');
const vm = require('vm');
const path = require('path');
const workerPath = path.join(__dirname, '..', 'matcher-worker.js');
const workerCode = fs.readFileSync(workerPath, 'utf8');

function runWorker(payload, fetchImpl, messages = []) {
  return new Promise((resolve, reject) => {
    const context = { setTimeout, clearTimeout, Uint16Array, Map, Set, Math, JSON, String, Number, Object, Array, Date, Intl, RegExp, Promise, AbortController, fetch: fetchImpl };
    context.self = context;
    context.postMessage = (message) => {
      messages.push(message);
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

(async () => {
  const result = await runWorker({
    type: 'MATCH',
    masterRecords: [
      { code: 'C001', display: 'General Consultation', standard: 'Consultation General', group: 'Consultation', subgroup: 'General', status: 'Active' },
      { code: 'C002', display: 'Chest X Ray', standard: 'X-ray chest', group: 'Radiology', subgroup: 'X-Ray', status: 'Active' },
      { code: 'C003', display: 'Electrocardiogram', standard: 'Electrocardiogram tracing', group: 'Cardiology', subgroup: 'Diagnostic', status: 'Active' },
      { code: 'C004', display: 'Conflicted Service', standard: 'Conflicted Service', group: 'Group A', subgroup: 'Sub A', status: 'Active' },
      { code: 'C005', display: 'Conflicted Service', standard: 'Conflicted Service', group: 'Group B', subgroup: 'Sub B', status: 'Active' },
      { code: 'C006', display: 'Conflicted Category', standard: 'Conflicted Category', group: 'Group A', subgroup: 'Sub A', status: 'Active' },
      { code: 'C006', display: 'Conflicted Category', standard: 'Conflicted Category', group: 'Group B', subgroup: 'Sub A', status: 'Active' }
    ],
    historicalMappings: [
      { sourceName: 'Cardiac tracing', code: 'C003', display: 'Electrocardiogram', standard: 'Electrocardiogram tracing', group: 'Cardiology', subgroup: 'Diagnostic' },
      { sourceName: 'Legacy ambiguous test', code: 'C004', display: 'Conflicted Service', group: 'Group A' },
      { sourceName: 'Legacy ambiguous test', code: 'C005', display: 'Conflicted Service', group: 'Group B' }
    ],
    approvedMappings: [
      { sourceName: 'Approved cardiac service', code: 'C003', group: 'Cardiology', subgroup: 'Diagnostic' }
    ],
    sourceRows: [
      { rawName: 'General Consultation', standardizedName: '', existingCode: 'C001' },
      { rawName: 'General Consult', standardizedName: '', existingCode: '' },
      { rawName: 'ECG', standardizedName: '', existingCode: '' },
      { rawName: 'General Consultation', standardizedName: '', existingCode: 'OTHER' },
      { rawName: 'Cardiac tracing', standardizedName: '', existingCode: '' },
      { rawName: 'Legacy ambiguous test', standardizedName: '', existingCode: '' },
      { rawName: 'Approved cardiac service', standardizedName: '', existingCode: '', sourceGroup: 'Cardiology', sourceSubgroup: 'Diagnostic' },
      { rawName: 'Approved cardiac service', standardizedName: '', existingCode: '', sourceGroup: 'Radiology', sourceSubgroup: 'X-Ray' },
      { rawName: 'Conflicted Service', standardizedName: '', existingCode: 'C004' },
      { rawName: 'General Consulttion', standardizedName: '', existingCode: '' },
      { rawName: '', standardizedName: '', existingCode: '' },
      { rawName: 'Conflicted Category', standardizedName: '', existingCode: '' }
    ],
    thresholds: { high: 95, review: 80 }
  });
  const rows = result.results;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  assert(rows.length === 12, 'Expected twelve processed test rows');
  assert(rows[0]['Auto Candidate Service Code'] === 'C001', 'Exact code should be assigned');
  assert(rows[0]['Auto Existing Code Check'] === 'Existing South code agrees with candidate', 'Existing-code comparison should be reported');
  assert(rows[0]['AI Recommendation'] === 'Auto-approved — exact unique match', 'Conflict-free 100% exact matches should be auto-approved');
  assert(rows[0]['Reviewer Decision'] === 'Auto-Approved (100% exact)', 'Exact auto-approval should be recorded distinctly from human approval');
  assert(rows[0]['Approved Service Code'] === 'C001', 'The exact unique candidate code should be recorded as approved');
  assert(rows[1]['Auto Candidate Service Code'] === 'C001', 'A fuzzy candidate should be returned for the misspelled/truncated name');
  assert(rows[1]['Auto Match Status / Review Required'].startsWith('FUZZY CANDIDATE'), 'A truncated service name should remain in manual review');
  assert(rows[2]['Auto Candidate Service Code'] === 'C003', 'A recognized medical abbreviation should find its catalogue term');
  assert(rows[2]['Auto Match Status / Review Required'].startsWith('MEDICAL TERM VARIANT'), 'A medical abbreviation match must require review');
  assert(rows[2]['Reviewer Decision'] === 'Pending', 'A 100% medical alias score must not count as an exact normalized match');
  assert(rows[3]['Auto Match Status / Review Required'].includes('EXISTING CODE DISAGREEMENT'), 'A candidate that differs from the existing code must require review');
  assert(rows[3]['AI Recommendation'] === 'Review carefully', 'Existing-code disagreements must be prioritized for careful review');
  assert(rows[3]['Reviewer Decision'] === 'Pending', 'Existing-code disagreements must not be auto-approved');
  assert(rows[4]['Auto Candidate Service Code'] === 'C003', 'A unique historical service mapping should return its prior code');
  assert(rows[4]['Auto Match Status / Review Required'].startsWith('HISTORICAL MAPPING'), 'Historical mappings must remain review-required');
  assert(rows[5]['Auto Candidate Service Code'] === '', 'Conflicting historical mappings must not auto-assign a code');
  assert(rows[5]['Auto Match Status / Review Required'].startsWith('AMBIGUOUS HISTORICAL MAPPING'), 'Conflicting historical mappings must remain ambiguous');
  assert(rows[6]['Auto Candidate Service Code'] === 'C003', 'A reviewer-approved mapping should be reused in the same category');
  assert(rows[6]['Auto Match Status / Review Required'].startsWith('REVIEWER MAPPING SUGGESTION'), 'A reviewer-approved mapping should remain a row-level suggestion');
  assert(rows[6]['Reviewer Decision'] === 'Pending', 'A prior approval should not auto-approve a new vendor row');
  assert(rows[7]['Auto Candidate Service Code'] === '', 'A reviewer-approved mapping must not cross into another category');
  assert(rows[8]['Auto Candidate Service Code'] === '', 'Ambiguous exact matches must not auto-assign a code');
  assert(rows[8]['Auto Match Status / Review Required'].startsWith('AMBIGUOUS'), 'Ambiguous row should be flagged');
  assert(rows[8]['Reviewer Decision'] === 'Pending', 'Ambiguous exact matches must remain pending');
  assert(rows[9]['Auto Match Status / Review Required'].startsWith('HIGH-CONFIDENCE FUZZY CANDIDATE'), 'High-confidence fuzzy row should be treated as ready');
  assert(rows[10]['Auto Match Status / Review Required'].startsWith('BLANK SERVICE NAME'), 'Blank names must be flagged');
  assert(rows[11]['Auto Match Score'] === 100, 'Category conflict boundary should use a 100% exact name score');
  assert(rows[11]['Reviewer Decision'] === 'Pending', 'A 100% exact match with a category conflict must remain pending');
  const reviewRows = getReviewRows(rows);
  assert(reviewRows.length === rows.length - 1, 'Only the safe exact unique match should be excluded from manual review');
  const rerankMessages = [];
  let ollamaCalls = 0;
  let modelSelectedCode = '';
  const reranked = await runWorker({
    type: 'MATCH',
    masterRecords: [
      { code: 'RAD001', display: 'Chest X Ray', standard: 'Chest Radiograph', group: 'Radiology', subgroup: 'X-Ray', status: 'Active' },
      { code: 'RAD002', display: 'Chest CT Scan', standard: 'Chest Computed Tomography', group: 'Radiology', subgroup: 'CT', status: 'Active' }
    ],
    sourceRows: [{ rawName: 'Chest imaging', standardizedName: '', existingCode: '' }],
    thresholds: { high: 95, review: 80 },
    localAi: { enabled: true, endpoint: 'http://localhost:11434', model: 'test-model', maxNames: 10 }
  }, async (url, options) => {
    ollamaCalls++;
    assert(url === 'http://localhost:11434/api/chat', 'Local LLM requests must use the localhost Ollama endpoint');
    const request = JSON.parse(options.body);
    const cases = JSON.parse(request.messages[1].content);
    const rankings = cases.map(item => {
      const choice = item.candidates.length - 1;
      modelSelectedCode = item.candidates[choice].code;
      return { query_id: item.query_id, choice };
    });
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ rankings }) } }) };
  }, rerankMessages);
  assert(ollamaCalls === 1, 'Unique uncertain service terms should be sent in a single bounded local request');
  assert(reranked.results[0]['Auto Candidate Service Code'] === modelSelectedCode, 'The local model selection should be constrained to the supplied catalogue candidates');
  assert(reranked.results[0]['Auto Match Status / Review Required'].includes('LOCAL AI SUGGESTION'), `LLM-ranked candidates must still require manual review: ${reranked.results[0]['Auto Match Status / Review Required']}; ${rerankMessages.filter(message => message.type === 'llm-status').map(message => message.message).join(' | ')}`);
  assert(reranked.results[0]['AI Recommendation'] === 'AI-ranked candidate — verify', 'AI-ranked results should be labeled for reviewer verification');
  assert(reranked.results[0]['Reviewer Decision'] !== 'Approved', 'AI ranking must not write a human approval decision');
  const fallbackMessages = [];
  const fallback = await runWorker({
    type: 'MATCH',
    masterRecords: [{ code: 'C001', display: 'General Consultation', standard: 'Consultation General', group: 'Consultation', subgroup: 'General', status: 'Active' }],
    sourceRows: [{ rawName: 'General Consulttion', standardizedName: '', existingCode: '' }],
    thresholds: { high: 95, review: 80 },
    localAi: { enabled: true, endpoint: 'http://localhost:11434', model: 'missing-model', maxNames: 10 }
  }, async () => { throw new Error('Ollama is not running'); }, fallbackMessages);
  assert(fallback.results[0]['Auto Candidate Service Code'] === 'C001', 'Regular suggestions must be retained if the local model is unavailable');
  assert(fallbackMessages.some(message => message.type === 'llm-status' && message.kind === 'error'), 'Unavailable local model must produce a visible warning');
  console.log('PASS: exact match, fuzzy candidate, existing-code comparison, ambiguous code protection, blank-name handling.');
  console.log(`PASS: ${result.stats.total} rows processed; ${result.stats.total - reviewRows.length} safe exact rows auto-approved; ${reviewRows.length} rows remain pending manual review.`);
  console.log('PASS: local model reranking stays within catalogue candidates and safely falls back when unavailable.');
})().catch((error) => { console.error('FAIL:', error.message); process.exit(1); });
