// Verifies that classify() and synthesize() send citation_schema:"stable-v1",
// evidenceFingerprint, and bypassCache to the proxy when on the free path.
// Also confirms the BYOK fallback-to-proxy payload carries the same fields.

import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal chrome stub — only what api-client.js touches at call time.
globalThis.chrome = { runtime: { id: "test-extension-id" } };

// Capture the last fetch call so tests can inspect the request body.
let lastFetchUrl = null;
let lastFetchBody = null;

const CLASSIFY_RESPONSE = JSON.stringify({ analyzable: false, article_type: "news", core_claim: "", topic: "", secondary_topic: "", research_query: "", expected_response_type: "none", claim_strength: 0, claim_type: "empirical", required_geography: [] });
const SYNTH_RESPONSE = JSON.stringify({ result_type: "none", reason: "no_material_counter" });

globalThis.fetch = async (url, opts) => {
  lastFetchUrl = url;
  lastFetchBody = opts?.body ? JSON.parse(opts.body) : null;
  const stage = lastFetchBody?.stage ?? "synthesize";
  return {
    ok: true,
    json: async () => ({ content: stage === "classify" ? CLASSIFY_RESPONSE : SYNTH_RESPONSE }),
  };
};

const { classify, synthesize } = await import("../src/lib/api-client.js");

const ARTICLE = { title: "Test article", text: "A ".repeat(200), url: "https://example.com/test" };
const EVIDENCE = [
  { id: "s1", citationToken: "TOKABC12345", url: "https://openalex.org/W1", kind: "academic",
    evidence_text: "This is a long enough evidence text for the test.", usable: true, year: 2022 },
];

test("classify free path sends citation_schema:stable-v1", async () => {
  await classify({ article: ARTICLE });
  assert.equal(lastFetchBody?.citation_schema, "stable-v1", "citation_schema missing from classify proxy body");
  assert.equal(lastFetchBody?.stage, "classify");
});

test("classify free path sends bypassCache when requested", async () => {
  await classify({ article: ARTICLE, bypassCache: true });
  assert.equal(lastFetchBody?.bypassCache, true, "bypassCache not forwarded");
});

test("classify free path omits bypassCache when false", async () => {
  await classify({ article: ARTICLE });
  assert.equal("bypassCache" in lastFetchBody, false, "bypassCache should be absent by default");
});

test("synthesize free path sends citation_schema:stable-v1", async () => {
  await synthesize({ article: ARTICLE, articleType: "news", coreClaim: "test", claimType: "empirical", evidence: EVIDENCE, evidenceFingerprint: "abc123" });
  assert.equal(lastFetchBody?.citation_schema, "stable-v1");
  assert.equal(lastFetchBody?.stage, "synthesize");
});

test("synthesize free path forwards evidenceFingerprint", async () => {
  await synthesize({ article: ARTICLE, articleType: "news", coreClaim: "test", claimType: "empirical", evidence: EVIDENCE, evidenceFingerprint: "fp_test_value" });
  assert.equal(lastFetchBody?.evidenceFingerprint, "fp_test_value");
});

test("synthesize free path sends bypassCache when requested", async () => {
  await synthesize({ article: ARTICLE, articleType: "news", coreClaim: "test", claimType: "empirical", evidence: EVIDENCE, evidenceFingerprint: "fp", bypassCache: true });
  assert.equal(lastFetchBody?.bypassCache, true);
});

test("synthesize omits evidenceFingerprint when not provided", async () => {
  await synthesize({ article: ARTICLE, articleType: "news", coreClaim: "test", claimType: "empirical", evidence: EVIDENCE });
  assert.equal("evidenceFingerprint" in lastFetchBody, false);
});

test("BYOK fallback-to-proxy carries citation_schema and evidenceFingerprint", async () => {
  // Simulate a 401 on the first (BYOK) fetch — client should fall back to proxy.
  let callCount = 0;
  globalThis.fetch = async (url, opts) => {
    callCount++;
    lastFetchUrl = url;
    lastFetchBody = opts?.body ? JSON.parse(opts.body) : null;
    if (callCount === 1) {
      // First call: BYOK direct endpoint — return 401 to trigger fallback.
      return { ok: false, status: 401, text: async () => "Unauthorized", json: async () => ({}) };
    }
    // Second call: proxy fallback.
    const stage2 = lastFetchBody?.stage ?? "synthesize";
    return {
      ok: true,
      json: async () => ({ content: stage2 === "classify" ? CLASSIFY_RESPONSE : SYNTH_RESPONSE }),
    };
  };

  await synthesize({
    apiKey: "invalid-key", provider: "groq",
    article: ARTICLE, articleType: "news", coreClaim: "test", claimType: "empirical",
    evidence: EVIDENCE, evidenceFingerprint: "fp_byok_fallback",
  });

  assert.equal(callCount, 2, "expected two fetch calls (BYOK then proxy fallback)");
  assert.equal(lastFetchBody?.citation_schema, "stable-v1", "proxy fallback missing citation_schema");
  assert.equal(lastFetchBody?.evidenceFingerprint, "fp_byok_fallback", "proxy fallback missing evidenceFingerprint");
});
