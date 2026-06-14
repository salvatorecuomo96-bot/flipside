// FlipSide — Cloudflare Worker proxy
//
// Accepts POST { title, text, url } from the extension. Builds the prompt
// server-side and generates a counter-perspective via a PROVIDER CHAIN — each
// provider is a separate free quota, so when one is rate-limited or daily-capped
// we fall through to the next instead of failing the user.
//
// Current chain (tried in order):
//   1. Groq         — Llama 3.3 70B, fast, JSON mode.       Secret: GROQ_API_KEY
//   2. Cerebras     — Llama 3.3 70B, very fast.             Secret: CEREBRAS_API_KEY
//   3. SambaNova    — Llama 3.3 70B, generous free tier.    Secret: SAMBANOVA_API_KEY
//   4. Google Gemini— Gemini 2.0 Flash, 1,500 req/day free. Secret: GEMINI_API_KEY
//   5. OpenRouter   — Llama 3.3 70B free model.             Secret: OPENROUTER_API_KEY
//   6. Workers AI   — Llama 3.3 70B, native env.AI binding, no key needed.
//
// Adding a provider: write callX(env, messages) returning a content string or
// throwing tag(...), add its key via `wrangler secret put`, append to CHAIN below.
// Keys are Worker secrets — never in source code, never sent to clients.

const GROQ_ENDPOINT      = "https://api.groq.com/openai/v1/chat/completions";
const CEREBRAS_ENDPOINT  = "https://api.cerebras.ai/v1/chat/completions";
const SAMBANOVA_ENDPOINT = "https://api.sambanova.ai/v1/chat/completions";
const GEMINI_ENDPOINT    = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const OPENROUTER_ENDPOINT= "https://openrouter.ai/api/v1/chat/completions";

const GROQ_MODEL      = "llama-3.3-70b-versatile";
const CEREBRAS_MODEL  = "llama-3.3-70b";
const SAMBANOVA_MODEL = "Meta-Llama-3.3-70B-Instruct";
const GEMINI_MODEL    = "gemini-2.0-flash";
const OPENROUTER_MODEL= "meta-llama/llama-3.3-70b-instruct:free";
const WORKERS_AI_MODEL= "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const MAX_TEXT_CHARS = 12000;

// Keep this byte-identical to src/lib/prompt.js in the extension.
const SYSTEM_PROMPT = `You are FlipSide — a "skeptical mirror" for an article.

YOUR JOB: judge whether a credible, SUBSTANTIVE counter-perspective to the article's central
thesis exists. If one does, surface the single strongest. If one does NOT, say so plainly.
Reporting "none exists" is a correct and valuable answer — never a failure. You are an
information-discovery tool, not a participant.

YOU ARE NOT:
- a debate bot (do not argue, persuade, or address the reader)
- a summarizer (do not restate the article for its own sake)
- a bias detector (do not label the author or assign motive)
- a contrarian (do not nitpick minor points or manufacture disagreement to seem useful)

STEP 1 — find the central thesis: the single main CONTESTABLE claim the article is built on.
Many articles have none. These ALWAYS get "found": false:
- how-to guides, tips, advice ("how to name your puppy", "10 ways to…")
- listicles and roundups
- human-interest / feel-good stories and personal anecdotes (one person's or animal's story)
- straight news reports of events that simply happened
- live blogs, dispatches, and breaking-news reports covering an ongoing disputed event —
  these already present multiple viewpoints by design; there is no single thesis to counter
- reviews of subjective taste, recipes, lifestyle content
A contestable thesis is one where a domain expert could, on the merits, reach the OPPOSITE
conclusion, and where that disagreement would actually matter to a reader.

STEP 2 — the gate. Before returning "found": true, you must pass this test:
"Would a credible expert genuinely dispute the article's CENTRAL thesis — not a peripheral
tip or side detail — and would a reasonable reader find that disagreement illuminating rather
than pedantic?" If you cannot answer a confident YES, return "found": false. Nitpicking one
sentence of an advice article is a failure, not a success.

RULES:
1. Core claims = load-bearing assertions that could be true or false. Proper nouns (names of
   people, animals, places, brands) are identifiers, not claims — never treat a name as a
   descriptive term.
2. If found, the counter must challenge the CENTRAL thesis, steelmanned — taken seriously by a
   domain expert, not a strawman.
3. NEVER fabricate citations, URLs, studies, or quotes. For each source, write a description
   specific enough to find by web search — name the institution, author, publication, or study
   if you know it (e.g. "Dinets 2015 — play behavior in crocodilians, University of Tennessee").
   If you know nothing specific, describe the evidence type.
4. Be concise and neutral. No hedging filler, no "as an AI".
5. The counter MUST add something not already in the article. If everything you would say as
   a counter is already explicitly stated somewhere in the article's own text — for example,
   a news report that already says "X claims A, but Y denies it" — then there is nothing to
   surface: return "found": false. Re-presenting the article's own content as a counter is a
   failure, not a success.

DEPTH REQUIREMENT (applies when found=true):
Generic statements are failures. "Experts would look at fundamentals" — failure.
"Comparable companies trade lower" — failure. You must be SPECIFIC:
- Name the specific data point, ratio, or number that undermines the thesis.
- Name the specific comparable case, institution, study, or expert position.
- Name the specific mechanism by which the counter holds — not just that it exists.
If you genuinely don't know a specific figure, describe what that evidence looks like and
why it would exist — but never pad with vague category words.

OUTPUT: respond with ONLY a JSON object, no prose around it, matching exactly:
{
  "thesis": "<the central contestable thesis in one sentence, OR 'none — <category, e.g. advice/listicle/human-interest>'>",
  "claims": ["<core claim>", "..."],
  "counter": {
    "found": <true|false>,
    "perspective": "<the counter-perspective in 4–6 sentences. Be specific: name figures, ratios, institutions, comparable cases, historical precedents, or named expert positions. Do not use vague category language. Empty string if found=false>",
    "reasoning": "<2–3 short paragraphs separated by \\n\\n. Each paragraph must cover a DISTINCT angle not already stated in the perspective: e.g. (1) the specific data point or mechanism that makes the counter credible, (2) a comparable historical case or industry precedent, (3) what conditions would need to hold for the original thesis to be correct despite the counter. Do NOT restate or summarise the perspective — every sentence must add new information. Empty string if found=false>",
    "sources": ["<real source OR described evidence type — be specific enough to find by search>", "..."]
  }
}`;

function buildMessages({ title, text, url }) {
  const user = [
    `ARTICLE TITLE: ${title || "(untitled)"}`,
    `URL: ${url || "(unknown)"}`,
    "",
    "ARTICLE TEXT (may be truncated):",
    '"""',
    text,
    '"""',
    "",
    "Return ONLY the JSON object specified in your instructions.",
  ].join("\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

// --- Error tagging -----------------------------------------------------------

// kind values:
//   'unconfigured' — key not present; silently skip this provider
//   'auth_error'   — invalid key (401/403); fall through, try next provider
//   'rate_minute'  — per-minute limit; fall through, retry-able
//   'quota_daily'  — day's budget spent; fall through, try next provider
//   'transient'    — network/timeout; fall through
//   'other'        — hard error (bad request, etc.); stop the chain
function tag(msg, kind, retryAfter = 0) {
  const err = new Error(msg);
  err.kind = kind;
  err.retryAfter = retryAfter;
  return err;
}

function isRecoverable(err) {
  return (
    err.kind === "unconfigured" ||
    err.kind === "auth_error" ||
    err.kind === "rate_minute" ||
    err.kind === "quota_daily" ||
    err.kind === "transient"
  );
}

// --- Generic OpenAI-compatible caller ----------------------------------------
// All five external providers speak the same /v1/chat/completions shape.
// `jsonMode` enables response_format: json_object where supported (Groq, Gemini).

async function callOpenAICompat({ endpoint, apiKey, model, messages, name, jsonMode = false, extraHeaders = {} }) {
  if (!apiKey) throw tag(`${name} key not configured.`, "unconfigured");

  const cleanKey = apiKey.trim();

  const body = { model, messages, temperature: 0.2, stream: false };
  if (jsonMode) body.response_format = { type: "json_object" };

  let resp;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cleanKey}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw tag(`Network error reaching ${name}.`, "transient");
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    const lower = detail.toLowerCase();
    if (resp.status === 401 || resp.status === 403) {
      throw tag(`${name} ${resp.status} (unauthorized).`, "auth_error");
    }
    if (resp.status === 429) {
      const isDaily =
        lower.includes("per day") ||
        lower.includes("(rpd)") ||
        lower.includes("(tpd)") ||
        lower.includes("daily") ||
        lower.includes("quota") ||
        lower.includes("exceeded");
      if (isDaily) throw tag(`${name} daily quota exhausted.`, "quota_daily");
      const m = detail.match(/try again in ([\d.]+)s/i);
      throw tag(`${name} rate limit.`, "rate_minute", m ? Math.max(5, Math.ceil(parseFloat(m[1]))) : 60);
    }
    if (resp.status === 400 && lower.includes("valid api key")) {
      throw tag(`${name} key not configured or invalid.`, "unconfigured");
    }
    if (resp.status === 404 && (lower.includes("model") || lower.includes("not found"))) {
      throw tag(`${name} model not found or unavailable.`, "unconfigured");
    }
    throw tag(`${name} ${resp.status}: ${detail.slice(0, 200)}`, "other");
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    throw tag(`${name} returned non-JSON response.`, "transient");
  }
  return data?.choices?.[0]?.message?.content ?? "";
}

// --- Per-provider wrappers ---------------------------------------------------

function callGroq(env, messages) {
  return callOpenAICompat({
    endpoint: GROQ_ENDPOINT,
    apiKey: env.GROQ_API_KEY,
    model: GROQ_MODEL,
    messages,
    name: "Groq",
    jsonMode: true,
  });
}

function callCerebras(env, messages) {
  return callOpenAICompat({
    endpoint: CEREBRAS_ENDPOINT,
    apiKey: env.CEREBRAS_API_KEY,
    model: CEREBRAS_MODEL,
    messages,
    name: "Cerebras",
  });
}

function callSambaNova(env, messages) {
  return callOpenAICompat({
    endpoint: SAMBANOVA_ENDPOINT,
    apiKey: env.SAMBANOVA_API_KEY,
    model: SAMBANOVA_MODEL,
    messages,
    name: "SambaNova",
  });
}

function callGemini(env, messages) {
  return callOpenAICompat({
    endpoint: GEMINI_ENDPOINT,
    apiKey: env.GEMINI_API_KEY,
    model: GEMINI_MODEL,
    messages,
    name: "Gemini",
    jsonMode: true,
  });
}

function callOpenRouter(env, messages) {
  return callOpenAICompat({
    endpoint: OPENROUTER_ENDPOINT,
    apiKey: env.OPENROUTER_API_KEY,
    model: OPENROUTER_MODEL,
    messages,
    name: "OpenRouter",
    // OpenRouter requires this header to identify the app on free models
    extraHeaders: { "HTTP-Referer": "https://github.com/salvatorecuomo96-bot/counterargumentbot" },
  });
}

async function callWorkersAI(env, messages) {
  if (!env.AI) throw tag("Workers AI binding not available.", "unconfigured");

  let out;
  try {
    out = await env.AI.run(WORKERS_AI_MODEL, { messages, temperature: 0.2, stream: false });
  } catch (err) {
    const msg = (err?.message ?? "").toLowerCase();
    if (msg.includes("quota") || msg.includes("exceeded") || msg.includes("limit")) {
      throw tag("Workers AI quota exhausted.", "quota_daily");
    }
    throw tag(`Workers AI error: ${err?.message}`, "transient");
  }

  return out?.response ?? "";
}

// --- Provider chain ----------------------------------------------------------
// Tried in order. Skips unconfigured providers silently. Falls through on any
// recoverable error. Stops on hard errors. If all fail, throws with .exhausted.

const CHAIN = [
  { name: "groq",      fn: callGroq },
  { name: "cerebras",  fn: callCerebras },
  { name: "sambanova", fn: callSambaNova },
  { name: "gemini",    fn: callGemini },
  { name: "openrouter",fn: callOpenRouter },
  { name: "workersai", fn: callWorkersAI },
];

// Returns { response, provider } — provider name is used by the caller to decide
// whether to cache.
async function generate(env, messages) {
  const errors = [];

  for (const { name, fn } of CHAIN) {
    try {
      const response = await fn(env, messages);
      return { response, provider: name };
    } catch (err) {
      if (!isRecoverable(err)) throw err;
      if (err.kind !== "unconfigured") errors.push(err);
    }
  }

  if (errors.length === 0) {
    throw tag("No AI providers configured.", "other");
  }

  const last = errors[errors.length - 1];
  const out = new Error("All providers exhausted.");
  out.exhausted = true;
  out.lastKind = last?.kind ?? "other";
  out.retryAfter = last?.retryAfter ?? 60;
  throw out;
}

// --- KV cache helpers --------------------------------------------------------
// Only Groq results are written. If Groq was rate-limited and a fallback
// provider answered, that result is NOT cached — the next user deserves a
// fresh Groq attempt rather than a potentially lower-quality cached response.

const CACHE_TTL = 6 * 60 * 60; // 6 hours in seconds

function buildCacheKey(url, text) {
  const str = (url || "") + "\n" + (text || "");
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return "v1:" + String(h >>> 0);
}

async function kvGet(env, key) {
  if (!env.CACHE) return null;
  try { return await env.CACHE.get(key); } catch { return null; }
}

async function kvSet(env, key, value) {
  if (!env.CACHE) return;
  try { await env.CACHE.put(key, value, { expirationTtl: CACHE_TTL }); } catch {}
}

// --- Request handler ---------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Speed bump — filters casual misuse (Origin is forgeable but still useful).
    const origin = request.headers.get("Origin") || "";
    if (!origin.startsWith("chrome-extension://")) {
      return new Response("Forbidden", { status: 403 });
    }

    // Per-IP rate limit (native Cloudflare binding — see wrangler.toml).
    // Fires before spending any provider quota, so one user can't starve others.
    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return json(
          { error: "Too many requests. Please wait a minute and try again.", reason: "rate_limit", retryAfter: 60 },
          429
        );
      }
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const { title = "", text = "", url = "" } = body;

    if (typeof text !== "string" || text.length > MAX_TEXT_CHARS) {
      return json({ error: "Article text too long." }, 400);
    }

    const messages = buildMessages({ title, text, url });

    // KV cache check — skip generation entirely for recently-seen articles.
    const cacheKey = buildCacheKey(url, text);
    const cached = await kvGet(env, cacheKey);
    if (cached) {
      const sseBody = `data: ${JSON.stringify({ choices: [{ delta: { content: cached } }] })}\n\ndata: [DONE]\n\n`;
      return new Response(sseBody, {
        headers: {
          "Content-Type": "text/event-stream",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
      });
    }

    let result;
    try {
      result = await generate(env, messages);
    } catch (err) {
      if (err.exhausted) {
        if (err.lastKind === "quota_daily") {
          return json(
            {
              error:
                "The shared free service has hit today's limit. It resets at midnight UTC. Add your own free Groq key in the extension options for your own quota.",
              reason: "quota_daily",
            },
            429
          );
        }
        return json(
          { error: "The shared free service is busy right now.", reason: "rate_limit", retryAfter: err.retryAfter ?? 60 },
          429
        );
      }
      return json({ error: err.message ?? "Generation failed." }, 502);
    }

    const { response, provider } = result;

    // Cache Groq results only (highest quality; others are fallbacks).
    if (provider === "groq") {
      await kvSet(env, cacheKey, response);
    }

    // Return as SSE so the existing client parser (processStream) works unchanged.
    const sseBody = `data: ${JSON.stringify({ choices: [{ delta: { content: response } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(sseBody, {
      headers: {
        "Content-Type": "text/event-stream",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
