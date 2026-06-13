# Epistemic Companion

A Chrome extension (Manifest V3) that acts as a **skeptical mirror** for the page you're reading.
Click the toolbar button and it surfaces the single strongest *credible* counter-perspective to the
article's core claims — or tells you plainly when none exists. It is not a debate bot, a summarizer,
or a bias detector.

## Install (unpacked)
1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Click the extension's icon → **Options** (or right-click → Options) and paste your
   [OpenRouter](https://openrouter.ai/keys) API key. Optionally set a model id and the web-search toggle.

## Use
Open any article, click the toolbar button. A floating panel appears (top-right) and runs the analysis.
Click again to close it.

## How it works
| Layer | File | Role |
|---|---|---|
| Background | `src/background/service-worker.js` | Handles the toolbar click; performs all network calls. |
| Content shim | `src/content/loader.js` | The only manifest-declared script; dynamically imports the module entry. |
| Orchestrator | `src/content/main.js` | Extracts content, observes SPA changes, drives the panel. |
| Extractor | `src/content/extractor.js` | Readability-style scoring to find the article body. |
| UI | `src/content/ui/panel.js` | Shadow-DOM floating panel (style-isolated). |
| API | `src/lib/api-client.js` | OpenRouter client with retry/backoff/timeout. |
| Prompt | `src/lib/prompt.js` | The "truth filter" system prompt + JSON contract. |
| Options | `src/options/*` | BYOK key, model id, web-search toggle. |

See [`roadmap.md`](roadmap.md) for the phase-by-phase design rationale and the known weaknesses of
each layer.

## Honest caveats
- **Without the web-search toggle, this is recall, not discovery.** A plain chat completion draws
  counter-perspectives from the model's training data. Enable `:online` (Options) for live search.
- The extractor is a lightweight scorer, not Mozilla Readability. It will miss on unusual layouts.
  Upgrade path: vendor `@mozilla/readability`.
- The model is instructed never to fabricate citations; when unsure it describes the *type* of
  evidence instead. Treat "Type of evidence" entries as pointers to verify, not proof.

## Privacy
Your API key lives in `chrome.storage.local` and is sent only to OpenRouter. Article text is sent to
OpenRouter solely when you click the button. Nothing is sent on page load.
