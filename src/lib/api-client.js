// api-client.js — two model calls, each routable to the free proxy or a BYOK key.
//
//   classify()   — Call 1: article → {analyzable, core_claim, topic, research_query, ...}
//   synthesize() — Call 2: article + core_claim + real evidence → grounded result
//
// Free path posts {stage, ...} to the Cloudflare Worker, which runs the matching
// prompt server-side and returns { content }. BYOK path builds messages locally
// and calls the provider directly (falling back to the proxy on an invalid key).

import { buildClassifyMessages, buildSynthMessages } from "./prompt.js";

const PROXY_URL = "https://epistemic-companion-proxy.salvatoreducksamurai96.workers.dev";
const TIMEOUT_MS = 30000;

const BYOK_PROVIDERS = {
  groq:       { endpoint: "https://api.groq.com/openai/v1/chat/completions",                          model: "llama-3.3-70b-versatile" },
  deepseek:   { endpoint: "https://api.deepseek.com/v1/chat/completions",                             model: "deepseek-chat" },
  openai:     { endpoint: "https://api.openai.com/v1/chat/completions",                               model: "gpt-4o-mini" },
  openrouter: { endpoint: "https://openrouter.ai/api/v1/chat/completions",                            model: "meta-llama/llama-3.3-70b-instruct:free" },
  cerebras:   { endpoint: "https://api.cerebras.ai/v1/chat/completions",                              model: "gpt-oss-120b" },
  sambanova:  { endpoint: "https://api.sambanova.ai/v1/chat/completions",                             model: "Meta-Llama-3.3-70B-Instruct" },
  gemini:     { endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-2.0-flash" },
  xai:        { endpoint: "https://api.x.ai/v1/chat/completions",                                     model: "grok-3-mini" },
  mistral:    { endpoint: "https://api.mistral.ai/v1/chat/completions",                               model: "mistral-small-latest" },
  perplexity: { endpoint: "https://api.perplexity.ai/chat/completions",                               model: "sonar" },
  together:   { endpoint: "https://api.together.xyz/v1/chat/completions",                             model: "meta-llama/Llama-3-70b-chat-hf" },
  fireworks:  { endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",                   model: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
};

// ── Public API ───────────────────────────────────────────────────────────────

export async function classify({ apiKey, provider = "groq", article }) {
  let content;
  if (apiKey) {
    content = await rawComplete({ apiKey, provider, messages: buildClassifyMessages(article), payloadForFallback: { stage: "classify", ...article } });
  } else {
    content = await proxyComplete({ stage: "classify", title: article.title, text: article.text, url: article.url });
  }
  return parseClassification(content);
}

export async function synthesize({ apiKey, provider = "groq", article, articleType, coreClaim, claimType, evidence }) {
  const messages = buildSynthMessages({ article, articleType, coreClaim, claimType, evidence });
  let content;
  if (apiKey) {
    content = await rawComplete({
      apiKey, provider, messages,
      payloadForFallback: { stage: "synthesize", title: article.title, text: article.text, url: article.url, articleType, coreClaim, claimType, evidence },
    });
  } else {
    content = await proxyComplete({
      stage: "synthesize", title: article.title, text: article.text, url: article.url, articleType, coreClaim, claimType, evidence,
    });
  }
  return parseSynthesis(content);
}

// ── Proxy (free) ─────────────────────────────────────────────────────────────

async function proxyComplete(body) {
  const resp = await fetchWithTimeout(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": `chrome-extension://${chrome.runtime.id}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    if (resp.status === 429) {
      const b = await safeJson(resp);
      const err = new Error(b?.error || "The shared free service is busy. Please wait a moment.");
      if (b?.reason === "quota_daily") err.daily = true; else err.retryAfter = b?.retryAfter || 60;
      throw err;
    }
    throw new Error(`Proxy error (${resp.status}): ${await safeErrorText(resp)}`);
  }
  const data = await resp.json();
  return data?.content ?? "";
}

// ── BYOK (direct) ────────────────────────────────────────────────────────────

async function rawComplete({ apiKey, provider, messages, payloadForFallback }) {
  if (provider === "anthropic") return rawAnthropic(apiKey, messages, payloadForFallback);

  const cfg = BYOK_PROVIDERS[provider] ?? BYOK_PROVIDERS.groq;
  const resp = await fetchWithTimeout(cfg.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0, response_format: { type: "json_object" }, stream: false }),
  });
  if (!resp.ok) {
    const detail = await safeErrorText(resp);
    if (resp.status === 401) return proxyComplete(payloadForFallback); // invalid key → free path
    if (resp.status === 429) {
      const lower = detail.toLowerCase();
      const err = new Error("Rate limit — too many requests.");
      if (lower.includes("per day") || lower.includes("(rpd)") || lower.includes("(tpd)")) { err.daily = true; }
      else { const m = detail.match(/try again in ([\d.]+)s/i); err.retryAfter = m ? Math.max(5, Math.ceil(parseFloat(m[1]))) : 60; }
      throw err;
    }
    throw new Error(`${provider} error (${resp.status}): ${detail}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function rawAnthropic(apiKey, messages, payloadForFallback) {
  const system = messages.find(m => m.role === "system")?.content ?? "";
  const msgs = messages.filter(m => m.role !== "system");
  const resp = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1024, system, messages: msgs, stream: false }),
  });
  if (!resp.ok) {
    if (resp.status === 401) return proxyComplete(payloadForFallback);
    if (resp.status === 429) { const err = new Error("Anthropic rate limit."); err.retryAfter = 60; throw err; }
    throw new Error(`Anthropic error (${resp.status}): ${await safeErrorText(resp)}`);
  }
  const data = await resp.json();
  return data?.content?.[0]?.text ?? "";
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function looseJson(content) {
  try { return JSON.parse(content); } catch {}
  const m = content.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

function parseClassification(content) {
  const p = looseJson(content) || {};
  return {
    analyzable: p.analyzable === true,
    article_type: typeof p.article_type === "string" ? p.article_type : "news",
    core_claim: typeof p.core_claim === "string" ? p.core_claim : "",
    topic: typeof p.topic === "string" ? p.topic : "",
    secondary_topic: typeof p.secondary_topic === "string" ? p.secondary_topic : "",
    research_query: typeof p.research_query === "string" ? p.research_query : "",
    expected_response_type: typeof p.expected_response_type === "string" ? p.expected_response_type : "unknown",
    claim_strength: typeof p.claim_strength === "number" ? Math.max(0, Math.min(1, p.claim_strength)) : 0.5,
    claim_type: ["normative", "mixed"].includes(p.claim_type) ? p.claim_type : "empirical",
    required_geography: Array.isArray(p.required_geography) ? p.required_geography.filter(g => typeof g === "string") : [],
  };
}

function parseUsedSources(arr) {
  return Array.isArray(arr) ? arr.filter(u => u && typeof u.id === "string").map(u => ({
    id: u.id,
    supports_sentence: typeof u.supports_sentence === "string" ? u.supports_sentence : "",
    evidence_quote: typeof u.evidence_quote === "string" ? u.evidence_quote : "",
  })) : [];
}

function parseSynthesis(content) {
  const p = looseJson(content) || {};

  // Mixed: two-part result, each half carrying its own provenance-checked sources.
  if (p.result_type === "mixed") {
    const block = (b) => ({
      summary: typeof b?.summary === "string" ? b.summary : "",
      confidence: typeof b?.confidence === "number" ? Math.max(0, Math.min(1, b.confidence)) : 0.5,
      used_sources: parseUsedSources(b?.used_sources),
    });
    return {
      result_type: "mixed",
      headline: typeof p.headline === "string" ? p.headline : "",
      core_claims: Array.isArray(p.core_claims) ? p.core_claims.map(String).slice(0, 4) : [],
      empirical_counter: block(p.empirical_counter),
      additional_context: block(p.additional_context),
    };
  }

  const type = p.result_type === "counter_perspective" || p.result_type === "additional_context" ? p.result_type : "none";
  if (type === "none") return { result_type: "none", reason: typeof p.reason === "string" ? p.reason : "" };
  return {
    result_type: type,
    headline: typeof p.headline === "string" ? p.headline : "",
    summary: typeof p.summary === "string" ? p.summary : "",
    core_claims: Array.isArray(p.core_claims) ? p.core_claims.map(String).slice(0, 4) : [],
    confidence: typeof p.confidence === "number" ? Math.max(0, Math.min(1, p.confidence)) : 0.5,
    used_sources: parseUsedSources(p.used_sources),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("All AI providers are busy right now. Wait a moment and try again.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function safeErrorText(resp) {
  try { const d = await resp.json(); return d?.error?.message || JSON.stringify(d).slice(0, 200); }
  catch { return resp.statusText || "no detail"; }
}
async function safeJson(resp) { try { return await resp.json(); } catch { return null; } }
