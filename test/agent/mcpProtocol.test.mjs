// The MCP server logic on its own, as claude 2.1.258 and codex 0.144.6 talk
// to it (the request sequence below is the one recorded from claude).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSIONS,
  checkToolArguments,
  handleMcpMessage,
  negotiateProtocolVersion,
  sameSecret,
} from "../../src/modules/agent/mcpProtocol.ts";

const readPages = {
  name: "read_pages",
  description: "Text of pages.",
  inputSchema: {
    type: "object",
    properties: {
      item_key: { type: "string" },
      from: { type: "integer", minimum: 1 },
      to: { type: "integer", minimum: 1 },
    },
    required: ["item_key", "from"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

function host(calls = []) {
  return {
    serverInfo: { name: "paperly", version: "1.0.0" },
    instructions: "Use the item key.",
    tools: () => [readPages],
    async call(name, args) {
      calls.push([name, args]);
      if (args.from === 13) {
        throw new Error("the reader went away");
      }
      return { text: `[page ${args.from}]\n…` };
    },
  };
}

test("the sequence claude sends: discover, initialize, initialized, list, call", async () => {
  const calls = [];
  const h = host(calls);
  const discover = await handleMcpMessage({ jsonrpc: "2.0", id: "server-discover-probe-1", method: "server/discover", params: {} }, h);
  assert.equal(discover.error.code, -32601, "unknown method makes a newer client fall back");

  const init = await handleMcpMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code" } } }, h);
  assert.equal(init.result.protocolVersion, "2025-11-25");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, "paperly");
  assert.equal(init.result.instructions, "Use the item key.");

  assert.equal(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, h), null);

  const list = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, h);
  assert.equal(list.result.tools[0].name, "read_pages");

  const call = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_pages", arguments: { item_key: "ABCD1234", from: 3 } } }, h);
  assert.deepEqual(call.result, { content: [{ type: "text", text: "[page 3]\n…" }] });
  assert.deepEqual(calls, [["read_pages", { item_key: "ABCD1234", from: 3 }]]);
});

test("protocol versions: the client's when known, else the newest", () => {
  assert.equal(negotiateProtocolVersion("2024-11-05"), "2024-11-05");
  assert.equal(negotiateProtocolVersion("2031-01-01"), PROTOCOL_VERSIONS[0]);
  assert.equal(negotiateProtocolVersion(undefined), PROTOCOL_VERSIONS[0]);
});

test("bad calls get answers the model can act on", async () => {
  const h = host();
  const unknown = await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "delete_everything", arguments: {} } }, h);
  assert.equal(unknown.error.code, -32602);

  const missing = await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_pages", arguments: { from: 1 } } }, h);
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /item_key/);

  const wrongType = await handleMcpMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_pages", arguments: { item_key: "A", from: "3" } } }, h);
  assert.match(wrongType.result.content[0].text, /whole number/);

  const thrown = await handleMcpMessage({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "read_pages", arguments: { item_key: "A", from: 13 } } }, h);
  assert.equal(thrown.result.isError, true);
  assert.match(thrown.result.content[0].text, /reader went away/);

  const notArgs = await handleMcpMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_pages", arguments: [1] } }, h);
  assert.equal(notArgs.error.code, -32602);
});

test("argument checks: ranges and unknown names", () => {
  assert.match(checkToolArguments(readPages, { item_key: "A", from: 0 }), /at least 1/);
  assert.match(checkToolArguments(readPages, { item_key: "A", from: 1, page: 2 }), /Unknown argument "page"/);
  assert.equal(checkToolArguments(readPages, { item_key: "A", from: 1, to: 2 }), null);
});

test("invalid requests, responses and batches", async () => {
  const h = host();
  assert.equal((await handleMcpMessage("nope", h)).error.code, -32600);
  assert.equal((await handleMcpMessage({ id: 1, method: "ping" }, h)).error.code, -32600);
  assert.equal(await handleMcpMessage({ jsonrpc: "2.0", id: 9, result: {} }, h).then((reply) => reply.error.code), -32600);
  const batch = await handleMcpMessage([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/cancelled" },
  ], h);
  assert.deepEqual(batch, [{ jsonrpc: "2.0", id: 1, result: {} }]);
  assert.equal(await handleMcpMessage([{ jsonrpc: "2.0", method: "notifications/x" }], h), null);
});

test("secrets compare whole", () => {
  assert.equal(sameSecret("abc123", "abc123"), true);
  assert.equal(sameSecret("abc123", "abc124"), false);
  assert.equal(sameSecret("abc123", "abc1234"), false);
  assert.equal(sameSecret("", ""), false);
  assert.equal(sameSecret(undefined, "x"), false);
});
