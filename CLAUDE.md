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

**No consensus loops.** Maximum 1 external review round (Gemini or other AI) per architectural
decision. Once a design is confirmed externally, that decision is closed — do not re-confirm it.
If the user says "go" or "are you confident?", stop reviewing and build. Implementation of an
already-approved spec never needs external review. Build, don't loop.

**Always run syntax checks before saying done.** After any JS change:
```
node --check src/background/service-worker.js src/lib/sources.js src/lib/api-client.js src/lib/prompt.js src/content/main.js src/content/ui/panel.js worker/index.js
```
For logic changes also run a quick curl smoke-test against the live worker.

## Architecture (v0.2.9)

Two-call evidence-first pipeline — every result is grounded in real fetched abstracts.

```
article text
  ↓
Call 1 — classify (service worker → Worker proxy or BYOK)
  → {analyzable, article_type, core_claim, topic, secondary_topic, research_query, claim_strength, claim_type}
  → claim_type: empirical | normative | mixed.
      • normative (pure moral/theological): ranker penalizes empirical kinds (P_OFFDOMAIN) so
        reference/Wikipedia wins; synthesis outputs additional_context only (Notch 1).
      • mixed (value claim + falsifiable premise, e.g. "rent control is a right because it prevents
        poverty"): no penalty; synthesis returns result_type:"mixed" with TWO provenance-checked
        blocks — empirical_counter (academic/preprint/government/legal) + additional_context
        (reference only), rendered as two stacked panels (Notch 2). Source-kind FIREWALL in
        service-worker physically drops wrong-kind sources per block (prompt alone leaked); a block
        with no valid-kind source loses its summary. Classifier guardrail: a moral/theological claim
        ("is evil/antichrist") is normative unless the article states an explicit measurable premise.
  ↓
code: fetchSources(query, topic, url, secondary_topic) — parallel keyless API calls
  → fires the feed groups for BOTH topic and secondary_topic (shared feeds run once)
  → each source tagged {origin: primary|secondary, age_tag, age_tier} (precomputed client-side)
  → sources[], each with {evidence_text, usable} (usable = evidence_text ≥ 80 chars)
  ↓
code: rankSources() — weighted composite scorer (lexical coverage + TF saturation + title boost
      + source authority prior + log citation count − age penalty). Top-6 by score; hard-age
      sources (>15y) then physically partitioned to bottom of array regardless of score.
      age_tag rendered as its own line in prompt, never in evidence_text (provenance gate safe).
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
| `worker/index.js` | Cloudflare Worker — mirrors prompt.js byte-for-byte, KV cache v13 |
| `manifest.json` | Version tracking — always bump before CWS upload |
| `build-zip.ps1` | Builds Chrome + Firefox zips into dist/ |

## Evidence sources (src/lib/sources.js)

| Feed | Kind | Has real abstract? | When fired |
|---|---|---|---|
| OpenAlex (filter=has_abstract:true) | academic | Yes | Always |
| Europe PMC | academic | Yes | topic: health/medicine/science |
| arXiv | preprint | Yes | topic: science/physics/technology |
| Federal Register | government | Yes | topic: government/policy/environment |
| CourtListener | legal | Yes | topic: law/legal/court |
| ClinicalTrials.gov | academic | Yes | topic: health/medicine/science |
| World Bank Documents | government | Yes (qterm param, abstracts["cdata!"]) | topic: finance/economics/environment |
| EPA (via Federal Register) | government | Yes | topic: environment |
| NBER Working Papers | academic | Yes | topic: finance/economics |
| Wikipedia (summary extract API) | reference | Yes | Always |
| Google News RSS | news | No — further reading only | Always |
| GDELT | news | No — further reading only | Always |

`usable=true` sources (evidence_text ≥ 80 chars) go into the synthesis prompt. Everything else is "Further reading."

Topics recognised by classify: health · science · law · finance · government · policy · politics · technology · economics · environment

## Cloudflare Worker

- URL: `https://epistemic-companion-proxy.salvatoreducksamurai96.workers.dev`
- Deploy: `cd worker && npx wrangler deploy`
- First deploy on a new machine: `cd worker && npx wrangler login && npx wrangler deploy`
- Secrets (already set server-side, don't re-add unless rotating):
  `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `SAMBANOVA_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`
- KV cache version: `v13` — bump `CACHE_KEY_VERSION` in `worker/index.js` whenever a prompt changes
- Provider chain: Groq → Cerebras → SambaNova → Gemini → OpenRouter → Workers AI

## CWS version state

Last submitted to Chrome Web Store: **0.2.0** (was rejected — still counts).
Current manifest version: **0.2.9** (built, ready to submit — `dist/FlipSide-v0.2.9-chrome.zip`).
Next submission must be **≥ 0.2.9**.

Privacy policy live at: `https://epistemic-companion-proxy.salvatoreducksamurai96.workers.dev/privacy`
Contact email: `flipsideextension@gmail.com` (personal email fully removed from codebase)
Store listing copy + permission justifications: `store/listing.md` (updated — preanalyze behavior now accurately described)

Dropped feeds (no viable keyless API as of 2026-06): SEC EDGAR (full-text search returns
no text snippet, only metadata), CRS / everycrsreport.com (no JSON API — 404; congress.gov
and govinfo require keys), UK Parliament Bills (longTitle needs N+1 per-bill fetch; slow/flaky).
Finance/economics gap recovered via NBER working papers (verified real abstracts).
legislation.gov.uk (UK law) verified to return usable Atom <summary> text — NOT yet wired in,
candidate for the UK gap when wanted.

Rule: version must be strictly increasing. Even a rejected upload locks that number.
Before every CWS upload: bump `manifest.json` version → `./build-zip.ps1` → upload `dist/FlipSide-vX.Y.Z-chrome.zip`.

## What was built in the 2026-06-19 session (pick up from here)

**Bugs fixed:**
- Local classification cache was broken — `getClassification()` read the store but never checked if the key existed, so it always re-classified. Fixed.
- Local result cache was broken — `saveAndReturn()` was a stub that discarded the result. Now writes to both content-hash cache and URL cache. Only non-"none" results are cached (so a bad first run doesn't stick and the user can retry).
- Cloudflare Worker KV cache re-enabled in hot path — first user to analyze a URL computes the result, everyone else gets the same cached response (cross-user consistency). Only non-"none" results cached. 6h TTL.

**Features added:**
- Thumbs 👍/👎 feedback at the bottom of every result panel. Rating stored locally (`feedbackCache` in chrome.storage.local) and POSTed to the worker as `stage=feedback`. Worker stores `{up:N, down:N}` per URL-hash in KV (90-day TTL). Useful for finding bad counters post-launch.
- Privacy policy page served directly from the worker at `/privacy`. No external hosting needed.
- Worker feedback endpoint: `stage=feedback` with `{url, rating}` body. Runs before text validation (no article text needed).

**Cleanup done:**
- Stale dist zips (0.2.7, 0.2.8) deleted — only 0.2.9 remains in `dist/`
- Personal email `salvatore.cuomo96@gmail.com` replaced with `flipsideextension@gmail.com` everywhere
- `store/listing.md` privacy URL updated to the live worker page
- `store/listing.md` permission descriptions corrected — previously falsely stated "only activates on click / does not run in background"; now accurately describes the preanalyze background call

**Next session — Tier 1 improvements (approved by user, not yet built):**
1. **Articulate silence** — when result_type is "none", explain *why* using signals already in `cls`: "Straight reporting — no contestable thesis", "Found research but none addresses this claim directly", etc. Mostly a prompt + panel change. High priority, very on-brand.
2. **Feedback reason chips** — after a 👎, show 4 chips: "Not relevant · Factually wrong · Still one-sided · Sources weak". Extend the `stage=feedback` payload with `reason`. Small extension of what exists.
3. **Social proof** — surface aggregate helpfulness % (e.g. "84% found this helpful, n=37") from KV vote tallies. Needs a small read endpoint on the worker. Hide below n<10 floor.

## Build

```powershell
./build-zip.ps1   # reads version from manifest.json, writes dist/FlipSide-vX.Y.Z-{chrome,firefox}.zip
```

No npm install or bundler needed. The extension uses native ES modules — load unpacked directly.

## Loading the extension in Chrome

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this repo root.
After any JS change: click the reload icon on the extension card, then reload the tab.
