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
    renderResult(data, url, onRetry) {
      inErrorState = false;
      clearCountdown();
      body.innerHTML = renderResultHtml(data);
      wireFeedback(shadow, url || "");
      if (data?.result_type === "none" && typeof onRetry === "function") {
        const retryBtn = shadow.querySelector(".ec-retry-btn");
        if (retryBtn) retryBtn.addEventListener("click", onRetry);
      }
    },
    renderIncomplete(onPaste) {
      inErrorState = false;
      clearCountdown();
      body.innerHTML = `
        <section class="ec-section">
          <p class="ec-label">FlipSide</p>
          <p class="ec-none-title">Couldn't access enough of this article</p>
          <p class="ec-none-body">This page may be behind a paywall or showing only a preview. FlipSide needs the full article text to work.</p>
          <button class="ec-paste-trigger">✎ Paste article text</button>
        </section>`;
      shadow.querySelector(".ec-paste-trigger").addEventListener("click", () => {
        body.innerHTML = `
          <section class="ec-section">
            <p class="ec-label">FlipSide</p>
            <p class="ec-none-title">Paste the full article text</p>
            <textarea class="ec-paste-area" placeholder="Paste the article text here…" rows="8"></textarea>
            <button class="ec-paste-submit">Analyze</button>
          </section>`;
        shadow.querySelector(".ec-paste-submit").addEventListener("click", () => {
          const text = (shadow.querySelector(".ec-paste-area").value || "").trim();
          if (text.split(/\s+/).filter(Boolean).length < 80) {
            shadow.querySelector(".ec-paste-area").placeholder = "Please paste more text — this doesn't look like a full article.";
            return;
          }
          if (typeof onPaste === "function") onPaste(text);
        });
      });
    },
  };

  controller = api;
  return controller;
}

function renderResultHtml(data) {
  const type = data?.result_type;

  if (type === "mixed") return renderMixedHtml(data);

  // NONE — articulated silence. The service worker hands us a whitelisted reason
  // code; we map it to fixed copy here and NEVER render model-generated prose.
  if (type !== "counter_perspective" && type !== "additional_context") {
    return renderNoneHtml(data);
  }

  const isCounter = type === "counter_perspective";
  const label = isCounter ? "Counter-perspective" : "Additional context";
  const labelClass = isCounter ? "ec-label-counter" : "ec-label-context";

  return `
    ${renderClaims(data.core_claims, data)}
    <section class="ec-section">
      <p class="ec-label ${labelClass}">${label} ${confChip(data.confidence)}</p>
      ${data.headline ? `<p class="ec-headline">${escapeHtml(data.headline)}</p>` : ""}
      ${data.summary ? `<p class="ec-perspective">${escapeHtml(data.summary)}</p>` : ""}
      ${renderSourcesBlock(data.sources)}
      ${renderFurther(data.furtherReading)}
    </section>
    ${renderFeedbackHtml()}`;
}

// MIXED — two stacked blocks: empirical counter (academic) + moral context
// (reference). Claims once on top, further-reading once at the bottom.
function renderMixedHtml(data) {
  const emp = data.empirical_counter || {};
  const ctx = data.additional_context || {};
  const empHtml = emp.summary
    ? `<section class="ec-section">
         <p class="ec-label ec-label-counter">Empirical counter-evidence ${confChip(emp.confidence)}</p>
         <p class="ec-perspective">${escapeHtml(emp.summary)}</p>
         ${renderSourcesBlock(emp.sources)}
       </section>`
    : "";
  const ctxHtml = ctx.summary
    ? `<section class="ec-section">
         <p class="ec-label ec-label-context">Additional context</p>
         <p class="ec-perspective">${escapeHtml(ctx.summary)}</p>
         ${renderSourcesBlock(ctx.sources)}
       </section>`
    : "";
  return `
    ${renderClaims(data.core_claims, data)}
    ${data.headline ? `<p class="ec-headline">${escapeHtml(data.headline)}</p>` : ""}
    ${empHtml}
    ${ctxHtml}
    <section class="ec-section">${renderFurther(data.furtherReading)}</section>
    ${renderFeedbackHtml()}`;
}

// Fixed copy for every "none" reason code (see src/lib/silence.js ALL_NONE_REASONS).
// The panel NEVER displays model-generated reason prose — only these strings.
export const REASON_COPY = {
  straight_reporting: {
    title: "Factual report, no contestable claim",
    body: "This article reports events or statements without advancing a conclusion that evidence could challenge.",
  },
  no_contestable_claim: {
    title: "No checkable claim to investigate",
    body: "This piece expresses a viewpoint but doesn't make a specific factual claim that research could address.",
  },
  no_sources_returned: {
    title: "No relevant sources found",
    body: "The evidence search returned nothing for this topic. The article may be too niche or too recent for indexed research.",
  },
  no_usable_evidence: {
    title: "Sources found, but not enough evidence text",
    body: "We found related sources, but could not retrieve enough of their content to evaluate the claim reliably.",
  },
  opinion_no_evidence_basis: {
    title: "Opinion article — no evidence-based challenge found",
    body: "The available evidence did not materially change how the article's central argument should be evaluated.",
  },
  evidence_off_target: {
    title: "Research found, but not on this claim",
    body: "Available sources covered the broader topic but didn't directly address the article's specific conclusion.",
  },
  evidence_too_weak: {
    title: "Evidence too thin to draw a conclusion",
    body: "Some relevant research exists, but it's insufficient to make a credible counter-argument without overstating what the evidence shows.",
  },
  no_material_counter: {
    title: "No meaningful counter-perspective found",
    body: "The evidence reviewed doesn't credibly challenge the article's conclusion or add context that would change how a reader interprets it.",
  },
  normative_unresolved: {
    title: "A value judgment — not settled by evidence",
    body: "This claim is fundamentally moral or theological. Research can add context, but no study can settle the underlying question.",
  },
};

// Transient silences — likely temporary API or retrieval issues.
// These get a Try again button; the caller wires up onRetry via renderResult().
const TRANSIENT_SILENCES = new Set(["no_sources_returned", "no_usable_evidence"]);

function renderNoneHtml(data) {
  const copy = REASON_COPY[data?.reason] || REASON_COPY.no_material_counter;
  const examined = typeof data?.examined_claim === "string" && data.examined_claim.trim()
    ? `<div class="ec-none-examined">
         <span class="ec-none-examined-label">Examined claim</span>
         <span class="ec-none-examined-text">${escapeHtml(data.examined_claim.trim())}</span>
       </div>`
    : "";
  const retryBtn = TRANSIENT_SILENCES.has(data?.reason)
    ? `<button class="ec-retry-btn">Try again</button>`
    : "";
  return `
    <section class="ec-section">
      <p class="ec-label">FlipSide</p>
      <p class="ec-none-title">${escapeHtml(copy.title)}</p>
      <p class="ec-none-body">${escapeHtml(copy.body)}</p>
      ${examined}
      ${retryBtn}
      ${renderFurther(data?.furtherReading)}
    </section>
    ${renderFeedbackHtml()}`;
}

function renderClaims(coreClaims, data = {}) {
  const claims = Array.isArray(coreClaims) ? coreClaims : [];
  const attribution = renderClaimHolder(data);
  if (!claims.length && !attribution) return "";
  return `<section class="ec-section">
       <p class="ec-label">Core claims</p>
       ${attribution}
       ${claims.length ? `<ul class="ec-claims">${claims.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>` : ""}
     </section>`;
}

function renderClaimHolder(data) {
  const holder = data?.claim_holder;
  const attribution = typeof data?.attribution === "string" ? data.attribution.trim() : "";
  if (!attribution || holder === "author") return "";
  const label = holder === "multiple_sources" ? "Reported dispute" : "Claim holder";
  return `<p class="ec-claim-holder"><span>${label}</span>${escapeHtml(attribution)}</p>`;
}

function confChip(confidence) {
  return typeof confidence === "number" ? `<span class="ec-conf">${confidenceLabel(confidence)}</span>` : "";
}

function renderSourcesBlock(sources) {
  const srcs = Array.isArray(sources) ? sources : [];
  if (!srcs.length) return "";
  return `<div class="ec-sources">
       <p class="ec-label">Sources <span class="ec-src-count">${srcs.length}</span></p>
       <ul class="ec-sources-list open">
         ${srcs.map((s) => `<li>${renderSource(s)}</li>`).join("")}
       </ul>
     </div>`;
}

function renderFurther(further) {
  const arr = Array.isArray(further) ? further : [];
  if (!arr.length) return "";
  return `<div class="ec-sources">
       <button class="ec-sources-toggle" aria-expanded="false" onclick="
         var btn=this, list=this.nextElementSibling;
         var open=btn.getAttribute('aria-expanded')==='true';
         btn.setAttribute('aria-expanded', open ? 'false' : 'true');
         list.classList.toggle('open', !open);
       ">
         <i class="ec-toggle-arrow">▶</i> Further reading
       </button>
       <ul class="ec-sources-list">
         ${arr.map((s) => `<li>${renderSource(s)}</li>`).join("")}
       </ul>
     </div>`;
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

function wireFeedback(shadow, url) {
  const upBtn = shadow.querySelector(".ec-feedback-up");
  const downBtn = shadow.querySelector(".ec-feedback-down");
  const reasonsRow = shadow.querySelector(".ec-feedback-reasons");
  if (!upBtn || !downBtn || !url) return;

  chrome.runtime.sendMessage({ type: "GET_FEEDBACK", url }, (resp) => {
    const rating = resp?.rating ?? null;
    if (rating === "up") upBtn.classList.add("ec-fb-selected");
    if (rating === "down") { downBtn.classList.add("ec-fb-selected"); reasonsRow?.removeAttribute("hidden"); }
  });

  upBtn.addEventListener("click", () => {
    upBtn.classList.add("ec-fb-selected");
    downBtn.classList.remove("ec-fb-selected");
    downBtn.disabled = true;
    upBtn.disabled = true;
    reasonsRow?.setAttribute("hidden", "");
    chrome.runtime.sendMessage({ type: "FEEDBACK", url, rating: "up" });
    if (reasonsRow) {
      reasonsRow.innerHTML = `<span class="ec-feedback-thanks">Thanks for your feedback!</span>`;
      reasonsRow.removeAttribute("hidden");
    }
  });

  downBtn.addEventListener("click", () => {
    const wasSelected = downBtn.classList.contains("ec-fb-selected");
    downBtn.classList.toggle("ec-fb-selected", !wasSelected);
    upBtn.classList.remove("ec-fb-selected");
    if (!wasSelected) {
      reasonsRow?.removeAttribute("hidden");
    } else {
      reasonsRow?.setAttribute("hidden", "");
      shadow.querySelectorAll(".ec-reason-chip").forEach(c => c.classList.remove("ec-chip-selected"));
    }
    chrome.runtime.sendMessage({ type: "FEEDBACK", url, rating: wasSelected ? null : "down" });
  });

  shadow.querySelectorAll(".ec-reason-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "FEEDBACK", url, rating: "down", reason: chip.dataset.reason });
      // Lock the whole feedback row — no more clicks allowed
      upBtn.disabled = true;
      downBtn.disabled = true;
      upBtn.classList.remove("ec-fb-selected");
      downBtn.classList.remove("ec-fb-selected");
      if (reasonsRow) {
        reasonsRow.innerHTML = `<span class="ec-feedback-thanks">Thanks for your feedback!</span>`;
        reasonsRow.removeAttribute("hidden");
      }
    });
  });
}

function renderFeedbackHtml() {
  return `<div class="ec-feedback">
    <span class="ec-feedback-label">Helpful?</span>
    <button class="ec-feedback-up" title="Yes">
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M2 10.5a1.5 1.5 0 113 0v6a1.5 1.5 0 01-3 0v-6zM6 10.333v5.43a2 2 0 001.106 1.79l.05.025A4 4 0 008.943 18h5.416a2 2 0 001.962-1.608l1.2-6A2 2 0 0015.56 8H12V4a2 2 0 00-2-2 1 1 0 00-1 1v.667L6 10.333z"/></svg>
    </button>
    <button class="ec-feedback-down" title="No">
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M18 9.5a1.5 1.5 0 11-3 0v-6a1.5 1.5 0 013 0v6zM14 9.667v-5.43a2 2 0 00-1.105-1.79l-.05-.025A4 4 0 0011.055 2H5.64a2 2 0 00-1.962 1.608l-1.2 6A2 2 0 004.44 12H8v4a2 2 0 002 2 1 1 0 001-1v-.667L14 9.667z"/></svg>
    </button>
  </div>
  <div class="ec-feedback-reasons" hidden>
    <button class="ec-reason-chip" data-reason="not_relevant">Not relevant</button>
    <button class="ec-reason-chip" data-reason="factually_wrong">Factually wrong</button>
    <button class="ec-reason-chip" data-reason="still_one_sided">Still one-sided</button>
    <button class="ec-reason-chip" data-reason="sources_weak">Sources weak</button>
  </div>`;
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
    .ec-claim-holder {
      margin: 0 0 6px;
      font-size: 12px;
      line-height: 1.45;
      color: var(--ec-text);
    }
    .ec-claim-holder span {
      margin-right: 6px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.7px;
      text-transform: uppercase;
      color: var(--ec-muted);
    }
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
    .ec-none-title {
      margin: 0 0 6px;
      font-size: 14px;
      font-weight: 650;
      line-height: 1.4;
      color: var(--ec-text);
    }
    .ec-none-body {
      margin: 0;
      font-size: 13px;
      line-height: 1.6;
      color: var(--ec-muted);
    }
    .ec-none-examined {
      margin-top: 11px;
      padding: 8px 10px;
      background: var(--ec-tint);
      border-radius: 7px;
      border-left: 2px solid var(--ec-border);
    }
    .ec-none-examined-label {
      display: block;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.7px;
      text-transform: uppercase;
      color: var(--ec-muted);
      margin-bottom: 2px;
    }
    .ec-none-examined-text {
      font-size: 12.5px;
      line-height: 1.55;
      color: var(--ec-text);
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

    /* ── Feedback ── */
    .ec-feedback {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid var(--ec-border);
    }
    .ec-feedback-label {
      font-size: 11px;
      color: var(--ec-muted);
      flex: 1;
    }
    .ec-feedback-up, .ec-feedback-down {
      all: unset;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      border-radius: 8px;
      color: var(--ec-muted);
      border: 1px solid transparent;
      transition: color 0.15s, background 0.15s, border-color 0.15s, transform 0.1s;
    }
    .ec-feedback-up svg, .ec-feedback-down svg {
      width: 16px; height: 16px; display: block;
    }
    .ec-feedback-up:hover {
      color: var(--ec-green);
      background: rgba(52, 211, 153, 0.1);
      border-color: rgba(52, 211, 153, 0.25);
    }
    .ec-feedback-down:hover {
      color: var(--ec-red);
      background: rgba(248, 113, 113, 0.1);
      border-color: rgba(248, 113, 113, 0.25);
    }
    .ec-feedback-up:disabled, .ec-feedback-down:disabled {
      opacity: 0.35;
      cursor: default;
      pointer-events: none;
    }
    .ec-feedback-up.ec-fb-selected {
      color: var(--ec-green);
      background: rgba(52, 211, 153, 0.15);
      border-color: rgba(52, 211, 153, 0.4);
      transform: scale(1.08);
    }
    .ec-feedback-down.ec-fb-selected {
      color: var(--ec-red);
      background: rgba(248, 113, 113, 0.15);
      border-color: rgba(248, 113, 113, 0.4);
      transform: scale(1.08);
    }
    .ec-feedback-reasons {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px 0 4px;
    }
    .ec-feedback-reasons[hidden] { display: none; }
    .ec-reason-chip {
      all: unset;
      cursor: pointer;
      font-size: 11px;
      font-family: inherit;
      color: var(--ec-muted);
      border: 1px solid var(--ec-border);
      border-radius: 12px;
      padding: 3px 10px;
      transition: color 0.15s, background 0.15s, border-color 0.15s;
      white-space: nowrap;
    }
    .ec-reason-chip:hover {
      color: var(--ec-text);
      border-color: var(--ec-muted);
      background: var(--ec-hover);
    }
    .ec-reason-chip.ec-chip-selected {
      color: var(--ec-red);
      background: rgba(248, 113, 113, 0.1);
      border-color: rgba(248, 113, 113, 0.4);
    }
    .ec-feedback-thanks {
      font-size: 11px;
      color: var(--ec-muted);
      font-style: italic;
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
    .ec-byok-btn {
      all: unset;
      cursor: pointer;
      font-size: 11px;
      color: var(--ec-muted);
      transition: color 0.12s;
    }
    .ec-byok-btn:hover { color: var(--ec-accent); }

    /* ── Incomplete-article paste fallback ── */
    .ec-paste-trigger, .ec-paste-submit, .ec-retry-btn {
      all: unset;
      cursor: pointer;
      display: inline-block;
      margin-top: 12px;
      padding: 6px 14px;
      border-radius: 8px;
      border: 1px solid var(--ec-border);
      font-size: 12.5px;
      color: var(--ec-accent);
      transition: background 0.12s, border-color 0.12s;
    }
    .ec-paste-trigger:hover, .ec-paste-submit:hover, .ec-retry-btn:hover {
      background: rgba(91, 142, 240, 0.08);
      border-color: rgba(91, 142, 240, 0.4);
    }
    .ec-paste-area {
      display: block;
      width: 100%;
      box-sizing: border-box;
      margin-top: 10px;
      padding: 8px 10px;
      background: var(--ec-tint);
      border: 1px solid var(--ec-border);
      border-radius: 8px;
      color: var(--ec-text);
      font-size: 12.5px;
      font-family: inherit;
      resize: vertical;
      outline: none;
      line-height: 1.5;
    }
    .ec-paste-area:focus { border-color: var(--ec-accent); }
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
    </div>
  </div>`;
