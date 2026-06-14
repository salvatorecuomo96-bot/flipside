# FlipSide

A Chrome extension (Manifest V3) that acts as a **skeptical mirror** for the page you're reading.
Click the toolbar button and FlipSide surfaces the single strongest *credible* counter-perspective
to the article's central thesis — or tells you plainly when none exists. It is **not** a debate bot,
a summarizer, or a bias detector, and it is designed to **stay silent** when an article has no
genuinely contestable claim (how-tos, listicles, human-interest, straight news).

## Zero setup

There is nothing to configure. The extension sends your article to a hosted proxy that tries a
chain of AI providers and returns the analysis. Open an article, click the icon, read the other side.

Power users can optionally paste their own free [Groq](https://console.groq.com) key in **Options**
to use a personal quota instead of the shared one.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open any article and click the FlipSide toolbar icon. A floating panel appears top-right.
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
| Proxy | `worker/index.js` | Cloudflare Worker: multi-provider fallback chain, rate limiting, 6h result cache. |

### Backend

**Default (no key):** the service worker POSTs `{title, text, url}` to the hosted Cloudflare Worker.
The Worker builds the prompt server-side and tries providers in order, falling through on rate limits
or quota exhaustion:

> Groq → Cerebras → SambaNova → Gemini → OpenRouter → Cloudflare Workers AI

All provider keys are stored as Worker secrets — never in client code, never sent to the browser.
Results are cached for 6 hours by article hash, so repeat requests on the same article are instant.

**BYOK:** if you've saved a Groq key in Options, the service worker calls Groq directly with your
key. Your key lives only in `chrome.storage.local`.

The proxy has abuse protection: a per-request size cap, a per-IP rate limit, and a
`chrome-extension://` origin check.

## Privacy

Nothing is sent on page load. **Only when you click the button**, the article's title, URL, and
extracted text are sent to the analysis service solely to generate the counter-perspective.

- **Default path:** article data goes to the hosted proxy, which forwards it to whichever provider
  in the fallback chain responds — currently Groq, Cerebras, SambaNova, Google Gemini, OpenRouter,
  or Cloudflare Workers AI. The full list and each provider's privacy policy is in
  [`store/PRIVACY.md`](store/PRIVACY.md).
- **BYOK:** article data goes directly to Groq using your key; it never touches the hosted proxy.

No account is required, no personal data is collected. An optional Groq key, if you add one, is
stored locally in `chrome.storage.local` and sent only to Groq.

## Honest caveats

- **Recall, not live web search.** The model draws counter-perspectives from its training knowledge,
  not a live search. It is instructed never to fabricate citations; when unsure it describes the
  *type* of evidence that would support the counter. Treat those as pointers to verify, not proof.
- **The extractor is a lightweight scorer**, not Mozilla Readability. It can miss on unusual layouts.
- **Shared free quota.** The default proxy shares free-tier quotas across all providers and all
  users. If all providers are exhausted simultaneously, add your own free Groq key in Options.

See [`roadmap.md`](roadmap.md) for the design rationale, including why local in-browser inference
was tried and abandoned.
