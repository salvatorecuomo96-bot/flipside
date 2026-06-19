// citation-resolver.js — maps the model's cited source IDs back to real sources,
// then runs the provenance gate. Pure module (no chrome/DOM deps) so it can be
// unit-tested in Node directly.
//
// Why a dual-key map: the synthesis prompt shows each source as its stable
// citation token (a 10–12 char Base32 string), so the model cites by TOKEN. But
// older/cached responses and some fallbacks may still cite by the internal
// sequential id ("s1", "s2", …). The resolver therefore accepts BOTH — every
// source is registered under its id AND its citationToken, both pointing to the
// same object. Resolving by either is correct; they can never disagree.

import { checkProvenance } from "./provenance.js";

export function dedupByUrl(arr) {
  const seen = new Set(), out = [];
  for (const s of arr) { if (!s?.url || seen.has(s.url)) continue; seen.add(s.url); out.push(s); }
  return out;
}

// Register each source under both its internal id and its stable citation token.
export function buildCitationMap(sources) {
  const map = new Map();
  for (const s of (sources || [])) {
    if (s.id) map.set(s.id, s);
    if (s.citationToken) map.set(s.citationToken, s);
  }
  return map;
}

// Provenance gate for one used_sources list: keep only cited sources that (a)
// resolve to a real source via the citation map and (b) carry a quote that is
// genuinely present in that source's evidence_text. No resurrection fallback —
// an unresolved or unverifiable citation is dropped.
export function validateShown(usedSources, citationMap) {
  const used = Array.isArray(usedSources) ? usedSources : [];
  const validated = [];
  for (const u of used) {
    const src = citationMap.get(u.id);
    if (!src) continue;
    const { matched } = checkProvenance(u.evidence_quote ?? "", src.evidence_text ?? "");
    if (matched) validated.push(src);
  }
  return dedupByUrl(validated);
}
