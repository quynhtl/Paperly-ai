// The instructions every turn starts from: the paper's key, and only the
// tools the session really has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../../src/modules/agent/prompt.ts";

test("a paper's prompt names its key and pins it", () => {
  const prompt = buildSystemPrompt({
    paper: { libraryID: 1, key: "ABCD1234", title: "Attention Is All You Need" },
    authors: "Ashish Vaswani, Noam Shazeer",
    year: "2017",
    webSearch: true,
    today: "2026-10-04",
  });
  assert.match(prompt, /"Attention Is All You Need" by Ashish Vaswani, Noam Shazeer \(2017\)/);
  assert.match(prompt, /item key is ABCD1234/);
  assert.match(prompt, /even if the user switches tabs/);
  assert.match(prompt, /WebSearch searches the web/);
  assert.match(prompt, /only after the user presses Allow/);
  assert.match(prompt, /Today is 2026-10-04/);
});

test("the library prompt, and no web search when it is off", () => {
  const prompt = buildSystemPrompt({ paper: null, webSearch: false, today: "2026-10-04" });
  assert.match(prompt, /No paper is open/);
  assert.match(prompt, /cannot search the web/);
  assert.doesNotMatch(prompt, /WebSearch searches/);
});
