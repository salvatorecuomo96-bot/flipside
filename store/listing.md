# Flipside — Chrome Web Store listing

Copy/paste sources for the Web Store submission. Fill the Developer Dashboard fields from here.

---

## Name
Flipside

## Short description (max 132 chars)
One click shows the strongest credible counter-argument to any article — or stays silent when there honestly isn't one.

## Category
Productivity (alt: News & Weather)

## Language
English

---

## Detailed description

Most of what we read only argues one side. Flipside shows you the other one — when it's actually worth showing.

Click the Flipside button on any article and it surfaces the **single strongest credible counter-perspective** to the article's central claim, with the reasoning behind it and pointers to the kind of evidence that supports it. If the piece is a how-to, a listicle, a human-interest story, or straight news with no genuinely contestable thesis, Flipside tells you plainly that there's no credible counter — it is built to **stay silent rather than manufacture a fake disagreement**.

Flipside is not:
- a debate bot (it doesn't argue with you),
- a summarizer (it doesn't restate the article),
- a bias detector (it doesn't label the author).

It's an honesty tool for people who want to think clearly and escape one-sided framing.

**No setup.** It works the moment you install it — no account, no API key. Power users can optionally add their own free Groq key for a personal usage quota.

**Private by design.** Nothing is sent when you browse. Only when you click the button does the current article's text get sent to generate the analysis. No accounts, no tracking, no ads, no data sold. See the privacy policy for specifics.

**How to use:** open any article → click the Flipside icon → read the other side in the floating panel. Click again to close.

---

## Single purpose (required field)
Flipside has one purpose: when the user clicks its toolbar button on an article, it displays the single strongest credible counter-perspective to that article's main claim, or states clearly that no credible counter exists.

---

## Permission justifications (required at submission)

- **activeTab** — Reads the text of the article on the tab you are currently viewing, only at the moment you click the Flipside button. Flipside does not read tabs in the background.
- **storage** — Saves your optional personal Groq API key on your own device so you don't have to re-enter it. No other data is stored.
- **Host permission: the hosted proxy URL (`*.workers.dev`)** — The default backend. The extension sends the article title, URL, and text to Flipside's hosted proxy, which forwards it to the language-model service so the extension works with zero setup.
- **Host permission: `api.groq.com`** — Used only when you have added your own Groq key: the extension sends the article text directly to Groq to generate the counter-perspective.
- **Content script on http/https pages** — A small script runs on pages to extract the readable article text and render the floating result panel. It only performs analysis when you click the button.

---

## Privacy practices form (Data usage)

- **Does this item collect user data?** Yes.
- **Website content** — Collected. Used only to provide the single core feature (generating the counter-perspective). Sent to the analysis backend at the moment the user clicks the button. Not used for tracking. Not sold.
- **Personally identifiable information** — Not collected.
- **Health, financial, location, web history, personal communications** — Not collected.
- **Authentication information** — The optional Groq API key is stored locally on the user's device and is not collected or transmitted to the developer.
- **Sold to third parties?** No.
- **Used for purposes unrelated to the core function?** No.
- **Used to determine creditworthiness / lending?** No.

Privacy policy URL: <paste the public URL of store/PRIVACY.md once hosted — e.g. the raw GitHub link>

---

## Assets still needed before submitting
- [ ] At least 1 screenshot, 1280×800 or 640×400 (PNG/JPEG). Recommended: the panel open over a real article.
- [ ] 128×128 store icon (already have icons/icon-128.png — reuse it).
- [ ] Small promo tile 440×280 (optional but recommended).
- [ ] Privacy policy hosted at a public URL (host store/PRIVACY.md).
