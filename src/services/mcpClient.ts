import type { Settings } from "./settingsManager";

const DEFAULT_MCP_SEARCH_ARGUMENTS_TEMPLATE =
  '{"q":"{{query}}","limit":1000,"mode":"complete","relevanceScoring":true,"sort":"relevance"}';
const DEFAULT_MCP_SEARCH_LIMIT = 1000;
const DEFAULT_MCP_RICH_MODE = "complete";

export interface MCPToolSummary {
  description?: string;
  inputSchema?: unknown;
  name: string;
}

export interface MCPToolResultItem {
  content?: string;
  key?: string;
  source?: string;
  title?: string;
  url?: string;
  year?: string;
}

export interface MCPToolCallOutcome {
  results: MCPToolResultItem[];
  toolName: string;
  usedFallback: boolean;
}

export interface MCPToolDetailedResult {
  raw: unknown;
  results: MCPToolResultItem[];
  text: string;
  toolName: string;
}

export interface MCPToolDetailedCallOutcome extends MCPToolDetailedResult {
  usedFallback: boolean;
}

interface MCPClientConfig {
  authToken?: string;
  endpoint: string;
  timeoutMs?: number;
}

interface MCPRequestContext {
  endpoint: string;
  headers: Record<string, string>;
  nextId: number;
  sessionId?: string;
  timeoutMs: number;
}

type MCPJsonRpcResponse = {
  error?: {
    code?: number;
    message?: string;
  };
  id?: number | string;
  result?: unknown;
};

export async function listMCPTools(
  settings: Pick<Settings, "mcpAuthToken" | "mcpEndpoint">,
): Promise<MCPToolSummary[]> {
  const context = await initializeMCP({
    authToken: settings.mcpAuthToken,
    endpoint: settings.mcpEndpoint || "",
  });
  const result = await sendMCPRequest(context, "tools/list", {});
  return normalizeToolList(result);
}

export async function callMCPTool(
  settings: Pick<
    Settings,
    | "mcpAuthToken"
    | "mcpEndpoint"
    | "mcpToolArgumentsTemplate"
    | "mcpToolName"
  >,
  query: string,
): Promise<MCPToolResultItem[]> {
  const toolName = settings.mcpToolName?.trim();
  if (!toolName) {
    throw new Error("MCP tool name is required");
  }

  const context = await initializeMCP({
    authToken: settings.mcpAuthToken,
    endpoint: settings.mcpEndpoint || "",
  });
  const result = await sendMCPRequest(context, "tools/call", {
    name: toolName,
    arguments: normalizeMCPToolArguments(
      toolName,
      buildToolArguments(
        settings.mcpToolArgumentsTemplate || "",
        query,
      ) as Record<string, unknown>,
    ),
  });
  return normalizeToolResult(result, toolName);
}

export async function callMCPToolByName(
  settings: Pick<Settings, "mcpAuthToken" | "mcpEndpoint">,
  toolName: string,
  toolArguments: Record<string, unknown> = {},
): Promise<MCPToolResultItem[]> {
  return (
    await callMCPToolDetailed(settings, toolName, toolArguments)
  ).results;
}

export async function callMCPToolDetailed(
  settings: Pick<Settings, "mcpAuthToken" | "mcpEndpoint">,
  toolName: string,
  toolArguments: Record<string, unknown> = {},
): Promise<MCPToolDetailedResult> {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) {
    throw new Error("MCP tool name is required");
  }

  const context = await initializeMCP({
    authToken: settings.mcpAuthToken,
    endpoint: settings.mcpEndpoint || "",
  });
  const result = await sendMCPRequest(context, "tools/call", {
    name: normalizedToolName,
    arguments: normalizeMCPToolArguments(normalizedToolName, toolArguments),
  });
  return normalizeDetailedToolResult(result, normalizedToolName);
}

export async function callMCPToolWithFallback(
  settings: Pick<
    Settings,
    | "mcpAuthToken"
    | "mcpEndpoint"
    | "mcpToolArgumentsTemplate"
    | "mcpToolName"
  >,
  query: string,
  knownTools?: MCPToolSummary[],
): Promise<MCPToolCallOutcome> {
  let primaryError: unknown = null;
  const configuredToolName = settings.mcpToolName?.trim();
  if (configuredToolName) {
    try {
      return {
        results: await callMCPTool(settings, query),
        toolName: configuredToolName,
        usedFallback: false,
      };
    } catch (error) {
      primaryError = error;
    }
  }

  const tools = knownTools || (await listMCPTools(settings));
  const candidates = selectFallbackMCPTools(tools, configuredToolName);
  let fallbackError: unknown = null;
  for (const tool of candidates) {
    try {
      return {
        results: await callMCPTool(
          {
            ...settings,
            mcpToolArgumentsTemplate: buildMCPToolArgumentsTemplate(tool),
            mcpToolName: tool.name,
          },
          query,
        ),
        toolName: tool.name,
        usedFallback: true,
      };
    } catch (error) {
      fallbackError = error;
    }
  }

  if (primaryError) {
    throw primaryError;
  }
  if (fallbackError) {
    throw fallbackError;
  }
  throw new Error("No suitable MCP tool found for conversation context");
}

export async function callMCPToolDetailedWithFallback(
  settings: Pick<
    Settings,
    | "mcpAuthToken"
    | "mcpEndpoint"
    | "mcpToolArgumentsTemplate"
    | "mcpToolName"
  >,
  query: string,
  knownTools?: MCPToolSummary[],
): Promise<MCPToolDetailedCallOutcome> {
  let primaryError: unknown = null;
  const configuredToolName = settings.mcpToolName?.trim();
  if (configuredToolName) {
    try {
      const detailed = await callMCPToolDetailed(
        settings,
        configuredToolName,
        buildToolArguments(
          settings.mcpToolArgumentsTemplate || "",
          query,
        ) as Record<string, unknown>,
      );
      return {
        ...detailed,
        usedFallback: false,
      };
    } catch (error) {
      primaryError = error;
    }
  }

  const tools = knownTools || (await listMCPTools(settings));
  const candidates = selectFallbackMCPTools(tools, configuredToolName);
  let fallbackError: unknown = null;
  for (const tool of candidates) {
    try {
      const detailed = await callMCPToolDetailed(
        settings,
        tool.name,
        buildToolArguments(buildMCPToolArgumentsTemplate(tool), query) as Record<
          string,
          unknown
        >,
      );
      return {
        ...detailed,
        usedFallback: true,
      };
    } catch (error) {
      fallbackError = error;
    }
  }

  if (primaryError) {
    throw primaryError;
  }
  if (fallbackError) {
    throw fallbackError;
  }
  throw new Error("No suitable MCP tool found for conversation context");
}

function buildToolArguments(template: string, query: string): unknown {
  const source = template.trim() || DEFAULT_MCP_SEARCH_ARGUMENTS_TEMPLATE;
  return JSON.parse(
    source.replace(/\{\{\s*query\s*\}\}/g, () => JSON.stringify(query).slice(1, -1)),
  );
}

function selectFallbackMCPTools(
  tools: MCPToolSummary[],
  configuredToolName?: string,
): MCPToolSummary[] {
  return tools
    .map((tool) => ({
      score: scoreFallbackMCPTool(tool, configuredToolName),
      tool,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((candidate) => candidate.tool);
}

function scoreFallbackMCPTool(
  tool: MCPToolSummary,
  configuredToolName?: string,
): number {
  const haystack = `${tool.name} ${tool.description || ""}`.toLowerCase();
  if (!tool.name || hasUnsafeToolVerb(haystack)) {
    return 0;
  }

  let score = 0;
  if (configuredToolName && tool.name === configuredToolName) score += 120;
  if (/\b(web_?search|search|find|query|lookup)\b/i.test(tool.name)) score += 100;
  if (/\b(search|find|query|lookup)\b/i.test(haystack)) score += 50;
  if (/\b(zotero|library|item|paper|collection|note|annotation)\b/i.test(haystack)) {
    score += 20;
  }
  if (getSchemaTextInputKey(tool.inputSchema)) score += 30;

  return score;
}

function hasUnsafeToolVerb(value: string): boolean {
  return /\b(add|append|attach|create|delete|edit|import|insert|move|patch|remove|rename|replace|save|set|tag|update|upload|write)\b/i.test(
    value,
  );
}

export function buildMCPToolArgumentsTemplate(
  tool?: Pick<MCPToolSummary, "inputSchema"> | null,
): string {
  const schema = normalizeObjectRecord(tool?.inputSchema);
  const properties = normalizeObjectRecord(schema?.properties);
  if (!properties) {
    return DEFAULT_MCP_SEARCH_ARGUMENTS_TEMPLATE;
  }

  const args: Record<string, unknown> = {};
  const queryKey = getSchemaTextInputKey(tool?.inputSchema);
  if (!queryKey) {
    return DEFAULT_MCP_SEARCH_ARGUMENTS_TEMPLATE;
  }

  args[queryKey] = "{{query}}";
  const limitKey = getSchemaLimitKey(properties);
  if (limitKey) {
    args[limitKey] = DEFAULT_MCP_SEARCH_LIMIT;
  }
  if (properties.mode) {
    args.mode = pickSchemaMode(properties.mode);
  }
  if (properties.relevanceScoring) {
    args.relevanceScoring = true;
  }
  if (properties.sort) {
    args.sort = "relevance";
  }

  return JSON.stringify(args);
}

function normalizeMCPToolArguments(
  toolName: string,
  toolArguments: Record<string, unknown>,
): Record<string, unknown> {
  const args = { ...toolArguments };
  const name = toolName.toLowerCase();
  if (/\b(search_library|search_fulltext|search_annotations|get_annotations|get_item_details|get_content|get_collections)\b/.test(name)) {
    const currentMode = String(args.mode || "").trim().toLowerCase();
    if (!currentMode || currentMode === "minimal" || currentMode === "preview") {
      args.mode = DEFAULT_MCP_RICH_MODE;
    }
  }

  const limitKey = ["limit", "maxResults", "max_results", "topK", "top_k"].find(
    (key) => key in args,
  );
  if (limitKey) {
    const currentLimit = Number(args[limitKey]);
    if (!Number.isFinite(currentLimit) || currentLimit < DEFAULT_MCP_SEARCH_LIMIT) {
      args[limitKey] = DEFAULT_MCP_SEARCH_LIMIT;
    }
  } else if (/\b(search_library|search_fulltext|search_annotations|get_annotations|get_libraries|get_collections|search_collections|semantic_search|fulltext_database)\b/.test(name)) {
    args.limit = DEFAULT_MCP_SEARCH_LIMIT;
  }

  if (name === "search_library") {
    args.relevanceScoring = args.relevanceScoring ?? true;
    args.sort = args.sort || "relevance";
  }

  if (name === "search_fulltext" && !("contextLength" in args)) {
    args.contextLength = 1200;
  }

  return args;
}

function pickSchemaMode(modeSchema: unknown): string {
  const schema = normalizeObjectRecord(modeSchema);
  const enumValues = Array.isArray(schema?.enum)
    ? schema.enum.map((value) => String(value))
    : [];
  if (enumValues.includes("complete")) {
    return "complete";
  }
  if (enumValues.includes("standard")) {
    return "standard";
  }
  return DEFAULT_MCP_RICH_MODE;
}

function getSchemaTextInputKey(schemaValue: unknown): string | null {
  const schema = normalizeObjectRecord(schemaValue);
  const properties = normalizeObjectRecord(schema?.properties);
  if (!properties) {
    return null;
  }

  const preferredKeys = [
    "query",
    "q",
    "search",
    "searchQuery",
    "search_query",
    "text",
    "input",
    "prompt",
    "question",
    "keyword",
    "keywords",
    "term",
    "terms",
    "title",
  ];
  for (const key of preferredKeys) {
    if (isStringLikeSchema(properties[key])) {
      return key;
    }
  }

  const blockedKeyPattern = /\b(id|key|path|url|uri|file|attachment|collection)\b/i;
  return (
    Object.keys(properties).find(
      (key) =>
        !blockedKeyPattern.test(key) &&
        /(query|search|text|keyword|term|title|name)/i.test(key) &&
        isStringLikeSchema(properties[key]),
    ) || null
  );
}

function getSchemaLimitKey(properties: Record<string, unknown>): string | null {
  const keys = ["max_results", "maxResults", "limit", "count", "top_k", "topK"];
  return keys.find((key) => isNumberLikeSchema(properties[key])) || null;
}

function isStringLikeSchema(value: unknown): boolean {
  const schema = normalizeObjectRecord(value);
  if (!schema) {
    return false;
  }
  const type = schema?.type;
  return !type || type === "string";
}

function isNumberLikeSchema(value: unknown): boolean {
  const schema = normalizeObjectRecord(value);
  const type = schema?.type;
  return type === "number" || type === "integer";
}

function normalizeObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function initializeMCP(config: MCPClientConfig): Promise<MCPRequestContext> {
  const endpoint = config.endpoint.trim();
  if (!endpoint) {
    throw new Error("MCP endpoint is required");
  }

  const context: MCPRequestContext = {
    endpoint,
    headers: buildMCPHeaders(config.authToken),
    nextId: 1,
    timeoutMs: config.timeoutMs || 10000,
  };
  await sendMCPRequest(context, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: {
      name: "Paperly AI",
      version: "0.9.11",
    },
  });
  await sendMCPNotification(context, "notifications/initialized");
  return context;
}

function buildMCPHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (authToken?.trim()) {
    headers.Authorization = `Bearer ${authToken.trim()}`;
  }
  return headers;
}

async function sendMCPNotification(
  context: MCPRequestContext,
  method: string,
): Promise<void> {
  await postMCPPayload(context, {
    jsonrpc: "2.0",
    method,
  });
}

async function sendMCPRequest(
  context: MCPRequestContext,
  method: string,
  params: unknown,
): Promise<unknown> {
  const response = await postMCPPayload(context, {
    jsonrpc: "2.0",
    id: context.nextId++,
    method,
    params,
  });
  if (response.error) {
    throw new Error(
      response.error.message || `MCP error ${response.error.code || ""}`.trim(),
    );
  }
  return response.result;
}

async function postMCPPayload(
  context: MCPRequestContext,
  payload: Record<string, unknown>,
): Promise<MCPJsonRpcResponse> {
  const headers = { ...context.headers };
  if (context.sessionId) {
    headers["Mcp-Session-Id"] = context.sessionId;
  }

  const response = await fetchWithTimeout(
    context.endpoint,
    {
      body: JSON.stringify(payload),
      headers,
      method: "POST",
    },
    context.timeoutMs,
  );
  const sessionId = response.headers?.get?.("Mcp-Session-Id");
  if (sessionId) {
    context.sessionId = sessionId;
  }
  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
  }

  const contentType = response.headers?.get?.("content-type") || "";
  const text = await response.text();
  return contentType.includes("text/event-stream")
    ? parseSSEResponse(text)
    : parseJsonResponse(text);
}

function parseJsonResponse(text: string): MCPJsonRpcResponse {
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text) as MCPJsonRpcResponse;
}

function parseSSEResponse(text: string): MCPJsonRpcResponse {
  const events = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n\n")
    .map((event) =>
      event
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
  if (events.length === 0) {
    return {};
  }
  return JSON.parse(events[events.length - 1]) as MCPJsonRpcResponse;
}

function normalizeToolList(result: unknown): MCPToolSummary[] {
  const tools = (result as { tools?: unknown[] } | null)?.tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .map((tool) => {
      const record = tool as Record<string, unknown>;
      return {
        description: String(record.description || ""),
        inputSchema: record.inputSchema,
        name: String(record.name || ""),
      };
    })
    .filter((tool) => tool.name);
}

function normalizeToolResult(
  result: unknown,
  toolName: string,
): MCPToolResultItem[] {
  return normalizeDetailedToolResult(result, toolName).results;
}

function normalizeDetailedToolResult(
  result: unknown,
  toolName: string,
): MCPToolDetailedResult {
  const record = (result || {}) as Record<string, unknown>;
  const structured = record.structuredContent;
  const structuredItems = normalizeStructuredItems(structured);
  const contentText = extractContentText(record.content);
  const structuredText =
    structured !== undefined ? safeJSONStringify(structured) : "";
  const fallbackText =
    contentText ||
    structuredText ||
    (result !== undefined ? safeJSONStringify(result) : "");

  if (structuredItems.length > 0) {
    return {
      raw: result,
      results: structuredItems,
      text: fallbackText,
      toolName,
    };
  }

  const parsedTextItems = parseTextItems(contentText);
  if (parsedTextItems.length > 0) {
    return {
      raw: result,
      results: parsedTextItems,
      text: fallbackText,
      toolName,
    };
  }

  return {
    raw: result,
    results: fallbackText
      ? [
          {
            content: fallbackText,
            source: toolName,
            title: "MCP tool result",
          },
        ]
      : [],
    text: fallbackText,
    toolName,
  };
}

function normalizeStructuredItems(value: unknown): MCPToolResultItem[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(record.results)
      ? record.results
      : Array.isArray(record.items)
        ? record.items
        : [];
  return candidates
    .map(normalizeResultRecord)
    .filter((item): item is MCPToolResultItem => item !== null);
}

function parseTextItems(text: string): MCPToolResultItem[] {
  if (!text.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    const parsedItems = normalizeStructuredItems(parsed);
    if (parsedItems.length > 0) {
      return parsedItems;
    }
    const parsedRecord = normalizeObjectRecord(parsed);
    if (parsedRecord) {
      const nested = [
        parsedRecord.data,
        parsedRecord.result,
        parsedRecord.structuredContent,
      ];
      for (const value of nested) {
        const nestedItems = normalizeStructuredItems(value);
        if (nestedItems.length > 0) {
          return nestedItems;
        }
      }
    }
    return [];
  } catch {
    return [];
  }
}

function normalizeResultRecord(value: unknown): MCPToolResultItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const content = buildResultContent(record);
  return {
    content,
    key: String(record.key || record.itemKey || record.id || ""),
    source: String(record.source || record.provider || "MCP"),
    title: String(record.title || record.name || "MCP result"),
    url: String(record.url || record.link || ""),
    year: String(record.year || record.date || ""),
  };
}

function buildResultContent(record: Record<string, unknown>): string {
  const directText = String(record.content || record.snippet || record.text || "").trim();
  if (directText) {
    return directText;
  }

  const lines = [
    record.key || record.itemKey || record.id ? `Key: ${record.key || record.itemKey || record.id}` : "",
    record.creators || record.authors ? `Creators: ${stringifyCompact(record.creators || record.authors)}` : "",
    record.publicationTitle || record.journal ? `Publication: ${record.publicationTitle || record.journal}` : "",
    record.abstractNote || record.abstract ? `Abstract: ${record.abstractNote || record.abstract}` : "",
    record.relevanceScore !== undefined ? `Relevance score: ${record.relevanceScore}` : "",
    record.matchedFields ? `Matched fields: ${stringifyCompact(record.matchedFields)}` : "",
    record.attachments ? `Attachments: ${stringifyCompact(record.attachments)}` : "",
    record.tags ? `Tags: ${stringifyCompact(record.tags)}` : "",
    record.DOI || record.doi ? `DOI: ${record.DOI || record.doi}` : "",
  ].filter(Boolean);

  return lines.join("\n");
}

function stringifyCompact(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function safeJSONStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const AbortControllerCtor = (globalThis as any).AbortController;
  const controller =
    typeof AbortControllerCtor === "function"
      ? new AbortControllerCtor()
      : null;
  const timeoutHost = resolveTimeoutHost();
  let timeoutId: unknown = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = timeoutHost.setTimeout(() => {
      controller?.abort?.();
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetch(input, {
        ...init,
        signal: controller?.signal,
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId != null) {
      timeoutHost.clearTimeout(timeoutId);
    }
  }
}

function resolveTimeoutHost(): {
  clearTimeout: (timerId: unknown) => void;
  setTimeout: (callback: () => void, timeoutMs: number) => unknown;
} {
  const globalSetTimeout = (globalThis as any).setTimeout;
  const globalClearTimeout = (globalThis as any).clearTimeout;
  if (typeof globalSetTimeout === "function" && typeof globalClearTimeout === "function") {
    return {
      clearTimeout: (timerId) => globalClearTimeout(timerId),
      setTimeout: (callback, timeoutMs) => globalSetTimeout(callback, timeoutMs),
    };
  }

  const win = Zotero.getMainWindow?.() as
    | {
        clearTimeout?: (timerId: unknown) => void;
        setTimeout?: (callback: () => void, timeoutMs: number) => unknown;
      }
    | undefined;

  return {
    clearTimeout: (timerId) => win?.clearTimeout?.(timerId),
    setTimeout: (callback, timeoutMs) => {
      if (typeof win?.setTimeout === "function") {
        return win.setTimeout(callback, timeoutMs);
      }
      callback();
      return timeoutMs;
    },
  };
}
