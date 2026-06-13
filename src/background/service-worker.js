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
  const { apiKey } = await chrome.storage.local.get("apiKey");

  try {
    let data;
    if (apiKey) {
      data = await callDirect({ apiKey, payload });
    } else {
      data = await callProxy(payload);
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err?.message ?? "The analysis request failed." };
  }
}
