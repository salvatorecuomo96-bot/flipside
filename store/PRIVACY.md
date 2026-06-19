# FlipSide — Privacy Policy

**Effective date:** 15 June 2026

FlipSide is a browser extension that shows the strongest credible counter-perspective to an article you are reading. This policy explains exactly what data the extension handles.

## What is sent, and when

Data leaves your browser in two situations:

**1. Automatic badge (on article pages):** When you open a page that contains a readable article, FlipSide silently analyzes it in the background and sets a colored badge on the toolbar icon — green if a counter-argument exists, red if not. The extension sends:

- the article's **title**,
- the page **URL**, and
- the extracted article **text** (capped at 12,000 characters)

to the analysis service. This happens automatically on article pages. Non-article pages (homepages, search results, social feeds, etc.) are not analyzed. If you have added your own API key, you can disable this in the extension's Options.

**2. Viewing the panel:** Clicking the FlipSide toolbar button opens the result panel. If the article was already analyzed (badge is showing), no additional data is sent — the result is served from local cache. If not yet analyzed, the same data as above is sent at that moment.

## Where it goes

- **By default (no setup):** the data is sent to FlipSide's hosted proxy (a Cloudflare Worker). The proxy forwards the request to one of several AI language-model providers — currently **Groq** (groq.com), **Cerebras** (cerebras.ai), **SambaNova** (sambanova.ai), **Google Gemini** (ai.google.dev), **OpenRouter** (openrouter.ai), or **Cloudflare Workers AI** (cloudflare.com). The proxy tries providers in order and uses whichever responds first. The proxy does **not** store or log article content; it passes it through to generate the response and returns the result.

  To reduce repeated API calls for the same article, a **hash of the URL and article text** (not the content itself) may be used as a cache key, and the model's *output* (the generated counter-perspective) may be cached for up to 6 hours in Cloudflare KV storage. The original article text is never stored — only the response.

- **If you add your own Groq API key** (optional, in the extension's Options): the data is sent **directly to Groq** using your key, and does not pass through FlipSide's proxy or any other provider.

Each third-party provider processes the text to produce a model response. Please refer to their own privacy policies for how they handle data in transit:
- Groq: https://groq.com/privacy-policy
- Cerebras: https://cerebras.ai/privacy-policy
- SambaNova: https://sambanova.ai/privacy-policy
- Google (Gemini): https://policies.google.com/privacy
- OpenRouter: https://openrouter.ai/privacy
- Cloudflare: https://www.cloudflare.com/privacypolicy

## What is stored

- FlipSide does **not** require an account and does **not** collect names, emails, or any personal identifiers.
- The only thing FlipSide stores on your device is an **optional Groq API key** that you choose to enter. It is saved locally using the browser's `chrome.storage.local` and is sent only to Groq. It is never transmitted to FlipSide's proxy or to any other party. You can remove it at any time with the **Clear key** button in Options.

## What is NOT done

- No analytics, telemetry, or usage tracking.
- No advertising, and no sale or sharing of your data with third parties for marketing.
- No browsing history collection. FlipSide only processes readable article pages — never homepages, search pages, or non-article content.

## Data retention

Article content is used transiently to generate a single response and is not retained by FlipSide. The model's *output* may be cached for up to 6 hours (keyed on a hash of the URL and text) to avoid re-spending provider quota on the same article. FlipSide operates no database of user content.

## Changes

If this policy changes, the updated version will be posted at this URL with a new effective date.

## Contact

Questions about privacy: **flipsideextension@gmail.com**
