// loader.js — the ONLY content script declared in the manifest.
//
// Why this file exists: a content script listed in `manifest.content_scripts`
// is loaded as a *classic* script, never as an ES module. There is no
// `"type": "module"` for content scripts. So we cannot use top-level `import`
// in the injected file. The workaround (and the documented MV3 pattern) is to
// keep this shim tiny and have it dynamically import the real, module-based
// entry point. Dynamic `import()` IS allowed in content scripts, provided the
// target is listed in `web_accessible_resources`.
(async () => {
  try {
    const url = chrome.runtime.getURL("src/content/main.js");
    const mod = await import(url);
    mod.init();
  } catch (err) {
    // Never throw into the host page; just log under our namespace.
    console.error("[Epistemic Companion] content module failed to load:", err);
  }
})();
