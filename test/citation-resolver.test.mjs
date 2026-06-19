// Integration tests for the citation resolver + provenance gate.
//
// These cover the path the unit provenance tests do NOT:
//   model-emitted id  →  source lookup  →  quote verification  →  survival
// This is the seam where the v0.2.10 regression lived (model cited by stable
// token, lookup only knew sequential ids), so these fail on the old code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCitationMap, validateShown } from "../src/lib/citation-resolver.js";

// Mirrors the service-worker constant used for the mixed-result source firewall.
const EMPIRICAL_KINDS = new Set(["academic", "preprint", "government", "legal"]);

const DIABETES_EVIDENCE =
  "A large cohort study published in 2022 reported that regular physical exercise " +
  "lowered the risk of type two diabetes by thirty percent among middle aged adults " +
  "over a ten year follow up period.";
// A contiguous span of the above, long enough to pass checkProvenance thresholds.
const DIABETES_QUOTE =
  "regular physical exercise lowered the risk of type two diabetes by thirty percent among middle aged adults";

const OTHER_EVIDENCE =
  "An unrelated report on coastal erosion described how rising sea levels eroded " +
  "shoreline sediment across several northern estuaries during the past two decades.";

test("stable citation token resolves and survives provenance", () => {
  const source = {
    id: "s1",
    citationToken: "ABCD3F2GHJ",
    url: "https://openalex.org/W123",
    kind: "academic",
    evidence_text: DIABETES_EVIDENCE,
  };
  const map = buildCitationMap([source]);
  const used = [{ id: "ABCD3F2GHJ", evidence_quote: DIABETES_QUOTE }];

  const shown = validateShown(used, map);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].url, "https://openalex.org/W123");
});

test("legacy sequential id still resolves and survives", () => {
  const source = {
    id: "s1",
    citationToken: "ABCD3F2GHJ",
    url: "https://openalex.org/W123",
    kind: "academic",
    evidence_text: DIABETES_EVIDENCE,
  };
  const map = buildCitationMap([source]);
  const used = [{ id: "s1", evidence_quote: DIABETES_QUOTE }];

  const shown = validateShown(used, map);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].id, "s1");
});

test("unknown citation id is dropped without crashing", () => {
  const source = {
    id: "s1",
    citationToken: "ABCD3F2GHJ",
    url: "https://openalex.org/W123",
    kind: "academic",
    evidence_text: DIABETES_EVIDENCE,
  };
  const map = buildCitationMap([source]);
  const used = [{ id: "ZZZZNOPE99", evidence_quote: DIABETES_QUOTE }];

  const shown = validateShown(used, map);
  assert.equal(shown.length, 0);
});

test("wrong token with a quote from another source gets no cross-source rescue", () => {
  const diabetes = {
    id: "s1", citationToken: "TOKDIABET1",
    url: "https://openalex.org/W1", kind: "academic", evidence_text: DIABETES_EVIDENCE,
  };
  const erosion = {
    id: "s2", citationToken: "TOKEROS222",
    url: "https://openalex.org/W2", kind: "academic", evidence_text: OTHER_EVIDENCE,
  };
  const map = buildCitationMap([diabetes, erosion]);
  // Cite the erosion source but supply the diabetes quote — must fail.
  const used = [{ id: "TOKEROS222", evidence_quote: DIABETES_QUOTE }];

  const shown = validateShown(used, map);
  assert.equal(shown.length, 0);
});

test("mixed result: stable tokens resolve and source-kind firewall holds", () => {
  const academic = {
    id: "s1", citationToken: "TOKACAD111",
    url: "https://openalex.org/W1", kind: "academic", evidence_text: DIABETES_EVIDENCE,
  };
  const reference = {
    id: "s2", citationToken: "TOKWIKI222",
    url: "https://en.wikipedia.org/wiki/Diabetes", kind: "reference", evidence_text: DIABETES_EVIDENCE,
  };
  const map = buildCitationMap([academic, reference]);

  const empUsed = [{ id: "TOKACAD111", evidence_quote: DIABETES_QUOTE }];
  const ctxUsed = [{ id: "TOKWIKI222", evidence_quote: DIABETES_QUOTE }];

  const empShown = validateShown(empUsed, map).filter((s) => EMPIRICAL_KINDS.has(s.kind));
  const ctxShown = validateShown(ctxUsed, map).filter((s) => s.kind === "reference");

  assert.equal(empShown.length, 1);
  assert.equal(empShown[0].kind, "academic");
  assert.equal(ctxShown.length, 1);
  assert.equal(ctxShown[0].kind, "reference");
});

test("mixed firewall drops a wrong-kind source even when its quote is valid", () => {
  // Model wrongly cites the academic source inside the additional_context block.
  const academic = {
    id: "s1", citationToken: "TOKACAD111",
    url: "https://openalex.org/W1", kind: "academic", evidence_text: DIABETES_EVIDENCE,
  };
  const map = buildCitationMap([academic]);
  const ctxUsed = [{ id: "TOKACAD111", evidence_quote: DIABETES_QUOTE }];

  // Resolves + passes provenance, but the reference-only firewall removes it.
  const resolved = validateShown(ctxUsed, map);
  assert.equal(resolved.length, 1);
  const ctxShown = resolved.filter((s) => s.kind === "reference");
  assert.equal(ctxShown.length, 0);
});
