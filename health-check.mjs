// health-check.mjs — independent ground-truth verifier for FlipSide.
//
// PURPOSE: This script exists so you do NOT have to trust Claude's word about the
// state of the project. It reads the ACTUAL files, the ACTUAL git state, and runs
// the ACTUAL tests, then prints facts you can read yourself. If Claude ever claims
// something that isn't real, this script will disagree with it.
//
// RUN IT ANY TIME:   node health-check.mjs
//
// It checks five things:
//   1. GIT      — what branch you're on, whether your work is committed and pushed
//   2. SYNTAX   — every core JS file parses without errors
//   3. TESTS    — the unit tests actually pass
//   4. FEATURES — specific things Claude claims to have built are really in the code
//   5. VERSION  — the manifest version (what would ship to the Chrome Web Store)
//
// A green ALL CLEAR at the bottom means the codebase matches what was promised.
// Any ✗ FAIL line is something to ask Claude about.

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const results = [];
const pass = (name, detail = "") => results.push({ name, ok: true, detail });
const fail = (name, detail = "") => results.push({ name, ok: false, detail });

function run(cmd) {
  try { return { ok: true, out: execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim() }; }
  catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || e.message || "") }; }
}

function section(title) { console.log("\n\x1b[1m" + title + "\x1b[0m"); }
function line(ok, text) {
  const mark = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗ FAIL\x1b[0m";
  console.log("  " + mark + "  " + text);
}

console.log("\n\x1b[1m═══ FlipSide Health Check ═══\x1b[0m");
console.log("Reads the real codebase so you can verify it independently.\n");

// ── 1. GIT ────────────────────────────────────────────────────────────────────
section("1. GIT — is your work saved and pushed?");

const branch = run("git rev-parse --abbrev-ref HEAD");
if (branch.ok) { line(true, "On branch: " + branch.out); pass("branch"); }
else { line(false, "Not a git repo or git unavailable"); fail("branch"); }

const status = run("git status --porcelain");
if (status.ok) {
  if (status.out === "") { line(true, "Working tree CLEAN — every change is committed"); pass("clean"); }
  else {
    const n = status.out.split("\n").length;
    line(false, `${n} uncommitted change(s) — work is NOT yet saved to git:`);
    status.out.split("\n").forEach(l => console.log("        " + l));
    fail("clean");
  }
}

// Did pushes actually land on GitHub? Compare local HEAD to origin.
run("git fetch --quiet"); // best-effort; ignored if offline
const ahead = run("git rev-list --count @{u}..HEAD 2>/dev/null || git rev-list --count origin/main..HEAD");
const behind = run("git rev-list --count HEAD..@{u} 2>/dev/null || git rev-list --count HEAD..origin/main");
if (ahead.ok && /^\d+$/.test(ahead.out)) {
  if (ahead.out === "0") { line(true, "All local commits are pushed to GitHub"); pass("pushed"); }
  else { line(false, `${ahead.out} commit(s) committed locally but NOT pushed to GitHub`); fail("pushed"); }
} else {
  line(true, "Could not compare to remote (offline?) — skipped");
}

const log = run('git log -5 --pretty=format:"%h  %s"');
if (log.ok) {
  console.log("\n    Last 5 commits (what Claude actually committed):");
  log.out.split("\n").forEach(l => console.log("        " + l));
}

// ── 2. SYNTAX ───────────────────────────────────────────────────────────────────
section("2. SYNTAX — does every core file parse?");

const coreFiles = [
  "src/background/service-worker.js",
  "src/lib/sources.js",
  "src/lib/api-client.js",
  "src/lib/prompt.js",
  "src/content/main.js",
  "src/content/ui/panel.js",
  "worker/index.js",
  "src/lib/evidence-id.js",
  "src/lib/provenance.js",
  "src/lib/claim-attribution.js",
  "src/lib/cache-schema.js",
];
for (const f of coreFiles) {
  if (!existsSync(f)) { line(false, `${f} — MISSING`); fail("syntax:" + f); continue; }
  const r = run(`node --check "${f}"`);
  if (r.ok) { line(true, f); pass("syntax:" + f); }
  else { line(false, `${f} — ${r.out.split("\n")[0]}`); fail("syntax:" + f); }
}

// ── 3. TESTS ────────────────────────────────────────────────────────────────────
section("3. TESTS — do the unit tests pass?");

const testFiles = ["test/provenance.test.mjs", "test/prompt-sync.test.mjs", "test/inline-citations.test.mjs"];
for (const t of testFiles) {
  if (!existsSync(t)) { line(false, `${t} — MISSING`); fail("test:" + t); continue; }
  const r = run(`node --test "${t}"`);
  const passed = /# pass \d+/.test(r.out) && !/# fail [1-9]/.test(r.out);
  const m = r.out.match(/# (pass \d+).*?# (fail \d+)/s);
  const summary = m ? `${m[1]}, ${m[2]}` : (r.ok ? "passed" : "failed");
  if (passed) { line(true, `${t} (${summary})`); pass("test:" + t); }
  else { line(false, `${t} (${summary}) — run: node --test ${t}`); fail("test:" + t); }
}

// ── 4. FEATURES ─────────────────────────────────────────────────────────────────
// Each entry verifies a specific claim about what was built. The script reads the
// file and checks the marker string is actually present. This is the anti-hallucination
// core: if Claude said it built X, the marker for X must exist in the named file.
section("4. FEATURES — are the claimed features actually in the code?");

const featureChecks = [
  ["Claim attribution helpers", "src/lib/claim-attribution.js", ["claimAttributionFields", "claimWithAttribution", "panelClaims"]],
  ["Cache schema versioning", "src/lib/cache-schema.js", ["ensureAnalysisCacheSchema", "LOCAL_ANALYSIS_SCHEMA_VERSION"]],
  ["Attribution parsing in classify", "src/lib/api-client.js", ["CLAIM_HOLDERS", "claim_holder", "article_stance"]],
  ["challengeTargetLabel in prompt", "src/lib/prompt.js", ["challengeTargetLabel"]],
  ["challengeTargetLabel mirrored in worker", "worker/index.js", ["challengeTargetLabel"]],
  ["Worker cache bumped to v19", "worker/index.js", ['CACHE_KEY_VERSION_STABLE', "v19"]],
  ["Wikipedia entity-title search", "src/lib/sources.js", ["articleTitle", "fetchWikipedia(wikiQ"]],
  ["Wikipedia zero-coverage gate", "src/lib/sources.js", ["zero query-term overlap", "qTokens"]],
  ["Self-link title filter", "src/lib/sources.js", ["self-link", "articleTitleTokens"]],
  ["Politics topic routing", "src/lib/sources.js", ['["politics"].includes(t)']],
  ["Claim-holder pill in panel", "src/content/ui/panel.js", ["renderClaimHolder", "ec-claim-holder"]],
  ["Inline citations module", "src/lib/inline-citations.js", ["applyInlineCitations"]],
  ["Inline citations wired in worker", "src/background/service-worker.js", ["applyInlineCitations"]],
  ["Inline citation markers in panel", "src/content/ui/panel.js", ["renderSummaryWithCites", "ec-cite"]],
];
for (const [label, file, markers] of featureChecks) {
  if (!existsSync(file)) { line(false, `${label} — ${file} MISSING`); fail("feat:" + label); continue; }
  const src = readFileSync(file, "utf8");
  const missing = markers.filter(m => !src.includes(m));
  if (missing.length === 0) { line(true, `${label} (${file})`); pass("feat:" + label); }
  else { line(false, `${label} — missing in ${file}: ${missing.join(", ")}`); fail("feat:" + label); }
}

// ── 5. VERSION ──────────────────────────────────────────────────────────────────
section("5. VERSION — what would ship to the Chrome Web Store?");
try {
  const mf = JSON.parse(readFileSync("manifest.json", "utf8"));
  line(true, `manifest.json version: ${mf.version}  (name: "${mf.name}")`);
  pass("version");
} catch (e) {
  line(false, "Could not read manifest.json: " + e.message);
  fail("version");
}

// ── VERDICT ─────────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
console.log("\n\x1b[1m═══ VERDICT ═══\x1b[0m");
if (failed.length === 0) {
  console.log("\x1b[32m\x1b[1m  ✓ ALL CLEAR — codebase matches what was promised.\x1b[0m");
  console.log(`  ${results.length} checks passed.\n`);
  process.exit(0);
} else {
  console.log(`\x1b[31m\x1b[1m  ✗ ${failed.length} CHECK(S) FAILED — ask Claude about these:\x1b[0m`);
  failed.forEach(r => console.log("      - " + r.name + (r.detail ? ": " + r.detail : "")));
  console.log("");
  process.exit(1);
}
