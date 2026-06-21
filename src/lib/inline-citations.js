// inline-citations.js — rewrite the synthesis model's inline citation markers in
// a summary into [N] display indices that match the final, post-provenance source
// order shown in the panel. Pure module (no chrome/DOM deps) so it can be unit-
// tested in Node directly.
//
// The model is shown each source as "[TOKEN] (kind, year) Title" and instructed
// to append that bracketed token after the sentence it supports. After the
// provenance gate filters used_sources down to `shown`, the surviving sources are
// renumbered 1..N in display order. This maps each inline token to its display
// number so the panel can render a clickable superscript.
//
// Robustness rules:
//   • A token that resolves to a shown source → its [N] display index.
//   • A bracket whose atoms ALL look like citation tokens/ids but none resolve
//     (e.g. the source was dropped by provenance) → removed entirely.
//   • Any other bracket (legitimate prose like "[sic]" or "[the plan]") → left
//     untouched. We never mangle real text.

const TOKEN_LIKE = /^[A-Za-z0-9_]{6,}$/; // Base32 citation tokens are 10–12 chars
const INTERNAL_ID = /^s\d+$/i;            // legacy sequential ids: s1, s2, …

export function applyInlineCitations(summary, shown) {
  if (typeof summary !== "string" || !summary) return summary || "";
  const list = Array.isArray(shown) ? shown : [];

  const indexOf = new Map();
  list.forEach((s, i) => {
    if (s?.id) indexOf.set(String(s.id), i + 1);
    if (s?.citationToken) indexOf.set(String(s.citationToken), i + 1);
  });

  const rewritten = summary.replace(/\[([^\]]+)\]/g, (whole, inner) => {
    const atoms = inner.split(/[\s,;]+/).filter(Boolean);
    if (!atoms.length) return whole;

    const indices = [];
    for (const a of atoms) {
      const idx = indexOf.get(a);
      if (idx && !indices.includes(idx)) indices.push(idx);
    }
    if (indices.length) return indices.map((i) => `[${i}]`).join("");

    // Nothing resolved. Strip only if every atom is citation-token-shaped, so we
    // never delete legitimate prose brackets the model might have written.
    if (atoms.every((a) => TOKEN_LIKE.test(a) || INTERNAL_ID.test(a))) return "";
    return whole;
  });

  // Tidy whitespace left behind by stripped markers.
  return rewritten
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\(\s*\)/g, "")
    .trim();
}
