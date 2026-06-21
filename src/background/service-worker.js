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
import { generateCitationToken } from "../lib/evidence-id.js";
import { buildCitationMap, validateShown, dedupByUrl } from "../lib/citation-resolver.js";
import { applyInlineCitations } from "../lib/inline-citations.js";
import {
  classificationSilenceReason, synthesisSilenceReason,
  silenceShowsFurther, silenceExaminedClaim,
} from "../lib/silence.js";
import { ensureAnalysisCacheSchema } from "../lib/cache-schema.js";
import { claimAttributionFields, claimWithAttribution, panelClaims } from "../lib/claim-attribution.js";

const PROXY_URL = "https://epistemic-companion-proxy.salvatoreducksamurai96.workers.dev";
const CONF_THRESHOLD = 0.7;
const CLAIM_THRESHOLD = 0.4; // min claim_strength to show the neutral "claim here" dot
const MAX_TOTAL_USABLE = 6;  // hard ceiling on abstracts sent to synthesis (dilution guard)
const EMPIRICAL_KINDS = new Set(["academic", "preprint", "government", "legal"]); // allowed in a mixed empirical_counter block
const COLOR_COUNTER = "#22c55e"; // green  — counter-perspective found
const COLOR_CONTEXT = "#3b82f6"; // blue   — additional context found
const COLOR_NEUTRAL = "#9ca3af"; // gray   — analyzable claim detected (pre-click)

// --- Local analysis-cache schema gate ----------
// Future result-shape changes should bump LOCAL_ANALYSIS_SCHEMA_VERSION in
// cache-schema.js. This clears only analysis-derived caches; keys/settings and
// feedback history are deliberately left untouched.
const analysisCacheSchemaReady = ensureAnalysisCacheSchema(chrome.storage.local)
  .then((cleared) => { if (cleared) console.log("[FlipSide] cleared old analysis caches for schema update"); })
  .catch((e) => console.warn("[FlipSide] cache schema check failed:", e?.message));

async function waitForAnalysisCacheSchema() {
  await analysisCacheSchemaReady;
}

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
  await waitForAnalysisCacheSchema();
  const store = (await chrome.storage.local.get(BADGE_CACHE_KEY))[BADGE_CACHE_KEY] || {};
  store[url] = { state, ts: Date.now() };
  const keys = Object.keys(store);
  if (keys.length > 500) { keys.sort((a, b) => store[a].ts - store[b].ts); for (const k of keys.slice(0, keys.length - 500)) delete store[k]; }
  await chrome.storage.local.set({ [BADGE_CACHE_KEY]: store });
}
async function getBadgeState(url) {
  await waitForAnalysisCacheSchema();
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
    const { url, rating, reason } = msg;
    if (!url) return false;
    chrome.storage.local.get("feedbackCache").then(({ feedbackCache = {} }) => {
      if (rating === null) delete feedbackCache[url];
      else if (rating === "up" || rating === "down") feedbackCache[url] = { rating, reason: reason || null };
      chrome.storage.local.set({ feedbackCache });
    });
    if (rating === "up" || rating === "down") {
      fetch(PROXY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Origin": `chrome-extension://${chrome.runtime.id}` },
        body: JSON.stringify({ stage: "feedback", url, rating, ...(reason ? { reason } : {}) }),
      }).catch(() => {});
    }
    return false;
  }
  if (msg?.type === "GET_FEEDBACK") {
    chrome.storage.local.get("feedbackCache").then(({ feedbackCache = {} }) => {
      const entry = feedbackCache[msg.url] ?? null;
      // Support both old string format and new {rating, reason} format
      const rating = entry ? (typeof entry === "string" ? entry : entry.rating) : null;
      sendResponse({ rating });
    });
    return true;
  }
  return false;
});

// --- Extraction completeness check ----------
// Runs before classification. Detects paywalled or truncated pages that lack
// enough text for meaningful analysis. Returns { ok: true } or
// { ok: false, reason, paywall_detected }.
// Phrases that only appear as real paywall gates — checked against first 800 chars
// only, so ad-break labels like "Continue reading below" (Daily Mail) don't fire.
const PAYWALL_RE = /subscribe\s+to\s+read|subscription\s+required|sign\s+in\s+to\s+(read|continue)|unlock\s+this\s+article|premium\s+(content|article)|members?\s+only|already\s+a\s+subscriber|read\s+the\s+full\s+(story|article)|get\s+full\s+access/i;

function checkExtractionCompleteness(text, paywallDetected) {
  const t = (text || "").trim();
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount < 80) return { ok: false, reason: "too_short" };
  // If we extracted ≥400 words the article is clearly readable — DOM paywall
  // selectors can fire on ad-containers and subscription upsell elements that
  // exist even on fully accessible pages (e.g. Daily Mail).
  const likelyPaywalled = wordCount < 400 && paywallDetected;
  if (likelyPaywalled || (wordCount < 350 && PAYWALL_RE.test(t.slice(0, 800)))) {
    return { ok: false, reason: "paywall_detected", paywall_detected: true };
  }
  return { ok: true };
}

// Post-synthesis confidence calibration — deterministic caps by validated source
// count and kind, applied after the provenance gate so only real citations count.
//   reference-only  → max 0.55 (encyclopedic sources can't support strong claims)
//   1 validated     → max 0.65
//   2 validated     → max 0.80
//   3+              → max 0.90
function calibrateConfidence(raw, validatedSources) {
  const n = validatedSources.length;
  if (n === 0) return 0;
  const allRef = validatedSources.every(s => s.kind === "reference");
  const cap = allRef ? 0.55 : n === 1 ? 0.65 : n === 2 ? 0.80 : 0.90;
  return Math.min(raw, cap);
}

// --- The pipeline ----------
async function handleAnalyze(payload, onStage = null) {
  await waitForAnalysisCacheSchema();
  const cacheKey = hashStr((payload.url || "") + "\n" + (payload.text || ""));

  // Extraction completeness — checked before any model call. isPastedText skips
  // this gate: the user has already supplied text they know is complete.
  if (!payload.isPastedText) {
    const extractionCached = await extractionCacheGet(cacheKey);
    if (extractionCached) return { ok: true, data: extractionCached };
    const completeness = checkExtractionCompleteness(payload.text, payload.paywallDetected);
    if (!completeness.ok) {
      const incompleteData = {
        result_type: "incomplete_article",
        reason: completeness.reason,
        paywall_detected: completeness.paywall_detected ?? false,
        retryable: false,
        paste_fallback: true,
      };
      await extractionCacheSet(cacheKey, incompleteData);
      return { ok: true, data: incompleteData };
    }
  }

  if (payload.url) {
    const urlCached = await urlCacheGet(payload.url);
    if (urlCached) return { ok: true, data: urlCached };
  }
  const hashCached = await cacheGet(cacheKey);
  if (hashCached) return { ok: true, data: hashCached };
  if (!payload.bypassNoneCache) {
    const noneCached = await noneCacheGet(cacheKey);
    if (noneCached) return { ok: true, data: noneCached };
  }

  const { apiKey, byokProvider } = await chrome.storage.local.get(["apiKey", "byokProvider"]);
  const provider = byokProvider ?? "groq";

  try {
    // CALL 1 — classify (reuses the result cached by background preanalyze)
    onStage?.("Finding the core claim…");
    const cls = await getClassification(payload);
    if (!cls.analyzable) {
      return await saveAndReturn(cacheKey, payload.url, buildNoneData(classificationSilenceReason(cls), cls, null));
    }

    // RETRIEVAL — real evidence
    onStage?.("Searching credible evidence…");
    const { sources: all, diagnostics, evidenceFingerprint } = await fetchSources(cls.research_query || payload.title, cls.topic, payload.url || "", cls.secondary_topic || "", payload.title || "");
    if (all.length === 0) {
      // If every evidence-bearing feed failed it's likely an API outage, not a
      // genuine topic gap. Throw so the pipeline surfaces a retry error rather
      // than caching a misleading "no sources found" silence.
      if (diagnostics.evidenceAttempted >= 2 && diagnostics.evidenceFailed === diagnostics.evidenceAttempted) {
        throw new Error("Evidence sources are temporarily unavailable. Please try again in a moment.");
      }
      return await saveAndReturn(cacheKey, payload.url, buildNoneData("no_sources_returned", cls, null));
    }

    const usable = rankSources(all.filter(s => s.usable), cls.research_query || payload.title, MAX_TOTAL_USABLE, cls.claim_type, cls.required_geography);
    if (usable.length === 0) {
      return await saveAndReturn(cacheKey, payload.url, buildNoneData("no_usable_evidence", cls, all));
    }

    // Assign stable citation tokens — collision-checked across the prompt's source set.
    const tokenSet = new Set();
    for (const s of usable) {
      s.citationToken = s.stableKey ? generateCitationToken(s.stableKey, tokenSet) : s.id;
      if (s.stableKey) tokenSet.add(s.citationToken);
    }

    // CALL 2 — synthesize from evidence
    onStage?.("Weighing the evidence…");
    const synth = await synthesize({
      apiKey, provider, article: payload,
      articleType: cls.article_type, coreClaim: cls.core_claim, claimType: cls.claim_type,
      claimHolder: cls.claim_holder, articleStance: cls.article_stance, attribution: cls.attribution,
      evidence: usable, evidenceFingerprint,
      bypassCache: payload.bypassNoneCache === true,
    });
    if (synth.result_type === "none") {
      return await saveAndReturn(cacheKey, payload.url, buildNoneData(synthesisSilenceReason(synth.reason, cls), cls, all));
    }

    // VALIDATE provenance — keep only cited sources whose quote is really present.
    // The model cites by stable citation token; the resolver also accepts the
    // internal sequential id so legacy/cached responses still resolve.
    const byCitationId = buildCitationMap(usable);

    // MIXED — two provenance-checked blocks (empirical counter + moral context).
    // Code-level source-kind firewall: the empirical block may only show evidence-
    // bearing kinds, the context block only reference. The model cannot bleed an
    // academic paper into the moral debate no matter what it emits. A block whose
    // sources are all filtered out loses its summary (no unsourced claims).
    if (synth.result_type === "mixed") {
      const empShown = validateShown(synth.empirical_counter.used_sources, byCitationId)
        .filter((s) => EMPIRICAL_KINDS.has(s.kind));
      const ctxShown = validateShown(synth.additional_context.used_sources, byCitationId)
        .filter((s) => s.kind === "reference");
      const empSummary = empShown.length ? applyInlineCitations(synth.empirical_counter.summary, empShown) : "";
      const ctxSummary = ctxShown.length ? applyInlineCitations(synth.additional_context.summary, ctxShown) : "";
      if (!empSummary && !ctxSummary) {
        // Both blocks stripped by the source-kind firewall: the model produced
        // something but all cited sources were wrong-kind. evidence_too_weak is
        // the most accurate public code — the model may have found something,
        // but the output failed the code-level provenance checks.
        return await saveAndReturn(cacheKey, payload.url, buildNoneData("evidence_too_weak", cls, all));
      }
      const usedUrls = new Set([...empShown, ...ctxShown].map((s) => s.url));
      return await saveAndReturn(cacheKey, payload.url, {
        result_type: "mixed",
        ...claimAttributionFields(cls),
        headline: synth.headline,
        core_claims: panelClaims(synth.core_claims, cls),
        empirical_counter: { summary: empSummary, confidence: calibrateConfidence(synth.empirical_counter.confidence, empShown), sources: empShown.map(pickFields) },
        additional_context: { summary: ctxSummary, sources: ctxShown.map(pickFields) },
        furtherReading: trimSources(all.filter((s) => !usedUrls.has(s.url)), 4),
      });
    }

    const shown = validateShown(synth.used_sources, byCitationId);
    if (shown.length === 0) {
      return await saveAndReturn(cacheKey, payload.url, buildNoneData("evidence_too_weak", cls, all));
    }
    const shownUrls = new Set(shown.map((s) => s.url));
    const data = {
      result_type: synth.result_type,
      ...claimAttributionFields(cls),
      headline: synth.headline,
      summary: applyInlineCitations(synth.summary, shown),
      core_claims: panelClaims(synth.core_claims, cls),
      confidence: calibrateConfidence(synth.confidence, shown),
      sources: shown.map(pickFields),
      furtherReading: trimSources(all.filter((s) => !shownUrls.has(s.url)), 4),
    };
    return await saveAndReturn(cacheKey, payload.url, data);
  } catch (err) {
    return { ok: false, error: err?.message ?? "The analysis request failed.", retryAfter: err?.retryAfter ?? 0, daily: err?.daily === true };
  }
}

// Build a "none" result with an articulated reason. The reason code is canonical
// (from silence.js); the panel maps it to fixed copy. examined_claim and further
// reading are attached only where the reason warrants them.
function buildNoneData(reason, cls, allSources) {
  const data = { result_type: "none", reason, ...claimAttributionFields(cls) };
  const claim = silenceExaminedClaim(reason, claimWithAttribution(cls?.core_claim, cls));
  if (claim) data.examined_claim = claim;
  if (silenceShowsFurther(reason) && Array.isArray(allSources) && allSources.length) {
    const fr = trimSources(allSources, 5);
    if (fr.length) data.furtherReading = fr;
  }
  return data;
}

function pickFields(s) { return { title: s.title, url: s.url, publisher: s.publisher, kind: s.kind }; }
function trimSources(arr, n) { return dedupByUrl(arr).slice(0, n).map(pickFields); }

async function saveAndReturn(cacheKey, url, data) {
  if (data.result_type === "none") {
    // Articulated silences expire fast (24h) and live in their own store — a
    // "none" should never occupy the 30-day positive-result cache, and a later
    // retrieval improvement should be able to supersede it within a day.
    await noneCacheSet(cacheKey, data);
  } else {
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

// --- "None" result cache (reason-specific TTL) ----------
// Separate from the 30-day positive cache. TTLs are shorter for retrieval-stage
// silence so a transient API failure or new source indexing takes effect quickly.
// Retrieval codes: no_sources_returned 2h, no_usable_evidence 6h.
// All other codes (classification + synthesis): 24h.
const NONE_CACHE_KEY = "noneCache";
const NONE_CACHE_MAX = 150;
const HOUR_MS = 1000 * 60 * 60;

function noneTtl(reason) {
  if (reason === "no_sources_returned") return 2 * HOUR_MS;
  if (reason === "no_usable_evidence")  return 6 * HOUR_MS;
  return 24 * HOUR_MS;
}

async function noneCacheGet(key) {
  const store = (await chrome.storage.local.get(NONE_CACHE_KEY))[NONE_CACHE_KEY] || {};
  const entry = store[key];
  if (!entry || Date.now() - entry.ts > (entry.ttl ?? 24 * HOUR_MS)) return null;
  return entry.data;
}
async function noneCacheSet(key, data) {
  const store = (await chrome.storage.local.get(NONE_CACHE_KEY))[NONE_CACHE_KEY] || {};
  store[key] = { data, ts: Date.now(), ttl: noneTtl(data.reason) };
  const keys = Object.keys(store);
  if (keys.length > NONE_CACHE_MAX) { keys.sort((a, b) => store[a].ts - store[b].ts); for (const k of keys.slice(0, keys.length - NONE_CACHE_MAX)) delete store[k]; }
  await chrome.storage.local.set({ [NONE_CACHE_KEY]: store });
}

// --- Classification cache ----------
// Call 1 (classify) result, shared between background preanalyze and the click.
// This is what keeps the cost at ~1 classify per article + 1 synth per click.
const CLASS_CACHE_KEY = "classifyCache";

async function getClassification(payload) {
  await waitForAnalysisCacheSchema();
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

// --- Extraction state cache ----------
// Keyed by hash(url + text) — same as the analysis cache — so a page that later
// becomes fully readable (soft paywall clears, user logs in) produces a different
// hash and re-evaluates instead of staying blocked for the full TTL.
const EXTRACTION_CACHE_KEY = "extractionCache";
const EXTRACTION_CACHE_TTL_MS = 2 * HOUR_MS;

async function extractionCacheGet(key) {
  const store = (await chrome.storage.local.get(EXTRACTION_CACHE_KEY))[EXTRACTION_CACHE_KEY] || {};
  const entry = store[key];
  if (!entry || Date.now() - entry.ts > EXTRACTION_CACHE_TTL_MS) return null;
  return entry.data;
}
async function extractionCacheSet(key, data) {
  const store = (await chrome.storage.local.get(EXTRACTION_CACHE_KEY))[EXTRACTION_CACHE_KEY] || {};
  store[key] = { data, ts: Date.now() };
  const keys = Object.keys(store);
  if (keys.length > 100) { keys.sort((a, b) => store[a].ts - store[b].ts); for (const k of keys.slice(0, keys.length - 100)) delete store[k]; }
  await chrome.storage.local.set({ [EXTRACTION_CACHE_KEY]: store });
}
