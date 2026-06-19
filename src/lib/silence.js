// silence.js — the canonical taxonomy of WHY a result is "none".
//
// The service worker is the single source of truth for the silence reason: a
// "none" can originate at the classification, retrieval, or synthesis stage, and
// only code sees all three. The SYNTHESIS model may emit one of a small enum of
// reason codes; everything else is derived here deterministically. The panel maps
// the final code to fixed copy and NEVER renders model-generated reason prose.

// The ONLY reason codes the synthesis model is allowed to emit (Call 2 "none").
// Anything outside this set is treated as absent → no_material_counter.
export const SYNTH_NONE_REASONS = new Set([
  "evidence_off_target",
  "evidence_too_weak",
  "no_material_counter",
  "normative_unresolved",
]);

// Every code the panel must have copy for. (= classification + retrieval codes
// + the synthesis enum + the one code derived in service-worker code.)
export const ALL_NONE_REASONS = new Set([
  // classification stage — deterministic from cls
  "straight_reporting",
  "no_contestable_claim",
  // retrieval stage — deterministic from fetched sources
  "no_sources_returned",
  "no_usable_evidence",
  // synthesis stage — emitted by the model, validated against SYNTH_NONE_REASONS
  "evidence_off_target",
  "evidence_too_weak",
  "no_material_counter",
  "normative_unresolved",
  // derived in code from a synthesis reason + article_type
  "opinion_no_evidence_basis",
]);

// !analyzable → which classification-stage code. Opinion/analysis pieces that
// carry no checkable claim read differently from a straight factual report.
export function classificationSilenceReason(cls) {
  const t = cls && cls.article_type;
  if (t === "opinion" || t === "analysis") return "no_contestable_claim";
  return "straight_reporting";
}

// Validate the model's synthesis "none" reason against the allowed enum, then
// derive the opinion-specific variant. Unknown/absent reason → no_material_counter.
// Only no_material_counter converts to the opinion code (per the v1 spec): the
// other codes describe an evidence problem that holds regardless of article_type.
export function synthesisSilenceReason(rawReason, cls) {
  const reason = SYNTH_NONE_REASONS.has(rawReason) ? rawReason : "no_material_counter";
  if (reason === "no_material_counter" && cls && cls.article_type === "opinion") {
    return "opinion_no_evidence_basis";
  }
  return reason;
}

// Further reading is shown for evidence-stage silence only — never for the
// classification-stage codes, where there was no evidence search to report.
export function silenceShowsFurther(reason) {
  return reason !== "straight_reporting" && reason !== "no_contestable_claim";
}

// examined_claim is shown only when we actually investigated a concrete claim.
// Suppressed for classification-stage silence and when the classifier produced
// no meaningful claim. Returns the trimmed claim, or "" when it should be hidden.
export function silenceExaminedClaim(reason, coreClaim) {
  if (reason === "straight_reporting" || reason === "no_contestable_claim") return "";
  return typeof coreClaim === "string" && coreClaim.trim() ? coreClaim.trim() : "";
}
