import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Load prompts from the authoritative source (src/lib/prompt.js).
// We can't use a dynamic import of an ES module easily here, so we read the
// source file and extract the prompt strings with a regex instead.
const promptSrc = readFileSync(resolve(root, "src/lib/prompt.js"), "utf8");
const workerSrc = readFileSync(resolve(root, "worker/index.js"), "utf8");

function extractPrompt(src, exportName) {
  // Match: export const NAME = `...`; (backtick template literal, no interpolations)
  const re = new RegExp(`export const ${exportName} = \`([\\s\\S]*?)\`;\\s*\\n`);
  const m = src.match(re);
  if (!m) throw new Error(`Could not extract ${exportName} from prompt.js`);
  return m[1];
}

const CLASSIFY_PROMPT   = extractPrompt(promptSrc, "CLASSIFY_PROMPT");
const SYNTHESIS_PROMPT  = extractPrompt(promptSrc, "SYNTHESIS_PROMPT");

test("CLASSIFY_PROMPT is in worker verbatim", () => {
  assert.ok(
    workerSrc.includes(CLASSIFY_PROMPT),
    "CLASSIFY_PROMPT not found verbatim in worker/index.js — run a sync update"
  );
});

test("SYNTHESIS_PROMPT is in worker verbatim", () => {
  assert.ok(
    workerSrc.includes(SYNTHESIS_PROMPT),
    "SYNTHESIS_PROMPT not found verbatim in worker/index.js — run a sync update"
  );
});
