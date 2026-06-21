// cache-schema.js — local analysis-cache invalidation.
//
// Bump LOCAL_ANALYSIS_SCHEMA_VERSION whenever stored classification or synthesis
// result shape changes. This clears only analysis-derived caches, leaving API
// keys, provider settings, user settings, and feedback history intact.

export const LOCAL_ANALYSIS_SCHEMA_VERSION = "analysis-v2-claim-attribution";
export const LOCAL_ANALYSIS_SCHEMA_KEY = "analysisCacheSchemaVersion";

export const LOCAL_ANALYSIS_CACHE_KEYS = [
  "classifyCache",
  "analysisCache",
  "urlCache",
  "noneCache",
  "badgeCache",
  "extractionCache",
];

export async function ensureAnalysisCacheSchema(storage) {
  if (!storage) throw new Error("storage is required");

  const current = (await storage.get(LOCAL_ANALYSIS_SCHEMA_KEY))[LOCAL_ANALYSIS_SCHEMA_KEY];
  if (current === LOCAL_ANALYSIS_SCHEMA_VERSION) return false;

  await storage.remove(LOCAL_ANALYSIS_CACHE_KEYS);
  await storage.set({ [LOCAL_ANALYSIS_SCHEMA_KEY]: LOCAL_ANALYSIS_SCHEMA_VERSION });
  return true;
}
