// The stream parsers against output recorded from claude 2.1.258 and
// codex-cli 0.144.6 (fixtures/, with machine paths and installed skills
// removed), plus hand-made lines for the cases a recording can't provoke.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyClaudeError,
  classifyCodexError,
  createClaudeMapper,
  createCodexMapper,
  createLineSplitter,
  toolOutputPreview,
} from "../../src/modules/agent/streamParser.ts";

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function run(mapperFactory, text, options) {
  const events = [];
  const handle = mapperFactory((event) => events.push(event), options);
  const results = [];
  const splitter = createLineSplitter((line) => results.push(handle(JSON.parse(line))));
  // Feed it in awkward pieces, the way a pipe delivers it.
  for (let index = 0; index < text.length; index += 37) {
    splitter.push(text.slice(index, index + 37));
  }
  splitter.flush();
  return { events, aborted: results.includes("abort") };
}

const paperlyOnly = (name) => name.startsWith("mcp__paperly__") || name === "WebSearch";

test("line splitter: whole lines only, any chunking, CRLF, trailing line", () => {
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push('{"a":');
  splitter.push('1}\r\n\n{"b"');
  splitter.push(":2}\n{");
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  splitter.push('"c":3}');
  splitter.flush();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("claude: a plain reply streams as text and ends with usage", () => {
  const { events } = run(createClaudeMapper, fixture("claude-hello.jsonl"), { isToolAllowed: paperlyOnly });
  const session = events.find((event) => event.type === "session");
  assert.equal(session.sessionId.length, 36);
  assert.deepEqual(session.tools, []);
  assert.equal(session.authSource, "none");
  const text = events.filter((event) => event.type === "text").map((event) => event.delta).join("");
  assert.equal(text, "hello Paperly");
  const firstText = events.find((event) => event.type === "text");
  assert.equal(firstText.newBlock, true);
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.ok, true);
  assert.equal(done.text, "hello Paperly");
  assert.ok(done.inputTokens > 0 && done.outputTokens > 0);
  assert.match(done.model, /^claude-/);
});

test("claude: a tool call is announced early, gets its input, then its result", () => {
  const { events } = run(createClaudeMapper, fixture("claude-tool-stream.jsonl"), { isToolAllowed: paperlyOnly });
  const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
  assert.equal(toolEvents[0].type, "tool_started");
  assert.equal(toolEvents[0].name, "mcp__paperly__echo_page");
  assert.equal(toolEvents[0].input, undefined, "announced before the input is known");
  const withInput = toolEvents.find((event) => event.type === "tool_started" && event.input);
  assert.deepEqual(withInput.input, { text: "x = 1" });
  const done = toolEvents.find((event) => event.type === "tool_done");
  assert.equal(done.ok, true);
  assert.equal(done.output, "[page 1]\nx = 1");
  assert.equal(done.id, toolEvents[0].id);
  // The reply after the tool is one new block, not duplicated by the
  // assistant frame that repeats it.
  const texts = events.filter((event) => event.type === "text");
  assert.equal(texts.filter((event) => event.newBlock).length, 1);
  const reply = texts.map((event) => event.delta).join("");
  assert.match(reply, /\$E=mc\^2\$/);
  assert.equal((reply.match(/The tool returned/g) || []).length, 1);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).ok, true);
});

test("claude: an unknown model is reported once, as a model error", () => {
  const { events } = run(createClaudeMapper, fixture("claude-bad-model.jsonl"));
  const errors = events.filter((event) => event.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, "model");
  assert.match(errors[0].message, /claude-nonexistent-9/);
  const done = events.at(-1);
  assert.equal(done.ok, false);
  assert.equal(done.errorKind, undefined, "already reported by the error frame");
});

test("claude: a lost session is recognised so it can be restarted", () => {
  const { events } = run(createClaudeMapper, fixture("claude-resume-missing.jsonl"));
  const done = events.at(-1);
  assert.equal(done.ok, false);
  assert.equal(done.errorKind, "session_lost");
  assert.match(done.message, /No conversation found/);
});

test("claude: a session that starts with a tool Paperly didn't give it is aborted", () => {
  const line = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "s",
    tools: ["mcp__paperly__read_pages", "Bash"],
  });
  const { events, aborted } = run(createClaudeMapper, line + "\n", { isToolAllowed: paperlyOnly });
  assert.equal(aborted, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "unsafe");
  assert.match(events[0].message, /Bash/);
});

test("claude: subagent and replayed lines are ignored; thinking streams", () => {
  const lines = [
    { type: "stream_event", parent_tool_use_id: "t1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "sub" } } },
    { type: "user", isReplay: true, message: { content: [{ type: "tool_result", tool_use_id: "x", content: "no" }] } },
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Let me see" } } },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "Let me see" }] } },
    { type: "system", subtype: "api_retry", attempt: 2, retry_delay_ms: 500, error: "overloaded" },
    { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1700000000, rateLimitType: "five_hour" } },
  ];
  const { events } = run(createClaudeMapper, lines.map((line) => JSON.stringify(line)).join("\n"));
  assert.deepEqual(events, [
    { type: "thinking", delta: "Let me see", newBlock: true },
    { type: "retry", attempt: 2, delayMs: 500, reason: "overloaded" },
    { type: "rate_limit", status: "allowed_warning", resetsAt: 1700000000, limitType: "five_hour" },
  ]);
});

test("claude: error words map to the right kind", () => {
  assert.equal(classifyClaudeError("authentication_failed", "x"), "not_signed_in");
  assert.equal(classifyClaudeError(undefined, "Invalid API key · Please run /login"), "not_signed_in");
  assert.equal(classifyClaudeError("rate_limit", "x"), "rate_limited");
  assert.equal(classifyClaudeError(undefined, "Claude Code 2.1.2 does not support this model; run claude update"), "update_required");
  assert.equal(classifyClaudeError("model_not_found", "There's an issue with the selected model"), "model");
  assert.equal(classifyClaudeError(undefined, "something else"), "api");
});

test("codex: a tool call and its answer, as Paperly's tool names", () => {
  const { events } = run(createCodexMapper, fixture("codex-tool.jsonl"), { isToolAllowed: paperlyOnly });
  assert.equal(events[0].type, "session");
  assert.match(events[0].sessionId, /^[0-9a-f-]{36}$/);
  const started = events.find((event) => event.type === "tool_started");
  assert.equal(started.name, "mcp__paperly__echo_page");
  assert.deepEqual(started.input, { text: "alpha" });
  const done = events.find((event) => event.type === "tool_done");
  assert.equal(done.ok, true);
  assert.equal(done.output, "[page 1]\nalpha");
  const texts = events.filter((event) => event.type === "text");
  assert.equal(texts.length, 2);
  assert.ok(texts.every((event) => event.newBlock));
  const end = events.at(-1);
  assert.equal(end.type, "done");
  assert.equal(end.ok, true);
  assert.ok(end.inputTokens > 0);
});

test("codex: a shell command is a tool Paperly never gives, so it aborts", () => {
  const line = JSON.stringify({ type: "item.started", item: { id: "i1", type: "command_execution", command: "ls /" } });
  const { events, aborted } = run(createCodexMapper, line + "\n", { isToolAllowed: paperlyOnly });
  assert.equal(aborted, true);
  assert.equal(events[0].kind, "unsafe");
});

test("codex: failures and reconnects", () => {
  const lines = [
    { type: "error", message: "Reconnecting... 2/5" },
    { type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } },
  ];
  const { events } = run(createCodexMapper, lines.map((line) => JSON.stringify(line)).join("\n"));
  assert.deepEqual(events[0], { type: "retry", attempt: 2, reason: "Reconnecting... 2/5" });
  assert.equal(events[1].kind, "rate_limited");
  assert.deepEqual(events[2], { type: "done", ok: false });
  assert.equal(classifyCodexError("Not logged in. Run codex login"), "not_signed_in");
});

test("tool output previews are text, shortened", () => {
  assert.equal(toolOutputPreview([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(toolOutputPreview({ content: [{ type: "text", text: "inner" }] }), "inner");
  const long = toolOutputPreview("x".repeat(2000));
  assert.ok(long.length <= 601 && long.endsWith("…"));
});
