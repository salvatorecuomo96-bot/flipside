import { test } from "node:test";
import assert from "node:assert/strict";
import { geoMismatch } from "../src/lib/sources.js";

const AU = ["Australia"];

test("drops a foreign-only source for a geo-specific article", () => {
  const mexico = { title: "Mexico's Growing Threat to Press Freedom", evidence_text: "" };
  const zimbabwe = { title: "Behind the Zimbabwean Media Divide", evidence_text: "press freedom" };
  assert.equal(geoMismatch(mexico, AU), true);
  assert.equal(geoMismatch(zimbabwe, AU), true);
});

test("keeps a source naming the required country", () => {
  const aus = { title: "National Press Club (Australia)", evidence_text: "" };
  assert.equal(geoMismatch(aus, AU), false);
});

test("keeps a country-neutral source", () => {
  const neutral = { title: "Press freedom and professionalism", evidence_text: "journalists and editors" };
  assert.equal(geoMismatch(neutral, AU), false);
});

test("keeps everything when the article is geo-agnostic", () => {
  const mexico = { title: "Mexico's Growing Threat to Press Freedom", evidence_text: "" };
  assert.equal(geoMismatch(mexico, []), false);
  assert.equal(geoMismatch(mexico, undefined), false);
});

test("keeps a source that names both a required and a foreign country", () => {
  const both = { title: "Australia and Mexico compared on press freedom", evidence_text: "" };
  assert.equal(geoMismatch(both, AU), false);
});
