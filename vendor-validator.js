/* Pakistani vendor-name validation module.
   Separate from clinical matching and Excel processing. */
'use strict';

function vvNorm(value) {
  if (value == null) return '';
  return String(value).normalize('NFKC').toLocaleLowerCase().trim()
    .replace(/&/g, ' and ')
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

function vvLevenshtein(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function loadVendorReference(reference) {
  const vendors = (reference && Array.isArray(reference.vendors)) ? reference.vendors : [];
  const normalized = vendors.map(vendor => ({
    canonical: String(vendor.canonical || '').trim(),
    canonicalNorm: vvNorm(vendor.canonical),
    aliases: (vendor.aliases || []).map(a => String(a).trim()),
    aliasNorms: (vendor.aliases || []).map(a => vvNorm(a)),
    category: vendor.category || null,
    city: vendor.city || null,
    website: vendor.website || null,
    sourceReference: vendor.sourceReference || null,
    verificationDate: vendor.verificationDate || null,
    verificationStatus: vendor.verificationStatus || 'unverified'
  }));
  return { version: reference && reference.version, policy: reference && reference.policy, vendors: normalized };
}

function validateVendorName(name, reference, options) {
  options = options || {};
  const original = String(name == null ? '' : name).trim();
  const normalized = vvNorm(original);
  const result = {
    original,
    normalized,
    status: 'not_in_directory',
    canonical: null,
    suggestedCanonical: null,
    reason: '',
    confidence: 0,
    inDirectory: false,
    reviewRequired: true,
    correctionHistoryEntry: null
  };
  if (!normalized) {
    result.status = 'blank';
    result.reason = 'Vendor name is blank';
    return result;
  }
  const ref = loadVendorReference(reference);
  const maxDistance = (options.maxEditDistance != null) ? options.maxEditDistance : ((ref.policy && ref.policy.maxEditDistanceForSuggestion) || 2);
  const autoCorrect = (options.autoCorrect != null) ? options.autoCorrect : ((ref.policy && ref.policy.autoCorrect) === true);

  // Exact canonical or alias match.
  for (const vendor of ref.vendors) {
    if (normalized === vendor.canonicalNorm) {
      result.status = 'verified_match';
      result.canonical = vendor.canonical;
      result.suggestedCanonical = vendor.canonical;
      result.inDirectory = true;
      result.reviewRequired = false;
      result.confidence = 1;
      result.reason = 'Exact match to canonical vendor name in reference directory';
      return result;
    }
    const aliasIndex = vendor.aliasNorms.indexOf(normalized);
    if (aliasIndex >= 0) {
      result.status = 'alias_match';
      result.canonical = vendor.canonical;
      result.suggestedCanonical = vendor.canonical;
      result.inDirectory = true;
      result.reviewRequired = false;
      result.confidence = 0.98;
      result.reason = 'Matched an approved alias for ' + vendor.canonical;
      return result;
    }
  }

  // Likely spelling error: nearest vendor within edit distance.
  let best = null;
  for (const vendor of ref.vendors) {
    const candidates = [vendor.canonicalNorm].concat(vendor.aliasNorms);
    for (const candidateNorm of candidates) {
      const distance = vvLevenshtein(normalized, candidateNorm);
      if (!best || distance < best.distance) {
        best = { vendor, candidateNorm, distance };
      }
    }
  }
  if (best && best.distance > 0 && best.distance <= maxDistance) {
    result.status = 'likely_misspelling';
    result.canonical = best.vendor.canonical;
    result.suggestedCanonical = best.vendor.canonical;
    result.inDirectory = false;
    result.reviewRequired = true;
    result.confidence = Math.max(0, 1 - (best.distance / Math.max(normalized.length, best.candidateNorm.length, 1)));
    result.reason = 'Likely spelling variation of ' + best.vendor.canonical + ' (edit distance ' + best.distance + '); requires human confirmation';
    if (autoCorrect) {
      result.canonical = best.vendor.canonical;
    }
    return result;
  }

  result.status = 'not_in_directory';
  result.reason = 'Vendor not found in reference directory; retained for audit and manual review';
  result.reviewRequired = true;
  result.confidence = 0;
  return result;
}

function createReviewQueue() {
  const items = [];
  return {
    add(item) { items.push(Object.assign({ queuedAt: new Date().toISOString() }, item)); },
    list() { return items.slice(); },
    size() { return items.length; }
  };
}

function appendCorrectionHistory(history, entry) {
  const record = Object.assign({ recordedAt: new Date().toISOString() }, entry || {});
  history.push(record);
  return record;
}

const VendorValidator = {
  norm: vvNorm,
  levenshtein: vvLevenshtein,
  loadReference: loadVendorReference,
  validate: validateVendorName,
  createReviewQueue,
  appendCorrectionHistory
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = VendorValidator;
}
if (typeof globalThis !== 'undefined') {
  globalThis.VendorValidator = VendorValidator;
}