// Flipside — Cloudflare Worker proxy
//
// Accepts POST { title, text, url } from the extension. Builds the prompt
// server-side and generates a counter-perspective via a PROVIDER CHAIN — each
// provider is a separate free quota, so when one is rate-limited or daily-capped
// we fall through to the next instead of failing the user.
//
// Current chain (in order):
//   1. Groq            — Llama 3.3 70B, fast, JSON mode.  Secret: GROQ_API_KEY.
//   2. Workers AI      — Llama 3.3 70B, native env.AI binding, separate free pool.
//
// To add a provider: write callX(env, messages) returning a content string or
// throwing tag(...), add its key as a wrangler secret, append to PROVIDERS below.
// Keys are Worker secrets — never in source code, never sent to clients.

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_TEXT_CHARS = 12000;

// Keep this byte-identical to src/lib/prompt.js in the extension.
const SYSTEM_PROMPT = `You are Flipside — a "skeptical mirror" for an article.

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

OUTPUT: respond with ONLY a JSON object, no prose around it, matching exactly:
{
  "thesis": "<the central contestable thesis in one sentence, OR 'none — <category, e.g. advice/listicle/human-interest>'>",
  "claims": ["<core claim>", "..."],
  "counter": {
    "found": <true|false>,
    "perspective": "<the counter-perspective in 2–3 sentences; empty string if found=false>",
    "reasoning": "<why a credible expert would hold it; empty string if found=false>",
    "sources": ["<real source OR described evidence type>", "..."]
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

// --- Provider helpers --------------------------------------------------------

// Attach metadata to an error so the chain knows whether to fall through.
// kind: 'rate_minute' | 'quota_daily' | 'transient' | 'other'
function tag(msg, kind, retryAfter = 0) {
  const err = new Error(msg);
  err.kind = kind;
  err.retryAfter = retryAfter;
  return err;
}

// Returns true for error kinds that warrant trying the next provider.
function isRecoverable(err) {
  return err.kind === "rate_minute" || err.kind === "quota_daily" || err.kind === "transient";
}

async function callGroq(env, messages) {
  if (!env.GROQ_API_KEY) throw tag("Groq key not configured.", "other");

  let resp;
  try {
    resp = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });
  } catch {
    throw tag("Network error reaching Groq.", "transient");
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    if (resp.status === 429) {
      const lower = detail.toLowerCase();
      const isDaily =
        lower.includes("per day") || lower.includes("(rpd)") || lower.includes("(tpd)");
      if (isDaily) throw tag("Groq daily quota exhausted.", "quota_daily");
      const m = detail.match(/try again in ([\d.]+)s/i);
      throw tag("Groq rate limit.", "rate_minute", m ? Math.max(5, Math.ceil(parseFloat(m[1]))) : 60);
    }
    throw tag(`Groq ${resp.status}.`, "other");
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function callWorkersAI(env, messages) {
  if (!env.AI) throw tag("Workers AI binding not available.", "other");

  let out;
  try {
    out = await env.AI.run(WORKERS_AI_MODEL, { messages, temperature: 0.2 });
  } catch (err) {
    const msg = (err?.message ?? "").toLowerCase();
    // Workers AI surfaces quota exhaustion as an exception with keywords like
    // "exceeded", "quota", or "limit" — treat as daily so the error message is honest.
    if (msg.includes("quota") || msg.includes("exceeded") || msg.includes("limit")) {
      throw tag("Workers AI quota exhausted.", "quota_daily");
    }
    throw tag(`Workers AI error: ${err?.message}`, "transient");
  }

  // env.AI.run returns { response: string } for text-generation models
  return out?.response ?? "";
}

// --- Provider chain ----------------------------------------------------------
// Try each provider in order. Fall through on recoverable errors (rate limits,
// quota). Stop on hard errors (misconfiguration, bad request). If all fail,
// throw with .exhausted=true so the caller can return the right HTTP response.

async function generate(env, messages) {
  const errors = [];

  // 1. Groq — primary (fast, JSON mode)
  try {
    return await callGroq(env, messages);
  } catch (err) {
    if (!isRecoverable(err)) throw err;
    errors.push(err);
  }

  // 2. Workers AI — fallback (separate free pool, no key needed)
  try {
    return await callWorkersAI(env, messages);
  } catch (err) {
    errors.push(err);
  }

  // All providers exhausted
  const last = errors[errors.length - 1];
  const out = new Error("All providers exhausted.");
  out.exhausted = true;
  out.lastKind = last?.kind ?? "other";
  out.retryAfter = last?.retryAfter ?? 60;
  throw out;
}

// --- Request handler ---------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Speed bump — filters casual misuse (Origin is forgeable but still useful).
    const origin = request.headers.get("Origin") || "";
    if (!origin.startsWith("chrome-extension://")) {
      return new Response("Forbidden", { status: 403 });
    }

    // Per-IP rate limit (native Cloudflare binding — see wrangler.toml).
    // This fires BEFORE we spend any provider quota, so one client can't starve others.
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

    let content;
    try {
      content = await generate(env, messages);
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

    return json({ content });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
