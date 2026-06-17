const PROVIDER_NAMES = {
  groq:       "Groq",
  anthropic:  "Anthropic (Claude)",
  openrouter: "OpenRouter",
  cerebras:   "Cerebras",
  openai:     "OpenAI",
  deepseek:   "DeepSeek",
  sambanova:  "SambaNova",
  gemini:     "Google Gemini",
  xai:        "xAI Grok",
  mistral:    "Mistral",
  perplexity: "Perplexity",
  together:   "Together AI",
  fireworks:  "Fireworks AI",
};

function detectProvider(key) {
  if (!key) return null;
  if (key.startsWith("gsk_"))           return "groq";
  if (key.startsWith("sk-ant-"))        return "anthropic";
  if (key.startsWith("sk-or-"))         return "openrouter";
  if (key.startsWith("csk-"))           return "cerebras";
  if (key.startsWith("sk-proj-"))       return "openai";
  if (key.startsWith("AIza"))           return "gemini";
  if (key.startsWith("xai-"))           return "xai";
  if (key.startsWith("pplx-"))          return "perplexity";
  if (key.startsWith("fw_"))            return "fireworks";
  if (key.startsWith("together_api_"))  return "together";
  if (key.startsWith("sk-"))            return "deepseek";
  return null; // unknown — don't guess
}

const els = {
  apiKey:            document.getElementById("apiKey"),
  detected:          document.getElementById("detected"),
  save:              document.getElementById("save"),
  clear:             document.getElementById("clear"),
  status:            document.getElementById("status"),
  preanalyzeSection: document.getElementById("preanalyze-section"),
  preanalyze:        document.getElementById("preanalyze"),
};

chrome.storage.local.get(["apiKey", "byokProvider", "preanalyzeEnabled"], ({ apiKey, byokProvider, preanalyzeEnabled }) => {
  if (apiKey) {
    els.apiKey.value = apiKey;
    showDetected(byokProvider);
    showPreanalyzeSection(preanalyzeEnabled);
  }
});

els.apiKey.addEventListener("input", () => {
  const provider = detectProvider(els.apiKey.value.trim());
  showDetected(provider);
});

els.save.addEventListener("click", async () => {
  const key = els.apiKey.value.trim();
  const provider = detectProvider(key);
  await chrome.storage.local.set({ apiKey: key || null, byokProvider: provider });
  if (key) {
    const { preanalyzeEnabled } = await chrome.storage.local.get("preanalyzeEnabled");
    showPreanalyzeSection(preanalyzeEnabled);
    flash(`Key saved — using ${PROVIDER_NAMES[provider] ?? provider}.`);
  } else {
    els.detected.hidden = true;
    els.preanalyzeSection.hidden = true;
    flash("Cleared — using free shared service.");
  }
});

els.clear.addEventListener("click", async () => {
  els.apiKey.value = "";
  els.detected.hidden = true;
  els.preanalyzeSection.hidden = true;
  await chrome.storage.local.remove(["apiKey", "byokProvider", "preanalyzeEnabled"]);
  flash("Cleared — using free shared service.");
});

els.preanalyze.addEventListener("change", async () => {
  await chrome.storage.local.set({ preanalyzeEnabled: els.preanalyze.checked });
});

function showDetected(provider) {
  if (!provider) {
    els.detected.textContent = "Provider not recognised — will fall back to shared service if key fails.";
    els.detected.style.color = "var(--muted)";
    els.detected.hidden = false;
    return;
  }
  els.detected.textContent = `Detected: ${PROVIDER_NAMES[provider] ?? provider}`;
  els.detected.style.color = "";
  els.detected.hidden = false;
}

function showPreanalyzeSection(preanalyzeEnabled) {
  els.preanalyze.checked = preanalyzeEnabled !== false;
  els.preanalyzeSection.hidden = false;
}

function flash(msg) {
  els.status.textContent = msg;
  setTimeout(() => { els.status.textContent = ""; }, 2500);
}
