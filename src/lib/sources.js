// sources.js — the EVIDENCE LAYER.
//
// FlipSide reasons over evidence, not over titles. Every source this module
// returns carries an `evidence_text` (a real abstract/snippet fetched live) and
// a `usable` flag. The synthesis model may only reason over `usable` sources;
// everything else is "further reading" and is NEVER used to justify a claim.
//
// All feeds are free and keyless. The model tags the article's `topic`, so we
// fire only the relevant specialists in parallel. Runs in the service worker
// (host_permissions bypass CORS). Each user fetches from their own IP.
//
// Evidence-bearing feeds:   OpenAlex · Europe PMC · arXiv · Federal Register · CourtListener
//                           ClinicalTrials.gov · World Bank · EPA · NBER · Wikipedia
// Further-reading-only feeds: Google News · GDELT

import { stableSourceKey, buildEvidenceFingerprint } from "./evidence-id.js";

const TIMEOUT_MS = 8000;
const MAILTO = "flipside-extension@proton.me";
const MIN_EVIDENCE_CHARS = 80; // shorter than this isn't real evidence

const CAP = {
  openAlex: 4, news: 3, gdelt: 2, wikipedia: 3,
  europePMC: 3, arxiv: 2, courtListener: 2, fedRegister: 2,
  clinicalTrials: 3, worldBank: 4, epaRegs: 2, nber: 3,
};

/**
 * @param {string} query      keywords from the model's research_query
 * @param {string} topic      topic tag (health|science|law|finance|government|...)
 * @param {string} articleUrl URL of the article (to filter self-links)
 * @param {string} secondaryTopic optional second topic for cross-domain claims
 * @returns {Promise<{sources: Source[], diagnostics: RetrievalDiagnostics}>}
 *   sources — each: {id,title,url,publisher,kind,evidence_text,citationCount,year,usable}
 *   diagnostics — {attempted, succeeded, failed, evidenceAttempted, evidenceFailed}
 */
export async function fetchSources(query, topic = "", articleUrl = "", secondaryTopic = "", articleTitle = "") {
  const q = (query || "").trim();
  if (!q) return { sources: [], diagnostics: { attempted: 0, succeeded: 0, failed: 0, evidenceAttempted: 0, evidenceFailed: 0 } };
  const articleDomain = extractDomain(articleUrl);
  // Wikipedia search: use article title for entity matching when available,
  // falling back to research_query. Title finds "Pope Leo XIV" directly;
  // research_query alone risks matching tangentially-related articles (e.g. a
  // "Dystopian film" for a query about "AI human dignity ethics").
  const wikiQ = (articleTitle || "").trim() || q;

  const jobs = [
    cap("openAlex",  true,  fetchOpenAlex(q),          CAP.openAlex),
    cap("news",      false, fetchNews(q),               CAP.news),
    cap("gdelt",     false, fetchGdelt(q),              CAP.gdelt),
    cap("wikipedia", true,  fetchWikipedia(wikiQ, q),   CAP.wikipedia),
  ];
  // Fire each topic's specialist feeds. A feed shared by both topics runs once.
  const fired = new Set();
  addTopicJobs(jobs, q, topic, fired, "primary");
  addTopicJobs(jobs, q, secondaryTopic, fired, "secondary");

  const results = await Promise.all(jobs);

  // Rank evidence-bearing kinds first; reference/news (usually no abstract) last.
  const ranked = [];
  const order = ["academic", "government", "legal", "preprint", "reference", "news"];
  for (const kind of order) for (const r of results) ranked.push(...r.items.filter(s => s.kind === kind));
  for (const r of results) for (const s of r.items) if (!order.includes(s.kind)) ranked.push(s);

  // Retrieval health: lets the service worker distinguish a genuine empty result
  // from a temporary API outage without hardcoding knowledge of individual feeds.
  const evidenceResults = results.filter(r => r.evidenceBearing);
  const diagnostics = {
    attempted:         results.length,
    succeeded:         results.filter(r => r.ok).length,
    failed:            results.filter(r => !r.ok).length,
    evidenceAttempted: evidenceResults.length,
    evidenceFailed:    evidenceResults.filter(r => !r.ok).length,
  };

  // De-dupe by URL, drop self-links, collect candidates.
  const seen = new Set();
  const candidates = [];
  for (const s of ranked) {
    if (!s.url) continue;
    const key = s.url.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    if (articleDomain && extractDomain(s.url) === articleDomain) continue;
    seen.add(key);
    candidates.push(s);
    if (candidates.length >= 16) break;
  }

  // Build output with stable source keys (async — runs in parallel).
  let n = 0;
  const out = await Promise.all(candidates.map(async s => {
    const evidence = (s.evidence_text || "").trim();
    const sKey = await stableSourceKey(s);
    return {
      id: "s" + (++n),
      title: s.title,
      url: s.url,
      publisher: s.publisher || "",
      kind: s.kind,
      evidence_text: evidence,
      citationCount: s.citationCount ?? null,
      year: s.year ?? null,
      origin: s.origin || "primary",
      ...ageTag(s.year ?? null),
      usable: evidence.length >= MIN_EVIDENCE_CHARS,
      stableKey: sKey,
    };
  }));

  // Evidence fingerprint over usable sources — used as a synthesis cache key
  // segment in the Worker so results are tied to the specific evidence set, not
  // just the article URL.
  const usableForFp = out.filter(s => s.usable).map(s => ({
    stableKey: s.stableKey, kind: s.kind, year: s.year, evidence_text: s.evidence_text,
  }));
  const evidenceFingerprint = await buildEvidenceFingerprint(usableForFp);

  return { sources: out, diagnostics, evidenceFingerprint };
}

// ─── Global Relevance Ranker ──────────────────────────────────────────────────
// Scores all usable candidates from all fired feeds against the classifier's
// research_query and returns the top `limit` sources, with hard-age sources
// guaranteed at the physical bottom regardless of score (double-layer defence).
//
// Components (all 0..1 so weights are interpretable):
//   W_COV  — query-term coverage (unique terms present ÷ unique terms in query)
//   W_TF   — TF saturation (BM25-style k1 without IDF, which is noisy at n≤16)
//   W_TTL  — title coverage bonus (query term in title > body)
//   W_KIND — source-kind authority prior
//   W_CITE — log-scaled citation count
//   P_SOFT/P_HARD — age penalties for soft/hard age tiers
const W_COV  = 0.45, W_TF = 0.15, W_TTL = 0.20, W_KIND = 0.10, W_CITE = 0.10;
const P_SOFT = 0.10, P_HARD = 0.30;
const P_OFFDOMAIN = 0.6; // normative claims: empirical research (academic/preprint) is wrong-domain,
                         // penalised below coverage's max so reference (Wikipedia) wins. (Notch 1)
const P_GEO = 2.0;       // geo-mismatch: exceeds max possible positive score (~1.0) so any foreign-
                         // specific source loses to any topically-relevant source. Soft (not a hard
                         // exclude) so if ALL sources mismatch, the least-bad still surfaces.
const K1 = 1.2;          // TF saturation constant
const MAX_CITES = 1000;  // citation count cap before log-scaling

// Lowercase alias → ISO-3166 code. Multi-word and demonym forms included.
// Deliberately OMITS ambiguous English words (Georgia/Turkey/Chad/Jordan) to avoid
// false positives — under-detecting rare countries beats penalising US articles that
// mention the state of Georgia. Classifier is instructed to emit full country names.
const GEO_ALIASES = {
  "united states":"US","u.s.a.":"US","usa":"US","america":"US","american":"US","americans":"US",
  "united kingdom":"GB","britain":"GB","british":"GB","england":"GB","scotland":"GB","wales":"GB",
  "australia":"AU","australian":"AU","australians":"AU",
  "canada":"CA","canadian":"CA","canadians":"CA",
  "new zealand":"NZ","zimbabwe":"ZW","zimbabwean":"ZW","zambia":"ZM","zambian":"ZM",
  "south africa":"ZA","south african":"ZA","nigeria":"NG","nigerian":"NG",
  "kenya":"KE","kenyan":"KE","ghana":"GH","ghanaian":"GH",
  "uganda":"UG","ugandan":"UG","ethiopia":"ET","ethiopian":"ET","tanzania":"TZ","tanzanian":"TZ",
  "egypt":"EG","egyptian":"EG","morocco":"MA","moroccan":"MA",
  "india":"IN","indian":"IN","pakistan":"PK","pakistani":"PK",
  "bangladesh":"BD","bangladeshi":"BD","sri lanka":"LK","nepal":"NP","nepali":"NP",
  "china":"CN","chinese":"CN","japan":"JP","japanese":"JP",
  "south korea":"KR","north korea":"KP","korea":"KR","korean":"KR",
  "indonesia":"ID","indonesian":"ID","philippines":"PH","filipino":"PH","filipina":"PH",
  "vietnam":"VN","vietnamese":"VN","thailand":"TH","thai":"TH","malaysia":"MY","malaysian":"MY",
  "germany":"DE","german":"DE","france":"FR","french":"FR","italy":"IT","italian":"IT",
  "spain":"ES","spanish":"ES","portugal":"PT","portuguese":"PT",
  "netherlands":"NL","dutch":"NL","belgium":"BE","belgian":"BE",
  "sweden":"SE","swedish":"SE","norway":"NO","norwegian":"NO",
  "denmark":"DK","danish":"DK","finland":"FI","finnish":"FI",
  "poland":"PL","polish":"PL","ukraine":"UA","ukrainian":"UA",
  "russia":"RU","russian":"RU","brazil":"BR","brazilian":"BR",
  "argentina":"AR","argentinian":"AR","chile":"CL","chilean":"CL",
  "colombia":"CO","colombian":"CO","mexico":"MX","mexican":"MX",
  "venezuela":"VE","venezuelan":"VE","peru":"PE","peruvian":"PE",
  "israel":"IL","israeli":"IL","iran":"IR","iranian":"IR",
  "saudi arabia":"SA","saudi":"SA","iraq":"IQ","iraqi":"IQ",
  "afghanistan":"AF","afghan":"AF","syria":"SY","syrian":"SY",
};

// Returns Set of ISO codes mentioned in text. Padding with spaces gives word-
// boundary matching for both single- and multi-word aliases without a full tokeniser.
function detectGeos(text) {
  const t = " " + String(text || "").toLowerCase().normalize("NFKD")
    .replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ") + " ";
  const found = new Set();
  for (const alias in GEO_ALIASES) if (t.includes(" " + alias + " ")) found.add(GEO_ALIASES[alias]);
  return found;
}

function geoPenalty(source, requiredCodes) {
  if (!requiredCodes.size) return 0;                               // claim is geo-agnostic
  const mentioned = detectGeos((source.title || "") + " " + (source.evidence_text || ""));
  if (!mentioned.size) return 0;                                   // source names no country — keep (theoretical)
  for (const c of mentioned) if (requiredCodes.has(c)) return 0;  // names a required country — relevant
  return P_GEO;                                                    // names ONLY foreign countries — sink it
}

const KIND_PRIOR = { academic: 1.0, government: 0.85, legal: 0.85, preprint: 0.6, reference: 0.4, news: 0.2 };

const STOPWORDS = new Set(["a","an","the","and","or","of","to","in","for","on","is","with",
  "at","by","from","as","it","its","are","was","be","has","that","this","which","not","but"]);

function tokenize(str) {
  return [...(str || "").toLowerCase().normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .matchAll(/[\p{L}\p{N}]+/gu)]
    .map(m => m[0])
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function termFreqs(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

function coverage(querySet, docSet) {
  if (!querySet.size) return 0;
  let hits = 0;
  for (const t of querySet) if (docSet.has(t)) hits++;
  return hits / querySet.size;
}

function tfSaturated(querySet, docFreqs) {
  if (!querySet.size) return 0;
  let sum = 0;
  for (const t of querySet) { const f = docFreqs.get(t) || 0; sum += f / (f + K1); }
  return sum / querySet.size;
}

export function rankSources(sources, query, limit = 6, claimType = "empirical", requiredGeography = []) {
  const qSet = new Set(tokenize(query));
  const normative = claimType === "normative";
  const requiredCodes = new Set();
  for (const g of (requiredGeography || [])) {
    const code = GEO_ALIASES[String(g).toLowerCase().trim()];
    if (code) requiredCodes.add(code);
  }

  const scored = sources.map(s => {
    const bodyToks = tokenize(s.evidence_text);
    const titleToks = tokenize(s.title);
    const bodyFreqs = termFreqs(bodyToks);
    const bodySet   = new Set(bodyToks);
    const titleSet  = new Set(titleToks);

    const cov  = coverage(qSet, bodySet);
    const tf   = tfSaturated(qSet, bodyFreqs);
    const ttl  = coverage(qSet, titleSet);
    const kind = KIND_PRIOR[s.kind] ?? 0.3;
    const cite = s.citationCount
      ? Math.log1p(Math.min(s.citationCount, MAX_CITES)) / Math.log1p(MAX_CITES)
      : 0;
    const age  = s.age_tier === "hard" ? P_HARD : s.age_tier === "soft" ? P_SOFT : 0;
    const off  = (normative && (s.kind === "academic" || s.kind === "preprint")) ? P_OFFDOMAIN : 0;
    const geo  = geoPenalty(s, requiredCodes);

    return { ...s, _score: W_COV*cov + W_TF*tf + W_TTL*ttl + W_KIND*kind + W_CITE*cite - age - off - geo };
  });

  // Stable tiebreak: citation count then recency for equal scores.
  scored.sort((a, b) =>
    b._score - a._score ||
    (b.citationCount || 0) - (a.citationCount || 0) ||
    (b.year || 0) - (a.year || 0)
  );

  const selected = scored.slice(0, limit);

  // Penalty governs selection; partition guarantees physical ordering.
  // Hard-age sources sink to the bottom even if score was high enough to be selected.
  return [
    ...selected.filter(s => s.age_tier !== "hard"),
    ...selected.filter(s => s.age_tier === "hard"),
  ];
}

// Push the specialist feeds for one topic, skipping any feed already queued by an
// earlier topic (so primary+secondary overlap doesn't double-fetch).
function addTopicJobs(jobs, q, topic, fired, origin = "primary") {
  const t = (topic || "").toLowerCase();
  if (!t) return;
  const add = (key, makeJob, n) => { if (fired.has(key)) return; fired.add(key); jobs.push(cap(key, true, makeJob(), n, origin)); };
  if (["health", "medicine", "science"].includes(t)) {
    add("europePMC",      () => fetchEuropePMC(q),      CAP.europePMC);
    add("clinicalTrials", () => fetchClinicalTrials(q), CAP.clinicalTrials);
  }
  if (["science", "physics", "technology"].includes(t)) add("arxiv",         () => fetchArxiv(q),           CAP.arxiv);
  if (["law", "legal", "court"].includes(t))            add("courtListener", () => fetchCourtListener(q),   CAP.courtListener);
  if (["government", "policy"].includes(t))             add("fedRegister",   () => fetchFederalRegister(q), CAP.fedRegister);
  if (["finance", "economics"].includes(t)) {
    add("worldBank", () => fetchWorldBank(q), CAP.worldBank);
    add("nber",      () => fetchNBER(q),      CAP.nber);
  }
  if (["environment"].includes(t)) {
    add("worldBank",   () => fetchWorldBank(q),       CAP.worldBank);
    add("epaRegs",     () => fetchEPARegulations(q),  CAP.epaRegs);
    add("fedRegister", () => fetchFederalRegister(q), CAP.fedRegister);
  }
}

async function cap(name, evidenceBearing, promise, n, origin = "primary") {
  try {
    const r = await promise;
    const items = Array.isArray(r) ? r.slice(0, n).map(s => ({ ...s, origin })) : [];
    return { name, evidenceBearing, ok: true, items, errorType: null };
  } catch (err) {
    let errorType = "error";
    if (err?.name === "AbortError") errorType = "timeout";
    else if (/^\d+$/.test(err?.message)) errorType = `http_${err.message}`;
    return { name, evidenceBearing, ok: false, items: [], errorType };
  }
}

// Code-level temporal label, precomputed once here (client side) so the client
// and worker prompt builders render the SAME string — no duplicated date math,
// no drift. Returned as its own field and rendered on its own line; it is NEVER
// folded into evidence_text, so the provenance gate (quoteAppears) is unaffected.
function ageTag(year) {
  if (!year || typeof year !== "number") return { age_tag: "", age_tier: "recent" };
  const age = new Date().getFullYear() - year;
  if (age <= 5)  return { age_tag: "", age_tier: "recent" };
  if (age <= 15) return { age_tag: `[Published ${age} years ago — verify it reflects current policy status]`, age_tier: "soft" };
  return { age_tag: `[Published ${age} years ago — use ONLY for foundational theory/mechanisms, NOT for current event status]`, age_tier: "hard" };
}

// --- OpenAlex: academic papers WITH abstracts -------------------------------
async function fetchOpenAlex(q) {
  // has_abstract:true is the key yield fix — only return papers we can actually
  // reason over. Without it most results lacked an abstract and were unusable.
  const url = "https://api.openalex.org/works?search=" + encodeURIComponent(q) +
    "&filter=has_abstract:true&per-page=6&sort=relevance_score:desc&mailto=" + encodeURIComponent(MAILTO) +
    "&select=title,doi,id,primary_location,publication_year,cited_by_count,abstract_inverted_index";
  const data = await getJson(url);
  return (data?.results || []).flatMap(w => {
    const title = (w?.title || "").trim();
    const link = w?.doi || w?.primary_location?.landing_page_url || w?.id || "";
    if (!title || !link) return [];
    const venue = w?.primary_location?.source?.display_name || "";
    const year = w?.publication_year || null;
    const publisher = [venue, year].filter(Boolean).join(" · ") || "Academic";
    return [{
      title, url: link, publisher, kind: "academic",
      evidence_text: reconstructAbstract(w?.abstract_inverted_index),
      citationCount: w?.cited_by_count ?? null, year,
    }];
  });
}

// OpenAlex stores abstracts as a word→positions inverted index.
function reconstructAbstract(inv) {
  if (!inv || typeof inv !== "object") return "";
  const words = [];
  for (const [word, positions] of Object.entries(inv)) {
    if (Array.isArray(positions)) for (const p of positions) words[p] = word;
  }
  return words.join(" ").replace(/\s+/g, " ").trim();
}

// --- Europe PMC: life-science papers WITH abstracts -------------------------
async function fetchEuropePMC(q) {
  const url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=" + encodeURIComponent(q) +
    "&resultType=core&pageSize=4&format=json&sort=relevance";
  const data = await getJson(url);
  return (data?.resultList?.result || []).flatMap(r => {
    const title = (r.title || "").trim();
    if (!title || !r.id) return [];
    return [{
      title,
      url: "https://europepmc.org/article/" + r.source + "/" + r.id,
      publisher: [r.journalTitle, r.pubYear].filter(Boolean).join(" · ") || "Europe PMC",
      kind: "academic",
      evidence_text: (r.abstractText || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      citationCount: r.citedByCount ?? null, year: r.pubYear ? Number(r.pubYear) : null,
    }];
  });
}

// --- arXiv: preprints WITH abstracts ----------------------------------------
async function fetchArxiv(q) {
  const url = "https://export.arxiv.org/api/query?search_query=all:" + encodeURIComponent(q) +
    "&max_results=3&sortBy=relevance";
  const xml = await getText(url);
  const out = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml)) && out.length < 3) {
    const block = m[1];
    const title = pick(block, /<title>([\s\S]*?)<\/title>/)?.trim().replace(/\s+/g, " ");
    const id = pick(block, /<id>([\s\S]*?)<\/id>/)?.trim();
    if (!title || !id) continue;
    const year = pick(block, /<published>([\s\S]*?)<\/published>/)?.slice(0, 4);
    out.push({
      title, url: id.replace("http://", "https://"),
      publisher: "arXiv" + (year ? " · " + year : ""), kind: "preprint",
      evidence_text: pick(block, /<summary>([\s\S]*?)<\/summary>/)?.replace(/\s+/g, " ").trim() || "",
      year: year ? Number(year) : null,
    });
  }
  return out;
}

// --- Federal Register: US gov rules WITH abstracts --------------------------
async function fetchFederalRegister(q) {
  const url = "https://www.federalregister.gov/api/v1/articles.json?conditions[term]=" + encodeURIComponent(q) +
    "&per_page=3&fields[]=title&fields[]=html_url&fields[]=abstract&fields[]=publication_date&fields[]=agencies";
  const data = await getJson(url);
  return (data?.results || []).flatMap(r => {
    const title = (r.title || "").trim();
    if (!title || !r.html_url) return [];
    const agency = (r.agencies || []).map(a => a.name).join(", ") || "Federal Register";
    const year = (r.publication_date || "").slice(0, 4);
    return [{
      title, url: r.html_url,
      publisher: [agency, year].filter(Boolean).join(" · "), kind: "government",
      evidence_text: (r.abstract || "").trim(), year: year ? Number(year) : null,
    }];
  });
}

// --- CourtListener: case law (snippet if present) ---------------------------
async function fetchCourtListener(q) {
  const url = "https://www.courtlistener.com/api/rest/v4/search/?q=" + encodeURIComponent(q) +
    "&type=o&format=json&order_by=score+desc";
  const data = await getJson(url);
  return (data?.results || []).slice(0, 3).flatMap(r => {
    const title = (r.caseName || r.case_name || "").trim();
    const path = r.absolute_url || "";
    if (!title || !path) return [];
    const court = r.court_citation_string || r.court || "";
    const year = (r.dateFiled || r.date_filed || "").slice(0, 4);
    const snippet = (Array.isArray(r.opinions) ? r.opinions[0]?.snippet : r.snippet) || "";
    return [{
      title, url: "https://www.courtlistener.com" + path,
      publisher: [court, year].filter(Boolean).join(" · ") || "CourtListener", kind: "legal",
      evidence_text: String(snippet).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      year: year ? Number(year) : null,
    }];
  });
}

// --- Google News: journalism (further reading — no abstract) ----------------
async function fetchNews(q) {
  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-US&gl=US&ceid=US:en";
  const xml = await getText(url);
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) && items.length < 6) {
    const block = m[1];
    const rawTitle = pick(block, /<title>([\s\S]*?)<\/title>/);
    const link = pick(block, /<link>([\s\S]*?)<\/link>/);
    if (!rawTitle || !link) continue;
    const srcM = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    const publisher = srcM ? decode(srcM[1]).trim() : "News";
    let title = decode(rawTitle).trim();
    if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3)).trim();
    items.push({ title, url: link.trim(), publisher, kind: "news", evidence_text: "" });
  }
  return items;
}

// --- GDELT: real-time global news (further reading) -------------------------
async function fetchGdelt(q) {
  const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + encodeURIComponent(q) +
    "&mode=artlist&maxrecords=4&format=json";
  const data = await getJson(url);
  return (data?.articles || []).flatMap(a => {
    const title = (a.title || "").trim();
    const link = (a.url || "").trim();
    if (!title || !link) return [];
    return [{ title, url: link, publisher: a.domain || "News", kind: "news", evidence_text: "" }];
  });
}

// --- Wikipedia: reference WITH summary extract (reliable context fallback) ---
// Top-3 pages: for normative/theological claims the encyclopedic concept entry IS
// the right evidence, so we pull a few candidates and let the ranker pick. (Notch 1)
// titleQ (article title) is used for the primary search for better entity matching;
// fallbackQ (research_query) is tried if the title search returns no usable results.
// Any page whose extract has zero token overlap with fallbackQ is dropped — this
// prevents totally unrelated Wikipedia articles (e.g. a dystopian film that mentions
// AI) from making it into the evidence pool just because KIND_PRIOR beats news.
async function fetchWikipedia(titleQ, fallbackQ = "") {
  const fetchPages = async (q) => {
    const url = "https://en.wikipedia.org/w/rest.php/v1/search/page?q=" + encodeURIComponent(q) + "&limit=3";
    const data = await getJson(url);
    return (data?.pages || []).filter(x => x?.key && x?.title).slice(0, 3);
  };

  let pages = await fetchPages(titleQ);
  if (!pages.length && fallbackQ && fallbackQ !== titleQ) pages = await fetchPages(fallbackQ);
  if (!pages.length) return [];

  const qTokens = new Set(tokenize(fallbackQ || titleQ));

  const results = await Promise.all(pages.map(async p => {
    let extract = (p.description || "").trim();
    try {
      const sum = await getJson("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(p.key));
      if (sum?.extract) extract = sum.extract.trim();
    } catch {}
    return {
      title: p.title,
      url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(p.key),
      publisher: "Wikipedia", kind: "reference",
      evidence_text: extract,
    };
  }));

  // Drop pages with zero query-term overlap — catches completely off-topic results
  // that slip through Wikipedia's search when the query is multi-concept.
  if (qTokens.size > 0) {
    return results.filter(r => {
      const docTokens = new Set(tokenize(r.title + " " + r.evidence_text));
      for (const t of qTokens) if (docTokens.has(t)) return true;
      return false;
    });
  }
  return results;
}

// --- ClinicalTrials.gov: registered studies WITH summaries ------------------
async function fetchClinicalTrials(q) {
  const url = "https://clinicaltrials.gov/api/v2/studies?query.term=" + encodeURIComponent(q) +
    "&fields=NCTId,BriefTitle,BriefSummary,StartDate&pageSize=3";
  const data = await getJson(url);
  return (data?.studies || []).flatMap(s => {
    const id   = s.protocolSection?.identificationModule;
    const desc = s.protocolSection?.descriptionModule;
    const stat = s.protocolSection?.statusModule;
    const title = (id?.briefTitle || "").trim();
    const nctId = id?.nctId;
    if (!title || !nctId) return [];
    const summary = (desc?.briefSummary || "").replace(/\s+/g, " ").trim();
    const year    = (stat?.startDateStruct?.date || "").slice(0, 4);
    return [{
      title,
      url: "https://clinicaltrials.gov/study/" + nctId,
      publisher: ["ClinicalTrials.gov", year].filter(Boolean).join(" · "),
      kind: "academic",
      evidence_text: summary,
      year: year ? Number(year) : null,
    }];
  });
}

// --- World Bank Documents: reports and working papers WITH abstracts ---------
// WDS quirks (verified live): the search param is `qterm` (not `q`); `documents`
// is an OBJECT keyed by doc id (plus a `facets` key to skip); the title is
// `display_title`; and the abstract is nested as abstracts["cdata!"].
async function fetchWorldBank(q) {
  const url = "https://search.worldbank.org/api/v2/wds?format=json&qterm=" + encodeURIComponent(q) +
    "&fl=docdt,docty,display_title,abstracts,url&rows=4&os=0";
  const data = await getJson(url);
  const docs = Object.values(data?.documents || {})
    .filter(d => d && typeof d === "object" && typeof d.display_title === "string");
  return docs.slice(0, 4).flatMap(d => {
    const title = (d.display_title || "").trim();
    const link  = (d.url || "").replace(/^http:/, "https:");
    if (!title || !link) return [];
    const rawAbstract = d.abstracts && typeof d.abstracts === "object"
      ? (d.abstracts["cdata!"] || d.abstracts.cdata || "")
      : (d.abstracts || "");
    const abstract = String(rawAbstract).replace(/\s+/g, " ").trim();
    const year = (d.docdt || "").slice(0, 4);
    return [{
      title, url: link,
      publisher: ["World Bank", d.docty, year].filter(Boolean).join(" · "),
      kind: "government",
      evidence_text: abstract,
      year: year ? Number(year) : null,
    }];
  });
}

// --- NBER: economics working papers WITH abstracts --------------------------
// Verified live: results[] each carry a real `abstract`, a `title`, a relative
// `url` (e.g. "/papers/w30678"), and `displaydate` ("November 2022").
async function fetchNBER(q) {
  const url = "https://www.nber.org/api/v1/working_page_listing/contentType/working_paper/_/_/search?q=" +
    encodeURIComponent(q) + "&page=1&perPage=4";
  const data = await getJson(url);
  return (data?.results || []).flatMap(r => {
    const title = (r.title || "").replace(/\s+/g, " ").trim();
    const path  = r.url || "";
    if (!title || !path) return [];
    const abstract = (r.abstract || "").replace(/\s+/g, " ").trim();
    const year = (String(r.displaydate || "").match(/\b(19|20)\d{2}\b/) || [])[0] || "";
    return [{
      title,
      url: path.startsWith("http") ? path : "https://www.nber.org" + path,
      publisher: ["NBER Working Paper", year].filter(Boolean).join(" · "),
      kind: "academic",
      evidence_text: abstract,
      year: year ? Number(year) : null,
    }];
  });
}

// --- EPA via Federal Register: EPA rules and notices WITH abstracts ----------
async function fetchEPARegulations(q) {
  const url = "https://www.federalregister.gov/api/v1/articles.json" +
    "?conditions[term]=" + encodeURIComponent(q) +
    "&conditions[agencies][]=environmental-protection-agency" +
    "&per_page=2" +
    "&fields[]=title&fields[]=html_url&fields[]=abstract&fields[]=publication_date&fields[]=agencies";
  const data = await getJson(url);
  return (data?.results || []).flatMap(r => {
    const title = (r.title || "").trim();
    if (!title || !r.html_url) return [];
    const year = (r.publication_date || "").slice(0, 4);
    return [{
      title, url: r.html_url,
      publisher: ["EPA · Federal Register", year].filter(Boolean).join(" · "),
      kind: "government",
      evidence_text: (r.abstract || "").trim(),
      year: year ? Number(year) : null,
    }];
  });
}

// --- helpers -----------------------------------------------------------------
async function getJson(url) { const r = await timed(url); if (!r.ok) throw new Error(r.status); return r.json(); }
async function getText(url) { const r = await timed(url); if (!r.ok) throw new Error(r.status); return r.text(); }

async function timed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, headers: { "User-Agent": "FlipSide/1.0 (mailto:" + MAILTO + ")" } });
  } finally { clearTimeout(timer); }
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}
function pick(s, re) { const m = s?.match(re); return m ? m[1] : ""; }
function decode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&");
}
