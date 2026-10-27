/* Clinical interpretation layer for the Service Code Match Portal.
   Independent of Excel import/export, IndexedDB, and final approval logic. */
'use strict';

function ciNorm(value) {
  if (value == null) return '';
  return String(value).normalize('NFKC').toLocaleLowerCase().trim()
    .replace(/&/g, ' and ')
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

function ciExpandAbbreviations(value) {
  let text = ciNorm(value);
  const replacements = [
    [/\bct\b/g, 'computed tomography'],
    [/\bmri\b/g, 'magnetic resonance imaging'],
    [/\busg\b/g, 'ultrasound'],
    [/\bultrasound\b/g, 'ultrasound'],
    [/\becg\b/g, 'electrocardiogram'],
    [/\bekg\b/g, 'electrocardiogram'],
    [/\bx\s*ray\b/g, 'radiograph'],
    [/\bxray\b/g, 'radiograph'],
    [/\bc\s*section\b/g, 'cesarean section'],
    [/\bcaesarean\b/g, 'cesarean'],
    [/\bcbc\b/g, 'complete blood count'],
    [/\bua\b/g, 'urinalysis'],
    [/\bctpa\b/g, 'computed tomography pulmonary angiography'],
    [/\bmra\b/g, 'magnetic resonance angiography']
  ];
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  return text;
}

const CI_BODY_SITES = ['head','brain','neck','chest','thorax','abdomen','pelvis','spine','cervical','thoracic','lumbar','sacral','shoulder','arm','elbow','wrist','hand','hip','knee','ankle','foot','leg','thigh','heart','lung','liver','kidney','bladder','prostate','breast','thyroid','sinus','eye','ear'];
const CI_BODY_SYSTEMS = { head:'neurological', brain:'neurological', neck:'head and neck', chest:'thoracic', thorax:'thoracic', abdomen:'abdominal', pelvis:'pelvic', spine:'musculoskeletal', cervical:'musculoskeletal', thoracic:'thoracic', lumbar:'musculoskeletal', sacral:'musculoskeletal', shoulder:'musculoskeletal', arm:'musculoskeletal', elbow:'musculoskeletal', wrist:'musculoskeletal', hand:'musculoskeletal', hip:'musculoskeletal', knee:'musculoskeletal', ankle:'musculoskeletal', foot:'musculoskeletal', leg:'musculoskeletal', thigh:'musculoskeletal', heart:'cardiovascular', lung:'respiratory', liver:'gastrointestinal', kidney:'renal', bladder:'urinary', prostate:'genitourinary', breast:'breast', thyroid:'endocrine', sinus:'head and neck', eye:'ophthalmological', ear:'otolaryngological' };
const CI_MODALITY_TERMS = [
  ['computed tomography', ['ct','computed tomography','computerized tomography','computerised tomography']],
  ['magnetic resonance imaging', ['mri','magnetic resonance','mr imaging']],
  ['ultrasound', ['ultrasound','ultrasonography','usg','sonography','doppler']],
  ['radiograph', ['x ray','x-ray','xray','radiograph','radiography']],
  ['laboratory', ['lab','laboratory','blood test','urine test','serology','biochemistry','pathology']],
  ['electrocardiogram', ['ecg','ekg','electrocardiogram','electrocardiograph']],
  ['endoscopy', ['endoscopy','colonoscopy','gastroscopy','bronchoscopy','cystoscopy']],
  ['biopsy', ['biopsy','fnac','fine needle aspiration']],
  ['laser', ['laser','laser therapy','laser treatment']],
  ['wax', ['wax','waxing','wax therapy']]
];
const CI_SPECIMEN_TERMS = ['blood','serum','plasma','urine','stool','sputum','swab','tissue','csf','saliva','bone marrow'];
const CI_METHOD_TERMS = ['culture','pcr','elisa','microscopy','histopathology','cytology','immunoassay','chromatography','spectrometry','electrophoresis'];
const CI_POPULATION_TERMS = ['pediatric','paediatric','child','adult','pregnant','pregnancy','neonatal','geriatric'];
const CI_PURPOSE_TERMS = [
  ['screening', ['screening','screen']],
  ['diagnostic', ['diagnostic','diagnosis','detect','detection','evaluation','assess','assessment']],
  ['therapeutic', ['therapeutic','treatment','therapy','intervention','procedure']],
  ['monitoring', ['monitoring','follow up','follow-up','surveillance']]
];

function ciHasTerm(text, term) {
  return new RegExp('\\b' + String(term).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '\\b').test(text);
}

function ciIsUnknown(value) {
  const normalized = ciNorm(String(value == null ? '' : value));
  return normalized === '' || normalized === 'unknown' || normalized === 'not specified' || normalized === 'unspecified';
}


function ciCriticalAttributesFor(input, candidate) {
  const critical = new Set();
  const mods = [input.modality, candidate.modality].map(v => String(v || '').toLowerCase());
  if (input.modality || candidate.modality) critical.add('modality');
  if (mods.some(m => m.includes('computed tomography') || m.includes('magnetic resonance'))) critical.add('contrast');
  if (mods.some(m => m.includes('laboratory')) || input.specimen || candidate.specimen || input.method || candidate.method) {
    critical.add('specimen');
    critical.add('method');
  }
  if (input.bodySite || candidate.bodySite) critical.add('bodySite');
  if (input.laterality || candidate.laterality) critical.add('laterality');
  if (input.population || candidate.population) critical.add('population');
  if (input.purpose && candidate.purpose) critical.add('purpose');
  if ((input.components && input.components.length) || (candidate.components && candidate.components.length)) critical.add('components');
  return [...critical];
}
function ciExtractClinicalAttributes(text) {
  const rawText = String(text || '').trim();
  const normalizedBase = ciNorm(rawText);
  const normalized = ciExpandAbbreviations(normalizedBase);
  const attributes = {
    rawText,
    serviceType: '',
    clinicalDomain: '',
    purpose: '',
    bodySite: '',
    organSystem: '',
    modality: '',
    contrast: 'unknown',
    specimen: '',
    method: '',
    laterality: '',
    components: [],
    population: '',
    qualifiers: [],
    exclusions: [],
    explicit: {},
    inferred: {},
    unknown: [],
    uncertainties: []
  };
  if (!normalized) {
    attributes.unknown = ['service description'];
    return attributes;
  }

  for (const [label, needles] of CI_MODALITY_TERMS) {
    if (needles.some(needle => ciHasTerm(normalized, needle))) {
      attributes.modality = label;
      attributes.explicit.modality = label;
      break;
    }
  }
  if (!attributes.modality) {
    const therapyMatch = normalized.match(/\b([a-z]+)\s+(?:therapy|treatment)\b/);
    if (therapyMatch && therapyMatch[1] && !['therapy','treatment'].includes(therapyMatch[1])) {
      attributes.modality = therapyMatch[1];
      attributes.explicit.modality = therapyMatch[1];
    }
  }
  if (/\bwith contrast\b/.test(normalized)) attributes.contrast = 'with contrast';
  else if (/\bwithout contrast\b|\bnon[- ]?contrast\b|\bplain\b/.test(normalized)) attributes.contrast = 'without contrast';
  else if (/\bcontrast\b/.test(normalized)) attributes.contrast = 'contrast mentioned';

  for (const site of CI_BODY_SITES) {
    if (ciHasTerm(normalized, site)) { attributes.bodySite = site; attributes.bodySystem = CI_BODY_SYSTEMS[site] || ''; attributes.explicit.bodySite = site; break; }
  }
  for (const specimen of CI_SPECIMEN_TERMS) {
    if (ciHasTerm(normalized, specimen)) { attributes.specimen = specimen; attributes.explicit.specimen = specimen; break; }
  }
  for (const method of CI_METHOD_TERMS) {
    if (ciHasTerm(normalized, method)) { attributes.method = method; attributes.explicit.method = method; break; }
  }
  if (/\bleft\b/.test(normalized)) attributes.laterality = 'left';
  else if (/\bright\b/.test(normalized)) attributes.laterality = 'right';
  else if (/\bbilateral\b/.test(normalized)) attributes.laterality = 'bilateral';

  let purposeFound = false;
  for (const [label, needles] of CI_PURPOSE_TERMS) {
    if (needles.some(needle => ciHasTerm(normalized, needle))) { attributes.purpose = label; purposeFound = true; break; }
  }
  if (purposeFound) {
    attributes.explicit.purpose = attributes.purpose;
  } else {
    attributes.uncertainties = attributes.uncertainties || [];
    attributes.uncertainties.push('Clinical purpose was not explicitly stated in the description.');
  }

  for (const population of CI_POPULATION_TERMS) {
    if (ciHasTerm(normalized, population)) { attributes.population = population; attributes.explicit.population = population; break; }
  }

  const exclusionMatch = normalized.match(/\b(?:without|excluding|not including)\b(.*)$/);
  if (exclusionMatch && exclusionMatch[1].trim()) {
    attributes.exclusions = exclusionMatch[1].split(/\band\b|,/).map(part => part.trim()).filter(Boolean);
  }
  const withMatch = normalized.match(/\bwith\b(.*)$/);
  if (withMatch && withMatch[1].trim()) {
    attributes.components = withMatch[1].split(/\band\b|,/).map(part => part.trim()).filter(Boolean);
    if (attributes.components.length) attributes.explicit.components = attributes.components.slice();
  }

  if (attributes.modality === 'laboratory' || attributes.specimen || attributes.method) {
    attributes.serviceType = 'laboratory test';
    attributes.clinicalDomain = 'pathology';
  } else if (attributes.modality && attributes.modality !== 'laboratory') {
    attributes.serviceType = 'imaging study';
    attributes.clinicalDomain = 'radiology';
  } else if (/consultation|visit|review/.test(normalized)) {
    attributes.serviceType = 'consultation';
    attributes.clinicalDomain = 'clinical service';
  } else if (/biopsy/.test(normalized)) {
    attributes.serviceType = 'procedure';
    attributes.clinicalDomain = 'procedure';
  } else {
    attributes.serviceType = 'service';
    attributes.clinicalDomain = 'unknown';
  }

  const unknown = [];
  if (!attributes.modality) unknown.push('modality');
  if (!attributes.bodySite && attributes.serviceType === 'imaging study') unknown.push('body site');
  if (attributes.contrast === 'unknown' && (attributes.modality === 'computed tomography' || attributes.modality === 'magnetic resonance imaging')) unknown.push('contrast status');
  if (attributes.serviceType === 'laboratory test' && !attributes.specimen) unknown.push('specimen');
  if (attributes.serviceType === 'laboratory test' && !attributes.method) unknown.push('test method');
  attributes.unknown = unknown;
  return attributes;
}

function ciAssessClinicalEquivalence(input, candidate) {
  const matching = [];
  const missing = [];
  const conflicts = [];
  const criticalConflicts = [];
  const critical = ciCriticalAttributesFor(input, candidate);
  const simpleAttrs = ['modality','bodySite','contrast','specimen','method','laterality','population','purpose'];
  for (const attr of simpleAttrs) {
    const a = input[attr];
    const b = candidate[attr];
    const aPresent = !ciIsUnknown(a);
    const bPresent = !ciIsUnknown(b);
    if (aPresent && bPresent) {
      if (ciNorm(String(a)) === ciNorm(String(b))) matching.push(attr);
      else {
        conflicts.push(attr + ': ' + a + ' vs ' + b);
        if (critical.includes(attr)) criticalConflicts.push(attr + ' differs (' + a + ' vs ' + b + ')');
      }
    } else if (aPresent || bPresent) {
      missing.push(attr + ' missing in ' + (aPresent ? 'candidate' : 'input'));
    } else if (critical.includes(attr)) {
      missing.push(attr + ' unknown for both input and candidate');
    }
  }
  if (input.components && input.components.length && candidate.components && candidate.components.length) {
    const a = new Set(input.components.map(ciNorm));
    const b = new Set(candidate.components.map(ciNorm));
    const same = a.size === b.size && [...a].every(v => b.has(v));
    if (same) matching.push('components');
    else {
      conflicts.push('components: ' + input.components.join(', ') + ' vs ' + candidate.components.join(', '));
      if (critical.includes('components')) criticalConflicts.push('components differ (' + input.components.join(', ') + ' vs ' + candidate.components.join(', ') + ')');
    }
  } else if ((input.components && input.components.length) || (candidate.components && candidate.components.length)) {
    missing.push('components missing in ' + ((input.components && input.components.length) ? 'candidate' : 'input'));
  } else if (critical.includes('components')) {
    missing.push('components unknown for both input and candidate');
  }
  const compatible = conflicts.length === 0;
  const candidatePresent = !!candidate.rawText;
  let explanation = 'Input service is ' + ciDescribeClinicalAttributes(input) + '; candidate service is ' + ciDescribeClinicalAttributes(candidate) + '.';
  if (matching.length) explanation += ' Matching attributes: ' + matching.join(', ') + '.';
  if (conflicts.length) explanation += ' Differences: ' + conflicts.join('; ') + '.';
  else if (candidatePresent) explanation += ' No clinical conflicts detected.';
  if (missing.length) explanation += ' Missing attributes: ' + missing.join('; ') + '.';
  if (!candidatePresent) explanation = 'No catalogue candidate was available for clinical comparison.';
  return { matching, missing, conflicts, criticalConflicts, compatible, explanation, critical };
}

function ciDescribeClinicalAttributes(attrs) {
  const parts = [];
  if (attrs.modality) parts.push(attrs.modality);
  if (attrs.bodySite) parts.push(attrs.bodySite);
  if (attrs.contrast && !ciIsUnknown(attrs.contrast)) parts.push(attrs.contrast);
  if (attrs.specimen) parts.push(attrs.specimen + ' specimen');
  if (attrs.method) parts.push(attrs.method);
  if (attrs.laterality) parts.push(attrs.laterality);
  if (attrs.population) parts.push(attrs.population);
  if (attrs.purpose) parts.push(attrs.purpose + ' purpose');
  if (!parts.length) return attrs.rawText ? '"' + attrs.rawText + '"' : 'an unspecified service';
  return parts.join(', ');
}


function ciValidateClinicalAttributes(attrs) {
  const errors = [];
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) {
    errors.push('Clinical attributes must be an object.');
    return { valid: false, errors };
  }
  const required = ['rawText','serviceType','clinicalDomain','purpose','bodySite','bodySystem','modality','contrast','contrastRoute','specimen','method','laterality','components','population','exclusions','unknown','uncertainties','explicit','inferred','evidence'];
  for (const field of required) if (!(field in attrs)) errors.push('Missing required field: ' + field);
  const typeChecks = { rawText: 'string', serviceType: 'string', clinicalDomain: 'string', purpose: 'string', bodySite: 'string', bodySystem: 'string', modality: 'string', contrast: 'string', contrastRoute: 'string', specimen: 'string', method: 'string', laterality: 'string', components: 'array', population: 'string', exclusions: 'array', unknown: 'array', uncertainties: 'array', explicit: 'object', inferred: 'object', evidence: 'array' };
  for (const [field, type] of Object.entries(typeChecks)) {
    if (!(field in attrs)) continue;
    const value = attrs[field];
    const ok = type === 'string' ? typeof value === 'string' : type === 'array' ? Array.isArray(value) : type === 'object' ? (typeof value === 'object' && value !== null && !Array.isArray(value)) : true;
    if (!ok) errors.push('Field ' + field + ' must be a ' + type);
  }
  if (attrs.contrast !== undefined && !['unknown','with contrast','without contrast','contrast mentioned'].includes(attrs.contrast)) errors.push('contrast has an unsupported value');
  return { valid: errors.length === 0, errors };
}

function ciFinalDecision(result, assessment, context) {
  const r = result || {};
  const status = String(r['Auto Match Status / Review Required'] || '').toUpperCase();
  const candidateText = String(r['Auto Candidate Service Display Name'] || r['Auto Candidate Standardized Service Name'] || '').trim();
  const critical = String(r['Critical Differences'] || (assessment && Array.isArray(assessment.criticalConflicts) ? assessment.criticalConflicts.join('; ') : '') || '').trim();
  const missing = String(r['Missing Attributes'] || (assessment && Array.isArray(assessment.missing) ? assessment.missing.join('; ') : '') || '').trim();
  if (!candidateText) return { decision: 'NO_SAFE_MATCH', reason: 'No catalogue candidate found' };
  if (critical) return { decision: 'REVIEW_REQUIRED', reason: 'Critical clinical conflict: ' + critical };
  if (missing) return { decision: 'REVIEW_REQUIRED', reason: 'Required clinical attributes missing: ' + missing };
  if (status.includes('AMBIGUOUS')) return { decision: 'REVIEW_REQUIRED', reason: 'Multiple clinically plausible catalogue codes' };
  if (status.includes('EXISTING CODE DISAGREEMENT')) return { decision: 'REVIEW_REQUIRED', reason: 'Suggested code differs from the existing vendor code' };
  if (status.includes('CATEGORY CONFLICT')) return { decision: 'REVIEW_REQUIRED', reason: 'Catalogue category conflict requires review' };
  if (status.includes('LOW CONFIDENCE')) return { decision: 'REVIEW_REQUIRED', reason: 'Low text similarity requires review' };
  if (status.includes('EXACT MATCH') && !status.includes('AMBIGUOUS')) return { decision: 'VERIFIED_CANDIDATE', reason: 'Normalized names match exactly with one unique catalogue code and no clinical conflicts' };
  return { decision: 'REVIEW_REQUIRED', reason: 'Requires human review' };
}


// Compatibility aliases used by matcher-worker.js and existing tests.
globalThis.extractClinicalAttributes = ciExtractClinicalAttributes;
globalThis.assessClinicalEquivalence = ciAssessClinicalEquivalence;
globalThis.criticalAttributesFor = ciCriticalAttributesFor;
globalThis.describeClinicalAttributes = ciDescribeClinicalAttributes;
globalThis.ciNorm = ciNorm;
globalThis.ciIsUnknown = ciIsUnknown;
globalThis.validateClinicalAttributes = ciValidateClinicalAttributes;
globalThis.finalDecision = ciFinalDecision;
globalThis.ClinicalInterpreter = {
  norm: ciNorm,
  expandAbbreviations: ciExpandAbbreviations,
  extractClinicalAttributes: ciExtractClinicalAttributes,
  assessClinicalEquivalence: ciAssessClinicalEquivalence,
  criticalAttributesFor: ciCriticalAttributesFor,
  describeClinicalAttributes: ciDescribeClinicalAttributes,
  validateClinicalAttributes: ciValidateClinicalAttributes,
  finalDecision: ciFinalDecision,
  isUnknown: ciIsUnknown,
  version: 'clinical-rules-v3'
};
