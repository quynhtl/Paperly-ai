// Markdown as Claude and Codex write it, including the half-written text the
// view re-parses while a reply streams in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, inlineText, markdownToNoteHtml, parseInline, parseMarkdown } from "../../src/modules/agent/markdown.ts";

test("headings, paragraphs and rules", () => {
  const blocks = parseMarkdown("# Title\n\nFirst line\nsame paragraph.\n\n---\n\n### Small ###");
  assert.deepEqual(blocks.map((block) => block.t), ["h", "p", "hr", "h"]);
  assert.equal(blocks[0].level, 1);
  assert.equal(inlineText(blocks[1].c), "First line same paragraph.");
  assert.equal(blocks[3].level, 3);
  assert.equal(inlineText(blocks[3].c), "Small");
});

test("nested and numbered lists", () => {
  const [list] = parseMarkdown("1. One\n2. Two\n   - nested a\n   - nested b\n3. Three");
  assert.equal(list.t, "list");
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 3);
  const nested = list.items[1][1];
  assert.equal(nested.t, "list");
  assert.equal(nested.ordered, false);
  assert.equal(nested.items.length, 2);

  const [started] = parseMarkdown("3) third\n4) fourth");
  assert.equal(started.start, 3);

  const [shallow] = parseMarkdown("1. a\n  - b");
  assert.equal(shallow.items[0][1].t, "list", "two-space nesting under a numbered item");
});

test("code fences, finished and still streaming", () => {
  const [code] = parseMarkdown("```python\nprint('<hi>')\n```");
  assert.deepEqual(code, { t: "code", lang: "python", v: "print('<hi>')" });
  const [open] = parseMarkdown("```\nhalf written");
  assert.deepEqual(open, { t: "code", lang: "", v: "half written" });
});

test("display math in every form", () => {
  assert.deepEqual(parseMarkdown("$$\na^2 + b^2\n= c^2\n$$"), [{ t: "math", v: "a^2 + b^2\n= c^2" }]);
  assert.deepEqual(parseMarkdown("$$E = mc^2$$"), [{ t: "math", v: "E = mc^2" }]);
  assert.deepEqual(parseMarkdown("\\[\n\\frac{1}{2}\n\\]"), [{ t: "math", v: "\\frac{1}{2}" }]);
});

test("inline math, but not prices", () => {
  const nodes = parseInline("Let $x_i$ be \\(y\\); it costs $5 and $10.");
  assert.deepEqual(nodes[1], { t: "math", v: "x_i" });
  assert.deepEqual(nodes[3], { t: "math", v: "y", display: false });
  assert.equal(nodes.filter((node) => node.t === "math").length, 2);
  assert.match(inlineText(nodes), /costs \$5 and \$10\./);
});

test("emphasis, code, strike and links", () => {
  const nodes = parseInline("**bold** and *it* and _it2_ and `a*b` and ~~gone~~ and snake_case_name");
  assert.deepEqual(nodes.map((node) => node.t), ["strong", "text", "em", "text", "em", "text", "code", "text", "del", "text"]);
  assert.equal(nodes[6].v, "a*b");
  assert.match(nodes.at(-1).v, /snake_case_name$/);

  const links = parseInline("[paper](https://arxiv.org/abs/1706.03762) [bad](javascript:alert(1)) see https://example.org/x.");
  assert.equal(links[0].t, "link");
  assert.equal(links[0].href, "https://arxiv.org/abs/1706.03762");
  assert.ok(!links.some((node) => node.t === "link" && /javascript/.test(node.href)), "unsafe link becomes text");
  const bare = links.find((node) => node.t === "link" && node.href.startsWith("https://example"));
  assert.equal(bare.href, "https://example.org/x", "trailing period is not part of the URL");
});

test("tables with alignment, and quotes", () => {
  const [table] = parseMarkdown("| Model | BLEU |\n|:--|--:|\n| Base | 27.3 |\n| Big | 28.4 |");
  assert.equal(table.t, "table");
  assert.deepEqual(table.align, ["left", "right"]);
  assert.equal(table.rows.length, 2);
  assert.equal(inlineText(table.rows[1][1]), "28.4");

  const [quote] = parseMarkdown("> quoted\n> more");
  assert.equal(quote.t, "quote");
  assert.equal(inlineText(quote.c[0].c), "quoted more");
});

test("note HTML escapes everything and keeps Zotero's math forms", () => {
  const html = markdownToNoteHtml('Hi <script>alert(1)</script> $x<y$\n\n$$\\sum_i a_i$$\n\n[x](https://e.org/?a="b")', 'T <1>');
  assert.ok(html.startsWith('<div data-schema-version="9"><h1>T &lt;1&gt;</h1>'));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes('<span class="math">$x&lt;y$</span>'));
  assert.ok(html.includes('<pre class="math">$$\\sum_i a_i$$</pre>'));
  assert.ok(html.includes('href="https://e.org/?a=&quot;b&quot;"'));
  assert.equal(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
});
