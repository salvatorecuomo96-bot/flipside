# Flipside — Privacy Policy

**Effective date:** 13 June 2026

Flipside is a browser extension that shows the strongest credible counter-perspective to an article
you are reading. This policy explains exactly what data the extension handles.

## What is sent, and when

Flipside sends **nothing** when you open or browse a page. Data leaves your browser **only when you
click the Flipside toolbar button** on an article. At that moment, the extension sends:

- the article's **title**,
- the page **URL**, and
- the extracted article **text**

to the analysis service, solely to generate the counter-perspective shown in the panel.

## Where it goes

- **By default (no setup):** the data is sent to Flipside's hosted proxy (a Cloudflare Worker), which
  forwards it to **Groq** (https://groq.com), the service that runs the language model. The proxy does
  not store the article content; it passes it through to generate the response and returns the result.
- **If you add your own Groq API key** (optional, in the extension's Options): the data is sent
  **directly to Groq** using your key, and does not pass through Flipside's proxy.

Groq processes the text to produce the model's response. Please refer to Groq's own privacy policy for
how they handle data in transit.

## What is stored

- Flipside does **not** require an account and does **not** collect names, emails, or any personal
  identifiers.
- The only thing Flipside can store is an **optional Groq API key** that you choose to enter. It is
  saved locally on your device using the browser's `chrome.storage.local` and is sent only to Groq.
  It is never transmitted to Flipside's proxy or to anyone else. You can remove it at any time with
  the **Clear key** button in Options.

## What is NOT done

- No analytics, telemetry, or usage tracking.
- No advertising, and no sale or sharing of your data with third parties for marketing.
- No browsing history collection. Flipside only ever sees the content of a page at the moment you
  explicitly click its button on that page.

## Data retention

Article content is used transiently to generate a single response and is not retained by Flipside.
Flipside operates no database of user content.

## Changes

If this policy changes, the updated version will be posted at this URL with a new effective date.

## Contact

Questions about privacy: **salvatore.cuomo96@gmail.com**
