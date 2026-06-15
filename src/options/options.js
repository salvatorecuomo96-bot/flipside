const els = {
  apiKey: document.getElementById("apiKey"),
  save: document.getElementById("save"),
  clear: document.getElementById("clear"),
  status: document.getElementById("status"),
  preanalyzeSection: document.getElementById("preanalyze-section"),
  preanalyze: document.getElementById("preanalyze"),
};

chrome.storage.local.get(["apiKey", "preanalyzeEnabled"], ({ apiKey, preanalyzeEnabled }) => {
  if (apiKey) {
    els.apiKey.value = apiKey;
    showPreanalyzeSection(preanalyzeEnabled);
  }
});

els.save.addEventListener("click", async () => {
  const key = els.apiKey.value.trim();
  await chrome.storage.local.set({ apiKey: key || null });
  if (key) {
    const { preanalyzeEnabled } = await chrome.storage.local.get("preanalyzeEnabled");
    showPreanalyzeSection(preanalyzeEnabled);
    flash("Key saved.");
  } else {
    els.preanalyzeSection.hidden = true;
    flash("Cleared — using free shared service.");
  }
});

els.clear.addEventListener("click", async () => {
  els.apiKey.value = "";
  els.preanalyzeSection.hidden = true;
  await chrome.storage.local.remove(["apiKey", "preanalyzeEnabled"]);
  flash("Cleared — using free shared service.");
});

els.preanalyze.addEventListener("change", async () => {
  await chrome.storage.local.set({ preanalyzeEnabled: els.preanalyze.checked });
});

function showPreanalyzeSection(preanalyzeEnabled) {
  els.preanalyze.checked = preanalyzeEnabled !== false; // default on
  els.preanalyzeSection.hidden = false;
}

function flash(msg) {
  els.status.textContent = msg;
  setTimeout(() => { els.status.textContent = ""; }, 2000);
}
