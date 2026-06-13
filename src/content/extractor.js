// extractor.js — pull the "main content" out of an arbitrary page.
//
// Design stance: class names and ids are the single most volatile part of a
// web page. A selector like `.article-body__text--v2` is dead the day the site
// redeploys. So instead of *matching*, we *score*. We rank candidate block
// elements by signals that correlate with "this is the article" — text length,
// paragraph count, and (inversely) link density — and pick the winner.
//
// This is a lightweight reimplementation of the core idea behind Mozilla's
// Readability. For production you would vendor `@mozilla/readability`; this
// version is dependency-free and good enough to demonstrate the principle.

const CONTAINER_TAGS = new Set(["ARTICLE", "MAIN", "SECTION", "DIV"]);
const POSITIVE_HINT = /(article|content|post|story|entry|main|body|text)/i;
const NEGATIVE_HINT = /(comment|sidebar|footer|header|nav|menu|promo|share|social|related|recommend|ad-|advert|cookie|banner)/i;
const MAX_TEXT_CHARS = 12000; // cap to control token cost downstream

/**
 * @param {Document} doc
 * @returns {{ title: string, text: string }}
 */
export function extractMainContent(doc) {
  const root = doc.body || doc.documentElement;
  if (!root) return { title: extractTitle(doc), text: "" };

  // Prefer an explicit semantic container as the *search scope*, but still
  // score inside it — a site may wrap teasers in <article> too.
  const scope = doc.querySelector("article, main, [role='main']") || root;

  let best = scope;
  let bestScore = scoreNode(scope);

  // Walk only block-level containers; text nodes and inline elements are noise
  // for "which container is the article" question.
  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) =>
      CONTAINER_TAGS.has(node.tagName)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP,
  });

  let node;
  while ((node = walker.nextNode())) {
    const score = scoreNode(node);
    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  }

  const text = normalizeText(best.innerText || best.textContent || "");
  return { title: extractTitle(doc), text };
}

function scoreNode(el) {
  const text = el.innerText || el.textContent || "";
  const len = text.length;
  if (len < 140) return -Infinity; // too short to be an article body

  const paragraphs = el.querySelectorAll("p").length;
  const linkTextLen = Array.from(el.querySelectorAll("a")).reduce(
    (sum, a) => sum + (a.textContent?.length || 0),
    0
  );
  const linkDensity = len > 0 ? linkTextLen / len : 1;

  let score = 0;
  score += Math.min(len / 100, 60); // raw length, capped so a giant <body> can't auto-win
  score += paragraphs * 3; // real articles are paragraph-dense
  score -= linkDensity * 45; // link-dense blocks are navigation/aggregation, not prose

  const idClass = `${el.id} ${el.className}`;
  if (POSITIVE_HINT.test(idClass)) score += 25;
  if (NEGATIVE_HINT.test(idClass)) score -= 25;
  if (el.tagName === "ARTICLE") score += 30;
  if (el.tagName === "MAIN") score += 20;

  return score;
}

function extractTitle(doc) {
  const og = doc.querySelector("meta[property='og:title']")?.getAttribute("content");
  if (og?.trim()) return og.trim();
  const h1 = doc.querySelector("h1")?.textContent;
  if (h1?.trim()) return h1.trim();
  return (doc.title || "").trim();
}

function normalizeText(raw) {
  return raw
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}
