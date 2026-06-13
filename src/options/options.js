const els = {
  apiKey: document.getElementById("apiKey"),
  save: document.getElementById("save"),
  clear: document.getElementById("clear"),
  status: document.getElementById("status"),
};

chrome.storage.local.get("apiKey", ({ apiKey }) => {
  if (apiKey) els.apiKey.value = apiKey;
});

els.save.addEventListener("click", async () => {
  const key = els.apiKey.value.trim();
  await chrome.storage.local.set({ apiKey: key || null });
  flash(key ? "Key saved." : "Cleared — using free shared service.");
});

els.clear.addEventListener("click", async () => {
  els.apiKey.value = "";
  await chrome.storage.local.remove("apiKey");
  flash("Cleared — using free shared service.");
});

function flash(msg) {
  els.status.textContent = msg;
  setTimeout(() => { els.status.textContent = ""; }, 2000);
}
