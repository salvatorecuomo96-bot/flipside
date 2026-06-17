const PROVIDER_HINTS = {
  groq:       'Free tier, no credit card needed. Get a key at <a href="https://console.groq.com" target="_blank" rel="noopener">console.groq.com</a>.',
  deepseek:   'Paid but very cheap. Get a key at <a href="https://platform.deepseek.com" target="_blank" rel="noopener">platform.deepseek.com</a>.',
  openai:     'Paid. Uses gpt-4o-mini by default. Get a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com</a>.',
  openrouter: 'Free and paid models available. Get a key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai</a>.',
  cerebras:   'Free tier available. Get a key at <a href="https://cloud.cerebras.ai" target="_blank" rel="noopener">cloud.cerebras.ai</a>.',
  sambanova:  'Free tier available. Get a key at <a href="https://cloud.sambanova.ai" target="_blank" rel="noopener">cloud.sambanova.ai</a>.',
  anthropic:  'Paid. Uses Claude Haiku (fast and cheap). Get a key at <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a>.',
};

const els = {
  provider:          document.getElementById("provider"),
  apiKey:            document.getElementById("apiKey"),
  keyHint:           document.getElementById("key-hint"),
  save:              document.getElementById("save"),
  clear:             document.getElementById("clear"),
  status:            document.getElementById("status"),
  preanalyzeSection: document.getElementById("preanalyze-section"),
  preanalyze:        document.getElementById("preanalyze"),
};

chrome.storage.local.get(["apiKey", "byokProvider", "preanalyzeEnabled"], ({ apiKey, byokProvider, preanalyzeEnabled }) => {
  if (byokProvider) els.provider.value = byokProvider;
  updateHint();
  if (apiKey) {
    els.apiKey.value = apiKey;
    showPreanalyzeSection(preanalyzeEnabled);
  }
});

els.provider.addEventListener("change", updateHint);

els.save.addEventListener("click", async () => {
  const key = els.apiKey.value.trim();
  const provider = els.provider.value;
  await chrome.storage.local.set({ apiKey: key || null, byokProvider: provider });
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
  await chrome.storage.local.remove(["apiKey", "byokProvider", "preanalyzeEnabled"]);
  flash("Cleared — using free shared service.");
});

els.preanalyze.addEventListener("change", async () => {
  await chrome.storage.local.set({ preanalyzeEnabled: els.preanalyze.checked });
});

function updateHint() {
  els.keyHint.innerHTML = PROVIDER_HINTS[els.provider.value] || "";
}

function showPreanalyzeSection(preanalyzeEnabled) {
  els.preanalyze.checked = preanalyzeEnabled !== false;
  els.preanalyzeSection.hidden = false;
}

function flash(msg) {
  els.status.textContent = msg;
  setTimeout(() => { els.status.textContent = ""; }, 2000);
}
