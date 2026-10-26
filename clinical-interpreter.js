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
    [/\bcbc\b/g, 'complete blood count'],
    [/\bua\b/g, 'urinalysis'],
    [/\bctpa\b/g, 'computed tomography pulmonary angiography'],
    [/\bmra\b/g, 'magnetic resonance angiography']
  ];
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  return text;
}

const CI_BODY_SITES = ['head','brain','neck','chest','thorax','abdomen','pelvis','spine','cervical','thoracic','lumbar','sacral','shoulder','arm','elbow','wrist','hand','hip','knee','ankle','foot','leg','thigh','heart','lung','liver','kidney','bladder','prostate','breast','thyroid','sinus','eye','ear'];
const CI_MODALITY_TERMS = [
  ['computed tomography', ['ct','computed tomography','computerized tomography','computerised tomography']],
  ['magnetic resonance imaging', ['mri','magnetic resonance','mr imaging']],
  ['ultrasound', ['ultrasound','ultrasonography','usg','sonography','doppler']],
  ['radiograph', ['x ray','x-ray','xray','radiograph','radiography']],
  ['laboratory', ['lab','laboratory','blood test','urine test','serology','biochemistry','pathology']],
  ['electrocardiogram', ['ecg','ekg','electrocardiogram','electrocardiograph']],
  ['endoscopy', ['endoscopy','colonoscopy','gastroscopy','bronchoscopy','cystoscopy']],
  ['biopsy', ['biopsy','fnac','fine needle aspiration']]
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

function ciCriticalAttributesFor(input, candidate) {
  const critical = new Set(['modality']);
  const mods = [input.modality, candidate.modality].map(v => String(v || '').toLowerCase());
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
    unknown: []
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
  if (/\bwith contrast\b/.test(normalized)) attributes.contrast = 'with contrast';
  else if (/\bwithout contrast\b|\bnon[- ]?contrast\b|\bplain\b/.test(normalized)) attributes.contrast = 'without contrast';
  else if (/\bcontrast\b/.test(normalized)) attributes.contrast = 'contrast mentioned';

  for (const site of CI_BODY_SITES) {
    if (ciHasTerm(normalized, site)) { attributes.bodySite = site; attributes.explicit.bodySite = site; break; }
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
  if (!purposeFound) {
    attributes.purpose = 'diagnostic';
    attributes.inferred.purpose = 'diagnostic (default, not explicitly stated)';
  } else {
    attributes.explicit.purpose = attributes.purpose;
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
    if (a && b) {
      if (ciNorm(String(a)) === ciNorm(String(b))) matching.push(attr);
      else {
        conflicts.push(attr + ': ' + a + ' vs ' + b);
        if (critical.includes(attr)) criticalConflicts.push(attr + ' differs (' + a + ' vs ' + b + ')');
      }
    } else if (a || b) {
      missing.push(attr + ' missing in ' + (a ? 'candidate' : 'input'));
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
  if (attrs.contrast && attrs.contrast !== 'unknown') parts.push(attrs.contrast);
  if (attrs.specimen) parts.push(attrs.specimen + ' specimen');
  if (attrs.method) parts.push(attrs.method);
  if (attrs.laterality) parts.push(attrs.laterality);
  if (attrs.population) parts.push(attrs.population);
  if (attrs.purpose) parts.push(attrs.purpose + ' purpose');
  if (!parts.length) return attrs.rawText ? '"' + attrs.rawText + '"' : 'an unspecified service';
  return parts.join(', ');
}


// Compatibility aliases used by matcher-worker.js and existing tests.
globalThis.extractClinicalAttributes = ciExtractClinicalAttributes;
globalThis.assessClinicalEquivalence = ciAssessClinicalEquivalence;
globalThis.criticalAttributesFor = ciCriticalAttributesFor;
globalThis.describeClinicalAttributes = ciDescribeClinicalAttributes;
globalThis.ciNorm = ciNorm;
globalThis.ClinicalInterpreter = {
  norm: ciNorm,
  expandAbbreviations: ciExpandAbbreviations,
  extractClinicalAttributes: ciExtractClinicalAttributes,
  assessClinicalEquivalence: ciAssessClinicalEquivalence,
  criticalAttributesFor: ciCriticalAttributesFor,
  describeClinicalAttributes: ciDescribeClinicalAttributes,
  version: 'clinical-rules-v2'
};
