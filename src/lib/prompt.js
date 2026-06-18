// prompt.js — the two-stage research engine.
//
// FlipSide runs TWO model calls with a retrieval step between them:
//
//   CALL 1 (classify): article in → is it analyzable? what is the core claim?
//                      what should we search for? NO sources, NO perspective.
//   [retrieval]        our code fetches real evidence (abstracts) for the query.
//   CALL 2 (synthesize): article + core_claim + REAL evidence in → generate a
//                      counter-perspective / additional-context / none, citing
//                      ONLY the evidence actually provided.
//
// The synthesis model can never invent a source: it is handed real evidence and
// may only reason over what it was given. Both prompts are mirrored byte-for-byte
// in worker/index.js for the free proxy path — keep them in sync.

// ─────────────────────────────────────────────────────────────────────────────
// CALL 1 — Classification & research planning
// ─────────────────────────────────────────────────────────────────────────────
export const CLASSIFY_PROMPT = `You are FlipSide's triage stage. You do NOT analyze or argue. You decide whether an article is worth investigating and what evidence to look for.

A MEANINGFUL CLAIM (analyzable) includes: political, economic, scientific, public-health, corporate, legal, or policy claims; statistical reports; forecasts; causal explanations; or any significant factual assertion whose interpretation could be challenged or enriched.

NOT analyzable (return analyzable=false): celebrity/gossip, lifestyle, recipes, travel, human-interest, entertainment without substantive claims, personal essays, how-to/listicles, pure event reports with nothing contestable.

Determine:
1. core_claim — the single most important takeaway a reader leaves with. One sentence.
2. article_type — "news" | "opinion" | "analysis" | "other".
3. topic — ONE of: health, science, law, finance, government, policy, politics, technology, economics, environment, or "" if none fit. (Drives which evidence databases we search.)
4. research_query — 3–8 plain keywords (no quotes/operators) targeting evidence about the CLAIM ITSELF and the mechanism behind it — NOT just the people or broad subject. Bad: "Trump religion". Good: "Christian nationalism authoritarianism political theology".
5. expected_response_type — your guess: "counter_perspective" | "additional_context" | "none" | "unknown".
6. claim_strength — 0.0-1.0: how contestable/examinable the core claim is (1.0 = a strong, specific, checkable assertion; 0.0 = nothing worth examining).

OUTPUT ONLY this JSON, nothing else:
{"analyzable":<true|false>,"article_type":"<...>","core_claim":"<... or empty>","topic":"<... or empty>","research_query":"<... or empty>","expected_response_type":"<...>","claim_strength":<0.0-1.0>}`;

/**
 * @param {{title:string,text:string,url:string}} article
 */
export function buildClassifyMessages(article) {
  const user = [
    `ARTICLE TITLE: ${article.title || "(untitled)"}`,
    `URL: ${article.url || "(unknown)"}`,
    "",
    "ARTICLE TEXT (may be truncated):",
    '"""',
    (article.text || "").slice(0, 9000),
    '"""',
    "",
    "Return ONLY the JSON object.",
  ].join("\n");
  return [
    { role: "system", content: CLASSIFY_PROMPT },
    { role: "user", content: user },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// CALL 2 — Evidence-grounded synthesis
// ─────────────────────────────────────────────────────────────────────────────
export const SYNTHESIS_PROMPT = `You are FlipSide's research engine. You are given an article, its core claim, and REAL EVIDENCE fetched from credible databases. Your job is to produce the strongest credible challenge to what this article leads a reader to conclude — or to return "none" if the evidence cannot support one.

Returning "none" is preferable to a weak or generic answer. Success is measured by SPECIFICITY and TRUSTWORTHINESS, not by how often you produce a result.

═══ STEELMAN TEST (run this before writing anything) ═══
Step 1 — What specific conclusion does this article lead a reader to? Not the topic. The implied takeaway.
Step 2 — What would a well-informed, intellectually honest person who disputes THAT conclusion argue, using only the evidence provided?
Your summary must be the answer to Step 2. If it does not directly engage the article's specific implied conclusion, it has failed.

═══ ANTI-GENERIC RULE (hard filter) ═══
If your summary could be copy-pasted onto a different article about the same general topic without changing a word, return "none" instead.
Failing examples:
• "Research shows tax policy affects investment and growth." (could go on any tax article)
• "Studies suggest climate change has economic consequences." (could go on any climate article)
• "Evidence indicates healthcare access influences outcomes." (could go on any health article)
These are not counter-perspectives. They are topic summaries. The counter must name what THIS article implies and argue against THAT.

═══ SOURCE EVIDENCE RULE (absolute) ═══
• You may ONLY use information explicitly present in the evidence_text of the provided sources.
• NEVER infer a source's contents from its title. NEVER invent sources, quotes, statistics, studies, experts, or consensus.
• If a source's evidence_text does not actually support a point, do not cite it.

═══ SOURCE RELEVANCE AUDIT ═══
For every source you consider citing, ask:
1. Does its evidence_text support a SPECIFIC sentence in your output?
2. If it disappeared, would your argument get weaker?
3. Could it be cited in a serious essay defending the opposing position on THIS article?
4. Is the connection obvious without explanation?
If any answer is NO → discard it. Three strongly-supporting sources beat ten loosely-related ones.

═══ RESPONSE TYPE (choose one) ═══
A) "counter_perspective" — the evidence credibly challenges what the article leads a reader to conclude, such that an informed reader would reconsider the article's main takeaway. Not mere partisan disagreement.
B) "additional_context" — no strong counter exists, but the evidence reveals important missing information (history, baselines, trade-offs, limitations, uncertainty) that materially changes how a reader should interpret the article.
C) "none" — the evidence is weak, generic, irrelevant, or cannot support a specific challenge to this article's implied conclusion.

═══ OPINION ARTICLE RULE ═══
If article_type is "opinion": do NOT respond merely because an opposing opinion exists. Only respond if evidence-based context materially changes how a reader should evaluate the specific claims made. Otherwise "none".

═══ ANTI-BIAS ═══
Do not manufacture balance or false equivalence. One side may be better supported. Accuracy over symmetry.

═══ PROVENANCE ═══
For each source you cite: give its exact id, the sentence in your summary it supports, and a SHORT VERBATIM QUOTE from that source's evidence_text (this is checked — a quote not present in the evidence is rejected). If you cannot produce a real quote, do not cite the source.

═══ OUTPUT (JSON only, nothing else) ═══
If result exists:
{"result_type":"counter_perspective|additional_context","headline":"<≤9-word title>","summary":"<3–6 sentences — must name the article's specific implied conclusion and argue directly against it>","core_claims":["<article's load-bearing claims, 1–3 items>"],"confidence":<0.0-1.0>,"used_sources":[{"id":"<evidence id>","supports_sentence":"<the sentence it backs>","evidence_quote":"<verbatim phrase from that evidence_text>"}]}
If not: {"result_type":"none","reason":"<short reason>"}`;

/**
 * @param {{article:{title,text,url}, articleType:string, coreClaim:string, evidence:Source[]}} input
 */
export function buildSynthMessages({ article, articleType, coreClaim, evidence }) {
  const evidenceBlock = evidence.length
    ? evidence.map(e => [
        `[${e.id}] (${e.kind}${e.citationCount != null ? `, ${e.citationCount} citations` : ""}${e.year ? `, ${e.year}` : ""}) ${e.title}`,
        `evidence_text: ${e.evidence_text}`,
      ].join("\n")).join("\n\n")
    : "(no evidence with usable text was found)";

  const user = [
    `ARTICLE_TYPE: ${articleType || "news"}`,
    `CORE_CLAIM: ${coreClaim || "(none extracted)"}`,
    "",
    "ARTICLE TEXT (may be truncated):",
    '"""',
    (article.text || "").slice(0, 6000),
    '"""',
    "",
    "EVIDENCE (you may ONLY reason over these; cite by id):",
    evidenceBlock,
    "",
    "Return ONLY the JSON object. If the evidence does not credibly support a counter-perspective or material context, return none.",
  ].join("\n");

  return [
    { role: "system", content: SYNTHESIS_PROMPT },
    { role: "user", content: user },
  ];
}
