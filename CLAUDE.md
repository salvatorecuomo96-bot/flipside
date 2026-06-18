# FlipSide — Claude Code context

Chrome MV3 extension that surfaces the strongest credible counter-perspective to news articles.
Free for users (no API key required). A Cloudflare Worker proxy supplies model calls from a
rotating provider chain.

## How to work with me (mandatory — read before every session)

**Always state the model recommendation before starting any task:**
- Sonnet — routine coding, simple edits, build scripts, well-defined single-file tasks
- Opus — architecture decisions, multi-file design tradeoffs, prompt engineering, subtle debugging
Include one sentence of reasoning, e.g. "Sonnet — mechanical edit to one file."

**Always ask before building.** When the user asks "can we do X?" respond with options and
tradeoffs and wait for confirmation. A question is not permission. Coding before confirming
is explicitly unwanted.

**Always run syntax checks before saying done.** After any JS change:
```
node --check src/background/service-worker.js src/lib/sources.js src/lib/api-client.js src/lib/prompt.js src/content/main.js src/content/ui/panel.js worker/index.js
```
For logic changes also run a quick curl smoke-test against the live worker.

## Architecture (v0.2.7)

Two-call evidence-first pipeline — every result is grounded in real fetched abstracts.

```
article text
  ↓
Call 1 — classify (service worker → Worker proxy or BYOK)
  → {analyzable, article_type, core_claim, topic, research_query, claim_strength}
  ↓
code: fetchSources() — parallel keyless API calls
  → sources[], each with {evidence_text, usable} (usable = evidence_text ≥ 80 chars)
  ↓
Call 2 — synthesize (evidence passed in prompt)
  → {result_type, headline, summary, core_claims, confidence, used_sources[{id, evidence_quote}]}
  ↓
code: provenance gate — drop any used_source whose evidence_quote isn't in its evidence_text
  ↓
badge: green (counter) / blue (context) / gray (classify-only, pre-click) / none
```

**Badge states:**
- Gray dot → classify fired during page load, `analyzable=true` and `claim_strength ≥ 0.4`. Pre-click only, no synthesis.
- Green dot → `result_type=counter_perspective`, `confidence ≥ 0.7`
- Blue dot → `result_type=additional_context`, `confidence ≥ 0.7`
- No dot → `none`, or below confidence threshold

## Key files

| File | Role |
|---|---|
| `src/lib/sources.js` | Evidence layer — fetches real abstracts from keyless APIs |
| `src/lib/prompt.js` | CLASSIFY_PROMPT + SYNTHESIS_PROMPT, buildClassifyMessages, buildSynthMessages |
| `src/lib/api-client.js` | classify() and synthesize() — two non-streaming calls, proxy or BYOK |
| `src/background/service-worker.js` | Orchestration, provenance gate, badge, caching |
| `src/content/ui/panel.js` | Shadow DOM panel rendering |
| `worker/index.js` | Cloudflare Worker — mirrors prompt.js byte-for-byte, KV cache v5 |
| `manifest.json` | Version tracking — always bump before CWS upload |
| `build-zip.ps1` | Builds Chrome + Firefox zips into dist/ |

## Evidence sources (src/lib/sources.js)

| Feed | Kind | Has real abstract? | When fired |
|---|---|---|---|
| OpenAlex (filter=has_abstract:true) | academic | Yes | Always |
| Europe PMC | academic | Yes | topic: health/medicine/science |
| arXiv | preprint | Yes | topic: science/physics/technology |
| Federal Register | government | Yes | topic: government/policy (NOT politics) |
| CourtListener | legal | Yes | topic: law/legal/court |
| Wikipedia (summary extract API) | reference | Yes | Always |
| Google News RSS | news | No — further reading only | Always |
| GDELT | news | No — further reading only | Always |

`usable=true` sources go into the synthesis prompt. Everything else is "Further reading."

## Cloudflare Worker

- URL: `https://epistemic-companion-proxy.salvatoreducksamurai96.workers.dev`
- Deploy: `cd worker && npx wrangler deploy`
- First deploy on a new machine: `cd worker && npx wrangler login && npx wrangler deploy`
- Secrets (already set server-side, don't re-add unless rotating):
  `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `SAMBANOVA_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`
- KV cache version: `v5` — bump `CACHE_KEY_VERSION` in `worker/index.js` whenever a prompt changes
- Provider chain: Groq → Cerebras → SambaNova → Gemini → OpenRouter → Workers AI

## CWS version state

Last submitted to Chrome Web Store: **0.2.0** (was rejected — still counts).
Current manifest version: **0.2.7** (not yet submitted).
Next submission must be **≥ 0.2.8**.

Rule: version must be strictly increasing. Even a rejected upload locks that number.
Before every CWS upload: bump `manifest.json` version → `./build-zip.ps1` → upload `dist/FlipSide-vX.Y.Z-chrome.zip`.

## Build

```powershell
./build-zip.ps1   # reads version from manifest.json, writes dist/FlipSide-vX.Y.Z-{chrome,firefox}.zip
```

No npm install or bundler needed. The extension uses native ES modules — load unpacked directly.

## Loading the extension in Chrome

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this repo root.
After any JS change: click the reload icon on the extension card, then reload the tab.
