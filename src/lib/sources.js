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
//                           ClinicalTrials.gov · SEC EDGAR · World Bank · CRS · EPA · UK Parliament
//                           Wikipedia
// Further-reading-only feeds: Google News · GDELT

const TIMEOUT_MS = 8000;
const MAILTO = "flipside-extension@proton.me";
const MIN_EVIDENCE_CHARS = 80; // shorter than this isn't real evidence

const CAP = {
  openAlex: 4, news: 3, gdelt: 2, wikipedia: 1,
  europePMC: 3, arxiv: 2, courtListener: 2, fedRegister: 2,
  clinicalTrials: 3, edgar: 3, worldBank: 3, crs: 3, epaRegs: 2, ukParliament: 3,
};

/**
 * @param {string} query      keywords from the model's research_query
 * @param {string} topic      topic tag (health|science|law|finance|government|...)
 * @param {string} articleUrl URL of the article (to filter self-links)
 * @returns {Promise<Source[]>}  each: {id,title,url,publisher,kind,evidence_text,citationCount,year,usable}
 */
export async function fetchSources(query, topic = "", articleUrl = "") {
  const q = (query || "").trim();
  if (!q) return [];
  const t = (topic || "").toLowerCase();
  const articleDomain = extractDomain(articleUrl);

  const jobs = [
    cap(fetchOpenAlex(q),    CAP.openAlex),
    cap(fetchNews(q),        CAP.news),
    cap(fetchGdelt(q),       CAP.gdelt),
    cap(fetchWikipedia(q),   CAP.wikipedia),
  ];
  if (["health", "medicine", "science"].includes(t)) {
    jobs.push(cap(fetchEuropePMC(q),      CAP.europePMC));
    jobs.push(cap(fetchClinicalTrials(q), CAP.clinicalTrials));
  }
  if (["science", "physics", "technology"].includes(t))   jobs.push(cap(fetchArxiv(q), CAP.arxiv));
  if (["law", "legal", "court"].includes(t)) {
    jobs.push(cap(fetchCourtListener(q), CAP.courtListener));
    jobs.push(cap(fetchUKParliament(q),  CAP.ukParliament));
  }
  if (["government", "policy"].includes(t)) {
    jobs.push(cap(fetchFederalRegister(q), CAP.fedRegister));
    jobs.push(cap(fetchCRS(q),             CAP.crs));
    jobs.push(cap(fetchUKParliament(q),    CAP.ukParliament));
  }
  if (["politics"].includes(t))                           jobs.push(cap(fetchCRS(q), CAP.crs));
  if (["finance", "economics"].includes(t)) {
    jobs.push(cap(fetchEdgar(q),     CAP.edgar));
    jobs.push(cap(fetchWorldBank(q), CAP.worldBank));
  }
  if (["environment"].includes(t)) {
    jobs.push(cap(fetchWorldBank(q),       CAP.worldBank));
    jobs.push(cap(fetchEPARegulations(q),  CAP.epaRegs));
    jobs.push(cap(fetchFederalRegister(q), CAP.fedRegister));
  }

  const pools = await Promise.all(jobs);

  // Rank evidence-bearing kinds first; reference/news (usually no abstract) last.
  const ranked = [];
  const order = ["academic", "government", "legal", "preprint", "reference", "news"];
  for (const kind of order) for (const pool of pools) ranked.push(...pool.filter(s => s.kind === kind));
  for (const pool of pools) for (const s of pool) if (!order.includes(s.kind)) ranked.push(s);

  // De-dupe by URL, drop self-links, assign stable ids, compute usable.
  const seen = new Set();
  const out = [];
  let n = 0;
  for (const s of ranked) {
    if (!s.url) continue;
    const key = s.url.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    if (articleDomain && extractDomain(s.url) === articleDomain) continue;
    seen.add(key);
    const evidence = (s.evidence_text || "").trim();
    out.push({
      id: "s" + (++n),
      title: s.title,
      url: s.url,
      publisher: s.publisher || "",
      kind: s.kind,
      evidence_text: evidence,
      citationCount: s.citationCount ?? null,
      year: s.year ?? null,
      usable: evidence.length >= MIN_EVIDENCE_CHARS,
    });
    if (out.length >= 16) break;
  }
  return out;
}

async function cap(promise, n) {
  try { const r = await promise; return Array.isArray(r) ? r.slice(0, n) : []; }
  catch { return []; }
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
async function fetchWikipedia(q) {
  const url = "https://en.wikipedia.org/w/rest.php/v1/search/page?q=" + encodeURIComponent(q) + "&limit=1";
  const data = await getJson(url);
  const p = (data?.pages || []).find(x => x?.key && x?.title);
  if (!p) return [];
  // Pull the real summary paragraph so Wikipedia is usable evidence, not just a link.
  let extract = (p.description || "").trim();
  try {
    const sum = await getJson("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(p.key));
    if (sum?.extract) extract = sum.extract.trim();
  } catch {}
  return [{
    title: p.title,
    url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(p.key),
    publisher: "Wikipedia", kind: "reference",
    evidence_text: extract,
  }];
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

// --- SEC EDGAR: public company filings WITH text highlights -----------------
async function fetchEdgar(q) {
  const url = "https://efts.sec.gov/LATEST/search-index?q=" + encodeURIComponent(q) +
    "&forms=10-K,8-K&dateRange=custom&startdt=2022-01-01";
  const data = await getJson(url);
  return (data?.hits?.hits || []).slice(0, 3).flatMap(h => {
    const src    = h._source || {};
    const entity = (src.display_names?.[0] || src.entity_name || "")
      .replace(/\s*\(CIK\s*[\d]+\)/i, "").trim();
    if (!entity) return [];
    const snippet   = (h.highlight?.file_contents?.[0] || "")
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const formType  = src.form_type || "";
    const year      = (src.file_date || "").slice(0, 4);
    const cikMatch  = (src.display_names?.[0] || "").match(/CIK\s*0*(\d+)/i);
    const cik       = cikMatch?.[1];
    const filingUrl = cik
      ? "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=" + cik +
        "&type=" + encodeURIComponent(formType) + "&dateb=&owner=include&count=5"
      : "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=" +
        encodeURIComponent(entity) + "&type=" + encodeURIComponent(formType) +
        "&dateb=&owner=include&count=5";
    return [{
      title: entity + (formType ? " — " + formType : ""),
      url: filingUrl,
      publisher: ["SEC EDGAR", formType, year].filter(Boolean).join(" · "),
      kind: "government",
      evidence_text: snippet,
      year: year ? Number(year) : null,
    }];
  });
}

// --- World Bank Documents: reports and working papers WITH abstracts ---------
async function fetchWorldBank(q) {
  const url = "https://search.worldbank.org/api/v2/wds?format=json&q=" + encodeURIComponent(q) +
    "&fl=docdt,docty,titl,abstracts,repnme,url&rows=3&os=0";
  const data = await getJson(url);
  const rawDocs = data?.documents;
  const docs = Array.isArray(rawDocs)
    ? rawDocs
    : Object.values(rawDocs || {}).filter(d => d && typeof d === "object" && typeof d.titl === "string");
  return docs.slice(0, 3).flatMap(d => {
    const title = (d.titl || "").trim();
    if (!title || !d.url) return [];
    const abstract = (Array.isArray(d.abstracts) ? d.abstracts[0] : (d.abstracts || ""))
      .replace(/\s+/g, " ").trim();
    const year = (d.docdt || "").slice(0, 4);
    return [{
      title, url: d.url,
      publisher: ["World Bank", d.repnme, year].filter(Boolean).join(" · "),
      kind: "government",
      evidence_text: abstract,
      year: year ? Number(year) : null,
    }];
  });
}

// --- Congressional Research Service: non-partisan policy analysis ------------
async function fetchCRS(q) {
  const url = "https://www.everycrsreport.com/search.json?q=" + encodeURIComponent(q) + "&n=3";
  const data = await getJson(url);
  return (data?.results || []).flatMap(r => {
    const title  = (r.title || "").trim();
    const crsUrl = r.url || "";
    if (!title || !crsUrl) return [];
    const summary = (r.summary || "").replace(/\s+/g, " ").trim();
    const year    = (r.updated || r.date || "").slice(0, 4);
    return [{
      title, url: crsUrl,
      publisher: ["Congressional Research Service", year].filter(Boolean).join(" · "),
      kind: "government",
      evidence_text: summary,
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

// --- UK Parliament Bills: primary legislation WITH long-title descriptions ---
async function fetchUKParliament(q) {
  const url = "https://bills-api.parliament.uk/api/v1/Bills?SearchTerm=" +
    encodeURIComponent(q) + "&Take=3&Skip=0";
  const data = await getJson(url);
  return (data?.items || []).flatMap(b => {
    const title = (b.shortTitle || "").trim();
    if (!title) return [];
    const longTitle = (b.longTitle || "").replace(/\s+/g, " ").trim();
    const year      = (b.lastUpdate || "").slice(0, 4);
    return [{
      title,
      url: "https://bills.parliament.uk/bills/" + b.billId,
      publisher: ["UK Parliament", b.currentHouse, year].filter(Boolean).join(" · "),
      kind: "government",
      evidence_text: longTitle,
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
