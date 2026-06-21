// run-corpus.js — FlipSide article regression runner
//
// Usage:
//   node test/articles/run-corpus.js
//   node test/articles/run-corpus.js --category=politics
//   node test/articles/run-corpus.js --dry-run
//
// Skips entries where url_verified:false unless --include-unverified is passed.
// Saves full results to test/articles/last-run.json.
// Exits with code 1 if any entries FAIL.

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dir, "corpus.json");
const RESULTS_PATH = join(__dir, "last-run.json");
const WORKER_URL = "https://epistemic-companion-proxy.salvatoreducksamurai96.workers.dev";
const FAKE_ORIGIN = "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const includeUnverified = args.includes("--include-unverified");
const categoryFilter = (args.find(a => a.startsWith("--category=")) || "").replace("--category=", "") || null;

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));

function stripHtml(html) {
  return html
    .replace(/<(script|style|nav|header|footer|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html) {
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (t) return t[1].trim();
  const h = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  return h ? h[1].trim() : "";
}

async function fetchArticle(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; FlipSideTest/1.0)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  return { title: extractTitle(html), text: stripHtml(html).slice(0, 9000) };
}

async function classify(url, title, text) {
  const resp = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": FAKE_ORIGIN },
    body: JSON.stringify({ stage: "classify", title, text, url, citation_schema: "stable-v1" }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Worker ${resp.status}`);
  const data = await resp.json();
  if (!data.content) throw new Error("No content in worker response");
  return JSON.parse(data.content);
}

function compare(actual, expected, field) {
  if (expected[field] === undefined) return null;
  return actual[field] === expected[field] ? "PASS" : "FAIL";
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pad(str, n) { return String(str ?? "").slice(0, n).padEnd(n); }

const results = [];
let passed = 0, failed = 0, skipped = 0;

console.log(`\nFlipSide Corpus Runner${dryRun ? " [DRY RUN]" : ""}${categoryFilter ? ` [category=${categoryFilter}]` : ""}\n`);
console.log(pad("ID", 18) + pad("category", 16) + pad("analyzable", 12) + pad("claim_holder", 18) + pad("article_stance", 16) + "RESULT");
console.log("─".repeat(96));

for (const entry of corpus) {
  if (categoryFilter && entry.category !== categoryFilter) continue;

  if (!entry.url_verified && !includeUnverified) {
    console.log(pad(entry.id, 18) + pad(entry.category, 16) + "─".repeat(46) + " SKIP (url_verified:false)");
    skipped++;
    results.push({ ...entry, status: "SKIP", reason: "url_verified:false" });
    continue;
  }

  if (dryRun) {
    console.log(pad(entry.id, 18) + pad(entry.category, 16) + pad(entry.expected.analyzable, 12) + pad(entry.expected.claim_holder, 18) + pad(entry.expected.article_stance, 16) + "DRY");
    skipped++;
    results.push({ ...entry, status: "DRY" });
    continue;
  }

  await sleep(1500); // avoid rate-limiting the worker

  let actual, fetchError;
  try {
    const { title, text } = await fetchArticle(entry.url);
    actual = await classify(entry.url, title, text);
  } catch (err) {
    fetchError = err.message;
  }

  if (fetchError || !actual) {
    console.log(pad(entry.id, 18) + pad(entry.category, 16) + "─".repeat(46) + ` ERROR: ${fetchError}`);
    failed++;
    results.push({ ...entry, status: "ERROR", error: fetchError });
    continue;
  }

  const notAnalyzable = actual.analyzable === false;
  const checks = {
    analyzable: compare(actual, entry.expected, "analyzable"),
    // skip attribution checks for non-analyzable articles — classifier returns "unclear" for those by design
    claim_holder: notAnalyzable ? null : compare(actual, entry.expected, "claim_holder"),
    article_stance: notAnalyzable ? null : compare(actual, entry.expected, "article_stance"),
  };

  const overallPass = Object.values(checks).filter(Boolean).every(v => v === "PASS");
  const status = overallPass ? "PASS" : "FAIL";
  if (overallPass) passed++; else failed++;

  const chResult = checks.claim_holder === "PASS" ? "✓" : checks.claim_holder === "FAIL" ? `✗(${actual.claim_holder})` : "-";
  const asResult = checks.article_stance === "PASS" ? "✓" : checks.article_stance === "FAIL" ? `✗(${actual.article_stance})` : "-";
  const anResult = checks.analyzable === "PASS" ? "✓" : checks.analyzable === "FAIL" ? `✗(${actual.analyzable})` : "-";

  console.log(
    pad(entry.id, 18) +
    pad(entry.category, 16) +
    pad(anResult, 12) +
    pad(chResult, 18) +
    pad(asResult, 16) +
    status
  );

  results.push({ ...entry, status, actual, checks });
}

console.log("─".repeat(96));
console.log(`\n${passed} passed · ${failed} failed · ${skipped} skipped\n`);

writeFileSync(RESULTS_PATH, JSON.stringify({ ran_at: new Date().toISOString(), results }, null, 2));
console.log(`Full results saved to test/articles/last-run.json\n`);

if (failed > 0) process.exit(1);
