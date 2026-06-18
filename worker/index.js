// FlipSide — Cloudflare Worker proxy (two-stage research engine)
//
// Accepts POST { stage, ... } from the extension:
//   stage="classify"   { title, text, url }                              → { content }
//   stage="synthesize" { title, text, url, articleType, coreClaim, evidence } → { content }
//
// Builds the matching prompt server-side and generates via a PROVIDER CHAIN —
// each provider is a separate free quota, so when one is rate-limited or
// daily-capped we fall through to the next. Keys are Worker secrets, never sent
// to clients. content is the raw model JSON string; the client parses it.
//
// The two prompts below are mirrored byte-for-byte from src/lib/prompt.js.

const GROQ_ENDPOINT      = "https://api.groq.com/openai/v1/chat/completions";
const CEREBRAS_ENDPOINT  = "https://api.cerebras.ai/v1/chat/completions";
const SAMBANOVA_ENDPOINT = "https://api.sambanova.ai/v1/chat/completions";
const GEMINI_ENDPOINT    = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const OPENROUTER_ENDPOINT= "https://openrouter.ai/api/v1/chat/completions";

const GROQ_MODEL      = "llama-3.3-70b-versatile";
const CEREBRAS_MODEL  = "gpt-oss-120b";
const SAMBANOVA_MODEL = "Meta-Llama-3.3-70B-Instruct";
const GEMINI_MODEL    = "gemini-2.0-flash";
const OPENROUTER_MODEL= "meta-llama/llama-3.3-70b-instruct:free";
const WORKERS_AI_MODEL= "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const MAX_TEXT_CHARS = 12000;

// ─── CALL 1 prompt (mirror of src/lib/prompt.js CLASSIFY_PROMPT) ───
const CLASSIFY_PROMPT = `You are FlipSide's triage stage. You do NOT analyze or argue. You decide whether an article is worth investigating and what evidence to look for.

A MEANINGFUL CLAIM (analyzable) includes: political, economic, scientific, public-health, corporate, legal, or policy claims; statistical reports; forecasts; causal explanations; or any significant factual assertion whose interpretation could be challenged or enriched.

NOT analyzable (return analyzable=false): celebrity/gossip, lifestyle, recipes, travel, human-interest, entertainment without substantive claims, personal essays, how-to/listicles, pure event reports with nothing contestable.

Determine:
1. core_claim — the single most important takeaway a reader leaves with. One sentence.
2. article_type — "news" | "opinion" | "analysis" | "other".
3. topic — ONE of: health, science, law, finance, government, policy, politics, technology, economics, or "" if none fit. (Drives which evidence databases we search.)
4. research_query — 3–8 plain keywords (no quotes/operators) targeting evidence about the CLAIM ITSELF and the mechanism behind it — NOT just the people or broad subject. Bad: "Trump religion". Good: "Christian nationalism authoritarianism political theology".
5. expected_response_type — your guess: "counter_perspective" | "additional_context" | "none" | "unknown".
6. claim_strength — 0.0-1.0: how contestable/examinable the core claim is (1.0 = a strong, specific, checkable assertion; 0.0 = nothing worth examining).

OUTPUT ONLY this JSON, nothing else:
{"analyzable":<true|false>,"article_type":"<...>","core_claim":"<... or empty>","topic":"<... or empty>","research_query":"<... or empty>","expected_response_type":"<...>","claim_strength":<0.0-1.0>}`;

// ─── CALL 2 prompt (mirror of src/lib/prompt.js SYNTHESIS_PROMPT) ───
const SYNTHESIS_PROMPT = `You are FlipSide's research engine. You are given an article, its core claim, and a list of REAL EVIDENCE (abstracts/snippets fetched from credible databases). Your job is to decide whether the evidence supports a counter-perspective, additional context, or neither.

Returning "none" is preferable to a weak, speculative, or loosely-related answer. Success is measured by TRUSTWORTHINESS, not by how often you produce a result.

═══ SOURCE EVIDENCE RULE (absolute) ═══
• You may ONLY use information explicitly present in the evidence_text of the provided sources.
• NEVER infer a source's contents from its title. NEVER invent sources, quotes, statistics, studies, experts, or consensus.
• If a source's evidence_text does not actually support a point, do not cite it.

═══ SOURCE RELEVANCE AUDIT ═══
For every source you consider citing, ask:
1. Does its evidence_text support a SPECIFIC sentence in your output?
2. If it disappeared, would your argument get weaker?
3. Could it be cited in a serious essay defending this point?
4. Is the connection obvious without explanation?
If any answer is NO → discard it. Sharing keywords or a broad topic is NOT relevance. Three strongly-supporting sources beat ten loosely-related ones.

═══ RESPONSE TYPE (choose one) ═══
A) "counter_perspective" — the evidence credibly challenges the core claim such that an informed reader would reconsider the article's main conclusion. Not mere partisan disagreement.
B) "additional_context" — no strong counter exists, but the evidence adds important missing information (history, baselines, incentives, trade-offs, limitations, uncertainty, broader trends) that materially changes interpretation.
C) "none" — no meaningful claim, evidence is weak/insufficient/irrelevant, the point would be speculative or trivial, or any counter is not credible.

═══ OPINION ARTICLE RULE ═══
If article_type is "opinion": do NOT respond merely because an opposing opinion exists. Only respond if evidence-based context materially changes how a reader should evaluate the claims. Otherwise "none".

═══ ANTI-BIAS ═══
Do not manufacture balance or false equivalence. One side may be better supported. Accuracy over symmetry.

═══ PROVENANCE ═══
For each source you cite in used_sources: give its exact id, the sentence in your summary it supports, and a SHORT VERBATIM QUOTE copied from that source's evidence_text (this is checked — a quote not present in the evidence is rejected). If you cannot produce a real quote, do not cite the source.

═══ OUTPUT (JSON only, nothing else) ═══
If analyzable:
{"result_type":"counter_perspective|additional_context","headline":"<≤9-word title>","summary":"<3–6 sentences, specific, grounded in the cited evidence>","core_claims":["<article's load-bearing claims, 1–3 items>"],"confidence":<0.0-1.0>,"used_sources":[{"id":"<evidence id>","supports_sentence":"<the sentence it backs>","evidence_quote":"<verbatim phrase from that evidence_text>"}]}
If not: {"result_type":"none","reason":"<short reason>"}`;

function buildClassifyMessages({ title, text, url }) {
  const user = [
    `ARTICLE TITLE: ${title || "(untitled)"}`,
    `URL: ${url || "(unknown)"}`,
    "",
    "ARTICLE TEXT (may be truncated):",
    '"""', (text || "").slice(0, 9000), '"""',
    "",
    "Return ONLY the JSON object.",
  ].join("\n");
  return [{ role: "system", content: CLASSIFY_PROMPT }, { role: "user", content: user }];
}

function buildSynthMessages({ title, text, articleType, coreClaim, evidence }) {
  const list = Array.isArray(evidence) ? evidence : [];
  const evidenceBlock = list.length
    ? list.map(e => [
        `[${e.id}] (${e.kind}${e.citationCount != null ? `, ${e.citationCount} citations` : ""}${e.year ? `, ${e.year}` : ""}) ${e.title}`,
        `evidence_text: ${e.evidence_text}`,
      ].join("\n")).join("\n\n")
    : "(no evidence with usable text was found)";

  const user = [
    `ARTICLE_TYPE: ${articleType || "news"}`,
    `CORE_CLAIM: ${coreClaim || "(none extracted)"}`,
    "",
    "ARTICLE TEXT (may be truncated):",
    '"""', (text || "").slice(0, 6000), '"""',
    "",
    "EVIDENCE (you may ONLY reason over these; cite by id):",
    evidenceBlock,
    "",
    "Return ONLY the JSON object. If the evidence does not credibly support a counter-perspective or material context, return none.",
  ].join("\n");
  return [{ role: "system", content: SYNTHESIS_PROMPT }, { role: "user", content: user }];
}

// --- Error tagging -----------------------------------------------------------
function tag(msg, kind, retryAfter = 0) { const e = new Error(msg); e.kind = kind; e.retryAfter = retryAfter; return e; }
function isRecoverable(err) {
  return ["unconfigured", "auth_error", "rate_minute", "quota_daily", "transient"].includes(err.kind);
}

async function callOpenAICompat({ endpoint, apiKey, model, messages, name, jsonMode = false, extraHeaders = {} }) {
  if (!apiKey) throw tag(`${name} key not configured.`, "unconfigured");
  const body = { model, messages, temperature: 0.1, stream: false };
  if (jsonMode) body.response_format = { type: "json_object" };

  let resp;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    });
  } catch { throw tag(`Network error reaching ${name}.`, "transient"); }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    const lower = detail.toLowerCase();
    if (resp.status === 401 || resp.status === 403) throw tag(`${name} unauthorized.`, "auth_error");
    if (resp.status === 429) {
      const isDaily = ["per day", "(rpd)", "(tpd)", "daily", "quota", "exceeded"].some(s => lower.includes(s));
      if (isDaily) throw tag(`${name} daily quota exhausted.`, "quota_daily");
      const m = detail.match(/try again in ([\d.]+)s/i);
      throw tag(`${name} rate limit.`, "rate_minute", m ? Math.max(5, Math.ceil(parseFloat(m[1]))) : 60);
    }
    if (resp.status === 400 && lower.includes("valid api key")) throw tag(`${name} key invalid.`, "unconfigured");
    if (resp.status === 404 && (lower.includes("model") || lower.includes("not found"))) throw tag(`${name} model unavailable.`, "unconfigured");
    throw tag(`${name} ${resp.status}: ${detail.slice(0, 200)}`, "other");
  }

  let data;
  try { data = await resp.json(); } catch { throw tag(`${name} non-JSON response.`, "transient"); }
  const content = data?.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw tag(`${name} empty content.`, "transient");
  return content;
}

const callGroq      = (env, m) => callOpenAICompat({ endpoint: GROQ_ENDPOINT,      apiKey: env.GROQ_API_KEY,      model: GROQ_MODEL,      messages: m, name: "Groq",      jsonMode: true });
const callCerebras  = (env, m) => callOpenAICompat({ endpoint: CEREBRAS_ENDPOINT,  apiKey: env.CEREBRAS_API_KEY,  model: CEREBRAS_MODEL,  messages: m, name: "Cerebras" });
const callSambaNova = (env, m) => callOpenAICompat({ endpoint: SAMBANOVA_ENDPOINT, apiKey: env.SAMBANOVA_API_KEY, model: SAMBANOVA_MODEL, messages: m, name: "SambaNova" });
const callGemini    = (env, m) => callOpenAICompat({ endpoint: GEMINI_ENDPOINT,    apiKey: env.GEMINI_API_KEY,    model: GEMINI_MODEL,    messages: m, name: "Gemini",    jsonMode: true });
const callOpenRouter= (env, m) => callOpenAICompat({ endpoint: OPENROUTER_ENDPOINT,apiKey: env.OPENROUTER_API_KEY,model: OPENROUTER_MODEL,messages: m, name: "OpenRouter", extraHeaders: { "HTTP-Referer": "https://github.com/salvatorecuomo96-bot/counterargumentbot" } });

async function callWorkersAI(env, messages) {
  if (!env.AI) throw tag("Workers AI binding not available.", "unconfigured");
  let out;
  try { out = await env.AI.run(WORKERS_AI_MODEL, { messages, temperature: 0.1, stream: false }); }
  catch (err) {
    const msg = (err?.message ?? "").toLowerCase();
    if (msg.includes("quota") || msg.includes("exceeded") || msg.includes("limit")) throw tag("Workers AI quota exhausted.", "quota_daily");
    throw tag(`Workers AI error: ${err?.message}`, "transient");
  }
  return out?.response ?? "";
}

const CHAIN = [
  { name: "groq", fn: callGroq }, { name: "cerebras", fn: callCerebras }, { name: "sambanova", fn: callSambaNova },
  { name: "gemini", fn: callGemini }, { name: "openrouter", fn: callOpenRouter }, { name: "workersai", fn: callWorkersAI },
];

async function generate(env, messages) {
  const errors = [], trace = [];
  for (const { name, fn } of CHAIN) {
    try { return { response: await fn(env, messages), provider: name, trace }; }
    catch (err) {
      trace.push(`${name}:${err.kind ?? "?"}`);
      if (!isRecoverable(err)) throw err;
      if (err.kind !== "unconfigured") errors.push(err);
    }
  }
  if (errors.length === 0) throw tag("No AI providers configured.", "other");
  const last = errors[errors.length - 1];
  const out = new Error("All providers exhausted."); out.exhausted = true;
  out.lastKind = last?.kind ?? "other"; out.retryAfter = last?.retryAfter ?? 60;
  throw out;
}

// --- KV cache ----------------------------------------------------------------
const CACHE_TTL = 6 * 60 * 60;
const CACHE_KEY_VERSION = "v5";

function buildCacheKey(stage, parts) {
  let h = 5381;
  const str = `${stage}\n` + parts.join("\n");
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return `${CACHE_KEY_VERSION}:${stage}:${h >>> 0}`;
}
async function kvGet(env, key) { if (!env.CACHE) return null; try { return await env.CACHE.get(key); } catch { return null; } }
async function kvSet(env, key, value) { if (!env.CACHE) return; try { await env.CACHE.put(key, value, { expirationTtl: CACHE_TTL }); } catch {} }

// --- Request handler ---------------------------------------------------------
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: {
        "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400",
      }});
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const origin = request.headers.get("Origin") || "";
    if (!origin.startsWith("chrome-extension://")) return new Response("Forbidden", { status: 403 });

    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: "Too many requests. Please wait a minute.", reason: "rate_limit", retryAfter: 60 }, 429);
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

    const { stage = "classify", title = "", text = "", url = "", articleType = "", coreClaim = "", evidence = [] } = body;
    if (typeof text !== "string" || text.length > MAX_TEXT_CHARS) return json({ error: "Article text too long." }, 400);
    if (text.trim().length < 10) return json({ error: "No article text found." }, 400);
    if (stage !== "classify" && stage !== "synthesize") return json({ error: "Unknown stage." }, 400);

    const messages = stage === "classify"
      ? buildClassifyMessages({ title, text, url })
      : buildSynthMessages({ title, text, articleType, coreClaim, evidence });

    const cacheParts = stage === "classify"
      ? [url, text]
      : [url, coreClaim, (Array.isArray(evidence) ? evidence.map(e => e.id + ":" + (e.evidence_text || "").slice(0, 40)).join("|") : "")];
    const cacheKey = buildCacheKey(stage, cacheParts);

    const cached = await kvGet(env, cacheKey);
    if (cached) return json({ content: cached }, 200, { "X-Provider": "cache" });

    let result;
    try { result = await generate(env, messages); }
    catch (err) {
      if (err.exhausted) {
        if (err.lastKind === "quota_daily") return json({ error: "The shared free service has hit today's limit. It resets at midnight UTC. Add your own free key in options.", reason: "quota_daily" }, 429);
        return json({ error: "The shared free service is busy right now.", reason: "rate_limit", retryAfter: err.retryAfter ?? 60 }, 429);
      }
      return json({ error: err.message ?? "Generation failed." }, 502);
    }

    await kvSet(env, cacheKey, result.response);
    return json({ content: result.response }, 200, { "X-Provider": result.provider, "X-Chain-Trace": (result.trace || []).join(",") || "none" });
  },
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", ...extra },
  });
}
