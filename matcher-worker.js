/* Matching engine runs in a Web Worker so the page stays responsive. */
'use strict';

try {
  if (typeof importScripts === 'function') importScripts('clinical-interpreter.js');
} catch (error) {
  // Fall back to the clinical helpers bundled below only when the separate module cannot be loaded.
}

const OUTPUT_COLUMNS = [
  'Auto Candidate Service Code',
  'Auto Candidate Standardized Service Name',
  'Auto Candidate Service Display Name',
  'Auto Candidate Group',
  'Auto Candidate Sub Group',
  'Auto Match Score',
  'Auto Match Method',
  'Auto Match Status / Review Required',
  'Auto Candidate Alternatives',
  'Auto Existing Code Check',
  'AI Recommendation'
];

const normalizationCache = new Map();
const gramCache = new Map();
const bigramCache = new Map();
const MEDICAL_TERM_ALIASES = [
  [/\b(?:c\s+t|ct|computed tomography|computerized tomography|computerised tomography)\b/g, 'computed tomography'],
  [/\b(?:m\s+r\s+i|mri|magnetic resonance imaging)\b/g, 'magnetic resonance imaging'],
  [/\b(?:e\s*c\s*g|ecg|ekg|electrocardiogram)\b/g, 'electrocardiogram'],
  [/\b(?:usg|ultrasonography|ultrasound)\b/g, 'ultrasound'],
  [/\b(?:x\s*ray|xray|radiograph)\b/g, 'radiograph'],
  [/\b(?:opg|orthopantomogram)\b/g, 'orthopantomogram'],
  [/\b(?:cbc|complete blood count)\b/g, 'complete blood count'],
  [/\b(?:lfts?|liver function tests?)\b/g, 'liver function test'],
  [/\b(?:rfts?|renal function tests?)\b/g, 'renal function test']
];

function blank(value) { return value == null || String(value).trim() === ''; }
function norm(value) {
  if (blank(value)) return '';
  const raw = String(value);
  if (normalizationCache.has(raw)) return normalizationCache.get(raw);
  const normalized = raw.normalize('NFKC').toLocaleLowerCase().trim()
    .replace(/&/g, ' and ')
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}_\s]+/gu, ' ')
    .replace(/[_\s]+/g, ' ').trim();
  normalizationCache.set(raw, normalized);
  return normalized;
}
function medicalTermKey(value) {
  let key = norm(value);
  for (const [pattern, replacement] of MEDICAL_TERM_ALIASES) key = key.replace(pattern, replacement);
  return key.replace(/\s+/g, ' ').trim();
}

function candidateDetails(candidates) {
  const distinct = (field) => [...new Set(candidates.map(c => c[field]).filter(v => !blank(v)))].sort((a,b) => a.localeCompare(b));
  const codes = distinct('code');
  const standards = distinct('standard');
  const displays = distinct('display');
  const groups = distinct('group');
  const subgroups = distinct('subgroup');
  return {
    codes,
    standard: standards.length === 1 ? standards[0] : (displays.length ? displays[0] : ''),
    display: displays.length === 1 ? displays[0] : (displays.length ? displays[0] : ''),
    group: groups.length === 1 ? groups[0] : '',
    subgroup: subgroups.length === 1 ? subgroups[0] : '',
    categoryConflict: groups.length > 1 || subgroups.length > 1 || standards.length > 1
  };
}

function setSuggestedCandidate(result, candidates, sourceContext = {}, existingCode = '') {
  const sourceGroup = norm(sourceContext.sourceGroup);
  const sourceSubgroup = norm(sourceContext.sourceSubgroup);
  const existing = String(existingCode || '').trim().toLocaleLowerCase();
  const ranked = [...candidates].filter(candidate => !blank(candidate.code)).sort((a, b) => {
    const score = candidate => (
      (existing && String(candidate.code).trim().toLocaleLowerCase() === existing ? 4 : 0)
      + (sourceGroup && norm(candidate.group) === sourceGroup ? 2 : 0)
      + (sourceSubgroup && norm(candidate.subgroup) === sourceSubgroup ? 1 : 0)
    );
    return score(b) - score(a)
      || String(a.code).localeCompare(String(b.code))
      || String(a.display || '').localeCompare(String(b.display || ''));
  });
  const suggested = ranked[0];
  if (!suggested) return;
  result['Auto Candidate Service Code'] = suggested.code;
  result['Auto Candidate Standardized Service Name'] = suggested.standard || '';
  result['Auto Candidate Service Display Name'] = suggested.display || '';
  result['Auto Candidate Group'] = suggested.group || '';
  result['Auto Candidate Sub Group'] = suggested.subgroup || '';
}

function candidateLabel(candidate) {
  return `${candidate.display || candidate.standard || ''} [${candidate.code || ''}]`;
}
function formatAlternatives(nameMap, rankedKeys, limit = 8) {
  const parts = [];
  const seen = new Set();
  for (const [key, score] of rankedKeys) {
    const candidates = nameMap.get(key) || [];
    for (const candidate of candidates) {
      const entry = `${candidateLabel(candidate)} (${Number(score).toFixed(1)}%)`;
      if (!seen.has(entry)) { seen.add(entry); parts.push(entry); }
      if (parts.length >= limit) return parts.join(' | ');
    }
  }
  return parts.join(' | ');
}
function compareExisting(existing, candidate) {
  if (!existing) return 'No existing code in vendor file';
  if (!candidate) return 'No unambiguous candidate code';
  if (String(existing).trim().toLocaleLowerCase() === String(candidate).trim().toLocaleLowerCase()) return 'Existing code agrees with candidate';
  return 'CHECK — existing code differs from candidate';
}
function setAiRecommendation(row) {
  const status = String(row['Auto Match Status / Review Required'] || '').toUpperCase();
  const check = String(row['Auto Existing Code Check'] || '');
  const exactUnique = status.startsWith('EXACT MATCH')
    && Number(row['Auto Match Score']) === 100
    && !status.includes('CATEGORY CONFLICT')
    && !status.includes('EXISTING CODE DISAGREEMENT')
    && !check.startsWith('CHECK')
    && blank(row['Critical Differences'])
    && blank(row['Missing Attributes'])
    && !blank(row['Auto Candidate Service Code']);
  if (exactUnique) {
    row['Auto Match Status / Review Required'] = 'EXACT MATCH — auto-approved (100%, unique code, no conflicts)';
    row['AI Recommendation'] = 'Auto-approved — exact unique match';
    row['Reviewer Decision'] = 'Auto-Approved (100% exact)';
    row['Approved Service Code'] = row['Auto Candidate Service Code'];
    return;
  }

  row['Reviewer Decision'] = 'Pending';
  row['Approved Service Code'] = '';
  if (status.includes('EXISTING CODE DISAGREEMENT') || status.includes('CATEGORY CONFLICT') || status.includes('AMBIGUOUS') || status.includes('LOW CONFIDENCE') || !row['Auto Candidate Service Code']) {
    row['AI Recommendation'] = 'Review carefully';
  } else if (status.includes('LOCAL AI SUGGESTION')) {
    row['AI Recommendation'] = 'AI-ranked candidate — verify';
  } else if (status.includes('REVIEWER MAPPING SUGGESTION')) {
    row['AI Recommendation'] = 'Previously confirmed mapping — verify';
  } else if (status.startsWith('EXACT MATCH') && (check.includes('agrees') || check.includes('No existing'))) {
    row['AI Recommendation'] = 'Strong candidate — confirm row';
  } else if (status.includes('HIGH-CONFIDENCE FUZZY CANDIDATE') && (check.includes('agrees') || check.includes('No existing'))) {
    row['AI Recommendation'] = 'Likely candidate — verify row';
  } else if (status.includes('HISTORICAL MAPPING')) {
    row['AI Recommendation'] = 'Prior match — verify';
  } else {
    row['AI Recommendation'] = 'Review carefully';
  }
}
function emptyResult() {
  return {
    'Original Service Name': '',
    'Auto Candidate Service Code': '',
    'Auto Candidate Standardized Service Name': '',
    'Auto Candidate Service Display Name': '',
    'Auto Candidate Group': '',
    'Auto Candidate Sub Group': '',
    'Auto Match Score': 0,
    'Auto Match Method': 'None',
    'Auto Match Status / Review Required': 'UNMATCHED — no candidate found',
    'Auto Candidate Alternatives': '',
    'Auto Existing Code Check': 'No candidate assigned',
    'AI Recommendation': 'Review carefully',
    'Input Clinical Attributes': '',
    'Candidate Clinical Attributes': '',
    'Text Match Evidence': '',
    'Clinical Equivalence Explanation': '',
    'Matching Attributes': '',
    'Missing Attributes': '',
    'Critical Differences': '',
    'Clinical Compatibility': 'Not evaluated',
    'Reference Verification Status': 'Unverified',
    'Code System': 'Unknown (not specified in reference catalogue)',
    'Code System Version': 'Unknown',
    'Decision': 'NO_SAFE_MATCH',
    'Decision Reason': 'No catalogue candidate found',
    'Semantic Similarity': 'Not evaluated (no embedding model configured)',
    'Clinical AI/Model Version': 'clinical-rules-v1'
  };
}

function isReviewRequiredStatus(status) {
  if (String(status || '').toUpperCase().includes('AUTO-APPROVED (100%')) return false;
  return !blank(status);
}

function collectReviewRows(rows) {
  return (rows || []).filter(row => isReviewRequiredStatus(row['Auto Match Status / Review Required']));
}

function makeIndex(masterRecords, historicalMappings = [], approvedMappings = []) {
  const nameMap = new Map();
  const seenByKey = new Map();
  const codeMap = new Map();
  const uniqueCodes = new Set();
  let indexedCount = 0;
  let excludedInactive = 0;
  const inactiveWords = new Set(['inactive', 'disabled', 'retired', 'discontinued', 'deleted']);
  for (const original of masterRecords || []) {
    const candidate = {
      code: String(original.code || '').trim(),
      display: String(original.display || '').trim(),
      standard: String(original.standard || '').trim(),
      group: String(original.group || '').trim(),
      subgroup: String(original.subgroup || '').trim(),
      status: String(original.status || '').trim(),
      codeSystem: String(original.codeSystem || original.code_system || original['Code System'] || '').trim(),
      codeSystemVersion: String(original.codeSystemVersion || original.code_system_version || original['Code System Version'] || '').trim()
    };
    if (!candidate.code) continue;
    if (norm(candidate.status).split(' ').some(word => inactiveWords.has(word))) { excludedInactive++; continue; }
    if (!codeMap.has(candidate.code)) codeMap.set(candidate.code, []);
    codeMap.get(candidate.code).push(candidate);
    const signature = JSON.stringify([candidate.code, candidate.display, candidate.standard, candidate.group, candidate.subgroup, candidate.status]);
    let added = false;
    for (const name of [candidate.display, candidate.standard]) {
      const key = norm(name);
      if (!key) continue;
      if (!nameMap.has(key)) { nameMap.set(key, []); seenByKey.set(key, new Set()); }
      const seen = seenByKey.get(key);
      if (!seen.has(signature)) { nameMap.get(key).push(candidate); seen.add(signature); added = true; }
    }
    if (added) { indexedCount++; uniqueCodes.add(candidate.code); }
  }
  if (!nameMap.size) throw new Error('No usable reference names and codes were found. Check the selected reference sheet and column headings.');

  const keys = [...nameMap.keys()].sort();
  const medicalNameMap = new Map();
  const historicalNameMap = new Map();
  const approvedNameMap = new Map();
  for (const original of approvedMappings || []) {
    const key = norm(original.sourceName || original.name);
    const code = String(original.code || '').trim();
    if (!key || !code) continue;
    if (!approvedNameMap.has(key)) approvedNameMap.set(key, new Map());
    const mappingKey = `${code}\u241f${norm(original.group)}\u241f${norm(original.subgroup)}`;
    approvedNameMap.get(key).set(mappingKey, { code, group: String(original.group || '').trim(), subgroup: String(original.subgroup || '').trim() });
  }
  for (const original of historicalMappings || []) {
    const key = norm(original.sourceName || original.name);
    const code = String(original.code || '').trim();
    if (!key || !code) continue;
    if (!historicalNameMap.has(key)) historicalNameMap.set(key, new Map());
    const byCode = historicalNameMap.get(key);
    if (!byCode.has(code)) {
      byCode.set(code, {
        code,
        display: String(original.display || '').trim(),
        standard: String(original.standard || '').trim(),
        group: String(original.group || '').trim(),
        subgroup: String(original.subgroup || '').trim(),
        status: String(original.status || 'Historical automated match; review required').trim()
      });
    }
  }
  const keyMeta = new Map();
  const gramIndex = new Map();
  const tokenIndex = new Map();
  const firstLetterIndex = new Map();
  const lengthIndex = new Map();
  for (const key of keys) {
    const medicalKey = medicalTermKey(key);
    if (!medicalNameMap.has(medicalKey)) medicalNameMap.set(medicalKey, []);
    medicalNameMap.get(medicalKey).push(key);
    const grams = charGrams(key);
    const bigrams = charBigrams(key);
    const tokens = new Set(key.split(' ').filter(Boolean));
    keyMeta.set(key, { grams, bigrams, tokens });
    const first = key[0] || '';
    if (!firstLetterIndex.has(first)) firstLetterIndex.set(first, []);
    firstLetterIndex.get(first).push(key);
    if (!lengthIndex.has(key.length)) lengthIndex.set(key.length, []);
    lengthIndex.get(key.length).push(key);
    for (const gram of grams) {
      if (!gramIndex.has(gram)) gramIndex.set(gram, []);
      gramIndex.get(gram).push(key);
    }
    for (const token of tokens) {
      if (!tokenIndex.has(token)) tokenIndex.set(token, []);
      tokenIndex.get(token).push(key);
    }
  }
  const keyClinical = new Map();
  if (typeof extractClinicalAttributes === 'function') {
    for (const key of keys) {
      const rec = (nameMap.get(key) || [])[0];
      const text = rec ? (rec.display || rec.standard || key) : key;
      keyClinical.set(key, extractClinicalAttributes(text));
    }
  }
  return { nameMap, codeMap, medicalNameMap, historicalNameMap, approvedNameMap, keys, keyMeta, gramIndex, tokenIndex, firstLetterIndex, lengthIndex, keyClinical, stats: {
    referenceCount: indexedCount,
    uniqueNames: nameMap.size,
    uniqueCodes: uniqueCodes.size,
    excludedInactive
  } };
}
function charGrams(value) {
  if (!value) return new Set();
  if (gramCache.has(value)) return new Set(gramCache.get(value));
  const result = new Set();
  if (value.length <= 3) { result.add(value); }
  else {
    for (let i = 0; i <= value.length - 3; i++) result.add(value.slice(i, i + 3));
  }
  gramCache.set(value, [...result]);
  return new Set(result);
}
function charBigrams(value) {
  if (!value) return new Set();
  if (bigramCache.has(value)) return new Set(bigramCache.get(value));
  const result = new Set();
  if (value.length <= 2) { result.add(value); }
  else {
    for (let i = 0; i < value.length - 1; i++) result.add(value.slice(i, i + 2));
  }
  bigramCache.set(value, [...result]);
  return new Set(result);
}
function shortlist(queryKey, ctx, maxCandidates = 20) {
  const queryGrams = charGrams(queryKey);
  const queryBigrams = charBigrams(queryKey);
  const queryTokens = new Set(queryKey.split(' ').filter(Boolean));
  const overlap = new Map();
  for (const gram of queryGrams) {
    const keys = ctx.gramIndex.get(gram) || [];
    // Ignore ultra-common fragments (e.g. 'tion') that would visit thousands of entries per query.
    if (keys.length > 80) continue;
    for (const key of keys) {
      let stats = overlap.get(key);
      if (!stats) { stats = { gram: 0, token: 0 }; overlap.set(key, stats); }
      stats.gram++;
    }
  }
  for (const token of queryTokens) {
    const keys = ctx.tokenIndex.get(token) || [];
    if (keys.length > 90) continue;
    for (const key of keys) {
      let stats = overlap.get(key);
      if (!stats) { stats = { gram: 0, token: 0 }; overlap.set(key, stats); }
      stats.token++;
    }
  }
  const ranked = [];
  for (const [key, shared] of overlap.entries()) {
    const meta = ctx.keyMeta.get(key);
    const gramDice = (queryGrams.size + meta.grams.size) ? (2 * shared.gram / (queryGrams.size + meta.grams.size)) : 0;
    const tokenDice = (queryTokens.size + meta.tokens.size) ? (2 * shared.token / (queryTokens.size + meta.tokens.size)) : 0;
    const lengthFit = Math.min(queryKey.length, key.length) / Math.max(queryKey.length, key.length, 1);
    const prefixBonus = queryKey[0] && queryKey[0] === key[0] ? 0.035 : 0;
    const score = Math.min(1, 0.58 * gramDice + 0.32 * tokenDice + 0.10 * lengthFit + prefixBonus);
    ranked.push({ key, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const expanded = ranked.slice(0, Math.max(maxCandidates, 20)).map(item => [item.key, approximateScore(queryKey, item.key, ctx, queryBigrams, queryTokens)]);
  expanded.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  let result = expanded.slice(0, maxCandidates);
  // Very short names can have no indexed overlap. Keep a conservative prefix fallback.
  if (!result.length) {
    const near = [];
    const firstLetter = ctx.firstLetterIndex.get(queryKey[0] || '') || [];
    for (const key of firstLetter) {
      if (Math.abs(key.length - queryKey.length) <= 4) near.push(key);
      if (near.length >= maxCandidates) break;
    }
    if (near.length) result = near.map(key => [key, approximateScore(queryKey, key, ctx, queryBigrams, queryTokens)]);
    else {
      // Rare fallback for very noisy/short strings: inspect only nearby length buckets.
      for (let length = Math.max(1, queryKey.length - 2); length <= queryKey.length + 2 && near.length < maxCandidates; length++) {
        const bucket = ctx.lengthIndex.get(length) || [];
        for (const key of bucket) { near.push(key); if (near.length >= maxCandidates) break; }
      }
      result = near.map(key => [key, approximateScore(queryKey, key, ctx, queryBigrams, queryTokens)]);
    }
  }
  return result;
}
function approximateScore(queryKey, key, ctx, queryGramsInput, queryTokensInput) {
  const queryGrams = queryGramsInput || charBigrams(queryKey);
  const queryTokens = queryTokensInput || new Set(queryKey.split(' ').filter(Boolean));
  const meta = ctx.keyMeta.get(key);
  if (!meta) return 0;
  let sharedGrams = 0;
  for (const gram of queryGrams) if (meta.bigrams.has(gram)) sharedGrams++;
  let sharedTokens = 0;
  for (const token of queryTokens) if (meta.tokens.has(token)) sharedTokens++;
  const gramDice = (queryGrams.size + meta.bigrams.size) ? (2 * sharedGrams / (queryGrams.size + meta.bigrams.size)) : 0;
  const tokenDice = (queryTokens.size + meta.tokens.size) ? (2 * sharedTokens / (queryTokens.size + meta.tokens.size)) : 0;
  const lengthFit = Math.min(queryKey.length, key.length) / Math.max(queryKey.length, key.length, 1);
  const prefixBonus = queryKey[0] && queryKey[0] === key[0] ? 0.035 : 0;
  const querySignature = String(queryKey).toLowerCase().replace(/[aeiou]/g, '').replace(/(.)\1+/g, '$1');
  const keySignature = String(key).toLowerCase().replace(/[aeiou]/g, '').replace(/(.)\1+/g, '$1');
  let signatureMatch = 0;
  if (querySignature && keySignature) {
    const maxSignatureLen = Math.max(querySignature.length, keySignature.length, 1);
    const overlap = [...querySignature].filter(ch => keySignature.includes(ch)).length;
    signatureMatch = overlap / maxSignatureLen;
    if (querySignature === keySignature) signatureMatch = 1;
  }
  let charSimilarity = 0;
  const maxLen = Math.max(queryKey.length, key.length, 1);
  if (maxLen > 0) {
    const editDistance = levenshteinDistance(queryKey, key);
    charSimilarity = 1 - (editDistance / maxLen);
  }
  const tokenOverlap = queryTokens.size && meta.tokens.size ? (2 * sharedTokens / (queryTokens.size + meta.tokens.size)) : 0;
  const weighted = 0.36 * gramDice + 0.18 * tokenOverlap + 0.12 * lengthFit + 0.12 * charSimilarity + 0.18 * signatureMatch + 0.04 * prefixBonus * 20;
  return Math.min(100, Math.round((weighted + prefixBonus) * 10000) / 100);
}

function levenshteinDistance(a, b) {
  if (a.length > b.length) [a, b] = [b, a];
  let previous = Array.from({ length: a.length + 1 }, (_, index) => index);
  let current = new Array(a.length + 1);
  for (let row = 1; row <= b.length; row++) {
    current[0] = row;
    for (let column = 1; column <= a.length; column++) {
      const cost = a[column - 1] === b[row - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[a.length];
}

// Browser-optimized approximate name similarity; fuzzy scores are not identical to RapidFuzz.
function makeFuzzyFinder(ctx) {
  const cache = new Map();
  return function fuzzyFind(query) {
    const q = norm(query);
    if (!q || q.length <= 3) return [];
    if (cache.has(q)) return cache.get(q);
    // Keep the shortlist tight enough for speed but broad enough to preserve the best fuzzy candidates.
    const top = shortlist(q, ctx, 10).slice(0, 4);
    cache.set(q, top);
    return top;
  };
}

function isSingleTypoMatch(queryKey, candidateKey) {
  const queryTokens = norm(queryKey).split(' ').filter(Boolean);
  const candidateTokens = norm(candidateKey).split(' ').filter(Boolean);
  if (!queryTokens.length || queryTokens.length !== candidateTokens.length) return false;

  let changedToken = false;
  for (let index = 0; index < queryTokens.length; index++) {
    const queryToken = queryTokens[index];
    const candidateToken = candidateTokens[index];
    if (queryToken === candidateToken) continue;
    if (changedToken || Math.min(queryToken.length, candidateToken.length) < 5) return false;
    if (Math.abs(queryToken.length - candidateToken.length) > 1 || levenshteinDistance(queryToken, candidateToken) > 1) return false;
    changedToken = true;
  }
  return changedToken;
}

function matchServiceCore(rawName, standardizedName, existingCode, ctx, fuzzyFind, thresholds, sourceContext = {}) {
  const raw = String(rawName || '').trim();
  const standardized = String(standardizedName || '').trim();
  const existing = String(existingCode || '').trim();
  const resultEmpty = emptyResult();
  const queries = [];
  if (!blank(raw)) queries.push({ value: raw, label: 'Service Name' });
  if (!blank(standardized) && norm(standardized) !== norm(raw)) queries.push({ value: standardized, label: 'Standardized Service Name' });
  if (!queries.length) {
    resultEmpty['Auto Match Status / Review Required'] = 'BLANK SERVICE NAME — manual entry required';
    return resultEmpty;
  }

  for (const query of queries) {
    const key = norm(query.value);
    if (!ctx.nameMap.has(key)) continue;
    const candidates = ctx.nameMap.get(key);
    const detail = candidateDetails(candidates);
    const result = { ...resultEmpty };
    result['Auto Candidate Standardized Service Name'] = detail.standard;
    result['Auto Candidate Service Display Name'] = detail.display;
    result['Auto Candidate Group'] = detail.group;
    result['Auto Candidate Sub Group'] = detail.subgroup;
    result['Auto Match Score'] = 100;
    result['Auto Match Method'] = `Exact normalized (${query.label})`;
    result['Auto Candidate Alternatives'] = formatAlternatives(ctx.nameMap, [[key, 100]]);
    if (detail.codes.length === 1) {
      result['Auto Candidate Service Code'] = detail.codes[0];
      result['Auto Match Status / Review Required'] = !detail.categoryConflict
        ? 'EXACT MATCH — code found; verify before approval'
        : 'EXACT MATCH — code unique; category conflict needs review';
      result['Auto Existing Code Check'] = compareExisting(existing, result['Auto Candidate Service Code']);
    } else if (detail.codes.length > 1) {
      setSuggestedCandidate(result, candidates, sourceContext, existing);
      result['Auto Match Status / Review Required'] = 'AMBIGUOUS EXACT MATCH — multiple reference codes';
      result['Auto Candidate Alternatives'] = candidates.map(c => candidateLabel(c)).join(' | ').slice(0, 3000);
      result['Auto Existing Code Check'] = 'Ambiguous candidate; existing code not evaluated';
    }
    return result;
  }

  for (const query of queries) {
    const matchedKeys = ctx.medicalNameMap.get(medicalTermKey(query.value)) || [];
    if (!matchedKeys.length) continue;
    const candidates = matchedKeys.flatMap(key => ctx.nameMap.get(key) || []);
    const detail = candidateDetails(candidates);
    const result = { ...resultEmpty };
    result['Auto Candidate Standardized Service Name'] = detail.standard;
    result['Auto Candidate Service Display Name'] = detail.display;
    result['Auto Candidate Group'] = detail.group;
    result['Auto Candidate Sub Group'] = detail.subgroup;
    result['Auto Match Score'] = 98;
    result['Auto Match Method'] = `Controlled medical term variant (${query.label})`;
    result['Auto Candidate Alternatives'] = formatAlternatives(ctx.nameMap, matchedKeys.map(key => [key, 98]));
    if (detail.codes.length === 1) {
      result['Auto Candidate Service Code'] = detail.codes[0];
      result['Auto Match Status / Review Required'] = detail.categoryConflict
        ? 'MEDICAL TERM VARIANT — category conflict needs review'
        : 'MEDICAL TERM VARIANT — manual review required';
      result['Auto Existing Code Check'] = compareExisting(existing, detail.codes[0]);
    } else {
      setSuggestedCandidate(result, candidates, sourceContext, existing);
      result['Auto Match Status / Review Required'] = 'AMBIGUOUS MEDICAL TERM VARIANT — multiple reference codes';
      result['Auto Candidate Alternatives'] = [...new Set(candidates.map(candidateLabel))].join(' | ').slice(0, 3000);
      result['Auto Existing Code Check'] = 'Ambiguous candidate; existing code not evaluated';
    }
    return result;
  }

  for (const query of queries) {
    const mappings = ctx.approvedNameMap.get(norm(query.value));
    if (!mappings || !mappings.size) continue;
    const sourceGroup = norm(sourceContext.sourceGroup);
    const sourceSubgroup = norm(sourceContext.sourceSubgroup);
    const compatible = [...mappings.values()].filter(mapping =>
      (!mapping.group || norm(mapping.group) === sourceGroup)
      && (!mapping.subgroup || norm(mapping.subgroup) === sourceSubgroup)
    );
    const codes = [...new Set(compatible.map(mapping => mapping.code))];
    if (!compatible.length) continue;
    if (codes.length !== 1) {
      const candidates = codes.flatMap(code => ctx.codeMap.get(code) || []);
      setSuggestedCandidate(resultEmpty, candidates, sourceContext, existing);
      resultEmpty['Auto Match Status / Review Required'] = 'AMBIGUOUS APPROVED MAPPING — multiple approved codes';
      resultEmpty['Auto Candidate Alternatives'] = candidates.map(candidateLabel).join(' | ').slice(0, 3000);
      resultEmpty['Auto Existing Code Check'] = 'Ambiguous candidate; existing code not evaluated';
      return resultEmpty;
    }
    const candidates = ctx.codeMap.get(codes[0]) || [];
    const detail = candidateDetails(candidates);
    if (!candidates.length) continue;
    const result = { ...resultEmpty };
    result['Auto Candidate Service Code'] = codes[0];
    result['Auto Candidate Standardized Service Name'] = detail.standard;
    result['Auto Candidate Service Display Name'] = detail.display;
    result['Auto Candidate Group'] = detail.group;
    result['Auto Candidate Sub Group'] = detail.subgroup;
    result['Auto Match Score'] = 100;
    result['Auto Match Method'] = `Reviewer-approved mapping (${query.label})`;
    result['Auto Candidate Alternatives'] = candidates.map(candidate => candidateLabel(candidate)).join(' | ');
    result['Auto Match Status / Review Required'] = detail.categoryConflict
      ? 'REVIEWER MAPPING SUGGESTION — catalogue category conflict; verify this row'
      : 'REVIEWER MAPPING SUGGESTION — verify this row';
    result['Auto Existing Code Check'] = compareExisting(existing, codes[0]);
    return result;
  }

  for (const query of queries) {
    const historical = ctx.historicalNameMap.get(norm(query.value));
    if (!historical || !historical.size) continue;
    const candidates = [...historical.values()];
    const detail = candidateDetails(candidates);
    const result = { ...resultEmpty };
    result['Auto Candidate Standardized Service Name'] = detail.standard;
    result['Auto Candidate Service Display Name'] = detail.display;
    result['Auto Candidate Group'] = detail.group;
    result['Auto Candidate Sub Group'] = detail.subgroup;
    result['Auto Match Score'] = 95;
    result['Auto Match Method'] = `Historical prior match (${query.label})`;
    result['Auto Candidate Alternatives'] = candidates.map(candidate => `${candidateLabel(candidate)} (historical)`).join(' | ').slice(0, 3000);
    if (detail.codes.length === 1 && !detail.categoryConflict) {
      result['Auto Candidate Service Code'] = detail.codes[0];
      result['Auto Match Status / Review Required'] = 'HISTORICAL MAPPING — prior automated match; manual review required';
      result['Auto Existing Code Check'] = compareExisting(existing, detail.codes[0]);
    } else {
      setSuggestedCandidate(result, candidates, sourceContext, existing);
      result['Auto Match Status / Review Required'] = 'AMBIGUOUS HISTORICAL MAPPING — multiple codes or categories';
      result['Auto Existing Code Check'] = 'Ambiguous candidate; existing code not evaluated';
    }
    return result;
  }

  const inputTextForClinical = standardized || raw;
  const inputAttrs = (typeof extractClinicalAttributes === 'function') ? extractClinicalAttributes(inputTextForClinical) : null;
  const ranked = new Map();
  const sourceForKey = new Map();
  let bestQueryValue = '';
  for (const query of queries) {
    for (const [key, score] of fuzzyFind(query.value)) {
      if (!ranked.has(key) || score > ranked.get(key)) {
        ranked.set(key, score);
        sourceForKey.set(key, query.label);
        bestQueryValue = query.value;
      }
    }
  }
  if (inputAttrs && ctx.keyClinical) {
    const clinicalKeys = ctx.keys.filter(key => {
      const c = ctx.keyClinical.get(key);
      if (!c) return false;
      return (inputAttrs.modality && c.modality === inputAttrs.modality)
        || (inputAttrs.bodySite && c.bodySite === inputAttrs.bodySite);
    }).slice(0, 12);
    for (const key of clinicalKeys) if (!ranked.has(key)) ranked.set(key, 60);
  }
  const sorted = [...ranked.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!sorted.length) return resultEmpty;
  const [bestKey, bestScore] = sorted[0];
  const bestCandidates = ctx.nameMap.get(bestKey) || [];
  const detail = candidateDetails(bestCandidates);
  const result = { ...resultEmpty };
  result['Auto Candidate Standardized Service Name'] = detail.standard;
  result['Auto Candidate Service Display Name'] = detail.display;
  result['Auto Candidate Group'] = detail.group;
  result['Auto Candidate Sub Group'] = detail.subgroup;
  result['Auto Match Score'] = Math.round(bestScore * 100) / 100;
  result['Auto Match Method'] = `Fuzzy name similarity (${sourceForKey.get(bestKey) || 'source name'})`;
  result['Auto Candidate Alternatives'] = formatAlternatives(ctx.nameMap, sorted, 8);
  const tiedKeys = sorted.filter(([, score]) => Math.abs(score - bestScore) < 0.0001).map(([key]) => key);
  const tiedCodes = new Set();
  tiedKeys.forEach(key => (ctx.nameMap.get(key) || []).forEach(c => { if (c.code) tiedCodes.add(c.code); }));
  if (detail.codes.length > 1) {
    setSuggestedCandidate(result, bestCandidates, sourceContext, existing);
    result['Auto Match Status / Review Required'] = 'AMBIGUOUS FUZZY CANDIDATE — multiple codes in reference';
    result['Auto Existing Code Check'] = 'Ambiguous candidate; existing code not evaluated';
  } else if (tiedCodes.size > 1) {
    const tiedCandidates = tiedKeys.flatMap(key => ctx.nameMap.get(key) || []);
    setSuggestedCandidate(result, tiedCandidates, sourceContext, existing);
    result['Auto Match Status / Review Required'] = 'AMBIGUOUS FUZZY CANDIDATES — top score ties across codes';
    result['Auto Existing Code Check'] = 'Ambiguous candidate; existing code not evaluated';
  } else {
    result['Auto Candidate Service Code'] = detail.codes[0] || '';
    if (bestScore < thresholds.review) result['Auto Match Status / Review Required'] = `LOW CONFIDENCE — candidate below ${thresholds.review}% — manual review`;
    else if (bestScore >= thresholds.high || isSingleTypoMatch(bestQueryValue, bestKey)) result['Auto Match Status / Review Required'] = 'HIGH-CONFIDENCE FUZZY CANDIDATE — verify before approval';
    else result['Auto Match Status / Review Required'] = 'FUZZY CANDIDATE — manual review required';
    if (detail.categoryConflict) result['Auto Match Status / Review Required'] += '; reference category conflict';
    result['Auto Existing Code Check'] = compareExisting(existing, result['Auto Candidate Service Code']);
  }
  return result;
}

function llmCandidatePool(input, ctx, fuzzyFind) {
  const queries = [];
  if (!blank(input.rawName)) queries.push(input.rawName);
  if (!blank(input.standardizedName) && norm(input.standardizedName) !== norm(input.rawName)) queries.push(input.standardizedName);
  const ranked = new Map();
  for (const query of queries) {
    for (const [key, score] of fuzzyFind(query)) {
      if (!ranked.has(key) || score > ranked.get(key)) ranked.set(key, score);
    }
  }
  const pool = [];
  const sorted = [...ranked.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
  for (const [key, score] of sorted) {
    for (const candidate of ctx.nameMap.get(key) || []) {
      const id = `c${pool.length}`;
      pool.push({
        id,
        key,
        score,
        code: candidate.code,
        display: candidate.display,
        standard: candidate.standard,
        group: candidate.group,
        subgroup: candidate.subgroup
      });
      if (pool.length >= 12) return pool;
    }
  }
  return pool;
}

function llmNeedsReranking(result) {
  const status = String(result['Auto Match Status / Review Required'] || '').toUpperCase();
  return status.includes('FUZZY CANDIDATE') || status.includes('LOW CONFIDENCE');
}

async function callLocalOllama(endpoint, model, batch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
        messages: [
          {
            role: 'system',
            content: 'You rank possible matches for a human reviewer. Select only a supplied candidate index; never invent codes. Compare the service wording, modality, anatomy, and procedure context. Similar spelling alone is not equivalence. If no candidate is clearly supported, return choice null. Return only JSON with this shape: {"rankings":[{"query_id":"q0","choice":0}]}. The choice must be an integer index into that query candidates array or null.'
          },
          { role: 'user', content: JSON.stringify(batch) }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
    const payload = await response.json();
    const content = payload && payload.message && payload.message.content;
    if (typeof content !== 'string') throw new Error('Ollama returned an unreadable response');
    const parsed = JSON.parse(content);
    if (!parsed || !Array.isArray(parsed.rankings)) throw new Error('Ollama response did not contain rankings');
    return parsed.rankings;
  } finally {
    clearTimeout(timeout);
  }
}

async function rerankWithLocalOllama(message, results, context, fuzzyFind, resultCache, resultInputs, rowIndexes) {
  const config = message.localAi || {};
  const candidates = [];
  for (const [key, result] of resultCache.entries()) {
    if (!llmNeedsReranking(result)) continue;
    const input = resultInputs.get(key);
    const pool = llmCandidatePool(input, context, fuzzyFind);
    if (!pool.length) continue;
    candidates.push({ key, input, pool, frequency: (rowIndexes.get(key) || []).length });
  }
  candidates.sort((a, b) => b.frequency - a.frequency || norm(a.input.rawName).localeCompare(norm(b.input.rawName)));
  const limited = candidates.slice(0, Math.max(1, Math.min(1000, Number(config.maxNames) || 100)));
  let applied = 0;
  let completed = 0;
  const batchSize = 8;
  for (let start = 0; start < limited.length; start += batchSize) {
    const batchItems = limited.slice(start, start + batchSize).map((item, index) => ({
      query_id: `q${start + index}`,
      service: String(item.input.rawName || '').slice(0, 300),
      standardized: String(item.input.standardizedName || '').slice(0, 300),
      vendor_group: String(item.input.sourceGroup || '').slice(0, 120),
      vendor_subgroup: String(item.input.sourceSubgroup || '').slice(0, 120),
      candidates: item.pool.map(candidate => ({
        code: candidate.code,
        display: candidate.display,
        standardized: candidate.standard,
        group: candidate.group,
        subgroup: candidate.subgroup
      }))
    }));
    const rankings = await callLocalOllama(config.endpoint, config.model, batchItems);
    const answers = new Map(rankings.map(ranking => [ranking.query_id, ranking.choice]));
    batchItems.forEach((request, index) => {
      const item = limited[start + index];
      const selectedIndex = answers.get(request.query_id);
      if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= item.pool.length) return;
      const selected = item.pool[selectedIndex];
      const candidateRecords = (context.nameMap.get(selected.key) || []).filter(candidate => candidate.code === selected.code);
      if (!candidateRecords.length) return;
      const detail = candidateDetails(candidateRecords);
      const alternatives = [selected, ...item.pool.filter(candidate => candidate !== selected)];
      const selectedScore = selected.score;
      for (const rowIndex of rowIndexes.get(item.key) || []) {
        const row = results[rowIndex];
        const rowInput = message.sourceRows[rowIndex] || item.input;
        row['Auto Candidate Service Code'] = detail.codes.length === 1 ? detail.codes[0] : '';
        row['Auto Candidate Standardized Service Name'] = detail.standard;
        row['Auto Candidate Service Display Name'] = detail.display;
        row['Auto Candidate Group'] = detail.group;
        row['Auto Candidate Sub Group'] = detail.subgroup;
        row['Auto Match Score'] = Math.round(selectedScore * 100) / 100;
        row['Auto Match Method'] = `Local AI reranking (${config.model})`;
        row['Auto Candidate Alternatives'] = alternatives.map(candidate => `${candidateLabel(candidate)} (${Number(candidate.score).toFixed(1)}%)`).join(' | ').slice(0, 3000);
        row['Auto Match Status / Review Required'] = detail.codes.length === 1
          ? 'LOCAL AI SUGGESTION — verify this vendor row manually'
          : 'AMBIGUOUS LOCAL AI SUGGESTION — multiple codes; verify manually';
        row['Auto Existing Code Check'] = detail.codes.length === 1
          ? compareExisting(rowInput.existingCode, detail.codes[0])
          : 'Ambiguous candidate; existing code not evaluated';
        if (row['Auto Existing Code Check'].startsWith('CHECK')) {
          row['Auto Match Status / Review Required'] += '; EXISTING CODE DISAGREEMENT — manual review required';
        }
        setAiRecommendation(row);
        enrichResultWithClinical(row, rowInput.rawName || item.input.rawName, rowInput.standardizedName || item.input.standardizedName, context);
        applied++;
      }
    });
    completed += batchItems.length;
    self.postMessage({ type: 'llm-progress', completed, total: limited.length, percent: 94 + (completed / Math.max(1, limited.length)) * 2 });
  }
  return { applied, considered: limited.length, available: candidates.length };
}

function processMatching(message) {
  const context = makeIndex(message.masterRecords || [], message.historicalMappings || [], message.approvedMappings || []);
  const fuzzyFind = makeFuzzyFinder(context);
  const inputRows = message.sourceRows || [];
  const thresholds = message.thresholds || { high: 95, review: 80 };
  const results = new Array(inputRows.length);
  const counts = Object.create(null);
  const resultCache = new Map();
  const resultInputs = new Map();
  const rowIndexes = new Map();
  let completed = 0;
  self.postMessage({ type: 'stage', title: 'Reference catalogue ready', detail: 'Your files are ready to process.', percent: 4 });

  function processBatch() {
    const batchSize = 400;
    const batchEnd = Math.min(completed + batchSize, inputRows.length);
    for (; completed < batchEnd; completed++) {
      const input = inputRows[completed] || {};
      const rawKey = norm(input.rawName);
      const stdKey = norm(input.standardizedName);
      const cacheKey = `${rawKey}\u241f${stdKey}\u241f${norm(input.sourceGroup)}\u241f${norm(input.sourceSubgroup)}`;
      let match = resultCache.get(cacheKey);
      if (!match) {
        match = matchService(input.rawName, input.standardizedName, '', context, fuzzyFind, thresholds, input);
        resultCache.set(cacheKey, match);
        resultInputs.set(cacheKey, input);
      }
      if (!rowIndexes.has(cacheKey)) rowIndexes.set(cacheKey, []);
      rowIndexes.get(cacheKey).push(completed);
      const rowResult = { ...match };
      const initialStatus = rowResult['Auto Match Status / Review Required'];
      if (initialStatus.startsWith('AMBIGUOUS')) rowResult['Auto Existing Code Check'] = 'Ambiguous candidate; existing code not evaluated';
      else if (rowResult['Auto Candidate Service Code']) {
        rowResult['Auto Existing Code Check'] = compareExisting(input.existingCode, rowResult['Auto Candidate Service Code']);
        if (rowResult['Auto Existing Code Check'].startsWith('CHECK')) {
          if (!rowResult['Auto Match Status / Review Required'].includes('EXISTING CODE DISAGREEMENT')) {
            rowResult['Auto Match Status / Review Required'] += '; EXISTING CODE DISAGREEMENT — manual review required';
          }
        }
      } else rowResult['Auto Existing Code Check'] = initialStatus.startsWith('BLANK SERVICE NAME') ? 'No service name; code not evaluated' : 'No unambiguous candidate code';
      if (rowResult['Auto Existing Code Check'].startsWith('CHECK') && !rowResult['Auto Match Status / Review Required'].includes('EXISTING CODE DISAGREEMENT')) {
        rowResult['Auto Match Status / Review Required'] += '; EXISTING CODE DISAGREEMENT — manual review required';
      }
      setAiRecommendation(rowResult);
      const status = rowResult['Auto Match Status / Review Required'];
      results[completed] = rowResult;
      counts[status] = (counts[status] || 0) + 1;
    }
    const percent = 5 + (completed / Math.max(1, inputRows.length)) * 89;
    self.postMessage({ type: 'progress', completed, total: inputRows.length, cacheSize: resultCache.size, percent });
    if (completed < inputRows.length) setTimeout(processBatch, 0);
    else {
      const finish = (llmSummary = null) => {
        for (const key of Object.keys(counts)) delete counts[key];
        results.forEach(row => {
          const status = row['Auto Match Status / Review Required'];
          counts[status] = (counts[status] || 0) + 1;
        });
      const candidateCodes = results.filter(r => !blank(r['Auto Candidate Service Code'])).length;
      self.postMessage({
        type: 'done', results,
        stats: {
          total: inputRows.length,
          candidateCodes,
          referenceCount: context.stats.referenceCount,
          uniqueNames: context.stats.uniqueNames,
          uniqueCodes: context.stats.uniqueCodes,
          excludedInactive: context.stats.excludedInactive,
          counts: { ...counts },
          distinctNameCombinations: resultCache.size,
          localLlm: llmSummary
        }
      });
      };
      if (message.localAi && message.localAi.enabled) {
        self.postMessage({ type: 'stage', title: 'Local AI ranking', detail: 'Reranking selected catalogue candidates on this computer.', percent: 94 });
        rerankWithLocalOllama(message, results, context, fuzzyFind, resultCache, resultInputs, rowIndexes)
          .then(summary => {
            self.postMessage({ type: 'llm-status', kind: 'success', message: `Local AI reviewed ${summary.considered} unique service names and reranked ${summary.applied} rows. Every row still requires manual verification.` });
            if (summary.available > summary.considered) self.postMessage({ type: 'llm-status', kind: '', message: `The local AI limit was ${summary.considered} unique names; remaining results use regular matching.` });
            finish(summary);
          })
          .catch(error => {
            self.postMessage({ type: 'llm-status', kind: 'error', message: `Local AI ranking unavailable; regular suggestions were kept. ${error.message}` });
            finish({ applied: 0, considered: 0, unavailable: true });
          });
      } else finish();
    }
  }
  setTimeout(processBatch, 0);
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type !== 'MATCH') return;
  try { processMatching(message); }
  catch (error) { self.postMessage({ type: 'error', error: error && error.message ? error.message : String(error) }); }
};

function enrichResultWithClinical(result, rawName, standardizedName, ctx) {
  if (!result || typeof result !== 'object') return result;
  const raw = String(rawName || '').trim();
  const standardized = String(standardizedName || '').trim();
  const inputText = standardized || raw;
  const candidateText = String(result['Auto Candidate Service Display Name'] || result['Auto Candidate Standardized Service Name'] || '').trim();
  result['Original Service Name'] = raw;
  const inputAttrs = extractClinicalAttributes(inputText);
  result['Input Clinical Attributes'] = JSON.stringify(inputAttrs);
  let assessment = null;
  let candidateAttrs = null;
  if (candidateText) {
    candidateAttrs = extractClinicalAttributes(candidateText);
    result['Candidate Clinical Attributes'] = JSON.stringify(candidateAttrs);
    assessment = assessClinicalEquivalence(inputAttrs, candidateAttrs);
    result['Clinical Equivalence Explanation'] = assessment.explanation;
    result['Matching Attributes'] = assessment.matching.join('; ');
    result['Missing Attributes'] = assessment.missing.join('; ');
    result['Critical Differences'] = assessment.criticalConflicts.join('; ');
    result['Clinical Compatibility'] = assessment.criticalConflicts.length
      ? 'Conflict'
      : (assessment.missing.length ? 'Partial / missing attributes' : (assessment.compatible ? 'Compatible' : 'Conflict'));
  } else {
    result['Candidate Clinical Attributes'] = '';
    result['Clinical Equivalence Explanation'] = 'No catalogue candidate was available for clinical comparison.';
    result['Matching Attributes'] = '';
    result['Missing Attributes'] = inputAttrs.unknown.join('; ');
    result['Critical Differences'] = '';
    result['Clinical Compatibility'] = 'Not evaluated';
  }

  const status = String(result['Auto Match Status / Review Required'] || '').toUpperCase();
  const candidateCode = String(result['Auto Candidate Service Code'] || '').trim();
  let codeSystem = 'Unknown (not specified in reference catalogue)';
  let codeSystemVersion = 'Unknown';
  let verification = candidateText ? 'Catalogue entry present; code system/version not supplied by reference catalogue' : 'No candidate';
  if (ctx && candidateCode && ctx.codeMap) {
    const records = ctx.codeMap.get(candidateCode) || [];
    const rec = records[0];
    if (rec) {
      if (rec.codeSystem) codeSystem = rec.codeSystem;
      if (rec.codeSystemVersion) codeSystemVersion = rec.codeSystemVersion;
      verification = codeSystem === 'Unknown (not specified in reference catalogue)'
        ? 'Catalogue entry present; code system/version not supplied by reference catalogue'
        : ('Catalogue entry present; code system "' + codeSystem + '" recorded (not independently verified)');
    }
  }
  result['Code System'] = codeSystem;
  result['Code System Version'] = codeSystemVersion;
  result['Reference Verification Status'] = verification;

  result['Text Match Evidence'] = (result['Auto Match Method'] || 'None') + '; score ' + result['Auto Match Score'];
  let decision = 'REVIEW_REQUIRED';
  if (!candidateText) decision = 'NO_SAFE_MATCH';
  else if (status.startsWith('EXACT MATCH') && !result['Critical Differences'] && !result['Missing Attributes']) decision = 'VERIFIED_CANDIDATE';
  else if (result['Critical Differences'] || result['Missing Attributes']) decision = 'REVIEW_REQUIRED';
  else if (status.includes('AMBIGUOUS')) decision = 'REVIEW_REQUIRED';
  else if (status.includes('EXISTING CODE DISAGREEMENT') || status.includes('CATEGORY CONFLICT') || status.includes('LOW CONFIDENCE')) decision = 'REVIEW_REQUIRED';
  else decision = 'REVIEW_REQUIRED';
  result['Decision'] = decision;

  if (result['Critical Differences']) result['Decision Reason'] = 'Critical clinical conflict: ' + result['Critical Differences'];
  else if (result['Missing Attributes']) result['Decision Reason'] = 'Required clinical attributes missing: ' + result['Missing Attributes'];
  else if (status.includes('AMBIGUOUS')) result['Decision Reason'] = 'Multiple clinically plausible catalogue codes';
  else if (status.includes('EXISTING CODE DISAGREEMENT')) result['Decision Reason'] = 'Suggested code differs from the existing vendor code';
  else if (decision === 'VERIFIED_CANDIDATE') result['Decision Reason'] = 'Normalized names match exactly with one unique catalogue code and no clinical conflicts';
  else if (!candidateText) result['Decision Reason'] = 'No catalogue candidate found';
  else result['Decision Reason'] = 'Requires human review';
  result['Semantic Similarity'] = 'Not evaluated (no embedding model configured)';
  result['Clinical AI/Model Version'] = 'clinical-rules-v2';
  return result;
}

function matchService(rawName, standardizedName, existingCode, ctx, fuzzyFind, thresholds, sourceContext = {}) {
  const result = matchServiceCore(rawName, standardizedName, existingCode, ctx, fuzzyFind, thresholds, sourceContext);
  return enrichResultWithClinical(result, rawName, standardizedName, ctx);
}