# Roadmap — Epistemic Companion (Autonomous Perspective Engine)

> Living document. Updated as phases land. Status legend: `[ ]` todo · `[~]` in progress · `[x]` done.

## Objective
A Chrome Extension (Manifest V3) that acts as a **Skeptical Mirror** for web content. It is
**not** a debate bot, a summarizer, or a bias detector. It is an *information discovery* tool:
when credible counter-perspectives to an article's core claims exist, it surfaces the single
strongest one. When they don't, it says so plainly.

## Operating constraints (how this repo is built)
- **Pedagogical:** every phase explains the *why* behind architectural choices, not just the *what*.
- **Adversarial:** any pattern I suspect is brittle/junior-grade is flagged with a more robust
  alternative *before* it ships. These flags live under "⚠ Known weaknesses" in each phase.
- **Zero-fluff:** no filler, no branding chatter.

## Cross-cutting architectural decisions
| Decision | Choice | Why |
|---|---|---|
| Build tooling | Vanilla ES modules, no bundler | Keeps focus on extension architecture, not toolchain config. |
| Module loading in content scripts | `loader.js` shim + dynamic `import()` | Manifest-declared content scripts **cannot** be ES modules. The shim dynamically imports a web-accessible module. |
| Where network calls happen | Service worker only | Privileged context: not subject to page CSP/CORS, and the API key never enters page-world JS. |
| Key model | OpenRouter BYOK, model id configurable | "Nex-N2-Pro" is treated as a user-supplied id; we don't hard-code a possibly-nonexistent model. |
| Content extraction | Readability-style scoring, not class selectors | Class names are the most fragile thing on the web. Scoring by text/link density survives redesigns. |

---

## Phase 1 — Scaffolding & Infrastructure  `[x]`
**Goal:** loadable MV3 skeleton with an isolated floating UI and working message passing.

- [x] `manifest.json` (MV3)
- [x] Service worker handles `action.onClicked` and message routing
- [x] `loader.js` shim → dynamic import of module entry point
- [x] Shadow DOM container for the floating window (style isolation)

**Why Shadow DOM is the only professional choice:** a content script shares the *host page's*
DOM and CSS cascade. Any plain `<div>` we inject inherits the page's styles and can be restyled
(or hidden) by the page. Shadow DOM gives us an encapsulated subtree the page's CSS cannot reach
and whose CSS cannot leak out. It's the browser-native answer to "render UI on a page I don't control."

**Why a Service Worker over a persistent background script:** MV3 forbids long-lived background
pages. The SW is event-driven and ephemeral (it spins up for an event, then dies). That's the only
place `action.onClicked` fires, and it's the privileged context for cross-origin `fetch`. A content
script can't reliably do either.

### ⚠ Known weaknesses (Phase 1)
- Dynamic `import()` in a content script requires the target be in `web_accessible_resources`,
  which makes those files enumerable by the host page. Acceptable: they contain no secrets.

---

## Phase 2 — Autonomous DOM Extraction  `[x]`
**Goal:** on page load, auto-detect and extract the article's main content, resiliently.

- [x] Readability-style scorer (length, paragraph count, link-density, semantic-tag bonus)
- [x] Title extraction (og:title → h1 → document.title)
- [x] `MutationObserver` for SPA route/content changes, with infinite-loop guards

**Handling SPA mutation without infinite loops** — the loop risk is: our own panel injection
mutates the DOM → observer fires → we re-extract → we re-render → observer fires again. Guards:
1. **Ignore self:** drop mutations whose targets all sit inside our Shadow host.
2. **Debounce:** coalesce bursts (~600ms) so a render storm yields one re-extract.
3. **Content-hash equality:** if re-extracted text hashes identically to last time, bail.
4. (Optional hardening) disconnect the observer while we mutate, reconnect after.

### ⚠ Known weaknesses (Phase 2)
- **Relying on `<article>`/`<main>` alone is still junior-grade.** Many sites omit them or wrap
  ads/teasers in them. The robust alternative shipped here is a *scoring* heuristic; the
  production-grade alternative is to vendor Mozilla's `@mozilla/readability` (battle-tested).
  We implement a lightweight scorer and document the upgrade path.

---

## Phase 3 — The "Perspective" Logic Pipeline (Truth Filter)  `[x]`
**Goal:** orchestrate the BYOK model to find the strongest credible contradictory perspective.

- [x] OpenRouter client (`/api/v1/chat/completions`)
- [x] Core prompt: (1) identify core claims, (2) find strongest credible counter, (3) else
      "No credible counter-evidence found."
- [x] Strict JSON output contract + defensive parsing
- [x] Graceful error/rate-limit handling (backoff+jitter, Retry-After, AbortController timeout)

**Handling API errors & rate-limiting in a browser:** exponential backoff **with jitter**,
honoring `Retry-After`; an `AbortController` timeout so a hung socket can't wedge the worker;
retry only on `429`/`5xx`/network errors, never on `4xx` (a bad key won't fix itself by retrying).

### ⚠ Known weaknesses (Phase 3)
- **A plain chat completion cannot *search the web*** — it recalls from training data. "Find the
  strongest counter-perspective" is therefore *recall*, not *discovery*, unless we enable web
  access. Mitigation: support OpenRouter's `:online` model suffix / web plugin as a toggle, and
  instruct the model to **describe the type of evidence rather than fabricate citations** when
  unsure. This is the single biggest honesty caveat in the project.

---

## Phase 4 — UI Integration & Calibration  `[x]`
**Goal:** wire the floating UI to the pipeline; render result, "no counter found", or error states.

- [x] Action button toggles the isolated floating window
- [x] UI states: loading · result · "No credible counter-evidence found." · error/no-key
- [x] Options page for BYOK key + model id + web-search toggle
- [x] XSS-safe rendering (all model output escaped before injection)

### ⚠ Known weaknesses (Phase 4)
- `z-index: 2147483647` is a blunt instrument; a page using the same value at a later stacking
  context can still cover us. Acceptable for v0.1; revisit if real sites clip the panel.

---

## Phase 5 — Zero-Friction Distribution (the inference-economics problem)  `[~]`
**Goal:** let a stranger use the product *instantly* (no install, no key, no signup) and keep it free.

This is not a UI problem; it's an economics problem. Every analysis is an LLM inference, and
inference costs money or compute. There is no architecture that is simultaneously (a) zero-setup
for the user, (b) zero-cost to run, (c) high quality, and (d) infinitely scalable. You pick three.
The whole "rate-limit whack-a-mole" we fought through Phases 3–4 is the symptom of pretending
otherwise.

### The three architectures

| Architecture | Who pays for inference | User setup | Quality ceiling | Scales to many users | Runs on phones | Key exposure risk |
|---|---|---|---|---|---|---|
| **BYOK** (current) | Each user (their key) | High (get a key) | High (any model) | Trivially (each user pays own way) | Yes | None (key in `chrome.storage`, server-side fetch) |
| **Hosted proxy** | The developer (one key) | None | High (any model) | Until the dev's quota/wallet runs out | Yes | **High if mishandled** — see below |
| **Browser-side** (WebLLM / WebGPU, or Chrome's built-in Gemini Nano) | Nobody — the user's own GPU | None (but a big first download) | Low–medium (only models that fit in browser VRAM) | Infinitely ($0 marginal cost) | Mostly no (WebGPU is desktop-grade) | None (no key exists) |

### Why you can't just ship a key in the client
The naïve "hosted, free, instant" idea is: put the dev's API key in the website's JavaScript.
**Never do this.** Client JS is world-readable — view-source, the Network tab, or a 10-line
scraper all expose it. Within hours a bot drains your quota or runs up a bill. CORS does **not**
protect you: CORS is a *browser* policy, and an attacker isn't using a browser — `curl` ignores it
entirely. The only safe "hosted" design is a **server-side proxy**: the key lives in a serverless
function (Cloudflare Workers / Vercel / Deno Deploy free tiers), the browser calls *your* endpoint,
and the function calls the LLM. Then you must add **abuse defenses** the BYOK model never needed:
per-IP rate limiting, an `Origin` allow-list, request-size caps, and ideally a Turnstile/hCaptcha
on burst traffic. The key never touches the wire to the client.

### The OpenRouter free-tier reality (why Phase 3 kept 429-ing)
OpenRouter's free models are not "unlimited free" — they're a shared charity pool with two
independent limits, and you were hitting both:
- **Per-minute:** ~20 requests/min across all free models, regardless of you.
- **Per-day:** historically ~50 requests/day if your account has purchased **< 10 credits
  lifetime**, rising to ~1000/day once you've ever topped up **$10** (you can still spend it on
  `:free` models — the credit just unlocks the higher ceiling). Subject to change without notice.
- **Endpoint saturation:** a popular `:free` model can 429 *everyone* when the upstream provider
  is slammed, independent of your personal quota. `openrouter/free` (the router) made this worse by
  fanning out to whichever free endpoint, so quality *and* availability swung per request.

The honest "make OpenRouter reliable" fixes are: (1) **pin one model** instead of the router so
behavior is consistent; (2) **per-URL cache** so re-opening an article costs zero requests; (3) the
real unlock is **$10 of credit once** — which violates "free is paramount," so it stays optional.

### Browser-side inference, in depth (the only *truly* free-forever path)
Two flavors, both shifting compute to the visitor's machine so the dev pays nothing, ever:
- **WebLLM / `@mlc-ai/web-llm`** — compiles quantized open models (Llama-3.2-3B, Qwen2.5-7B, Phi)
  to **WebGPU + WebAssembly** and runs them in the tab. Models are 4-bit quantized
  (`q4f16_1`): ~1.7–2.2 GB for a 3B, ~4–5 GB for a 7B. First visit downloads the weights once;
  the **Cache Storage API** persists them so later loads are instant and offline-capable. Needs
  WebGPU (Chrome/Edge/Brave on a desktop with a halfway-modern GPU) and roughly the model's size
  in free VRAM/RAM. **Effectively desktop-only** — mobile WebGPU exists but a 3B model on a phone
  is slow and thermally brutal.
- **Chrome Built-in AI / Prompt API (`LanguageModel`, Gemini Nano)** — a ~2–4 GB on-device model
  Chrome manages for you. Zero download code on your part, but: weak (Nano is ~1.8B-class, bad at
  the "is there a credible counter?" judgment that is this product's entire value), gated behind
  recent-Chrome + a component download, and not guaranteed exposed in Brave.

**The trade you're really making with browser-side:** you permanently delete the entire problem
class you hate — no keys, no quotas, no 429s, no bills, unlimited users — in exchange for a weaker
model, a heavy first load, and abandoning mobile/low-end visitors.

### A product wrinkle the framing hides: website ≠ extension
The current product is an **extension**, whose superpower is reading *the page you're already on*.
A **website** can't do that — browser same-origin rules forbid a site from reading another site's
DOM. So "go on the website and use it straight away" necessarily becomes **"paste a URL or paste
the article text."** And "paste a URL" needs a **server** to fetch it (CORS again blocks the
browser from fetching arbitrary cross-origin pages + their readable HTML). So:
- A **pure-static** site (incl. WebLLM) can only do **paste-text**.
- **Paste-a-URL** requires a backend to fetch + extract — which pairs naturally with the hosted-proxy
  model anyway.

### ⚠ Known weaknesses / open decisions (Phase 5)
- Hosted-proxy "free" has a hard daily ceiling (e.g. Gemini AI Studio free ≈ 1500 req/day, ~15/min,
  **shared across all visitors**). Fine to launch; a single abuser or a front-page spike exhausts it.
  Abuse protection is mandatory, not optional.
- Browser-side quality may be too low for the "say *nothing* when no credible counter exists"
  discipline — a weak model that invents disagreement is *worse* than no tool.
- Keeping the extension AND adding a website doubles the surface to maintain. Decide whether the
  website replaces or complements the extension.

### Phase 5 outcome: local inference abandoned  `[x]`
A WebLLM spike (offscreen-capable extension page, `vendor/web-llm.js`, `src/spike/`) ran the
real product prompt on a 4-bit 3B model on the user's GPU. **Result: quality far below the bar.**
On the Trump/antichrist article it produced a vague "counter" that *agreed* with the article and
emitted malformed sources. This is a **model-capacity limit, not a prompt bug**: "find the
strongest credible counter, or say nothing" needs 70B-class reasoning + world knowledge that a
2 GB model structurally lacks. Conclusion: the big model must run **off** the user's GPU → a
server holds the key. Local/WebLLM path is dead (files to delete listed in Phase 6).

---

## Phase 6 — Hybrid quality architecture (free proxy default + optional BYOK)  `[ ]`
**Goal:** restore the proven 70B-quality output (the OpenRouter screenshot) while keeping
one-click-on-page and free-to-the-user. Exactly one thing gives vs. the impossible four-way: a
server runs the big model, so the user needs no GPU and no key by default.

**Backend model:** **Llama 3.3 70B via Groq** — same family as the proven-good OpenRouter run, so
output behaves identically. Both routes use the same provider/model on purpose.

**Two routes, chosen in the service worker:**
- **BYOK:** user pasted their own Groq key in options → service worker calls Groq directly. No
  shared ceiling, no proxy hop.
- **Default (no key):** service worker calls the hosted proxy. Zero setup.
- Proxy says quota spent (429/503) → panel shows "free shared quota used up for today — add your
  own free key in options" + link. This is the pressure valve that makes the hybrid robust.

**Component A — serverless proxy (Cloudflare Worker, deploy once, free tier):**
- Accepts `POST {title, text, url}` — **not** raw messages.
- **Builds the prompt server-side** (its own copy of the system prompt + `buildMessages`) so the
  endpoint can't be used as a general-purpose LLM with your key.
- Calls Groq's OpenAI-compatible endpoint (`https://api.groq.com/openai/v1/chat/completions`),
  `GROQ_API_KEY` stored as a Worker **secret** (never in client JS).
- Returns the model's raw JSON content; the extension parses it.
- **Abuse defenses — low stakes (free tier: worst case is "unavailable today," never a bill):**
  request-size cap (reject text > ~12k chars), per-IP rate limit (Worker + KV/Durable Object
  counter), a global daily counter that fails gracefully before Groq's free ceiling, and an
  `Origin: chrome-extension://<id>` check as a speed bump (forgeable — not the main defense).

**Component B — extension changes:**
- Re-add a thin `src/lib/api-client.js` with two functions + the defensive `parsePerspective`
  (which was deleted with the old client — put it back here):
  - `callProxy({title,text,url})` → POST Worker URL → parse.
  - `callDirect({apiKey, payload})` → build messages via `prompt.js` → POST Groq → parse.
- `service-worker.js` `handleAnalyze`: read `apiKey` from storage; present → `callDirect`,
  else → `callProxy`. (Replaces the current "not yet wired" stub.)
- Re-add a **minimal options page**: one optional "Groq API key" field + note "leave blank to use
  the free shared service" + link to get a free Groq key. Restore `options_ui` in the manifest.

**Manifest changes (undo the local-path cleanup):**
- Remove: `"offscreen"` permission, the `'wasm-unsafe-eval'` CSP block, and the
  `huggingface.co` / `raw.githubusercontent.com` host permissions.
- Add `host_permissions`: the Worker URL (`https://<worker>.workers.dev/*`) and, for BYOK,
  `https://api.groq.com/*`.
- Restore `options_ui`. Keep `web_accessible_resources` (prompt.js still needed for BYOK).

**⚠ Sync caveat:** the system prompt now lives in **two** places — `src/lib/prompt.js` (BYOK,
in-extension) and the Worker (proxy). Keep them byte-identical by hand until there's a build step.

**Files to delete:** `vendor/web-llm.js`, `src/spike/spike.html`, `src/spike/spike.js`.

---

## Future / out of scope for v0.1
- Caching analyses per-URL to avoid re-spending tokens (also the cheapest OpenRouter-reliability win).
- Streaming the model response into the panel (and into a WebLLM build, where tokens trickle in).
- Per-site extraction overrides.
- Firefox MV3 port (background `scripts` vs `service_worker` differences).
- Server-side `Readability` (Mozilla's real one) once a backend exists — better extraction than the
  in-page scorer, and it can run on fetched HTML.
