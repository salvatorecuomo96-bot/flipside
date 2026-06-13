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
    "width: 520px",
    "max-width: calc(100vw - 32px)",
    "z-index: 2147483647",
  ].join(";");

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = TEMPLATE;

  document.documentElement.appendChild(host);

  const body = shadow.querySelector(".ec-body");
  let open = false;

  shadow.querySelector(".ec-close").addEventListener("click", () => api.close());

  const api = {
    host,
    shadow,
    isOpen: () => open,
    open() {
      open = true;
      host.style.display = "block";
    },
    close() {
      open = false;
      host.style.display = "none";
    },
    renderLoading() {
      body.innerHTML = `
        <div class="ec-state ec-loading">
          <div class="ec-spinner" aria-hidden="true"></div>
          <p>Finding the strongest counter-perspective…</p>
        </div>`;
    },
    renderError(message) {
      body.innerHTML = `
        <div class="ec-state ec-error">
          <p class="ec-error-title">Can't analyze this page</p>
          <p>${escapeHtml(message)}</p>
        </div>`;
    },
    renderResult(data) {
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
  const keyFigures = Array.isArray(counter.key_figures) ? counter.key_figures : [];
  const searchQueries = Array.isArray(counter.search_queries) ? counter.search_queries : [];

  const reasoningHtml = counter.reasoning
    ? `<div>
         <p class="ec-label">Why experts disagree</p>
         <p class="ec-reasoning">${escapeHtml(counter.reasoning)}</p>
       </div>`
    : "";

  const keyFiguresHtml = keyFigures.length
    ? `<div>
         <p class="ec-label">Key voices</p>
         <div class="ec-figures">${keyFigures.map((f) => `<span class="ec-figure">${escapeHtml(f)}</span>`).join("")}</div>
       </div>`
    : "";

  const searchQueriesHtml = searchQueries.length
    ? `<div>
         <p class="ec-label">Explore further</p>
         <ul class="ec-sources-list">${searchQueries.map((q) => `<li>${searchQueryToLink(q)}</li>`).join("")}</ul>
       </div>`
    : "";

  const sourcesHtml = sources.length
    ? `<div>
         <p class="ec-label">Evidence &amp; sources</p>
         <ul class="ec-sources-list">${sources.map((s) => `<li>${linkifySource(s)}</li>`).join("")}</ul>
       </div>`
    : "";

  const hasMore = reasoningHtml || keyFiguresHtml || searchQueriesHtml || sourcesHtml;
  const learnMoreHtml = hasMore
    ? `<div class="ec-more">
         <button class="ec-more-toggle" aria-expanded="false" onclick="
           var btn=this, section=this.nextElementSibling;
           var open=btn.getAttribute('aria-expanded')==='true';
           btn.setAttribute('aria-expanded', open ? 'false' : 'true');
           section.classList.toggle('open', !open);
         ">
           <i class="ec-more-arrow">▶</i> Learn more
         </button>
         <div class="ec-more-section">
           ${reasoningHtml}
           ${keyFiguresHtml}
           ${searchQueriesHtml}
           ${sourcesHtml}
         </div>
       </div>`
    : "";

  return `
    ${claimsHtml}
    <section class="ec-section">
      <p class="ec-label">Strongest counter-perspective</p>
      <p class="ec-perspective">${escapeHtml(counter.perspective ?? "")}</p>
      ${learnMoreHtml}
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

function searchQueryToLink(q) {
  const href = `https://duckduckgo.com/?q=${encodeURIComponent(q.trim())}`;
  return `<a class="ec-src-search" href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(q)}</a>`;
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
    .ec-reasoning {
      margin: 0;
      font-size: 13px;
      font-weight: 400;
      line-height: 1.65;
      color: var(--ec-text);
    }

    /* ── Sources list ── */
    .ec-sources-list {
      padding: 0; margin: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
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
    .ec-src-direct,
    .ec-src-search { color: var(--ec-accent); }
    .ec-src-search::before {
      content: '↗ ';
      font-size: 11px;
    }

    /* ── Learn more (collapsible) ── */
    .ec-more {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--ec-border);
    }
    .ec-more-toggle {
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
    .ec-more-toggle:hover { color: var(--ec-text); }
    .ec-more-arrow {
      display: inline-block;
      font-style: normal;
      font-size: 8px;
      transition: transform 0.18s;
      opacity: 0.6;
    }
    .ec-more-toggle[aria-expanded="true"] .ec-more-arrow {
      transform: rotate(90deg);
    }
    .ec-more-section {
      display: none;
      margin-top: 14px;
      flex-direction: column;
      gap: 14px;
    }
    .ec-more-section.open { display: flex; }

    /* ── Key figures (pill badges) ── */
    .ec-figures {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0;
    }
    .ec-figure {
      padding: 3px 10px;
      background: var(--ec-tint);
      border: 1px solid var(--ec-border);
      border-radius: 99px;
      font-size: 12px;
      color: var(--ec-text);
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
  </div>`;
