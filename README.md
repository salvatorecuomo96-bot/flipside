# FlipSide

A Chrome extension (Manifest V3) that acts as a **skeptical mirror** for the page you're reading.
Click the toolbar button and FlipSide surfaces the single strongest *credible* counter-perspective
to the article's central thesis — or tells you plainly when none exists. It is **not** a debate bot,
a summarizer, or a bias detector, and it is designed to **stay silent** when an article has no
genuinely contestable claim (how-tos, listicles, human-interest, straight news).

## Zero setup

By default there is nothing to configure — no account, no API key. The extension talks to a small
hosted proxy that runs a 70B-class model and returns the analysis. Open an article, click the icon,
read the other side.

Power users can optionally paste their own free [Groq](https://console.groq.com) key in **Options**
to use their own personal quota instead of the shared one.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open any article and click the FlipSide toolbar icon. A floating panel appears (top-right).
   Click the icon again to close it.

## How it works

| Layer | File | Role |
|---|---|---|
| Background | `src/background/service-worker.js` | Handles the toolbar click; routes analysis (BYOK → Groq directly, else → hosted proxy). |
| Content shim | `src/content/loader.js` | The only manifest-declared script; dynamically imports the module entry. |
| Orchestrator | `src/content/main.js` | Extracts content, observes SPA changes, drives the panel. |
| Extractor | `src/content/extractor.js` | Readability-style scoring to find the article body. |
| UI | `src/content/ui/panel.js` | Shadow-DOM floating panel (style-isolated, auto light/dark). |
| API client | `src/lib/api-client.js` | `callProxy` (default) + `callDirect` (BYOK) + defensive JSON parsing. |
| Prompt | `src/lib/prompt.js` | The "skeptical mirror" system prompt + strict JSON contract. |
| Options | `src/options/*` | Optional personal Groq key. |
| Proxy | `worker/index.js` | Cloudflare Worker: holds the Groq key as a **secret**, builds the prompt server-side, calls Groq. |

### Backend

Both routes use the **same** provider and model on purpose, so output behaves identically:
**Llama 3.3 70B via [Groq](https://groq.com)**.

- **Default (no key):** the service worker POSTs `{title, text, url}` to the Cloudflare Worker. The
  Worker holds `GROQ_API_KEY` as a Worker secret (never in client code, never on the wire to the
  browser), builds the prompt itself, calls Groq, and returns the model's JSON.
- **BYOK:** if you've saved a Groq key in Options, the service worker calls Groq directly with your
  key. Your key lives only in `chrome.storage.local`.

The proxy has basic abuse protection: a request-size cap, a per-IP rate limit, and a
`chrome-extension://` origin check. If the shared free quota is exhausted for the day, the panel
tells you to add your own free key.

## Privacy

Nothing is sent on page load. **Only when you click the button**, the article's title, URL, and
extracted text are sent — to the hosted proxy (default) or directly to Groq (BYOK) — solely to
generate the counter-perspective. No account is required and no personal data is collected. An
optional Groq key, if you add one, is stored locally in `chrome.storage.local` and sent only to Groq.

## Honest caveats

- **Recall, not live web search.** The model draws counter-perspectives from its training knowledge,
  not a live search. It is instructed never to fabricate citations; when unsure it describes the
  *type* of evidence to look for. Treat those as pointers to verify, not proof.
- **The extractor is a lightweight scorer**, not Mozilla Readability. It can miss on unusual layouts.
- **Shared free quota.** The default proxy shares one daily Groq quota across all users. If it runs
  out, add your own free key (Options) — that path has its own personal quota.

See [`roadmap.md`](roadmap.md) for the phase-by-phase design rationale, including why local in-browser
inference was tried and abandoned (a 3B on-device model couldn't hold the "say nothing when there's
no credible counter" discipline that is the entire point of the tool).
