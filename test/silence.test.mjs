// silence.test.mjs — exercises every "articulate silence" reason path.
//
//   node test/silence.test.mjs
//
// Pure-logic tests: no network, no chrome, no DOM. Covers the canonical reason
// taxonomy (silence.js), the panel copy map (panel.js), and the malformed-
// classification guard (api-client.js parseClassification).

import assert from "node:assert/strict";
import {
  SYNTH_NONE_REASONS, ALL_NONE_REASONS,
  classificationSilenceReason, synthesisSilenceReason,
  silenceShowsFurther, silenceExaminedClaim,
} from "../src/lib/silence.js";
import { REASON_COPY } from "../src/content/ui/panel.js";
import { parseClassification } from "../src/lib/api-client.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (err) { console.error("  ✗ " + name + "\n    " + (err.message || err)); process.exitCode = 1; }
}

// ── Classification-stage reasons ───────────────────────────────────────────────
console.log("classificationSilenceReason");
test("news → straight_reporting", () => assert.equal(classificationSilenceReason({ article_type: "news" }), "straight_reporting"));
test("other → straight_reporting", () => assert.equal(classificationSilenceReason({ article_type: "other" }), "straight_reporting"));
test("missing type → straight_reporting", () => assert.equal(classificationSilenceReason({}), "straight_reporting"));
test("opinion → no_contestable_claim", () => assert.equal(classificationSilenceReason({ article_type: "opinion" }), "no_contestable_claim"));
test("analysis → no_contestable_claim", () => assert.equal(classificationSilenceReason({ article_type: "analysis" }), "no_contestable_claim"));

// ── Synthesis-stage reasons + opinion derivation ───────────────────────────────
console.log("synthesisSilenceReason");
for (const code of SYNTH_NONE_REASONS) {
  test(`${code} passes through (news)`, () => assert.equal(synthesisSilenceReason(code, { article_type: "news" }), code));
}
test("empty reason → no_material_counter", () => assert.equal(synthesisSilenceReason("", { article_type: "news" }), "no_material_counter"));
test("undefined reason → no_material_counter", () => assert.equal(synthesisSilenceReason(undefined, { article_type: "news" }), "no_material_counter"));
test("unknown code → no_material_counter", () => assert.equal(synthesisSilenceReason("totally_made_up", { article_type: "news" }), "no_material_counter"));
test("no_material_counter + opinion → opinion_no_evidence_basis", () => assert.equal(synthesisSilenceReason("no_material_counter", { article_type: "opinion" }), "opinion_no_evidence_basis"));
test("unknown + opinion → opinion_no_evidence_basis", () => assert.equal(synthesisSilenceReason("garbage", { article_type: "opinion" }), "opinion_no_evidence_basis"));
test("evidence_off_target + opinion stays off_target (only NMC converts)", () => assert.equal(synthesisSilenceReason("evidence_off_target", { article_type: "opinion" }), "evidence_off_target"));
test("evidence_too_weak + opinion stays too_weak", () => assert.equal(synthesisSilenceReason("evidence_too_weak", { article_type: "opinion" }), "evidence_too_weak"));
test("null cls is safe", () => assert.equal(synthesisSilenceReason("normative_unresolved", null), "normative_unresolved"));

// ── Further-reading visibility ─────────────────────────────────────────────────
console.log("silenceShowsFurther");
test("hidden for straight_reporting", () => assert.equal(silenceShowsFurther("straight_reporting"), false));
test("hidden for no_contestable_claim", () => assert.equal(silenceShowsFurther("no_contestable_claim"), false));
for (const code of ["no_sources_returned", "no_usable_evidence", "evidence_off_target", "evidence_too_weak", "no_material_counter", "normative_unresolved", "opinion_no_evidence_basis"]) {
  test(`shown for ${code}`, () => assert.equal(silenceShowsFurther(code), true));
}

// ── examined_claim visibility ──────────────────────────────────────────────────
console.log("silenceExaminedClaim");
test("hidden for straight_reporting even with a claim", () => assert.equal(silenceExaminedClaim("straight_reporting", "Trump is the antichrist"), ""));
test("hidden for no_contestable_claim", () => assert.equal(silenceExaminedClaim("no_contestable_claim", "some claim"), ""));
test("hidden when claim empty", () => assert.equal(silenceExaminedClaim("evidence_off_target", ""), ""));
test("hidden when claim whitespace", () => assert.equal(silenceExaminedClaim("evidence_off_target", "   "), ""));
test("hidden when claim missing", () => assert.equal(silenceExaminedClaim("no_material_counter", undefined), ""));
test("trimmed claim shown for evidence reason", () => assert.equal(silenceExaminedClaim("evidence_off_target", "  Rent control prevents poverty  "), "Rent control prevents poverty"));

// ── Taxonomy ↔ copy consistency (the load-bearing guard) ───────────────────────
console.log("taxonomy / copy consistency");
test("every reason code has copy with title+body", () => {
  for (const code of ALL_NONE_REASONS) {
    const c = REASON_COPY[code];
    assert.ok(c, `missing copy for ${code}`);
    assert.ok(c.title && c.title.length, `empty title for ${code}`);
    assert.ok(c.body && c.body.length, `empty body for ${code}`);
  }
});
test("no orphan copy entries", () => {
  for (const code of Object.keys(REASON_COPY)) {
    assert.ok(ALL_NONE_REASONS.has(code), `copy for unknown code ${code}`);
  }
});
test("synthesis enum is a subset of all reasons", () => {
  for (const code of SYNTH_NONE_REASONS) assert.ok(ALL_NONE_REASONS.has(code), `${code} not in ALL_NONE_REASONS`);
});
test("panel falls back to no_material_counter for an unknown reason", () => {
  // Mirrors renderNoneHtml's fallback: REASON_COPY[reason] || REASON_COPY.no_material_counter
  const copy = REASON_COPY["something_unexpected"] || REASON_COPY.no_material_counter;
  assert.equal(copy, REASON_COPY.no_material_counter);
});

// ── Malformed classification → technical error (never a silence) ───────────────
console.log("parseClassification validity");
test("throws on empty string", () => assert.throws(() => parseClassification(""), /try again/i));
test("throws on non-JSON", () => assert.throws(() => parseClassification("the model said no"), /try again/i));
test("throws when analyzable missing", () => assert.throws(() => parseClassification('{"article_type":"news"}')));
test("throws when analyzable not boolean", () => assert.throws(() => parseClassification('{"analyzable":"yes"}')));
test("parses analyzable:true with safe defaults", () => {
  const c = parseClassification('{"analyzable":true}');
  assert.equal(c.analyzable, true);
  assert.equal(c.article_type, "news");
  assert.equal(c.claim_type, "empirical");
  assert.equal(c.claim_strength, 0.5);
  assert.deepEqual(c.required_geography, []);
});
test("preserves analyzable:false + fields", () => {
  const c = parseClassification('{"analyzable":false,"article_type":"opinion","core_claim":"x"}');
  assert.equal(c.analyzable, false);
  assert.equal(c.article_type, "opinion");
  assert.equal(c.core_claim, "x");
});
test("extracts JSON embedded in prose", () => {
  const c = parseClassification('Sure! {"analyzable":true,"topic":"health"} done');
  assert.equal(c.analyzable, true);
  assert.equal(c.topic, "health");
});
test("clamps claim_strength to [0,1]", () => {
  assert.equal(parseClassification('{"analyzable":true,"claim_strength":1.7}').claim_strength, 1);
  assert.equal(parseClassification('{"analyzable":true,"claim_strength":-3}').claim_strength, 0);
});

console.log(`\n${passed} passed` + (process.exitCode ? " — WITH FAILURES" : ""));
