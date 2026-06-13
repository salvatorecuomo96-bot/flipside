// service-worker.js — the extension's privileged, event-driven brain.
//
// Two jobs:
//   1. Turn a toolbar-button click into a "toggle the panel" message to the page.
//   2. Route ANALYZE requests: direct to Groq if the user has a key, else via proxy.

import { callProxy, callDirect } from "../lib/api-client.js";

// --- 1. Toolbar click -> tell the active tab to toggle its panel ----------
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" });
  } catch (err) {
    console.warn("[Flipside] no content script on this tab:", err?.message);
  }
});

// --- 2. Analysis requests from the content script -------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ANALYZE") {
    handleAnalyze(msg.payload).then(sendResponse);
    return true; // keep channel open for async response
  }
  return false;
});

async function handleAnalyze(payload) {
  // Cache first: re-opening the same article (or a different user-key vs proxy
  // run on identical text) returns instantly and spends zero quota. Keyed on a
  // hash of url+text, so an edited article (different text) correctly misses.
  const cacheKey = hashStr((payload.url || "") + "\n" + (payload.text || ""));
  const cached = await cacheGet(cacheKey);
  if (cached) return { ok: true, data: cached, cached: true };

  const { apiKey } = await chrome.storage.local.get("apiKey");

  try {
    let data;
    if (apiKey) {
      data = await callDirect({ apiKey, payload });
    } else {
      data = await callProxy(payload);
    }
    await cacheSet(cacheKey, data); // only successes are cached
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err?.message ?? "The analysis request failed.",
      retryAfter: err?.retryAfter ?? 0,
      daily: err?.daily === true,
    };
  }
}

// --- Result cache (chrome.storage.local) ----------------------------------
// One JSON object holds all entries; small payloads (~1–2 KB each) and a hard
// cap keep us well under the storage quota without needing extra permissions.
const CACHE_KEY = "analysisCache";
const CACHE_MAX = 150; // evict oldest beyond this
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30-day freshness bound

async function cacheGet(key) {
  const store = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
  return entry.data;
}

async function cacheSet(key, data) {
  const store = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  store[key] = { data, ts: Date.now() };
  const keys = Object.keys(store);
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => store[a].ts - store[b].ts);
    for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete store[k];
  }
  await chrome.storage.local.set({ [CACHE_KEY]: store });
}

// djb2 — fast, non-cryptographic; we only need a stable cache key.
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
