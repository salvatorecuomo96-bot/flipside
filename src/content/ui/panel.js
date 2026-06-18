// panel.js — the floating window, fully isolated via Shadow DOM.
//
// Why Shadow DOM and not a styled <div>: a content script injects into a page
// we do not control. A plain element inherits the page's cascade and the page's
// JS can read or restyle it. A shadow root is an encapsulation boundary: the
// page's CSS cannot reach in, and our CSS cannot leak out.

let controller = null;

export function getPanel() {
  return controller;
}

export function mountPanel(onAnalyze) {
  if (controller) return controller;

  const host = document.createElement("div");
  host.id = "flipside-host";
  host.style.cssText = [
    "all: initial",
    "display: none",
    "position: fixed",
    "top: 16px",
    "right: 16px",
    "width: 460px",
    "max-width: calc(100vw - 32px)",
    "z-index: 2147483647",
  ].join(";");

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = TEMPLATE;

  document.documentElement.appendChild(host);

  const body = shadow.querySelector(".ec-body");
  let open = false;

  let inErrorState = false;
  let countdownId = null;
  function clearCountdown() {
    if (countdownId) { clearInterval(countdownId); countdownId = null; }
  }

  shadow.querySelector(".ec-close").addEventListener("click", () => api.close());
  shadow.querySelector(".ec-byok-btn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
  });
  shadow.querySelector(".ec-paste-btn").addEventListener("click", () => api.renderPasteMode());

  const api = {
    host,
    shadow,
    isOpen: () => open,
    isError: () => inErrorState,
    open() {
      open = true;
      host.style.display = "block";
    },
    close() {
      open = false;
      inErrorState = false;
      clearCountdown();
      host.style.display = "none";
    },
    renderLoading(stage) {
      inErrorState = false;
      clearCountdown();
      body.innerHTML = `
        <div class="ec-state ec-loading">
          <div class="ec-spinner" aria-hidden="true"></div>
          <p>${escapeHtml(stage || "Analyzing…")}</p>
        </div>`;
    },
    renderError(message, retryAfter = 0, daily = false) {
      inErrorState = true;
      clearCountdown();
      let extra = "";
      if (retryAfter > 0) {
        extra = `<p class="ec-retry-hint">Try again in <span class="ec-cd">${retryAfter}</span>s</p>`;
      } else if (daily) {
        const reset = new Date();
        reset.setUTCHours(24, 0, 0, 0);
        const local = reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        extra = `<p class="ec-retry-hint">Resets around ${escapeHtml(local)} your time.</p>`;
      }
      body.innerHTML = `
        <div class="ec-state ec-error">
          <p class="ec-error-title">Can't analyze this page</p>
          <p>${escapeHtml(message)}</p>
          ${extra}
        </div>`;
      if (retryAfter > 0) {
        let secs = retryAfter;
        const cdEl = shadow.querySelector(".ec-cd");
        const hintEl = shadow.querySelector(".ec-retry-hint");
        countdownId = setInterval(() => {
          secs--;
          if (secs <= 0) {
            clearCountdown();
            if (hintEl) hintEl.textContent = "Ready — click the FlipSide button to retry.";
          } else if (cdEl) {
            cdEl.textContent = String(secs);
          }
        }, 1000);
      }
    },
    renderResult(data) {
      inErrorState = false;
      clearCountdown();
      body.innerHTML = renderResultHtml(data);
    },
    renderPasteMode() {
      inErrorState = false;
      clearCountdown();
      body.innerHTML = `
        <div class="ec-paste-mode">
          <p class="ec-label">Paste article text</p>
          <textarea class="ec-paste-area" placeholder="Paste any text here to analyze it…" spellcheck="false"></textarea>
          <div class="ec-paste-actions">
            <button class="ec-paste-submit">Analyze</button>
            <span class="ec-paste-hint"></span>
          </div>
        </div>`;
      shadow.querySelector(".ec-paste-submit").addEventListener("click", async () => {
        const text = shadow.querySelector(".ec-paste-area").value.trim();
        const hint = shadow.querySelector(".ec-paste-hint");
        if (text.length < 200) {
          hint.textContent = "Paste at least a paragraph of text.";
          return;
        }
        api.renderLoading();
        try {
          if (onAnalyze) {
            const res = await onAnalyze({ title: "(pasted text)", text, url: "" }, api);
            if (res?.ok) api.renderResult(res.data);
            else api.renderError(res?.error ?? "Something went wrong.", res?.retryAfter ?? 0, res?.daily === true);
          }
        } catch (err) {
          api.renderError(
            err?.message === "client-timeout"
              ? "Timed out — close and try again."
              : "Couldn't reach the background service."
          );
        }
      });
    },
  };

  controller = api;
  return controller;
}

function renderResultHtml(data) {
  const type = data?.result_type;

  // NONE — confident silence. No links, no hedging.
  if (type !== "counter_perspective" && type !== "additional_context") {
    return `
      <section class="ec-section">
        <p class="ec-label">FlipSide</p>
        <p class="ec-none-msg">No credible counter-perspective or material context found.</p>
      </section>`;
  }

  const isCounter = type === "counter_perspective";
  const label = isCounter ? "Counter-perspective" : "Additional context";
  const labelClass = isCounter ? "ec-label-counter" : "ec-label-context";

  const claims = Array.isArray(data?.core_claims) ? data.core_claims : [];
  const claimsHtml = claims.length
    ? `<section class="ec-section">
         <p class="ec-label">Core claims</p>
         <ul class="ec-claims">${claims.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
       </section>`
    : "";

  const headlineHtml = data.headline
    ? `<p class="ec-headline">${escapeHtml(data.headline)}</p>` : "";
  const summaryHtml = data.summary
    ? `<p class="ec-perspective">${escapeHtml(data.summary)}</p>` : "";

  const conf = typeof data.confidence === "number" ? data.confidence : null;
  const confHtml = conf != null ? `<span class="ec-conf">${confidenceLabel(conf)}</span>` : "";

  const sources = Array.isArray(data.sources) ? data.sources : [];
  const sourcesHtml = sources.length
    ? `<div class="ec-sources">
         <p class="ec-label">Sources <span class="ec-src-count">${sources.length}</span></p>
         <ul class="ec-sources-list open">
           ${sources.map((s) => `<li>${renderSource(s)}</li>`).join("")}
         </ul>
       </div>`
    : "";

  const further = Array.isArray(data.furtherReading) ? data.furtherReading : [];
  const furtherHtml = further.length
    ? `<div class="ec-sources">
         <button class="ec-sources-toggle" aria-expanded="false" onclick="
           var btn=this, list=this.nextElementSibling;
           var open=btn.getAttribute('aria-expanded')==='true';
           btn.setAttribute('aria-expanded', open ? 'false' : 'true');
           list.classList.toggle('open', !open);
         ">
           <i class="ec-toggle-arrow">▶</i> Further reading
         </button>
         <ul class="ec-sources-list">
           ${further.map((s) => `<li>${renderSource(s)}</li>`).join("")}
         </ul>
       </div>`
    : "";

  return `
    ${claimsHtml}
    <section class="ec-section">
      <p class="ec-label ${labelClass}">${label} ${confHtml}</p>
      ${headlineHtml}
      ${summaryHtml}
      ${sourcesHtml}
      ${furtherHtml}
    </section>`;
}

function confidenceLabel(c) {
  if (c >= 0.85) return "High confidence";
  if (c >= 0.7) return "Medium-high confidence";
  if (c >= 0.5) return "Medium confidence";
  return "Low confidence";
}

// Renders one source. New results are objects with a real, fetched URL
// ({ title, url, publisher, kind }); legacy/cached results may still be plain
// strings, which fall back to the old linkifier.
function renderSource(s) {
  if (typeof s === "string") return linkifySource(s);
  if (!s || !s.url) return "";

  const title = escapeHtml(s.title || s.url);
  const url = escapeHtml(s.url);
  const pub = escapeHtml(s.publisher || "");
  const kind = String(s.kind || "");
  const kindLabel =
    kind === "academic" ? "Academic" :
    kind === "preprint" ? "Preprint" :
    kind === "government" ? "Government" :
    kind === "legal" ? "Legal" :
    kind === "news" ? "News" :
    kind === "reference" ? "Reference" : "";

  const kindHtml = kindLabel
    ? `<span class="ec-src-kind ec-kind-${escapeHtml(kind)}">${kindLabel}</span>`
    : "";
  const metaText = [kindHtml, pub].filter(Boolean).join(" · ");
  const metaHtml = metaText ? `<span class="ec-src-meta">${metaText}</span>` : "";

  return `<a class="ec-src-link" href="${url}" target="_blank" rel="noopener noreferrer">${title}</a>${metaHtml}`;
}

// Turns a source string into a clickable link.
// - Real URL → direct link.
// - Descriptive text → DuckDuckGo search link. The domain is always duckduckgo.com
//   (we control the URL structure) and the text is encodeURIComponent-encoded so
//   model output cannot escape the query parameter or redirect anywhere unexpected.
//   It's transparent: the user lands on a search page, not a fabricated citation.
function linkifySource(str) {
  const text = escapeHtml(str);
  const trimmed = str.trim();

  // Direct URL — link straight to it.
  if (/^https?:\/\//i.test(trimmed)) {
    return `<a class="ec-src-direct" href="${text}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  }

  // URL embedded in text (e.g. "Some paper https://example.com").
  const embedded = trimmed.match(/https?:\/\/[^\s)>\]]+/i);
  if (embedded) {
    const url = escapeHtml(embedded[0]);
    const label = escapeHtml(trimmed.replace(embedded[0], "").trim().replace(/^[-–—:,\s]+/, ""));
    return `<a class="ec-src-direct" href="${url}" target="_blank" rel="noopener noreferrer">${label || url}</a>`;
  }

  // No URL — generate a DuckDuckGo search link from the description.
  const query = encodeURIComponent(trimmed);
  const href = `https://duckduckgo.com/?q=${query}`;
  return `<a class="ec-src-search" href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const TEMPLATE = `
  <style>
    /* ── Tokens ── */
    :host {
      all: initial;
      --ec-surface:  rgba(13, 15, 21, 0.95);
      --ec-header:   rgba(17, 20, 28, 0.98);
      --ec-border:   rgba(255, 255, 255, 0.07);
      --ec-tint:     rgba(255, 255, 255, 0.04);
      --ec-text:     #eaecf0;
      --ec-muted:    #6e7585;
      --ec-accent:   #5b8ef0;
      --ec-green:    #34d399;
      --ec-red:      #f87171;
      --ec-radius:   14px;
    }
    @media (prefers-color-scheme: light) {
      :host {
        --ec-surface:  rgba(255, 255, 255, 0.95);
        --ec-header:   rgba(247, 248, 250, 0.98);
        --ec-border:   rgba(0, 0, 0, 0.07);
        --ec-tint:     rgba(0, 0, 0, 0.03);
        --ec-text:     #111318;
        --ec-muted:    #6b7280;
        --ec-accent:   #3b6be8;
        --ec-green:    #059669;
        --ec-red:      #dc2626;
      }
    }

    *, *::before, *::after { box-sizing: border-box; }

    /* ── Shell ── */
    .ec-panel {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      line-height: 1.6;
      color: var(--ec-text);
      background: var(--ec-surface);
      border: 1px solid var(--ec-border);
      border-radius: var(--ec-radius);
      box-shadow: 0 32px 64px rgba(0,0,0,0.4), 0 4px 16px rgba(0,0,0,0.25);
      backdrop-filter: blur(20px) saturate(1.5);
      -webkit-backdrop-filter: blur(20px) saturate(1.5);
      overflow: hidden;
    }

    /* ── Header ── */
    .ec-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 10px 10px 15px;
      background: var(--ec-header);
      border-bottom: 1px solid var(--ec-border);
    }
    .ec-wordmark {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.1px;
      color: var(--ec-text);
    }
    .ec-gem {
      color: var(--ec-accent);
      font-size: 9px;
      line-height: 1;
    }
    .ec-close {
      all: unset;
      cursor: pointer;
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 7px;
      color: var(--ec-muted);
      transition: background 0.12s, color 0.12s;
    }
    .ec-close:hover { background: var(--ec-tint); color: var(--ec-text); }
    .ec-close svg {
      width: 11px; height: 11px;
      stroke: currentColor; stroke-width: 2;
      stroke-linecap: round; fill: none;
    }

    /* ── Body ── */
    .ec-body {
      padding: 15px 16px;
      max-height: 68vh;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--ec-border) transparent;
    }
    .ec-body::-webkit-scrollbar { width: 4px; }
    .ec-body::-webkit-scrollbar-track { background: transparent; }
    .ec-body::-webkit-scrollbar-thumb { background: var(--ec-border); border-radius: 99px; }

    /* ── Section labels ── */
    .ec-section { margin-bottom: 16px; }
    .ec-section:last-child { margin-bottom: 0; }

    .ec-label {
      margin: 0 0 8px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.85px;
      text-transform: uppercase;
      color: var(--ec-muted);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ec-label::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--ec-border);
    }

    /* ── Claims ── */
    .ec-claims {
      list-style: none;
      padding: 0; margin: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ec-claims li {
      padding: 7px 10px 7px 11px;
      background: var(--ec-tint);
      border-radius: 7px;
      border-left: 2px solid var(--ec-accent);
      font-size: 13px;
      line-height: 1.65;
      color: var(--ec-text);
    }

    /* ── Counter text ── */
    .ec-perspective {
      margin: 0 0 10px;
      font-size: 13px;
      font-weight: 400;
      line-height: 1.65;
      color: var(--ec-text);
    }
    .ec-perspective:last-of-type { margin-bottom: 0; }

    /* ── Paste mode ── */
    .ec-paste-mode { display: flex; flex-direction: column; gap: 10px; }
    .ec-paste-area {
      width: 100%;
      min-height: 130px;
      padding: 10px 11px;
      background: var(--ec-tint);
      border: 1px solid var(--ec-border);
      border-radius: 8px;
      color: var(--ec-text);
      font-family: inherit;
      font-size: 12.5px;
      line-height: 1.6;
      resize: vertical;
      outline: none;
      box-sizing: border-box;
    }
    .ec-paste-area:focus { border-color: var(--ec-accent); }
    .ec-paste-area::placeholder { color: var(--ec-muted); }
    .ec-paste-actions { display: flex; align-items: center; gap: 10px; }
    .ec-paste-submit {
      all: unset;
      cursor: pointer;
      padding: 7px 15px;
      background: var(--ec-accent);
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      border-radius: 7px;
      transition: opacity 0.12s;
    }
    .ec-paste-submit:hover { opacity: 0.85; }
    .ec-paste-hint { font-size: 11px; color: var(--ec-red); }

    /* ── Sources (collapsible) ── */
    .ec-sources {
      margin-top: 11px;
      padding-top: 11px;
      border-top: 1px solid var(--ec-border);
    }
    .ec-sources-toggle {
      all: unset;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.7px;
      text-transform: uppercase;
      color: var(--ec-muted);
      transition: color 0.12s;
      user-select: none;
    }
    .ec-sources-toggle:hover { color: var(--ec-text); }
    .ec-toggle-arrow {
      display: inline-block;
      font-style: normal;
      font-size: 8px;
      transition: transform 0.18s;
      opacity: 0.6;
    }
    .ec-sources-toggle[aria-expanded="true"] .ec-toggle-arrow {
      transform: rotate(90deg);
    }
    .ec-sources-list {
      display: none;
      padding: 0; margin: 6px 0 0;
      list-style: none;
      flex-direction: column;
      gap: 5px;
    }
    .ec-sources-list.open { display: flex; }
    .ec-sources-list li {
      font-size: 13px;
      line-height: 1.5;
    }
    .ec-sources-list a {
      text-decoration: none;
      word-break: break-word;
      display: block;
    }
    .ec-sources-list a:hover { text-decoration: underline; }
    /* real, fetched links */
    .ec-src-link { color: var(--ec-accent); font-weight: 500; }
    /* legacy string sources */
    .ec-src-direct,
    .ec-src-search { color: var(--ec-accent); }
    .ec-src-search::before {
      content: '↗ ';
      font-size: 11px;
    }
    .ec-src-meta {
      display: block;
      margin-top: 1px;
      font-size: 11px;
      color: var(--ec-muted);
    }
    .ec-src-kind {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 4px;
      vertical-align: 1px;
    }
    .ec-kind-academic   { color: #a78bfa; background: rgba(167,139,250,0.13); }
    .ec-kind-preprint   { color: #c4b5fd; background: rgba(167,139,250,0.10); }
    .ec-kind-government { color: #fbbf24; background: rgba(251,191,36,0.13); }
    .ec-kind-legal      { color: #f0abfc; background: rgba(240,171,252,0.13); }
    .ec-kind-news       { color: var(--ec-accent); background: rgba(91,142,240,0.13); }
    .ec-kind-reference  { color: var(--ec-green); background: rgba(52,211,153,0.13); }
    .ec-src-count {
      color: var(--ec-muted); font-weight: 700;
    }

    /* ── Result headline + confidence ── */
    .ec-headline {
      margin: 0 0 8px;
      font-size: 14.5px;
      font-weight: 650;
      line-height: 1.4;
      color: var(--ec-text);
    }
    .ec-label-counter { color: var(--ec-green); }
    .ec-label-counter::after { background: var(--ec-green); opacity: 0.25; }
    .ec-label-context { color: var(--ec-accent); }
    .ec-label-context::after { background: var(--ec-accent); opacity: 0.25; }
    .ec-conf {
      order: 3;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.3px;
      color: var(--ec-muted);
      text-transform: none;
      white-space: nowrap;
    }

    /* ── States ── */
    .ec-none-msg {
      margin: 0;
      font-size: 13px;
      font-weight: 400;
      color: var(--ec-green);
    }
    .ec-state {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .ec-loading {
      flex-direction: row;
      align-items: center;
      gap: 10px;
      padding: 2px 0;
    }
    .ec-loading p {
      margin: 0;
      font-size: 13px;
      color: var(--ec-muted);
    }
    .ec-spinner {
      flex-shrink: 0;
      width: 15px; height: 15px;
      border-radius: 50%;
      border: 1.5px solid var(--ec-border);
      border-top-color: var(--ec-accent);
      animation: ec-spin 0.7s linear infinite;
    }
    @keyframes ec-spin { to { transform: rotate(360deg); } }

    .ec-error-title {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      color: var(--ec-red);
    }
    .ec-error p:last-child {
      margin: 0;
      font-size: 13px;
      color: var(--ec-muted);
    }
    .ec-retry-hint {
      margin: 8px 0 0;
      font-size: 12px;
      color: var(--ec-muted);
    }
    .ec-cd {
      font-variant-numeric: tabular-nums;
      color: var(--ec-accent);
    }

    /* ── Footer ── */
    .ec-footer {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-top: 1px solid var(--ec-border);
      background: var(--ec-header);
    }
    .ec-footer-sep { font-size: 11px; color: var(--ec-border); }
    .ec-byok-btn, .ec-paste-btn {
      all: unset;
      cursor: pointer;
      font-size: 11px;
      color: var(--ec-muted);
      transition: color 0.12s;
    }
    .ec-byok-btn:hover, .ec-paste-btn:hover { color: var(--ec-accent); }
  </style>

  <div class="ec-panel">
    <div class="ec-header">
      <span class="ec-wordmark">
        <span class="ec-gem">◆</span>
        FlipSide
      </span>
      <button class="ec-close" title="Close" aria-label="Close">
        <svg viewBox="0 0 11 11">
          <line x1="1" y1="1" x2="10" y2="10"/>
          <line x1="10" y1="1" x2="1" y2="10"/>
        </svg>
      </button>
    </div>
    <div class="ec-body">
      <div class="ec-state"><p style="color:var(--ec-muted);margin:0;font-size:12.5px">Ready.</p></div>
    </div>
    <div class="ec-footer">
      <button class="ec-byok-btn">⚙ Connect your API Key</button>
      <span class="ec-footer-sep">·</span>
      <button class="ec-paste-btn">✎ Paste text</button>
    </div>
  </div>`;
