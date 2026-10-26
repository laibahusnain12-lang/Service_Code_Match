# Clinical Intelligence Layer

This portal now augments the existing matching engine with a deterministic, rule-based clinical interpretation layer. The original exact/normalized/synonym/fuzzy engine remains authoritative for candidate retrieval; clinical logic adds explainability and blocks unsafe auto-acceptance.

## New result fields
- Original Service Name
- Input Clinical Attributes / Candidate Clinical Attributes (JSON)
- Text Match Evidence
- Clinical Equivalence Explanation
- Matching Attributes
- Missing Attributes
- Critical Differences
- Clinical Compatibility
- Reference Verification Status
- Decision (Exact match / Probable equivalent / Manual review / No safe match)
- Decision Reason
- Semantic Similarity (not evaluated without an embedding model)
- Clinical AI/Model Version

## Critical attribute conflicts
Contrast status, specimen, test method, laterality, body site, and population differences are treated as critical for relevant service types and prevent auto-approval.

## Safety
- AI/LLM (Ollama) is used only for ranking supplied candidates and labeling; it cannot create codes.
- Unverified candidates are labeled; catalogue source/version metadata is marked as not supplied when unavailable.
- Invalid or missing clinical details force manual review.

## Testing
- `node tests/worker-smoke-test.js`
- `node tests/clinical-intelligence-test.js`