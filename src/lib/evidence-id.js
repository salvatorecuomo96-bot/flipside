// evidence-id.js — stable source identity + evidence fingerprinting.
//
// Works in both Chrome extension service workers (Web Crypto API) and Node
// (globalThis.crypto.subtle via --experimental-global-webcrypto or Node ≥ 19).

export async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeEvidence(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function canonicalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hostname = u.hostname.toLowerCase();
    if (u.protocol === "http:"  && u.port === "80")  u.port = "";
    if (u.protocol === "https:" && u.port === "443") u.port = "";
    u.hash = "";
    const TRACKING = new Set([
      "utm_source","utm_medium","utm_campaign","utm_term","utm_content",
      "fbclid","gclid","ref","source","via",
    ]);
    const kept = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING.has(k.toLowerCase()));
    kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    u.search = new URLSearchParams(kept).toString();
    return u.toString();
  } catch {
    return rawUrl;
  }
}

// Derive a stable string identity from a processed source object { url, kind }.
// Matches on well-known URL patterns to extract persistent identifiers;
// falls back to canonicalized URL so every source gets an identity.
export function sourceIdentity(source) {
  const url = (source.url || "").trim();
  if (!url) return null;

  // DOI — highest priority; doi.org redirects to publisher but the DOI itself is stable
  const doiM = url.match(/https?:\/\/doi\.org\/(.+)/i);
  if (doiM) return "doi:" + doiM[1];

  // OpenAlex work ID (W-prefixed)
  const oaM = url.match(/https?:\/\/openalex\.org\/(W\d+)/i);
  if (oaM) return "openalex:" + oaM[1];

  // Europe PMC (source/id path)
  const epmcM = url.match(/https?:\/\/europepmc\.org\/article\/([^/?#]+\/[^/?#]+)/i);
  if (epmcM) return "europepmc:" + epmcM[1];

  // arXiv abstract (strip version suffix so v1 and v2 share the same key)
  const arxivM = url.match(/https?:\/\/arxiv\.org\/abs\/([^/?#]+)/i);
  if (arxivM) return "arxiv:" + arxivM[1].replace(/v\d+$/, "");

  // ClinicalTrials.gov NCT ID
  const nctM = url.match(/https?:\/\/clinicaltrials\.gov\/study\/(NCT\d+)/i);
  if (nctM) return "clinicaltrials:" + nctM[1];

  // NBER working paper number
  const nberM = url.match(/https?:\/\/(?:www\.)?nber\.org\/papers\/(w\d+)/i);
  if (nberM) return "nber:" + nberM[1];

  // Federal Register document (date + slug path segment)
  const fedM = url.match(/https?:\/\/(?:www\.)?federalregister\.gov\/documents\/(\d{4}\/\d{2}\/\d{2}\/[^/?#]+)/i);
  if (fedM) return "fedreg:" + fedM[1];

  // CourtListener opinion path (stable across redirects)
  const clM = url.match(/https?:\/\/(?:www\.)?courtlistener\.com(\/opinion\/[^/?#]+(?:\/[^/?#]+)?)/i);
  if (clM) return "courtlistener:" + clM[1];

  // English Wikipedia article key
  const wikiM = url.match(/https?:\/\/en\.wikipedia\.org\/wiki\/([^?#]+)/i);
  if (wikiM) return "wikipedia:" + decodeURIComponent(wikiM[1]);

  // Default: full canonical URL (covers World Bank, EPA sub-paths, etc.)
  return "url:" + canonicalizeUrl(url);
}

export async function stableSourceKey(source) {
  const identity = sourceIdentity(source);
  if (!identity) return null;
  return "src_" + await sha256hex(identity);
}

// ─── Citation token (10–12 Base32 chars) ─────────────────────────────────────
// The token is a prefix of the stable key encoded in Base32 so the model can
// cite sources by a short, copy-safe string. Collision-checked; extends to 12
// chars before giving up (accepting the collision rather than throwing).

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function hexToBase32(hex, len) {
  let result = "";
  for (let i = 0; i < len; i++) {
    const byteIndex = Math.floor(i * 5 / 8);
    const bitOffset = (i * 5) % 8;
    const b1 = parseInt(hex.slice(byteIndex * 2, byteIndex * 2 + 2), 16) || 0;
    const b2 = parseInt(hex.slice(byteIndex * 2 + 2, byteIndex * 2 + 4), 16) || 0;
    const combined = (b1 << 8) | b2;
    result += B32[(combined >> (11 - bitOffset)) & 0x1F];
  }
  return result;
}

export function generateCitationToken(stableKey, existingTokens) {
  const hex = stableKey.slice(4); // strip "src_"
  for (let len = 10; len <= 12; len++) {
    const tok = hexToBase32(hex, len);
    if (!existingTokens.has(tok)) return tok;
  }
  return hexToBase32(hex, 12); // last resort — accept collision
}

// ─── Evidence fingerprint ─────────────────────────────────────────────────────
// SHA-256 of a sorted list of per-source entries. Identical evidence set
// (same sources, kinds, years, and abstract text) produces the same fingerprint
// regardless of fetch order — suitable as a Worker cache key segment.
//
// sources: Array<{ stableKey: string|null, kind: string, year: number|null, evidence_text: string }>

export async function buildEvidenceFingerprint(sources) {
  const entries = await Promise.all(
    sources.map(async s => {
      const eHash = await sha256hex(normalizeEvidence(s.evidence_text || ""));
      return (s.stableKey || "") + "|" + (s.kind || "") + "|" + (s.year ?? "") + "|" + eHash;
    })
  );
  entries.sort();
  return sha256hex(entries.join("\n"));
}
