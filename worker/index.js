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
3. topic — ONE of: health, science, law, finance, government, policy, politics, technology, economics, environment, or "" if none fit. (Drives which evidence databases we search.) Tiebreaker: if an article discusses fiscal policy, budgets, tax, spending, or economic reform — even if politically framed — prefer "economics" or "finance" over "politics". The evidence quality for those topics is significantly higher.
4. secondary_topic — a SECOND topic from the same list ONLY if the claim genuinely spans two domains where evidence from the second would materially help (e.g. a carbon-tax article is economics + environment; a vaccine-mandate article is health + law). Otherwise "". Must differ from topic. Do not pad — most articles have just one topic.
5. research_query — 3–8 plain keywords (no quotes/operators) targeting evidence about the CLAIM ITSELF and the mechanism behind it — NOT just the people or broad subject. Disambiguate any word that means something different in another field: write "fiscal budget tax relief concessions" not the bare word "concessions" (which also means toll-road/franchise concessions). Bad: "Trump religion". Good: "Christian nationalism authoritarianism political theology". ALWAYS provide a query for any analyzable article, including opinion and normative ones — name the central concept, movement, or entity so reference evidence can be found (e.g. for a moral claim about Christian nationalism: "Christian nationalism political theology democracy"). Never leave this empty.
6. expected_response_type — your guess: "counter_perspective" | "additional_context" | "none" | "unknown".
7. claim_strength — 0.0-1.0: how contestable/examinable the core claim is (1.0 = a strong, specific, checkable assertion; 0.0 = nothing worth examining).
8. claim_type — one of:
   • "empirical" — testable against data, evidence, or scholarly findings (most news: economics, health, policy, science, law).
   • "normative" — a moral, theological, or value judgment no empirical study can settle (e.g. "X is evil", "X is the antichrist of democracy", "X is a sin"). Routes to reference/encyclopedic evidence; citing an empirical study to "disprove" a moral claim is a logic error.
   • "mixed" — a value judgment justified by a falsifiable factual premise (e.g. "rent control is a human right because it prevents poverty" — the "human right" part is normative, the "prevents poverty" part is empirical).
   GUARDRAIL — be strict; the model tends to over-tag "mixed". A claim that something "is evil", "is the antichrist", "is immoral", "is a sin", or "is a moral good" is NORMATIVE, even though the thing has real-world effects. To tag "mixed" the ARTICLE must EXPLICITLY state a specific, measurable, on-topic causal premise as its justification (e.g. "…because it prevents poverty", "…because it lowers wages"). An inferred "it probably causes harm/good" does NOT count. Examples: "Christian nationalism is the antichrist / a systemic evil" = normative (no explicit measurable premise). "Rent control is a right because it prevents poverty" = mixed. If unsure, choose "normative".

9. required_geography — array of full country names (e.g. ["United States"]) if the core claim is implicitly tied to a specific country or countries (e.g. US domestic politics, UK policy). Empty array [] if the claim is globally applicable or theoretical. Use full names only — not abbreviations or codes. Examples: a Trump tax policy article → ["United States"]. A WHO pandemic study → [].

OUTPUT ONLY this JSON, nothing else:
{"analyzable":<true|false>,"article_type":"<...>","core_claim":"<... or empty>","topic":"<... or empty>","secondary_topic":"<... or empty>","research_query":"<... or empty>","expected_response_type":"<...>","claim_strength":<0.0-1.0>,"claim_type":"<empirical|normative|mixed>","required_geography":[<... or empty array>]}`;

// ─── CALL 2 prompt (mirror of src/lib/prompt.js SYNTHESIS_PROMPT) ───
const SYNTHESIS_PROMPT = `You are FlipSide's research engine. You are given an article, its core claim, and REAL EVIDENCE fetched from credible databases. Your job is to produce the strongest credible challenge to what this article leads a reader to conclude — or to return "none" if the evidence cannot support one.

Returning "none" is preferable to a weak or generic answer. Success is measured by SPECIFICITY and TRUSTWORTHINESS, not by how often you produce a result.

═══ STEELMAN TEST (run this before writing anything) ═══
Step 1 — What specific conclusion does this article lead a reader to? Not the topic. The implied takeaway.
Step 2 — What would a well-informed, intellectually honest person who disputes THAT conclusion argue, using only the evidence provided?
Your summary must be the answer to Step 2. If it does not directly engage the article's specific implied conclusion, it has failed.

═══ ANTI-GENERIC RULE (hard filter) ═══
If your summary could be copy-pasted onto a different article about the same general topic without changing a word, return "none" instead.
Failing examples:
• "Research shows tax policy affects investment and growth." (could go on any tax article)
• "Studies suggest climate change has economic consequences." (could go on any climate article)
• "Evidence indicates healthcare access influences outcomes." (could go on any health article)
These are not counter-perspectives. They are topic summaries. The counter must name what THIS article implies and argue against THAT.

═══ SOURCE EVIDENCE RULE (absolute) ═══
• You may ONLY use information explicitly present in the evidence_text of the provided sources.
• NEVER infer a source's contents from its title. NEVER invent sources, quotes, statistics, studies, experts, or consensus.
• If a source's evidence_text does not actually support a point, do not cite it.

═══ SOURCE RELEVANCE AUDIT ═══
For every source you consider citing, ask:
1. Does its evidence_text support a SPECIFIC sentence in your output?
2. If it disappeared, would your argument get weaker?
3. Could it be cited in a serious essay defending the opposing position on THIS article?
4. Is the connection obvious without explanation?
5. Is this source in the same subject domain as the article's specific claim? A paper on foreign policy behaviour cannot support a domestic tax policy claim. A study on international trade cannot support a domestic criminal justice claim. Domain mismatch = discard, regardless of keyword overlap.
If any answer is NO → discard it. Three strongly-supporting sources beat ten loosely-related ones.

═══ RESPONSE TYPE (choose one) ═══
A) "counter_perspective" — the evidence credibly challenges what the article leads a reader to conclude, such that an informed reader would reconsider the article's main takeaway. Not mere partisan disagreement.
B) "additional_context" — no strong counter exists, but the evidence reveals important missing information (history, baselines, trade-offs, limitations, uncertainty) that materially changes how a reader should interpret the article.
C) "none" — the evidence is weak, generic, irrelevant, or cannot support a specific challenge to this article's implied conclusion.

═══ OPINION ARTICLE RULE ═══
If article_type is "opinion": do NOT respond merely because an opposing opinion exists. Only respond if evidence-based context materially changes how a reader should evaluate the specific claims made. Otherwise "none".

═══ CLAIM-TYPE ROUTING (read the CLAIM_TYPE field) ═══
• empirical → normal output (counter_perspective / additional_context / none).
• normative (pure moral/theological/value judgment — e.g. "X is evil", "X is the antichrist of democracy"): empirical research CANNOT settle it. NEVER cite a study as if it resolves the value question, and NEVER use a critical description of something as a defence of it (do not argue "it isn't bad, it's only authoritarian"). Output ONLY additional_context: use reference/encyclopedic evidence to explain the actual debate — what the term means, how it is contested, what serious thinkers on different sides argue. Stay grounded in the article's specific subject (American Christian nationalism is a specific movement — a paper about religion in another country is NOT relevant). If reference evidence cannot illuminate the specific claim, return "none".
• mixed (a value judgment justified by a falsifiable factual premise — e.g. "rent control is a human right because it prevents poverty"): produce a two-part result with a HARD source-kind mapping. Each evidence item shows its kind in parentheses, e.g. "(academic…)", "(government…)", "(reference)".
   – empirical_counter — challenges the FACTUAL premise. You MUST ONLY cite sources whose kind is academic, preprint, government, or legal. NEVER cite a (reference) or (news) source here.
   – additional_context — frames the moral/value debate. You MUST ONLY cite sources whose kind is reference (e.g. Wikipedia). NEVER cite an (academic), (preprint), (government), or (legal) source here under any circumstances.
   A source placed in the wrong block is a hard error — drop it. Never use an academic study to argue against the moral claim, or an encyclopedia entry as a factual rebuttal. If a half has no source of its allowed kind, leave that half's summary empty.

═══ LOGICAL VALIDITY ═══
Do not commit these fallacies:
• Motive ≠ effect: A policy being politically motivated does not make it substantively ineffective. These are independent claims requiring independent evidence. Do not argue "this is political theater" unless you have economic or empirical evidence that the stated mechanism fails.
• Surface relevance ≠ actual relevance: A source mentioning similar words (e.g. "backlash", "concessions") is not relevant if its subject matter is a different domain.

═══ TEMPORAL VALIDITY ═══
Each source shows its publication year; compare it to TODAY'S DATE (given below).
• A source published more than ~5 years before today can establish a general mechanism, a historical pattern, or a baseline — it CANNOT describe what a government, company, or person is "currently" doing, planning, prioritizing, or concentrating on now. Never use an old source to assert a present-tense fact about a current actor.
• If your only evidence for a present-tense claim is old, either restate the claim in its valid historical form ("historically, X has tended to…") or return "none".
• Exception — timeless evidence does not expire: a clinical result, a physical finding, or an established economic mechanism remains valid however old it is. The limit applies to claims about the present, not to claims about how things work.

═══ ANTI-BIAS ═══
Do not manufacture balance or false equivalence. One side may be better supported. Accuracy over symmetry.

═══ REFERENCE SOURCE SCOPE ═══
A reference source (Wikipedia or similar encyclopedic summary) may define concepts, explain historical framing, and summarize established debates. It may NOT, by itself, support claims about: current policy effectiveness, legal obligations, causal effects, present-day behavior of governments, companies, parties, or individuals, or current public opinion. If your only validated evidence is a reference source, limit your summary to 2–3 concise sentences and use additional_context — never counter_perspective. Do not set confidence above 0.55 when only reference evidence is available.

═══ EVIDENCE SCOPE ═══
Match your summary length to your evidence strength. One narrow validated source supports one focused point — not a multi-claim paragraph. If you have one weak or narrow source: 2–3 sentences maximum. Two independent strong sources: up to 4 sentences. Three or more: normal 3–6 sentences. Do not inflate length to appear more authoritative. Every factual sentence must be directly supportable by a cited source's evidence_text.

═══ PROVENANCE ═══
For each source you cite: give its exact id, the sentence in your summary it supports, and an EXACT VERBATIM QUOTE of at least 8 words and at least 35 characters from that source's evidence_text. Do not paraphrase. Do not shorten a quote below 8 words. This is checked against the source text — a quote not found verbatim in the evidence is rejected. If you cannot produce a qualifying real quote, do not cite the source.

═══ OUTPUT (JSON only, nothing else) ═══
If result exists (empirical or normative claim):
{"result_type":"counter_perspective|additional_context","headline":"<≤9-word title>","summary":"<3–6 sentences — must name the article's specific implied conclusion and argue directly against it>","core_claims":["<article's load-bearing claims, 1–3 items>"],"confidence":<0.0-1.0>,"used_sources":[{"id":"<evidence id>","supports_sentence":"<the sentence it backs>","evidence_quote":"<verbatim phrase from that evidence_text>"}]}
If CLAIM_TYPE is mixed (two-part — each half cites ONLY its own source kind; every used_source still needs a verbatim evidence_quote):
{"result_type":"mixed","headline":"<≤9-word title>","core_claims":["<1–3 items>"],"empirical_counter":{"summary":"<challenge the factual premise; ACADEMIC sources only>","confidence":<0.0-1.0>,"used_sources":[{"id":"<...>","supports_sentence":"<...>","evidence_quote":"<verbatim>"}]},"additional_context":{"summary":"<frame the moral debate; REFERENCE sources only>","used_sources":[{"id":"<...>","supports_sentence":"<...>","evidence_quote":"<verbatim>"}]}}
If no credible result, choose the SINGLE most accurate reason code:
{"result_type":"none","reason":"<evidence_off_target|evidence_too_weak|no_material_counter|normative_unresolved>"}
  • evidence_off_target — the sources cover the broader topic but none addresses THIS article's specific claim.
  • evidence_too_weak — some on-point evidence exists but is too thin or preliminary to support a credible challenge without overstating it.
  • no_material_counter — the evidence is on-point and adequate, but it neither challenges the conclusion nor adds context that changes interpretation.
  • normative_unresolved — the claim is moral/theological and no reference evidence could illuminate the specific debate.`;

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

function buildSynthMessages({ title, text, articleType, coreClaim, claimType, evidence }) {
  const list = Array.isArray(evidence) ? evidence : [];
  const evidenceBlock = list.length
    ? list.map(e => [
        `[${e.citationToken ?? e.id}] (${e.kind}${e.year ? `, ${e.year}` : ""}) ${e.title}`,
        ...(e.age_tag ? [e.age_tag] : []),
        `evidence_text: ${e.evidence_text}`,
      ].join("\n")).join("\n\n")
    : "(no evidence with usable text was found)";

  const user = [
    `TODAY'S DATE: ${new Date().toISOString().slice(0, 10)}`,
    `ARTICLE_TYPE: ${articleType || "news"}`,
    `CLAIM_TYPE: ${claimType || "empirical"}`,
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
  const body = { model, messages, temperature: 0, stream: false };
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
  try { out = await env.AI.run(WORKERS_AI_MODEL, { messages, temperature: 0, stream: false }); }
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
const CACHE_KEY_VERSION_LEGACY = "v14"; // URL-keyed — old clients without citation_schema
const CACHE_KEY_VERSION_STABLE = "v16"; // content-keyed — clients sending citation_schema:"stable-v1"

// djb2 hash over a multi-part key string
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return h >>> 0;
}

// Legacy: URL-based key (v14 namespace). One URL → one cached result.
function buildLegacyCacheKey(stage, url) {
  return `${CACHE_KEY_VERSION_LEGACY}:${stage}:${djb2(`${stage}\n${url || ""}`)}`;
}

// Stable: content-based key (v15 namespace). Same evidence set → same result
// regardless of URL. Synthesis includes a daily date bucket because TODAY'S DATE
// is in the synthesis prompt and bounded staleness (6h TTL) is explicitly accepted.
function buildStableCacheKey(stage, parts) {
  return `${CACHE_KEY_VERSION_STABLE}:${stage}:${djb2(`${stage}\n` + parts.join("\n"))}`;
}

async function kvGet(env, key) { if (!env.CACHE) return null; try { return await env.CACHE.get(key); } catch { return null; } }
async function kvSet(env, key, value, ttl = CACHE_TTL) { if (!env.CACHE) return; try { await env.CACHE.put(key, value, { expirationTtl: ttl }); } catch {} }

// --- Request handler ---------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET" && new URL(request.url).pathname === "/privacy") {
      return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FlipSide — Privacy Policy</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:680px;margin:48px auto;padding:0 24px;line-height:1.7;color:#1a1a1a}h1{font-size:1.5rem;margin-bottom:4px}p.sub{color:#666;font-size:.9rem;margin-top:0}h2{font-size:1rem;margin-top:2rem}p,ul{font-size:.95rem}ul{padding-left:1.3em}</style></head><body>
<h1>FlipSide — Privacy Policy</h1><p class="sub">Last updated: June 2026</p>
<p>FlipSide is a browser extension that surfaces credible counter-perspectives on news articles. This policy explains what data we collect and how we handle it.</p>
<h2>What we collect</h2>
<ul>
<li><strong>Nothing about you personally.</strong> FlipSide does not collect your name, email address, IP address, browsing history, or any information that identifies you.</li>
<li><strong>Anonymous vote counts.</strong> When you tap 👍 or 👎 on a result, we record one vote against a one-way hash of the article URL. The hash cannot be reversed to recover the URL. We see only totals such as "3 thumbs-up, 1 thumbs-down."</li>
<li><strong>Article text is processed transiently.</strong> When you click FlipSide, the article text is sent to our Cloudflare Worker to generate a counter-perspective. It is used only to produce that response and is not stored or logged.</li>
</ul>
<h2>What we do not do</h2>
<ul>
<li>We do not sell, share, or monetise any data.</li>
<li>We do not track you across websites or sessions.</li>
<li>We do not store article text, search queries, or AI responses linked to any user.</li>
</ul>
<h2>Third-party AI providers</h2>
<p>The free path routes article text through a Cloudflare Worker, which calls one of several AI providers (Groq, Cerebras, SambaNova, Gemini, OpenRouter) to generate a response. These providers process the text under their own privacy policies. If you use the Bring Your Own Key option, your text goes directly to your chosen provider.</p>
<h2>Data retention</h2>
<p>Anonymous vote counts are retained for up to 90 days on Cloudflare infrastructure and then deleted automatically. No other data is retained.</p>
<h2>Contact</h2>
<p>Questions? Email <a href="mailto:flipsideextension@gmail.com">flipsideextension@gmail.com</a>.</p>
</body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "public,max-age=86400" } });
    }

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

    const {
      stage = "classify", title = "", text = "", url = "",
      articleType = "", coreClaim = "", claimType = "empirical",
      evidence = [], rating = "",
      citation_schema = "", bypassCache = false, evidenceFingerprint = "",
    } = body;

    // Feedback — handled before text validation (no article text needed)
    if (stage === "feedback") {
      if (rating !== "up" && rating !== "down") return json({ error: "Invalid rating." }, 400);
      if (!url) return json({ error: "URL required." }, 400);
      const fbKey = `fb:${buildLegacyCacheKey("u", url)}`;
      const existing = await kvGet(env, fbKey);
      let counts = { up: 0, down: 0 };
      if (existing) { try { counts = JSON.parse(existing); } catch {} }
      counts[rating] = (counts[rating] || 0) + 1;
      ctx.waitUntil(kvSet(env, fbKey, JSON.stringify(counts), 60 * 60 * 24 * 90));
      return json({ ok: true });
    }

    if (typeof text !== "string" || text.length > MAX_TEXT_CHARS) return json({ error: "Article text too long." }, 400);
    if (text.trim().length < 10) return json({ error: "No article text found." }, 400);
    if (stage !== "classify" && stage !== "synthesize") return json({ error: "Unknown stage." }, 400);

    const messages = stage === "classify"
      ? buildClassifyMessages({ title, text, url })
      : buildSynthMessages({ title, text, articleType, coreClaim, claimType, evidence });

    // KV cache — dual namespace:
    //   v14 (legacy): URL-keyed — old clients without citation_schema
    //   v15 (stable): content-keyed — clients sending citation_schema:"stable-v1"
    const stableSchema = citation_schema === "stable-v1";
    let kvCacheKey;
    if (stableSchema) {
      if (stage === "classify") {
        kvCacheKey = buildStableCacheKey("classify", [(title || "").slice(0, 500), (text || "").slice(0, 9000)]);
      } else {
        const dateBucket = new Date().toISOString().slice(0, 10);
        kvCacheKey = buildStableCacheKey("synth", [
          (text || "").slice(0, 6000),
          (coreClaim || "").toLowerCase().trim(),
          claimType || "empirical",
          articleType || "news",
          evidenceFingerprint || "",
          dateBucket,
        ]);
      }
    } else {
      kvCacheKey = buildLegacyCacheKey(stage, url);
    }

    if (!bypassCache) {
      const kvCached = await kvGet(env, kvCacheKey);
      if (kvCached) return json({ content: kvCached }, 200, { "X-Cache": "HIT", "X-Provider": "cache" });
    }

    let result;
    try { result = await generate(env, messages); }
    catch (err) {
      if (err.exhausted) {
        if (err.lastKind === "quota_daily") return json({ error: "The shared free service has hit today's limit. It resets at midnight UTC. Add your own free key in options.", reason: "quota_daily" }, 429);
        return json({ error: "The shared free service is busy right now.", reason: "rate_limit", retryAfter: err.retryAfter ?? 60 }, 429);
      }
      return json({ error: err.message ?? "Generation failed." }, 502);
    }

    // Classify: always cache (deterministic, cheap to serve, expensive to generate).
    // Synthesis: cache only non-"none" results — lets the pipeline retry on bad runs.
    let parsed;
    try { parsed = JSON.parse(result.response); } catch {}
    const shouldCache =
      stage === "classify" ||
      (parsed?.result_type && parsed.result_type !== "none");
    if (shouldCache) {
      ctx.waitUntil(kvSet(env, kvCacheKey, result.response));
    }

    return json({ content: result.response }, 200, { "X-Provider": result.provider, "X-Chain-Trace": (result.trace || []).join(",") || "none" });
  },
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", ...extra },
  });
}
