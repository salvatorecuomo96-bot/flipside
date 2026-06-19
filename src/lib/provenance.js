// provenance.js — verifies that a model-cited quote actually appears in
// the source's evidence_text. Guards against hallucinated citations.
//
// Match strategy (in order):
//   1. Full contiguous token-span — all quote tokens appear in order, adjacent.
//   2. Ellipsis split — quote contains "…" or "..."; each part matches a span
//      in the evidence; total token gap between parts ≤ 40.
//
// Minimum thresholds (applied before any span search):
//   ≥ 8 tokens, ≥ 5 distinct tokens, ≥ 4 meaningful tokens, ≥ 35 chars.
// Quotes that don't meet these are too short to verify — fail with "too_short".

const STOPWORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","of","for",
  "with","by","is","are","was","were","be","been","it","this","that",
  "these","those",
]);

function normalizeForMatch(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenize(text) {
  return text.split(/\s+/)
    .map(t => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter(Boolean);
}

function isMeaningful(token) {
  return token.length > 1 && !STOPWORDS.has(token);
}

// Find the start index of `pattern` as a contiguous subsequence in `tokens`,
// starting search from `fromIndex`. Returns -1 if not found.
function findSpan(tokens, pattern, fromIndex = 0) {
  outer: for (let i = fromIndex; i <= tokens.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (tokens[i + j] !== pattern[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Check whether `quote` is genuinely present in `evidenceText`.
 *
 * @param {string} quote        The evidence_quote the model cited.
 * @param {string} evidenceText The full evidence_text for that source.
 * @returns {{ matched: boolean, reason?: string }}
 */
export function checkProvenance(quote, evidenceText) {
  const normQ = normalizeForMatch(quote);
  const normE = normalizeForMatch(evidenceText);
  const qToks = tokenize(normQ);
  const eToks = tokenize(normE);

  // Threshold checks
  const distinct   = new Set(qToks).size;
  const meaningful = qToks.filter(isMeaningful).length;
  if (qToks.length < 8 || distinct < 5 || meaningful < 4 || normQ.length < 35) {
    return { matched: false, reason: "too_short" };
  }

  // Strategy 1: full contiguous span
  if (findSpan(eToks, qToks) !== -1) return { matched: true };

  // Strategy 2: ellipsis split
  if (normQ.includes("…") || normQ.includes("...")) {
    const rawParts = normQ.split(/\.{3}|…/);
    const parts = rawParts.map(p => tokenize(p.trim())).filter(p => p.length > 0);
    if (parts.length >= 2) {
      let pos      = 0;
      let totalGap = 0;
      let allFound = true;

      for (const part of parts) {
        const start = findSpan(eToks, part, pos);
        if (start === -1) { allFound = false; break; }
        if (pos > 0) totalGap += start - pos;
        pos = start + part.length;
      }

      if (allFound && totalGap <= 40) return { matched: true };
    }
  }

  return { matched: false, reason: "no_span_found" };
}
