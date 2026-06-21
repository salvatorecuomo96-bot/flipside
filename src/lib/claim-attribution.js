// claim-attribution.js — deterministic helpers for preserving who made a claim.

export const CLAIM_HOLDERS = new Set(["author", "quoted_source", "multiple_sources", "unclear"]);
export const ARTICLE_STANCES = new Set(["endorses", "reports", "contrasts", "unclear"]);

export function claimAttributionFields(cls) {
  const holder = CLAIM_HOLDERS.has(cls?.claim_holder) ? cls.claim_holder : "author";
  const stance = ARTICLE_STANCES.has(cls?.article_stance) ? cls.article_stance : "endorses";
  return {
    claim_holder: holder,
    article_stance: stance,
    attribution: typeof cls?.attribution === "string" ? cls.attribution.trim() : "",
  };
}

export function claimWithAttribution(claim, cls) {
  const text = typeof claim === "string" ? claim.trim() : "";
  if (!text) return "";

  const { claim_holder, attribution } = claimAttributionFields(cls);
  if (claim_holder === "author" || !attribution) return text;
  if (text.toLowerCase().includes(attribution.toLowerCase())) return text;
  return `${attribution}: ${text}`;
}

export function panelClaims(coreClaims, cls) {
  const claims = Array.isArray(coreClaims) ? coreClaims.map(String).map(s => s.trim()).filter(Boolean) : [];
  const source = claims.length ? claims : [cls?.core_claim];
  return source.map((claim) => claimWithAttribution(claim, cls)).filter(Boolean).slice(0, 4);
}
