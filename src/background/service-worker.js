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
    console.warn("[FlipSide] no content script on this tab:", err?.message);
  }
});

// --- 2. Analysis requests from the content script -------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "stream-analyze") {
    const tabId = port.sender?.tab?.id ?? null;
    port.onMessage.addListener(async (msg) => {
      if (msg.type === "ANALYZE") {
        if (tabId) clearDot(tabId);
        const res = await handleAnalyze(msg.payload, (partialText) => {
          port.postMessage({ type: "CHUNK", text: partialText });
        });
        port.postMessage({ type: "DONE", result: res });
        setBadge(tabId, res);
        if (res.ok && msg.payload?.url) {
          await saveBadgeState(msg.payload.url, res.data?.counter?.found === true ? "found" : "notfound");
        }
      }
    });
  }
});

// Clear the dot when the user navigates — stale state would be misleading.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") clearDot(tabId);
});

function setBadge(tabId, res) {
  if (!tabId) return;
  if (res.ok && res.data?.counter?.found === true) {
    applyDot(tabId, "#22c55e");
  } else if (res.ok && res.data?.counter?.found === false) {
    applyDot(tabId, "#ef4444");
  } else {
    clearDot(tabId);
  }
}

function restoreBadge(tabId, state) {
  if (!tabId || !state) return;
  if (state === "found") applyDot(tabId, "#22c55e");
  else if (state === "notfound") applyDot(tabId, "#ef4444");
}

async function applyDot(tabId, color) {
  try {
    const bitmap = await createImageBitmap(
      await (await fetch(chrome.runtime.getURL("icons/icon32.png"))).blob()
    );
    const canvas = new OffscreenCanvas(32, 32);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, 32, 32);
    ctx.beginPath();
    ctx.arc(25, 25, 7, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const imageData = ctx.getImageData(0, 0, 32, 32);
    await chrome.action.setIcon({ imageData: { 32: imageData }, tabId });
  } catch (e) {
    console.warn("[FlipSide] applyDot failed:", e);
  }
}

function clearDot(tabId) {
  chrome.action.setIcon({
    path: { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png" },
    tabId,
  }).catch(() => {});
}

// --- Badge state cache (chrome.storage.local) -----------------------------
const BADGE_CACHE_KEY = "badgeCache";
const BADGE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

async function saveBadgeState(url, state) {
  const store = (await chrome.storage.local.get(BADGE_CACHE_KEY))[BADGE_CACHE_KEY] || {};
  store[url] = { state, ts: Date.now() };
  const keys = Object.keys(store);
  if (keys.length > 500) {
    keys.sort((a, b) => store[a].ts - store[b].ts);
    for (const k of keys.slice(0, keys.length - 500)) delete store[k];
  }
  await chrome.storage.local.set({ [BADGE_CACHE_KEY]: store });
}

async function getBadgeState(url) {
  const store = (await chrome.storage.local.get(BADGE_CACHE_KEY))[BADGE_CACHE_KEY] || {};
  const entry = store[url];
  if (!entry || Date.now() - entry.ts > BADGE_TTL_MS) return null;
  return entry.state;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Legacy non-streaming endpoint
  if (msg?.type === "ANALYZE") {
    handleAnalyze(msg.payload).then(sendResponse);
    return true; // keep channel open for async response
  }
  if (msg?.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    return false;
  }
  if (msg?.type === "PAGE_LOADED") {
    const tabId = sender.tab?.id ?? null;
    if (tabId && msg.url) {
      getBadgeState(msg.url).then((state) => restoreBadge(tabId, state));
    }
    return false;
  }
  if (msg?.type === "PREANALYZE") {
    const tabId = sender.tab?.id ?? null;
    const url = msg.payload?.url;
    if (!tabId || !url) return false;
    chrome.storage.local.get(["apiKey", "preanalyzeEnabled"]).then(async ({ apiKey, preanalyzeEnabled }) => {
      if (apiKey && preanalyzeEnabled === false) return; // user opted out
      const existing = await getBadgeState(url);
      if (existing) return; // badge already cached — PAGE_LOADED already restored it
      const res = await handleAnalyze(msg.payload);
      setBadge(tabId, res);
      if (res.ok) {
        await saveBadgeState(url, res.data?.counter?.found === true ? "found" : "notfound");
      }
    });
    return false;
  }
  return false;
});

async function handleAnalyze(payload, onChunk = null) {
  // Cache first: re-opening the same article (or a different user-key vs proxy
  // run on identical text) returns instantly and spends zero quota. Keyed on a
  // hash of url+text, so an edited article (different text) correctly misses.
  const cacheKey = hashStr((payload.url || "") + "\n" + (payload.text || ""));
  const cached = await cacheGet(cacheKey);
  if (cached) {
    // If we have a cached result, simulate a single chunk with the full text 
    // to satisfy the streaming UI's expectations before returning DONE.
    // However, the cached result is already parsed JSON. The UI expects raw JSON strings in CHUNKs.
    if (onChunk) onChunk(JSON.stringify(cached));
    return { ok: true, data: cached, cached: true };
  }

  const { apiKey } = await chrome.storage.local.get("apiKey");

  try {
    let data;
    if (apiKey) {
      data = await callDirect({ apiKey, payload }, onChunk);
    } else {
      data = await callProxy(payload, onChunk);
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
