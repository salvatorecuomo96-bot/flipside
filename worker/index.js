// Flipside — Cloudflare Worker proxy
//
// Accepts POST { title, text, url } from the extension.
// Builds the prompt server-side, calls Groq, returns { content } (raw model JSON).
//
// GROQ_API_KEY is a Worker secret — never in code, never on the wire to clients.
// Deploy: wrangler secret put GROQ_API_KEY

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";
const MAX_TEXT_CHARS = 12000; // ~3k tokens; longer texts get truncated by the extension anyway

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

export default {
  async fetch(request, env) {
    // Only POST
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Speed bump: only chrome extensions should be calling this.
    // Not a hard security gate (Origin is forgeable), but filters casual misuse.
    const origin = request.headers.get("Origin") || "";
    if (!origin.startsWith("chrome-extension://")) {
      return new Response("Forbidden", { status: 403 });
    }

    // Per-IP rate limit (Cloudflare native limiter — see wrangler.toml binding).
    // Stops one client from bursting through the shared daily quota. We mark the
    // response with reason:"rate_limit" so the extension shows a "slow down" nudge
    // rather than the "daily quota used up — add your key" message, which is only
    // correct when Groq itself returns 429 (passed through further below).
    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return json(
          {
            error: "Too many requests. Please wait a minute and try again.",
            reason: "rate_limit",
            retryAfter: 60,
          },
          429
        );
      }
    }

    // Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const { title = "", text = "", url = "" } = body;

    // Size cap — rejects unusually large payloads before they hit Groq
    if (typeof text !== "string" || text.length > MAX_TEXT_CHARS) {
      return json({ error: "Article text too long." }, 400);
    }

    // Call Groq
    let groqResp;
    try {
      groqResp = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: buildMessages({ title, text, url }),
          temperature: 0.2,
          response_format: { type: "json_object" },
        }),
      });
    } catch (err) {
      return json({ error: "Network error reaching Groq." }, 502);
    }

    if (!groqResp.ok) {
      const detail = await groqResp.text().catch(() => "");

      // Groq 429s come in two flavors and we must NOT conflate them:
      //   - per-minute (TPM/RPM): transient, clears within ~a minute. Groq's
      //     message says "per minute" and often "try again in Xs".
      //   - per-day (TPD/RPD): the day's shared budget is spent; resets at
      //     midnight UTC. Telling the user to "wait a minute" here is a lie.
      if (groqResp.status === 429) {
        const lower = detail.toLowerCase();
        const isDaily =
          lower.includes("per day") || lower.includes("(rpd)") || lower.includes("(tpd)");
        if (isDaily) {
          return json(
            {
              error:
                "The shared free service has hit today's limit. It resets at midnight UTC. Add your own free Groq key in the extension options for your own quota.",
              reason: "quota_daily",
            },
            429
          );
        }
        const m = detail.match(/try again in ([\d.]+)s/i);
        const retryAfter = m ? Math.max(5, Math.ceil(parseFloat(m[1]))) : 60;
        return json(
          {
            error: "The shared free service is busy right now.",
            reason: "rate_limit",
            retryAfter,
          },
          429
        );
      }

      return json(
        { error: `Groq ${groqResp.status}: ${detail.slice(0, 200)}` },
        groqResp.status
      );
    }

    const groqData = await groqResp.json();
    const content = groqData?.choices?.[0]?.message?.content ?? "";
    return json({ content });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
