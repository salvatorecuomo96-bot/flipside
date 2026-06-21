import { test } from "node:test";
import assert from "node:assert/strict";

import { parseClassification } from "../src/lib/api-client.js";
import { CLASSIFY_PROMPT } from "../src/lib/prompt.js";
import { classificationSilenceReason } from "../src/lib/silence.js";

test("classification parser preserves attribution fields", () => {
  const cls = parseClassification(JSON.stringify({
    analyzable: true,
    article_type: "news",
    core_claim: "The opposition leader alleges that the contracts were improperly awarded.",
    claim_holder: "quoted_source",
    article_stance: "reports",
    attribution: "the opposition leader",
  }));

  assert.equal(cls.claim_holder, "quoted_source");
  assert.equal(cls.article_stance, "reports");
  assert.equal(cls.attribution, "the opposition leader");
  assert.equal(cls.core_claim, "The opposition leader alleges that the contracts were improperly awarded.");
});

test("classification parser defaults old responses safely", () => {
  const cls = parseClassification('{"analyzable":true}');

  assert.equal(cls.claim_holder, "author");
  assert.equal(cls.article_stance, "endorses");
  assert.equal(cls.attribution, "");
});

test("classification parser rejects unknown attribution enums", () => {
  const cls = parseClassification(JSON.stringify({
    analyzable: true,
    claim_holder: "journalist",
    article_stance: "amplifies",
    attribution: "  a named source  ",
  }));

  assert.equal(cls.claim_holder, "author");
  assert.equal(cls.article_stance, "endorses");
  assert.equal(cls.attribution, "a named source");
});

test("classifier prompt covers required attribution cases", () => {
  const requiredSnippets = [
    "Journalist clearly endorses a thesis",
    "Journalist reports one politician's allegation",
    "Journalist reports one expert prediction",
    "Two quoted sides disagree",
    "Analysis article weighs evidence and reaches a conclusion",
    "Headline is stronger than the body",
    "Repeated attributed statement remains attributed",
    "Anonymous sources make a warning",
    "Article quotes a criticism and rebuts it",
    "Neutral reported dispute becomes straight_reporting",
  ];

  for (const snippet of requiredSnippets) {
    assert.ok(CLASSIFY_PROMPT.includes(snippet), `missing classifier example: ${snippet}`);
  }
});

test("neutral reported dispute maps to straight_reporting silence", () => {
  const cls = parseClassification(JSON.stringify({
    analyzable: false,
    article_type: "news",
    core_claim: "Supporters and opponents of the bill disagree about its cost.",
    claim_holder: "multiple_sources",
    article_stance: "contrasts",
    attribution: "supporters and opponents of the bill",
  }));

  assert.equal(classificationSilenceReason(cls), "straight_reporting");
});
