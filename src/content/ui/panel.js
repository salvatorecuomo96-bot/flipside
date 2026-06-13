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

export function mountPanel() {
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
    renderLoading() {
      inErrorState = false;
      clearCountdown();
      body.innerHTML = `
        <div class="ec-state ec-loading">
          <div class="ec-spinner" aria-hidden="true"></div>
          <p>Finding the strongest counter-perspective…</p>
        </div>`;
    },
    renderError(message, retryAfter = 0, daily = false) {
      inErrorState = true;
      clearCountdown();
      let extra = "";
      if (retryAfter > 0) {
        extra = `<p class="ec-retry-hint">Try again in <span class="ec-cd">${retryAfter}</span>s</p>`;
      } else if (daily) {
        // Daily caps reset at midnight UTC — show that in the user's local time.
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
            if (hintEl) hintEl.textContent = "Ready — click the Flipside button to retry.";
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
  };

  controller = api;
  return controller;
}

function renderResultHtml(data) {
  const claims = Array.isArray(data?.claims) ? data.claims : [];
  const counter = data?.counter ?? {};
  const found = counter.found === true;

  const claimsHtml = claims.length
    ? `<section class="ec-section">
         <p class="ec-label">Core claims</p>
         <ul class="ec-claims">${claims.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
       </section>`
    : "";

  if (!found) {
    return `
      ${claimsHtml}
      <section class="ec-section">
        <p class="ec-label">Counter-perspective</p>
        <p class="ec-none-msg">No credible counter-evidence found.</p>
      </section>`;
  }

  const sources = Array.isArray(counter.sources) ? counter.sources : [];
  const sourcesHtml = sources.length
    ? `<div class="ec-sources">
         <button class="ec-sources-toggle" aria-expanded="false" onclick="
           var btn=this, list=this.nextElementSibling;
           var open=btn.getAttribute('aria-expanded')==='true';
           btn.setAttribute('aria-expanded', open ? 'false' : 'true');
           list.classList.toggle('open', !open);
         ">
           <i class="ec-toggle-arrow">▶</i> Evidence &amp; sources
         </button>
         <ul class="ec-sources-list">
           ${sources.map((s) => `<li>${linkifySource(s)}</li>`).join("")}
         </ul>
       </div>`
    : "";

  const reasoningHtml = counter.reasoning
    ? `<div class="ec-reasoning-block">
         <p class="ec-reasoning-label">Why experts hold this</p>
         <p class="ec-reasoning">${escapeHtml(counter.reasoning)}</p>
       </div>`
    : "";

  return `
    ${claimsHtml}
    <section class="ec-section">
      <p class="ec-label">Strongest counter-perspective</p>
      <p class="ec-perspective">${escapeHtml(counter.perspective ?? "")}</p>
      ${reasoningHtml}
      ${sourcesHtml}
    </section>`;
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
      margin: 0 0 12px;
      font-size: 13px;
      font-weight: 400;
      line-height: 1.65;
      color: var(--ec-text);
    }
    .ec-reasoning-block {
      margin: 0 0 12px;
      padding: 10px 12px;
      background: var(--ec-tint);
      border-radius: 8px;
      border-left: 2px solid var(--ec-muted);
    }
    .ec-reasoning-label {
      margin: 0 0 5px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.7px;
      text-transform: uppercase;
      color: var(--ec-muted);
    }
    .ec-reasoning {
      margin: 0;
      font-size: 12.5px;
      font-weight: 400;
      line-height: 1.65;
      color: var(--ec-muted);
    }

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
      line-height: 1.65;
    }
    .ec-sources-list a {
      text-decoration: none;
      word-break: break-word;
      display: block;
    }
    .ec-sources-list a:hover { text-decoration: underline; }
    /* both link types use accent color — same visual weight */
    .ec-src-direct,
    .ec-src-search { color: var(--ec-accent); }
    .ec-src-search::before {
      content: '↗ ';
      font-size: 11px;
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
      padding: 8px 16px;
      border-top: 1px solid var(--ec-border);
      background: var(--ec-header);
    }
    .ec-byok-btn {
      all: unset;
      cursor: pointer;
      font-size: 11px;
      color: var(--ec-muted);
      transition: color 0.12s;
    }
    .ec-byok-btn:hover { color: var(--ec-accent); }
  </style>

  <div class="ec-panel">
    <div class="ec-header">
      <span class="ec-wordmark">
        <span class="ec-gem">◆</span>
        Flipside
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
      <button class="ec-byok-btn">⚙ Use your own free Groq key</button>
    </div>
  </div>`;
