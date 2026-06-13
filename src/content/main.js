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
    console.error("[Flipside] extraction failed:", err);
    return null;
  }
}

async function handleToggle() {
  const panel = mountPanel();
  // Close on click only when showing a result — error state means retry instead.
  if (panel.isOpen() && !panel.isError()) {
    panel.close();
    return;
  }
  if (!panel.isOpen()) panel.open();

  const extraction = lastExtraction ?? safeExtract();
  if (!extraction || extraction.text.length < 200) {
    panel.renderError("Couldn't find a readable article on this page.");
    return;
  }

  panel.renderLoading();
  try {
    const res = await withTimeout(
      chrome.runtime.sendMessage({
        type: "ANALYZE",
        payload: {
          title: extraction.title,
          text: extraction.text,
          url: location.href,
        },
      }),
      35000 // 30s model timeout + 5s buffer
    );
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

// Client-side backstop: the service worker has its own per-request timeout, but
// if the worker itself is torn down mid-flight, sendMessage never resolves. This
// guarantees the UI always reaches a terminal state.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("client-timeout")), ms)
    ),
  ]);
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
