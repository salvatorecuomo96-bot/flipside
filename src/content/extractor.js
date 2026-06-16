// extractor.js — pull the "main content" out of an arbitrary page.
//
// Two-strategy approach:
//   1. Collect all <p> tags from semantic containers (article, main). Works on
//      the vast majority of news and editorial sites — they consistently put
//      body text in <p> inside <article>. Fast and robust.
//   2. Scoring fallback: rank block containers by text length, paragraph count,
//      and link density, then take the winner. Handles sites that don't use <p>
//      well (some use <div> for paragraphs, or lack semantic structure).

const SKIP_TAGS = new Set(["NAV", "ASIDE", "FOOTER", "HEADER", "SCRIPT", "STYLE", "FIGURE", "FIGCAPTION", "FORM"]);
const CONTAINER_TAGS = new Set(["ARTICLE", "MAIN", "SECTION", "DIV"]);
const POSITIVE_HINT = /(article|content|post|story|entry|main|body|text)/i;
const NEGATIVE_HINT = /(comment|sidebar|footer|header|nav|menu|promo|share|social|related|recommend|ad-|advert|cookie|banner)/i;
const MAX_TEXT_CHARS = 12000;

/**
 * @param {Document} doc
 * @returns {{ title: string, text: string }}
 */
export function extractMainContent(doc) {
  const title = extractTitle(doc);

  // Strategy 1: collect <p> tags from semantic containers.
  // Ordered by specificity: named article containers first, then main.
  const semanticCandidates = [
    ...Array.from(doc.querySelectorAll("article, [role='article']")),
    doc.querySelector("main, [role='main']"),
  ].filter(Boolean);

  for (const container of semanticCandidates) {
    const text = collectParagraphText(container);
    if (text.length >= 200) return { title, text };
  }

  // Strategy 2: scoring fallback for sites without good semantic structure.
  const root = doc.body || doc.documentElement;
  if (!root) return { title, text: "" };

  const scope = doc.querySelector("article, main, [role='main']") || root;
  let best = scope;
  let bestScore = scoreNode(scope);

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
  // Require a minimum score so nav-heavy homepages don't pass as articles.
  if (bestScore < 20 || text.length < 200) return { title, text: "" };
  return { title, text };
}

// Collect text from <p> tags inside a container, skipping nav/aside/footer etc.
function collectParagraphText(container) {
  const parts = [];
  for (const p of container.querySelectorAll("p")) {
    if (isInsideSkipped(p, container)) continue;
    const t = (p.innerText || p.textContent || "").trim();
    if (t.length > 20) parts.push(t);
  }
  return normalizeText(parts.join("\n\n"));
}

// Walk up from el to root; return true if any ancestor is in SKIP_TAGS.
function isInsideSkipped(el, root) {
  let node = el.parentElement;
  while (node && node !== root) {
    if (SKIP_TAGS.has(node.tagName)) return true;
    node = node.parentElement;
  }
  return false;
}

function scoreNode(el) {
  const text = el.innerText || el.textContent || "";
  const len = text.length;
  if (len < 140) return -Infinity;

  const paragraphs = el.querySelectorAll("p").length;
  const linkTextLen = Array.from(el.querySelectorAll("a")).reduce(
    (sum, a) => sum + (a.textContent?.length || 0),
    0
  );
  const linkDensity = len > 0 ? linkTextLen / len : 1;

  let score = 0;
  score += Math.min(len / 100, 60);
  score += paragraphs * 3;
  score -= linkDensity * 45;

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
