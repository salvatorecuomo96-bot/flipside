// main.js — content-script orchestrator (loaded as a module by loader.js).
//
// Responsibilities:
//   - Extract the article on load, cache it.
//   - Keep that cache fresh across SPA navigations (MutationObserver) WITHOUT
//     looping on our own UI mutations.
//   - On a TOGGLE_PANEL message, mount/toggle the Shadow DOM panel and drive it
//     through its states by asking the service worker to run the analysis.

import { extractMainContent } from "./extractor.js";
import { mountPanel, getPanel } from "./ui/panel.js";

let lastExtraction = null;
let observer = null;
let debounceTimer = null;
let lastHash = "";
let lastUrl = location.href;

export function init() {
  lastExtraction = safeExtract();
  lastHash = lastExtraction ? hashText(lastExtraction.text) : "";
  setupMutationObserver();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "TOGGLE_PANEL") handleToggle();
  });
}

function safeExtract() {
  try {
    return extractMainContent(document);
  } catch (err) {
    console.error("[FlipSide] extraction failed:", err);
    return null;
  }
}

// Retry extraction up to 4 times with 500ms gaps. Handles early clicks where
// the DOM hasn't finished rendering the article body yet.
async function extractWithRetry() {
  if (lastExtraction?.text.length >= 200) return lastExtraction;
  for (let i = 0; i < 4; i++) {
    const result = safeExtract();
    if (result?.text.length >= 200) {
      lastExtraction = result;
      lastHash = hashText(result.text);
      return result;
    }
    if (i < 3) await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function streamAnalyze(payload, panel) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const port = chrome.runtime.connect({ name: "stream-analyze" });
    const timeout = setTimeout(() => {
      if (!resolved) { port.disconnect(); reject(new Error("client-timeout")); }
    }, 35000);

    port.onMessage.addListener((msg) => {
      if (msg.type === "CHUNK") {
        if (panel && panel.renderPartial) panel.renderPartial(msg.text);
      } else if (msg.type === "DONE") {
        resolved = true;
        clearTimeout(timeout);
        port.disconnect();
        resolve(msg.result);
      } else if (msg.type === "ERROR") {
        resolved = true;
        clearTimeout(timeout);
        port.disconnect();
        resolve({ ok: false, error: msg.error });
      }
    });

    port.onDisconnect.addListener(() => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error("disconnected"));
      }
    });

    port.postMessage({ type: "ANALYZE", payload });
  });
}

async function handleToggle() {
  const panel = mountPanel(streamAnalyze);
  // Close on click only when showing a result — error state means retry instead.
  if (panel.isOpen() && !panel.isError()) {
    panel.close();
    return;
  }
  if (!panel.isOpen()) panel.open();

  // Show the spinner immediately, then try extraction. Heavy JS pages (Euractiv,
  // Bloomberg, etc.) can take 2-4s to render the article body. Fast pass tries
  // every 500ms for 1.5s; if that fails we keep the spinner and retry slowly
  // for up to 4s more before showing an error.
  panel.renderLoading();
  let extraction = await extractWithRetry();
  if (!extraction) {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      extraction = await extractWithRetry();
      if (extraction) break;
    }
  }
  if (!extraction) {
    panel.renderError("Couldn't find a readable article on this page.");
    return;
  }
  try {
    const res = await streamAnalyze({
      title: extraction.title,
      text: extraction.text,
      url: location.href,
    }, panel);
    
    if (res?.ok) panel.renderResult(res.data);
    else panel.renderError(res?.error ?? "Something went wrong.", res?.retryAfter ?? 0, res?.daily === true);
  } catch (err) {
    if (err?.message === "client-timeout") {
      panel.renderError("Timed out. The model is still generating — close and try again.");
    } else {
      panel.renderError("Couldn't reach the background service. Try reloading the page.");
    }
  }
}

// --- SPA handling ---------------------------------------------------------
// The loop hazard: mounting/rendering our panel mutates the DOM, which fires
// the observer, which could re-extract and re-render, firing again. Guards:
//   (1) ignore mutations contained entirely within our Shadow host;
//   (2) debounce bursts into a single re-extract;
//   (3) bail if the freshly-extracted text hashes the same as last time.
function setupMutationObserver() {
  observer = new MutationObserver((mutations) => {
    const host = getPanel()?.host ?? null;

    // Guard (1): if every mutation target is inside our own UI, it's us. Skip.
    if (host) {
      const allOurs = mutations.every((m) => host.contains(m.target));
      if (allOurs) return;
    }

    // Guard (2): debounce.
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(reextractIfChanged, 600);
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function reextractIfChanged() {
  const urlChanged = location.href !== lastUrl;
  const next = safeExtract();
  if (!next) return;

  const nextHash = hashText(next.text);
  // Guard (3): nothing materially changed -> do nothing (prevents the loop).
  if (!urlChanged && nextHash === lastHash) return;

  lastUrl = location.href;
  lastHash = nextHash;
  lastExtraction = next;
  // We intentionally do NOT auto-refresh an open panel here: re-running the
  // model on every SPA tick would burn the user's API budget. The next manual
  // toggle uses the fresh cache.
}

// Tiny, fast, non-cryptographic string hash (djb2). We only need change
// detection, not security, so this is the right tool — a full hash would be
// overkill and slower on long article bodies.
function hashText(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return String(h);
}
