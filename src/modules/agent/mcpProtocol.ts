// The MCP server side of Paperly Agent: JSON-RPC 2.0 messages in, answers out.
//
// Transport-free on purpose. endpoint.ts feeds it what Zotero's local server
// received; the tests feed it plain objects. Replies are always plain JSON,
// which Streamable HTTP allows -- Zotero's server cannot stream anyway.
//
// No runtime imports: the tests load this file straight into Node.

/** Newest first. Answered with the client's version when it is one of these. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type?: string; description?: string; minimum?: number; maximum?: number; enum?: unknown[] }>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: Record<string, unknown>;
}

export interface McpToolResult {
  text: string;
  isError?: boolean;
}

export interface McpHost {
  serverInfo: { name: string; version: string; title?: string };
  instructions?: string;
  tools(): McpTool[];
  call(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

type JsonRpcId = string | number;

function errorReply(id: JsonRpcId | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolReply(id: JsonRpcId, result: McpToolResult) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: result.text }],
      ...(result.isError ? { isError: true } : {}),
    },
  };
}

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : PROTOCOL_VERSIONS[0];
}

/**
 * Checks arguments against the parts of a tool's schema Paperly's tools use:
 * required names, and the type of each named property. Returns what is wrong
 * in words the model can act on, or null.
 */
export function checkToolArguments(tool: McpTool, args: Record<string, unknown>): string | null {
  const properties = tool.inputSchema.properties || {};
  for (const name of tool.inputSchema.required || []) {
    if (args[name] === undefined || args[name] === null || args[name] === "") {
      return `Missing required argument "${name}".`;
    }
  }
  for (const [name, value] of Object.entries(args)) {
    const schema = properties[name];
    if (!schema) {
      if (tool.inputSchema.additionalProperties === false) {
        return `Unknown argument "${name}". This tool takes: ${Object.keys(properties).join(", ") || "nothing"}.`;
      }
      continue;
    }
    if (value === undefined || value === null) {
      continue;
    }
    switch (schema.type) {
      case "string":
        if (typeof value !== "string") {
          return `Argument "${name}" must be a string.`;
        }
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value)) {
          return `Argument "${name}" must be a whole number.`;
        }
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return `Argument "${name}" must be a number.`;
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          return `Argument "${name}" must be true or false.`;
        }
        break;
      default:
        break;
    }
    if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        return `Argument "${name}" must be at least ${schema.minimum}.`;
      }
      if (typeof schema.maximum === "number" && value > schema.maximum) {
        return `Argument "${name}" must be at most ${schema.maximum}.`;
      }
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      return `Argument "${name}" must be one of: ${schema.enum.join(", ")}.`;
    }
  }
  return null;
}

async function handleOne(message: unknown, host: McpHost): Promise<Record<string, unknown> | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return errorReply(null, -32600, "Invalid Request");
  }
  const { id, method, params } = message as {
    id?: JsonRpcId | null;
    method?: unknown;
    params?: any;
  };
  const isNotification = id === undefined;
  if ((message as { jsonrpc?: unknown }).jsonrpc !== "2.0" || typeof method !== "string") {
    // A response or garbage. Notifications get no reply in any case.
    return isNotification ? null : errorReply(id ?? null, -32600, "Invalid Request");
  }
  if (isNotification) {
    return null;
  }
  const requestId = id as JsonRpcId;
  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: requestId,
        result: {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: host.serverInfo,
          ...(host.instructions ? { instructions: host.instructions } : {}),
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id: requestId, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id: requestId, result: { tools: host.tools() } };
    case "tools/call": {
      const name = params?.name;
      if (typeof name !== "string") {
        return errorReply(requestId, -32602, "tools/call needs a tool name.");
      }
      const tool = host.tools().find((candidate) => candidate.name === name);
      if (!tool) {
        return errorReply(requestId, -32602, `Unknown tool: ${name}`);
      }
      const args = params?.arguments ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return errorReply(requestId, -32602, "Tool arguments must be an object.");
      }
      const problem = checkToolArguments(tool, args);
      if (problem) {
        return toolReply(requestId, { text: problem, isError: true });
      }
      try {
        return toolReply(requestId, await host.call(name, args));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return toolReply(requestId, { text: `Paperly could not run ${name}: ${reason}`, isError: true });
      }
    }
    default:
      // Includes newer discovery methods (server/discover): an unknown-method
      // error is what makes a newer client fall back to initialize.
      return errorReply(requestId, -32601, `Method not found: ${method}`);
  }
}

/** One JSON-RPC message or a batch; null when nothing needs an answer. */
export async function handleMcpMessage(
  message: unknown,
  host: McpHost,
): Promise<Record<string, unknown> | Record<string, unknown>[] | null> {
  if (Array.isArray(message)) {
    if (!message.length) {
      return errorReply(null, -32600, "Invalid Request");
    }
    const replies: Record<string, unknown>[] = [];
    for (const entry of message) {
      const reply = await handleOne(entry, host);
      if (reply) {
        replies.push(reply);
      }
    }
    return replies.length ? replies : null;
  }
  return handleOne(message, host);
}

/** Compares two secrets in time that does not depend on where they differ. */
export function sameSecret(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) {
    return false;
  }
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    difference |= (a.charCodeAt(index % a.length) || 0) ^ (b.charCodeAt(index % b.length) || 0);
  }
  return difference === 0;
}
