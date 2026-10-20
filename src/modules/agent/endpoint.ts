// /paperly/mcp on Paperly's own local server (port 23119 by default): where
// the agent CLI reaches Paperly's tools. Runs inside Paperly, so the tools use
// Zotero's API directly; there is no separate server process.
//
// Zotero's server already refuses what a web page could send: a Host other
// than localhost (DNS rebinding), and anything that looks like a browser (a
// Mozilla user agent or an Origin header) -- such requests are dropped
// without an answer. On top of that this endpoint wants Paperly's token.

import { handleMcpMessage, sameSecret } from "./mcpProtocol";
import type { McpHost } from "./mcpProtocol";
import type { ToolCallContext } from "./paperTools";
import { errorMessage } from "./util";

export const ENDPOINT_PATH = "/paperly/mcp";

type HostFactory = (context: ToolCallContext) => McpHost;

interface RequestData {
  method: string;
  headers: Record<string, string | undefined>;
  data: unknown;
}

type Reply = [number, string | Record<string, string>, string];

let hostFactory: HostFactory | null = null;
let tokenSource: (() => string) | null = null;

function jsonReply(status: number, body: unknown): Reply {
  return [status, { "Content-Type": "application/json" }, JSON.stringify(body)];
}

async function answer(request: RequestData): Promise<Reply> {
  if (request.method !== "POST") {
    // Streamable HTTP clients open a GET event stream if the server offers
    // one; 405 tells them this server answers every POST directly.
    return [405, { "Content-Type": "text/plain", Allow: "POST" }, "Method Not Allowed\n"];
  }
  const headers = request.headers || {};
  if (headers.origin) {
    return [403, "text/plain", "Forbidden\n"];
  }
  if (!tokenSource || !hostFactory || !sameSecret(headers["x-paperly-token"], tokenSource())) {
    return [401, "text/plain", "Unauthorized\n"];
  }
  const turnId = typeof headers["x-paperly-turn"] === "string" ? headers["x-paperly-turn"]! : null;
  const host = hostFactory({ turnId });
  try {
    const reply = await handleMcpMessage(request.data, host);
    if (!reply) {
      return [202, "text/plain", ""];
    }
    return jsonReply(200, reply);
  } catch (error) {
    // A thrown init() would reach the CLI as an empty 500; say what happened.
    const id = (request.data as { id?: unknown } | null)?.id;
    return jsonReply(200, {
      jsonrpc: "2.0",
      id: typeof id === "string" || typeof id === "number" ? id : null,
      error: { code: -32603, message: `Paperly: ${errorMessage(error)}` },
    });
  }
}

class PaperlyMcpEndpoint {
  supportedMethods = ["POST", "GET"];
  supportedDataTypes = ["application/json"];

  // Exactly one parameter: Zotero's server picks the calling convention from
  // init.length, and only a length of 1 gets the request object.
  init(requestData: RequestData): Promise<Reply> {
    return answer(requestData);
  }
}

export function registerAgentEndpoint(factory: HostFactory, token: () => string): void {
  hostFactory = factory;
  tokenSource = token;
  (Zotero.Server as any).Endpoints[ENDPOINT_PATH] = PaperlyMcpEndpoint;
}

export function unregisterAgentEndpoint(): void {
  const endpoints = (Zotero.Server as any)?.Endpoints;
  if (endpoints && endpoints[ENDPOINT_PATH] === PaperlyMcpEndpoint) {
    delete endpoints[ENDPOINT_PATH];
  }
  hostFactory = null;
  tokenSource = null;
}

/** http://127.0.0.1:<port>/paperly/mcp, or null when the local server is off. */
export function endpointURL(): string | null {
  if (Zotero.Prefs.get("httpServer.enabled") === false) {
    return null;
  }
  const port = Number(Zotero.Prefs.get("httpServer.port")) || 23119;
  return `http://127.0.0.1:${port}${ENDPOINT_PATH}`;
}
