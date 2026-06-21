import { test } from "node:test";
import assert from "node:assert/strict";
import { applyInlineCitations } from "../src/lib/inline-citations.js";

const shown = [
  { id: "s1", citationToken: "K7H2QXAB", url: "https://a" },
  { id: "s2", citationToken: "9QF2BRCD", url: "https://b" },
];

test("maps a citation token to its 1-based display index", () => {
  const out = applyInlineCitations("Wages actually rose [K7H2QXAB].", shown);
  assert.equal(out, "Wages actually rose [1].");
});

test("maps the second source to [2]", () => {
  const out = applyInlineCitations("Growth slowed [9QF2BRCD].", shown);
  assert.equal(out, "Growth slowed [2].");
});

test("resolves legacy internal ids too", () => {
  const out = applyInlineCitations("Rose [s1] then fell [s2].", shown);
  assert.equal(out, "Rose [1] then fell [2].");
});

test("two tokens in one bracket become two markers", () => {
  const out = applyInlineCitations("Both agree [K7H2QXAB][9QF2BRCD].", shown);
  assert.equal(out, "Both agree [1][2].");
});

test("strips a token whose source was dropped by provenance", () => {
  const out = applyInlineCitations("Claim with no backing [ZZTOPDROP].", shown);
  assert.equal(out, "Claim with no backing.");
});

test("strips a dropped marker mid-sentence and tidies whitespace", () => {
  const out = applyInlineCitations("First [ZZTOPDROP] and second [K7H2QXAB].", shown);
  assert.equal(out, "First and second [1].");
});

test("leaves legitimate prose brackets untouched", () => {
  const out = applyInlineCitations("He said [sic] it would rise [K7H2QXAB].", shown);
  assert.equal(out, "He said [sic] it would rise [1].");
});

test("returns empty string for empty/non-string input", () => {
  assert.equal(applyInlineCitations("", shown), "");
  assert.equal(applyInlineCitations(null, shown), "");
  assert.equal(applyInlineCitations(undefined, shown), "");
});

test("summary with no markers is returned unchanged (trimmed)", () => {
  const out = applyInlineCitations("A plain summary with no citations.", shown);
  assert.equal(out, "A plain summary with no citations.");
});

test("deduplicates repeated tokens within one bracket", () => {
  const out = applyInlineCitations("Repeated [K7H2QXAB, K7H2QXAB].", shown);
  assert.equal(out, "Repeated [1].");
});
