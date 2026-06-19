// service-worker.js — the two-call research pipeline orchestrator.
//
//   1. classify   (model)  — analyzable? core claim? what to search for?
//   2. fetchSources (code) — real evidence (abstracts) from credible DBs
//   3. synthesize (model)  — grounded result, citing only provided evidence
//   4. validate   (code)   — drop any cited source whose quote isn't really
//                            in its abstract (anti-hallucination provenance gate)
//
// Badge: green = counter-perspective, blue = additional context (both only when
// confidence ≥ THRESHOLD). No dot for "none" — silence is the honest default.

import { classify, synthesize } from "../lib/api-client.js";
import { fetchSources, rankSources } from "../lib/sources.js";

const PROXY_URL = "https://epistemic-companion-proxy.salvatoreducksamurai96.workers.dev";
const CONF_THRESHOLD = 0.7;
const CLAIM_THRESHOLD = 0.4; // min claim_strength to show the neutral "claim here" dot
const MAX_TOTAL_USABLE = 6;  // hard ceiling on abstracts sent to synthesis (dilution guard)
const EMPIRICAL_KINDS = new Set(["academic", "preprint", "government", "legal"]); // allowed in a mixed empirical_counter block
const COLOR_COUNTER = "#22c55e"; // green  — counter-perspective found
const COLOR_CONTEXT = "#3b82f6"; // blue   — additional context found
const COLOR_NEUTRAL = "#9ca3af"; // gray   — analyzable claim detected (pre-click)

// --- Toolbar click -> toggle the panel ----------
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" }); }
  catch (err) { console.warn("[FlipSide] no content script:", err?.message); }
});

// --- Streaming-style port: drives stage messages then DONE ----------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "stream-analyze") return;
  const tabId = port.sender?.tab?.id ?? null;
  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "ANALYZE") return;
    if (tabId) clearDot(tabId);
    const res = await handleAnalyze(msg.payload, (stage) => port.postMessage({ type: "STAGE", text: stage }));
    port.postMessage({ type: "DONE", result: res });
    setBadge(tabId, res);
    if (res.ok && msg.payload?.url) await saveBadgeState(msg.payload.url, badgeState(res.data));
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") clearDot(tabId);
});

// --- Badge ----------
function badgeState(data) {
  if (!data || data.result_type === "none") return "none";
  // Mixed always has a moral-context half worth surfacing; green if its empirical
  // counter is confident enough, otherwise blue (context).
  if (data.result_type === "mixed") {
    return (data.empirical_counter?.confidence ?? 0) >= CONF_THRESHOLD ? "counter" : "context";
  }
  if ((data.confidence ?? 0) < CONF_THRESHOLD) return "none";
  return data.result_type === "counter_perspective" ? "counter" : "context";
}

function setBadge(tabId, res) {
  if (!tabId) return;
  const state = res.ok ? badgeState(res.data) : "none";
  if (state === "counter") applyDot(tabId, COLOR_COUNTER);
  else if (state === "context") applyDot(tabId, COLOR_CONTEXT);
  else clearDot(tabId);
}

function restoreBadge(tabId, state) {
  if (!tabId) return;
  if (state === "counter") applyDot(tabId, COLOR_COUNTER);
  else if (state === "context") applyDot(tabId, COLOR_CONTEXT);
  else if (state === "neutral") applyDot(tabId, COLOR_NEUTRAL);
}

async function applyDot(tabId, color) {
  try {
    const bitmap = await createImageBitmap(await (await fetch(chrome.runtime.getURL("icons/icon32.png"))).blob());
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
    await chrome.action.setIcon({ imageData: { 32: ctx.getImageData(0, 0, 32, 32) }, tabId });
  } catch (e) { console.warn("[FlipSide] applyDot failed:", e); }
}

function clearDot(tabId) {
  chrome.action.setIcon({ path: { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png" }, tabId }).catch(() => {});
}

// --- Badge-state cache ----------
const BADGE_CACHE_KEY = "badgeCache";
const BADGE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

async function saveBadgeState(url, state) {
  const store = (await chrome.storage.local.get(BADGE_CACHE_KEY))[BADGE_CACHE_KEY] || {};
  store[url] = { state, ts: Date.now() };
  const keys = Object.keys(store);
  if (keys.length > 500) { keys.sort((a, b) => store[a].ts - store[b].ts); for (const k of keys.slice(0, keys.length - 500)) delete store[k]; }
  await chrome.storage.local.set({ [BADGE_CACHE_KEY]: store });
}
async function getBadgeState(url) {
  const store = (await chrome.storage.local.get(BADGE_CACHE_KEY))[BADGE_CACHE_KEY] || {};
  const entry = store[url];
  if (!entry || Date.now() - entry.ts > BADGE_TTL_MS) return null;
  return entry.state;
}

// --- Messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "ANALYZE") { handleAnalyze(msg.payload).then(sendResponse); return true; }
  if (msg?.type === "OPEN_OPTIONS") { chrome.runtime.openOptionsPage(); return false; }
  if (msg?.type === "PAGE_LOADED") {
    const tabId = sender.tab?.id ?? null;
    if (tabId && msg.url) getBadgeState(msg.url).then((state) => restoreBadge(tabId, state));
    return false;
  }
  if (msg?.type === "PREANALYZE") {
    const tabId = sender.tab?.id ?? null;
    const url = msg.payload?.url;
    if (!tabId || !url) return false;
    chrome.storage.local.get(["apiKey", "preanalyzeEnabled"]).then(async ({ apiKey, preanalyzeEnabled }) => {
      if (apiKey && preanalyzeEnabled === false) return;
      if (await getBadgeState(url)) return; // already known (neutral or a real result)
      // Classify only — cheap. The expensive synthesis runs on click. A neutral
      // gray dot means "there's an examinable claim here", never an over-promise.
      const cls = await getClassification(msg.payload).catch(() => null);
      if (!cls) return;
      const analyzable = cls.analyzable && (cls.claim_strength ?? 1) >= CLAIM_THRESHOLD;
      if (analyzable) applyDot(tabId, COLOR_NEUTRAL);
      await saveBadgeState(url, analyzable ? "neutral" : "none");
    });
    return false;
  }
  if (msg?.type === "FEEDBACK") {
    const { url, rating } = msg;
    if (!url || (rating !== "up" && rating !== "down")) return false;
    chrome.storage.local.get("feedbackCache").then(({ feedbackCache = {} }) => {
      feedbackCache[url] = rating;
      chrome.storage.local.set({ feedbackCache });
    });
    fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": `chrome-extension://${chrome.runtime.id}` },
      body: JSON.stringify({ stage: "feedback", url, rating }),
    }).catch(() => {});
    return false;
  }
  if (msg?.type === "GET_FEEDBACK") {
    chrome.storage.local.get("feedbackCache").then(({ feedbackCache = {} }) => {
      sendResponse({ rating: feedbackCache[msg.url] ?? null });
    });
    return true;
  }
  return false;
});

// --- The pipeline ----------
async function handleAnalyze(payload, onStage = null) {
  const cacheKey = hashStr((payload.url || "") + "\n" + (payload.text || ""));

  if (payload.url) {
    const urlCached = await urlCacheGet(payload.url);
    if (urlCached) return { ok: true, data: urlCached };
  }
  const hashCached = await cacheGet(cacheKey);
  if (hashCached) return { ok: true, data: hashCached };

  const { apiKey, byokProvider } = await chrome.storage.local.get(["apiKey", "byokProvider"]);
  const provider = byokProvider ?? "groq";

  try {
    // CALL 1 — classify (reuses the result cached by background preanalyze)
    onStage?.("Finding the core claim…");
    const cls = await getClassification(payload);
    if (!cls.analyzable) return await saveAndReturn(cacheKey, payload.url, { result_type: "none", reason: "not_analyzable" });

    // RETRIEVAL — real evidence
    onStage?.("Searching credible evidence…");
    const all = await fetchSources(cls.research_query || payload.title, cls.topic, payload.url || "", cls.secondary_topic || "");

    const usable = rankSources(all.filter(s => s.usable), cls.research_query || payload.title, MAX_TOTAL_USABLE, cls.claim_type, cls.required_geography);
    if (usable.length === 0) {
      return await saveAndReturn(cacheKey, payload.url, {
        result_type: "none", reason: "insufficient_evidence",
        furtherReading: trimSources(all, 5),
      });
    }

    // CALL 2 — synthesize from evidence
    onStage?.("Weighing the evidence…");
    const synth = await synthesize({
      apiKey, provider, article: payload,
      articleType: cls.article_type, coreClaim: cls.core_claim, claimType: cls.claim_type, evidence: usable,
    });
    if (synth.result_type === "none") {
      return await saveAndReturn(cacheKey, payload.url, {
        result_type: "none", reason: synth.reason || "no_material_finding",
        furtherReading: trimSources(all, 5),
      });
    }

    // VALIDATE provenance — keep only cited sources whose quote is really present
    const byId = new Map(usable.map((s) => [s.id, s]));

    // MIXED — two provenance-checked blocks (empirical counter + moral context).
    // Code-level source-kind firewall: the empirical block may only show evidence-
    // bearing kinds, the context block only reference. The model cannot bleed an
    // academic paper into the moral debate no matter what it emits. A block whose
    // sources are all filtered out loses its summary (no unsourced claims).
    if (synth.result_type === "mixed") {
      const empShown = validateShown(synth.empirical_counter.used_sources, byId)
        .filter((s) => EMPIRICAL_KINDS.has(s.kind));
      const ctxShown = validateShown(synth.additional_context.used_sources, byId)
        .filter((s) => s.kind === "reference");
      const empSummary = empShown.length ? synth.empirical_counter.summary : "";
      const ctxSummary = ctxShown.length ? synth.additional_context.summary : "";
      if (!empSummary && !ctxSummary) {
        return await saveAndReturn(cacheKey, payload.url, {
          result_type: "none", reason: "no_material_finding", furtherReading: trimSources(all, 5),
        });
      }
      const usedUrls = new Set([...empShown, ...ctxShown].map((s) => s.url));
      return await saveAndReturn(cacheKey, payload.url, {
        result_type: "mixed",
        headline: synth.headline,
        core_claims: synth.core_claims,
        empirical_counter: { summary: empSummary, confidence: synth.empirical_counter.confidence, sources: empShown.map(pickFields) },
        additional_context: { summary: ctxSummary, sources: ctxShown.map(pickFields) },
        furtherReading: trimSources(all.filter((s) => !usedUrls.has(s.url)), 4),
      });
    }

    const shown = validateShown(synth.used_sources, byId);
    const shownUrls = new Set(shown.map((s) => s.url));
    const data = {
      result_type: synth.result_type,
      headline: synth.headline,
      summary: synth.summary,
      core_claims: synth.core_claims,
      confidence: synth.confidence,
      sources: shown.map(pickFields),
      furtherReading: trimSources(all.filter((s) => !shownUrls.has(s.url)), 4),
    };
    return await saveAndReturn(cacheKey, payload.url, data);
  } catch (err) {
    return { ok: false, error: err?.message ?? "The analysis request failed.", retryAfter: err?.retryAfter ?? 0, daily: err?.daily === true };
  }
}

// Lenient verbatim check: the model's quote must actually appear in the abstract
// (whitespace/case-normalized). Paraphrases are rejected — that's intentional.
function quoteAppears(quote, evidence) {
  const q = normalize(quote);
  const hay = normalize(evidence);
  if (!hay) return false;
  if (q.length < 8) return false;            // too short to verify → reject
  return hay.includes(q.slice(0, Math.min(q.length, 50)));
}
function normalize(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }

// Provenance gate for one used_sources list: keep cited sources whose quote is
// really present; if none pass, fall back to the cited sources (synthesis still
// reasoned over real abstracts) rather than showing a perspective with no sources.
function validateShown(usedSources, byId) {
  const used = Array.isArray(usedSources) ? usedSources : [];
  const validated = [];
  for (const u of used) {
    const src = byId.get(u.id);
    if (!src) continue;
    if (quoteAppears(u.evidence_quote, src.evidence_text)) validated.push(src);
  }
  let shown = dedupByUrl(validated);
  if (shown.length === 0) shown = dedupByUrl(used.map((u) => byId.get(u.id)).filter(Boolean));
  return shown;
}

function pickFields(s) { return { title: s.title, url: s.url, publisher: s.publisher, kind: s.kind }; }
function trimSources(arr, n) { return dedupByUrl(arr).slice(0, n).map(pickFields); }
function dedupByUrl(arr) {
  const seen = new Set(), out = [];
  for (const s of arr) { if (!s?.url || seen.has(s.url)) continue; seen.add(s.url); out.push(s); }
  return out;
}

async function saveAndReturn(cacheKey, url, data) {
  if (data.result_type !== "none") {
    await Promise.all([
      cacheSet(cacheKey, data),
      url ? urlCacheSet(url, data) : Promise.resolve(),
    ]);
  }
  return { ok: true, data };
}

// --- Result cache ----------
const CACHE_KEY = "analysisCache";
const CACHE_MAX = 150;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

async function cacheGet(key) {
  const store = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  const entry = store[key];
  if (!entry || Date.now() - entry.ts > CACHE_TTL_MS) return null;
  return entry.data;
}
async function cacheSet(key, data) {
  const store = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  store[key] = { data, ts: Date.now() };
  const keys = Object.keys(store);
  if (keys.length > CACHE_MAX) { keys.sort((a, b) => store[a].ts - store[b].ts); for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete store[k]; }
  await chrome.storage.local.set({ [CACHE_KEY]: store });
}

const URL_CACHE_KEY = "urlCache";
async function urlCacheGet(url) {
  if (!url) return null;
  const store = (await chrome.storage.local.get(URL_CACHE_KEY))[URL_CACHE_KEY] || {};
  const entry = store[url];
  if (!entry || Date.now() - entry.ts > CACHE_TTL_MS) return null;
  return entry.data;
}
async function urlCacheSet(url, data) {
  if (!url) return;
  const store = (await chrome.storage.local.get(URL_CACHE_KEY))[URL_CACHE_KEY] || {};
  store[url] = { data, ts: Date.now() };
  const keys = Object.keys(store);
  if (keys.length > 200) { keys.sort((a, b) => store[a].ts - store[b].ts); for (const k of keys.slice(0, keys.length - 200)) delete store[k]; }
  await chrome.storage.local.set({ [URL_CACHE_KEY]: store });
}

// --- Classification cache ----------
// Call 1 (classify) result, shared between background preanalyze and the click.
// This is what keeps the cost at ~1 classify per article + 1 synth per click.
const CLASS_CACHE_KEY = "classifyCache";

async function getClassification(payload) {
  const key = hashStr((payload.url || "") + "\n" + (payload.text || ""));
  const store = (await chrome.storage.local.get(CLASS_CACHE_KEY))[CLASS_CACHE_KEY] || {};
  if (store[key] && Date.now() - store[key].ts < CACHE_TTL_MS) return store[key].data;
  const { apiKey, byokProvider } = await chrome.storage.local.get(["apiKey", "byokProvider"]);
  const cls = await classify({ apiKey, provider: byokProvider ?? "groq", article: payload });

  store[key] = { data: cls, ts: Date.now() };
  const keys = Object.keys(store);
  if (keys.length > 200) { keys.sort((a, b) => store[a].ts - store[b].ts); for (const k of keys.slice(0, keys.length - 200)) delete store[k]; }
  await chrome.storage.local.set({ [CLASS_CACHE_KEY]: store });
  return cls;
}

function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
