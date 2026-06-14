# FlipSide — Chrome Web Store listing

Copy/paste sources for the Web Store submission. Fill the Developer Dashboard fields from here.

---

## Name
FlipSide

## Short description (max 132 chars)
One click shows the strongest credible counter-argument to any article — or stays silent when there honestly isn't one.

## Category
Productivity (alt: News & Weather)

## Language
English

---

## Detailed description

Most of what we read only argues one side. FlipSide shows you the other one — when it's actually worth showing.

Click the FlipSide button on any article and it surfaces the **single strongest credible counter-perspective** to the article's central claim, with the reasoning behind it and pointers to the kind of evidence that supports it. If the piece is a how-to, a listicle, a human-interest story, or straight news with no genuinely contestable thesis, FlipSide tells you plainly that there's no credible counter — it is built to **stay silent rather than manufacture a fake disagreement**.

FlipSide is not:
- a debate bot (it doesn't argue with you),
- a summarizer (it doesn't restate the article),
- a bias detector (it doesn't label the author).

It's an honesty tool for people who want to think clearly and escape one-sided framing.

**No setup.** It works the moment you install it — no account, no API key needed. Power users can optionally add their own free Groq key for a dedicated personal quota.

**Private by design.** Nothing is sent when you browse. **Only when you explicitly click the FlipSide button** does the current article's text get sent for analysis. No accounts, no tracking, no ads, no data sold. See the privacy policy for full details including the list of AI providers.

**How to use:** open any article → click the FlipSide icon → read the other side in the floating panel. Click again to close.

---

## Single purpose (required field)
FlipSide has one purpose: when the user clicks its toolbar button on an article, it displays the single strongest credible counter-perspective to that article's main claim, or states clearly that no credible counter exists.

---

## Permission justifications (required at submission)

- **activeTab** — Reads the text of the article on the tab you are currently viewing, only at the moment you click the FlipSide button. FlipSide does not read tabs in the background and does not run continuously.
- **storage** — Saves your optional personal Groq API key on your own device. No browsing data or article content is ever stored by FlipSide.
- **Host permission: the hosted proxy URL (`*.workers.dev`)** — The default backend. When you click the button, the extension sends the article title, URL, and extracted text to FlipSide's hosted Cloudflare Worker proxy, which forwards it to an AI language-model provider (Groq, Cerebras, SambaNova, Google Gemini, OpenRouter, or Cloudflare Workers AI) to generate the counter-perspective. The provider is chosen automatically based on availability.
- **Host permission: `api.groq.com`** — Used only when you have added your own Groq key in Options: the extension sends the article text directly to Groq, bypassing the proxy entirely.
- **Content script on http/https pages** — A small script runs on pages to extract the readable article text and render the floating result panel. It only activates when you click the button — it does not observe your browsing or collect data passively.

---

## Privacy practices form (Data usage)

- **Does this item collect user data?** Yes.
- **Website content** — The article title, URL, and extracted text of the page you are currently viewing are sent to an AI provider when you click the FlipSide button. This data is used solely to generate the counter-perspective. It is not used for tracking, advertising, or profiling. It is not sold.
- **Personally identifiable information** — Not collected.
- **Health, financial, location, web history, personal communications** — Not collected.
- **Authentication information** — The optional Groq API key is stored locally on the user's device only. It is never transmitted to FlipSide's proxy or to the developer.
- **Sold to third parties?** No.
- **Used for purposes unrelated to the core function?** No.
- **Used to determine creditworthiness / lending?** No.

Privacy policy URL: https://raw.githubusercontent.com/salvatorecuomo96-bot/flipside/main/store/PRIVACY.md

---

## Assets still needed before submitting
- [ ] At least 1 screenshot, 1280×800 or 640×400 (PNG/JPEG). Recommended: the panel open over a real article.
- [ ] Small promo tile 440×280 (optional but recommended).
- [x] Repo is public at https://github.com/salvatorecuomo96-bot/flipside — privacy policy URL is live.
