// api-client.js — two routes to the same 70B model, chosen by the service worker.
//
// callProxy  — no key needed; posts to the hosted Cloudflare Worker.
// callDirect — user supplied their own Groq key; calls Groq directly.
//
// Both return a parsed perspective object; both throw on failure.

import { buildMessages } from "./prompt.js";

const PROXY_URL = "https://epistemic-companion-proxy.salvatoreducksamurai96.workers.dev";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const TIMEOUT_MS = 30000; // Groq is fast; 30s is generous

export async function callProxy({ title, text, url }, onChunk) {
  const resp = await fetchWithTimeout(PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": `chrome-extension://${chrome.runtime.id}`,
    },
    body: JSON.stringify({ title, text, url }),
  });

  if (!resp.ok) {
    if (resp.status === 429) {
      const body = await safeJson(resp);
      if (body?.reason === "rate_limit") {
        const err = new Error(body.error || "The service is busy. Please wait a moment.");
        err.retryAfter = body.retryAfter || 60;
        throw err;
      }
      const err = new Error(
        body?.error || "The shared free service has hit today's limit. Add your own free Groq key in the extension options for your own quota."
      );
      err.daily = true;
      throw err;
    }
    const detail = await safeErrorText(resp);
    throw new Error(`Proxy error (${resp.status}): ${detail}`);
  }

  return processStream(resp, onChunk);
}

export async function callDirect({ apiKey, payload }, onChunk) {
  const resp = await fetchWithTimeout(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: buildMessages(payload),
      temperature: 0.2,
      response_format: { type: "json_object" },
      stream: true
    }),
  });

  if (!resp.ok) {
    const detail = await safeErrorText(resp);
    if (resp.status === 429) {
      const lower = detail.toLowerCase();
      if (lower.includes("per day") || lower.includes("(rpd)") || lower.includes("(tpd)")) {
        const err = new Error("Your Groq key hit today's free limit. It resets at midnight UTC.");
        err.daily = true;
        throw err;
      }
      const m = detail.match(/try again in ([\d.]+)s/i);
      const err = new Error("Groq rate limit — too many requests this minute.");
      err.retryAfter = m ? Math.max(5, Math.ceil(parseFloat(m[1]))) : 60;
      throw err;
    }
    if (resp.status === 401) {
      // Invalid key — silently fall back to the shared proxy so the user isn't blocked.
      return callProxy(payload, onChunk);
    }
    throw new Error(`Groq error (${resp.status}): ${detail}`);
  }

  return processStream(resp, onChunk);
}

async function processStream(resp, onChunk) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let lines = buffer.split("\n");
    buffer = lines.pop(); // keep the last incomplete line

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") continue;
        try {
          const data = JSON.parse(dataStr);
          const chunk = data?.choices?.[0]?.delta?.content ?? "";
          if (chunk) {
            fullText += chunk;
            if (onChunk) onChunk(fullText);
          }
        } catch {
          // Ignore invalid JSON chunks (some providers send comments or bad formatting)
        }
      }
    }
  }
  
  if (buffer.startsWith("data: ")) {
    try {
      const dataStr = buffer.slice(6).trim();
      if (dataStr !== "[DONE]") {
        const data = JSON.parse(dataStr);
        const chunk = data?.choices?.[0]?.delta?.content ?? "";
        if (chunk) fullText += chunk;
      }
    } catch {}
  }

  if (onChunk) onChunk(fullText);
  return parsePerspective(fullText);
}

// --- helpers ------------------------------------------------------------------

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
  try {
    const d = await resp.json();
    return d?.error?.message || JSON.stringify(d).slice(0, 200);
  } catch {
    return resp.statusText || "no detail";
  }
}

// Read a JSON body without throwing (a response body can only be read once).
async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

function parsePerspective(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { claims: [], counter: { found: false, perspective: "", reasoning: "", sources: [] } };
    try { parsed = JSON.parse(match[0]); } catch { return { claims: [], counter: { found: false, perspective: "", reasoning: "", sources: [] } }; }
  }
  const counter = parsed?.counter ?? {};
  return {
    claims: Array.isArray(parsed?.claims) ? parsed.claims.map(String) : [],
    counter: {
      found: counter.found === true,
      perspective: typeof counter.perspective === "string" ? counter.perspective : "",
      reasoning: typeof counter.reasoning === "string" ? counter.reasoning : "",
      sources: Array.isArray(counter.sources) ? counter.sources.map(String) : [],
    },
  };
}
