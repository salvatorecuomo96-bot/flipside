// api-client.js — two routes to the same 70B model, chosen by the service worker.
//
// callProxy  — no key needed; posts to the hosted Cloudflare Worker.
// callDirect — user supplied their own Groq key; calls Groq directly.
//
// Both return a parsed perspective object; both throw on failure.

import { buildMessages } from "./prompt.js";

const PROXY_URL = "https://epistemic-companion-proxy.salvatoreducksamurai96.workers.dev";
const TIMEOUT_MS = 30000;

const BYOK_PROVIDERS = {
  groq:       { endpoint: "https://api.groq.com/openai/v1/chat/completions",        model: "llama-3.3-70b-versatile" },
  deepseek:   { endpoint: "https://api.deepseek.com/v1/chat/completions",           model: "deepseek-chat" },
  openai:     { endpoint: "https://api.openai.com/v1/chat/completions",             model: "gpt-4o-mini" },
  openrouter: { endpoint: "https://openrouter.ai/api/v1/chat/completions",          model: "meta-llama/llama-3.3-70b-instruct:free" },
  cerebras:   { endpoint: "https://api.cerebras.ai/v1/chat/completions",            model: "gpt-oss-120b" },
  sambanova:  { endpoint: "https://api.sambanova.ai/v1/chat/completions",           model: "Meta-Llama-3.3-70B-Instruct" },
};

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

export async function callDirect({ apiKey, provider = "groq", payload }, onChunk) {
  if (provider === "anthropic") return callAnthropic(apiKey, payload, onChunk);

  const cfg = BYOK_PROVIDERS[provider] ?? BYOK_PROVIDERS.groq;

  const resp = await fetchWithTimeout(cfg.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: buildMessages(payload),
      temperature: 0.2,
      response_format: { type: "json_object" },
      stream: true,
    }),
  });

  if (!resp.ok) {
    const detail = await safeErrorText(resp);
    if (resp.status === 429) {
      const lower = detail.toLowerCase();
      if (lower.includes("per day") || lower.includes("(rpd)") || lower.includes("(tpd)")) {
        const err = new Error("Your API key hit today's limit. It resets at midnight UTC.");
        err.daily = true;
        throw err;
      }
      const m = detail.match(/try again in ([\d.]+)s/i);
      const err = new Error("Rate limit — too many requests this minute.");
      err.retryAfter = m ? Math.max(5, Math.ceil(parseFloat(m[1]))) : 60;
      throw err;
    }
    if (resp.status === 401) {
      // Invalid key — silently fall back to the shared proxy so the user isn't blocked.
      return callProxy(payload, onChunk);
    }
    throw new Error(`${provider} error (${resp.status}): ${detail}`);
  }

  return processStream(resp, onChunk);
}

async function callAnthropic(apiKey, payload, onChunk) {
  const all = buildMessages(payload);
  const system = all.find(m => m.role === "system")?.content ?? "";
  const messages = all.filter(m => m.role !== "system");

  const resp = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system,
      messages,
      stream: true,
    }),
  });

  if (!resp.ok) {
    if (resp.status === 401) return callProxy(payload, onChunk);
    if (resp.status === 429) {
      const err = new Error("Anthropic rate limit — too many requests.");
      err.retryAfter = 60;
      throw err;
    }
    const detail = await safeErrorText(resp);
    throw new Error(`Anthropic error (${resp.status}): ${detail}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
          fullText += data.delta.text ?? "";
          if (onChunk) onChunk(fullText);
        }
      } catch {}
    }
  }

  if (onChunk) onChunk(fullText);
  return parsePerspective(fullText);
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
