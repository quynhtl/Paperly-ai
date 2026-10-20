// What an agent CLI prints, turned into the events the chat view draws.
//
// `claude -p --output-format stream-json --verbose --include-partial-messages`
// and `codex exec --json` both print one JSON object per line. The shapes
// handled here were recorded from claude 2.1.258 and codex-cli 0.144.6; lines
// of any other shape are ignored rather than guessed at.
//
// No runtime imports: the tests load this file straight into Node.

import type { AgentErrorKind } from "./types";

export type AgentEvent =
  | { type: "session"; sessionId: string; model?: string; tools?: string[]; authSource?: string }
  /** More of the reply. `newBlock` starts a new paragraph run in the view. */
  | { type: "text"; delta: string; newBlock?: boolean }
  | { type: "thinking"; delta: string; newBlock?: boolean }
  /** A tool call began, or its input became known (same id: update it). */
  | { type: "tool_started"; id: string; name: string; input?: Record<string, unknown> }
  | { type: "tool_done"; id: string; ok: boolean; output: string }
  | { type: "retry"; attempt: number; delayMs?: number; reason?: string }
  | { type: "rate_limit"; status: string; resetsAt?: number; limitType?: string }
  | { type: "error"; kind: AgentErrorKind; message: string }
  | {
      type: "done";
      ok: boolean;
      text?: string;
      durationMs?: number;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      model?: string;
      errorKind?: AgentErrorKind;
      message?: string;
    };

/** Calls `onLine` once per complete line; output arrives in arbitrary chunks. */
export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          onLine(line);
        }
        newline = buffer.indexOf("\n");
      }
    },
    flush() {
      const rest = buffer.replace(/\r$/, "");
      buffer = "";
      if (rest.trim()) {
        onLine(rest);
      }
    },
  };
}

const OUTPUT_PREVIEW_LIMIT = 600;

/** A tool result's text, shortened for display. */
export function toolOutputPreview(content: unknown): string {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  } else if (content && typeof content === "object") {
    const inner = (content as { content?: unknown }).content;
    if (inner !== undefined) {
      return toolOutputPreview(inner);
    }
  }
  text = text.trim();
  return text.length > OUTPUT_PREVIEW_LIMIT
    ? `${text.slice(0, OUTPUT_PREVIEW_LIMIT).trimEnd()}…`
    : text;
}

/** What kind of failure Claude Code's own error text describes. */
export function classifyClaudeError(code: unknown, text: string): AgentErrorKind {
  if (/no conversation found with session id/i.test(text)) {
    return "session_lost";
  }
  if (/does not support this model|is too old|claude update/i.test(text)) {
    return "update_required";
  }
  switch (code) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return "not_signed_in";
    case "rate_limit":
      return "rate_limited";
    case "model_not_found":
      return "model";
    default:
      break;
  }
  if (/\/login|not logged in|log in again|please (run|use) .*login|invalid api key/i.test(text)) {
    return "not_signed_in";
  }
  if (/usage limit|rate limit|limit reached|resets? at/i.test(text)) {
    return "rate_limited";
  }
  return "api";
}

export interface MapperOptions {
  /** Tools the session may have. Anything else in `init` aborts the turn. */
  isToolAllowed?: (name: string) => boolean;
}

/**
 * Feeds Claude Code stream-json objects in, emits events out. Returns "abort"
 * for a line that must stop the run (a session that came up with a tool it
 * should not have).
 */
export function createClaudeMapper(
  emit: (event: AgentEvent) => void,
  options: MapperOptions = {},
): (message: any) => "abort" | void {
  let sawTextDelta = false;
  let sawThinkingDelta = false;
  let nextTextIsNewBlock = true;
  let nextThinkingIsNewBlock = true;
  let errorEmitted = false;
  let model: string | undefined;
  const announcedTools = new Set<string>();

  return (message: any) => {
    if (!message || typeof message !== "object") {
      return;
    }
    switch (message.type) {
      case "system": {
        if (message.subtype === "init") {
          model = typeof message.model === "string" ? message.model : undefined;
          const tools: string[] = Array.isArray(message.tools)
            ? message.tools.filter((tool: unknown) => typeof tool === "string")
            : [];
          if (options.isToolAllowed) {
            const unexpected = tools.filter((tool) => !options.isToolAllowed!(tool));
            if (unexpected.length) {
              errorEmitted = true;
              emit({
                type: "error",
                kind: "unsafe",
                message: `The agent started with tools Paperly did not give it (${unexpected.join(", ")}), so the turn was stopped.`,
              });
              return "abort";
            }
          }
          if (typeof message.session_id === "string") {
            emit({
              type: "session",
              sessionId: message.session_id,
              model,
              tools,
              authSource: typeof message.apiKeySource === "string" ? message.apiKeySource : undefined,
            });
          }
        } else if (message.subtype === "api_retry") {
          emit({
            type: "retry",
            attempt: Number(message.attempt) || 1,
            delayMs: typeof message.retry_delay_ms === "number" ? message.retry_delay_ms : undefined,
            reason: typeof message.error === "string" ? message.error : undefined,
          });
        }
        return;
      }
      case "rate_limit_event": {
        const info = message.rate_limit_info || {};
        if (typeof info.status === "string") {
          emit({
            type: "rate_limit",
            status: info.status,
            resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : undefined,
            limitType: typeof info.rateLimitType === "string" ? info.rateLimitType : undefined,
          });
        }
        return;
      }
      case "stream_event": {
        // A subagent's narration would interleave with the reply; this
        // session never has subagents, but the guard costs nothing.
        if (message.parent_tool_use_id) {
          return;
        }
        const event = message.event || {};
        if (event.type === "content_block_start") {
          const block = event.content_block || {};
          if (block.type === "tool_use" && typeof block.id === "string") {
            if (!announcedTools.has(block.id)) {
              announcedTools.add(block.id);
              emit({ type: "tool_started", id: block.id, name: String(block.name || "") });
            }
          } else if (block.type === "text") {
            nextTextIsNewBlock = true;
          } else if (block.type === "thinking") {
            nextThinkingIsNewBlock = true;
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta || {};
          if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
            sawTextDelta = true;
            emit({ type: "text", delta: delta.text, newBlock: nextTextIsNewBlock });
            nextTextIsNewBlock = false;
          } else if (
            delta.type === "thinking_delta" &&
            typeof delta.thinking === "string" &&
            delta.thinking
          ) {
            sawThinkingDelta = true;
            emit({ type: "thinking", delta: delta.thinking, newBlock: nextThinkingIsNewBlock });
            nextThinkingIsNewBlock = false;
          }
        }
        return;
      }
      case "assistant": {
        if (message.parent_tool_use_id) {
          return;
        }
        const content: any[] = Array.isArray(message.message?.content) ? message.message.content : [];
        if (typeof message.message?.model === "string") {
          model = message.message.model;
        }
        if (message.error || message.is_api_error_message) {
          const text = content
            .filter((block) => block?.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("\n")
            .trim();
          errorEmitted = true;
          emit({
            type: "error",
            kind: classifyClaudeError(message.error, text),
            message: text || String(message.error || "Claude reported an error."),
          });
          return;
        }
        for (const block of content) {
          if (!block || typeof block !== "object") {
            continue;
          }
          if (block.type === "tool_use" && typeof block.id === "string") {
            announcedTools.add(block.id);
            emit({
              type: "tool_started",
              id: block.id,
              name: String(block.name || ""),
              input: block.input && typeof block.input === "object" ? block.input : undefined,
            });
          } else if (block.type === "text" && typeof block.text === "string") {
            // Only when the block never streamed: an older CLI, or a path
            // that skipped the deltas.
            if (!sawTextDelta && block.text) {
              emit({ type: "text", delta: block.text, newBlock: true });
            }
          } else if (block.type === "thinking" && typeof block.thinking === "string") {
            if (!sawThinkingDelta && block.thinking) {
              emit({ type: "thinking", delta: block.thinking, newBlock: true });
            }
          }
        }
        sawTextDelta = false;
        sawThinkingDelta = false;
        nextTextIsNewBlock = true;
        nextThinkingIsNewBlock = true;
        return;
      }
      case "user": {
        if (message.isReplay || message.parent_tool_use_id) {
          return;
        }
        const content = message.message?.content;
        if (!Array.isArray(content)) {
          return;
        }
        for (const block of content) {
          if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
            emit({
              type: "tool_done",
              id: block.tool_use_id,
              ok: block.is_error !== true,
              output: toolOutputPreview(block.content),
            });
          }
        }
        return;
      }
      case "result": {
        const usage = message.usage || {};
        const ok = message.is_error !== true && message.subtype === "success";
        const done: Extract<AgentEvent, { type: "done" }> = {
          type: "done",
          ok,
          text: typeof message.result === "string" ? message.result : undefined,
          durationMs: typeof message.duration_ms === "number" ? message.duration_ms : undefined,
          costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : undefined,
          inputTokens:
            (Number(usage.input_tokens) || 0) +
            (Number(usage.cache_read_input_tokens) || 0) +
            (Number(usage.cache_creation_input_tokens) || 0),
          outputTokens: Number(usage.output_tokens) || 0,
          model,
        };
        if (!ok && !errorEmitted) {
          const errors = Array.isArray(message.errors) ? message.errors.join("\n") : "";
          const text = (typeof message.result === "string" && message.result) || errors;
          done.errorKind = text ? classifyClaudeError(undefined, text) : "cli";
          done.message = text || `Claude Code stopped (${String(message.subtype || "error")}).`;
        }
        emit(done);
        return;
      }
      default:
        return;
    }
  };
}

/** Codex's words for "not signed in" and "out of quota". */
export function classifyCodexError(text: string): AgentErrorKind {
  if (/not logged in|log ?in|unauthori[sz]ed|401|token (is )?expired|re-?authenticate/i.test(text)) {
    return "not_signed_in";
  }
  if (/usage limit|rate limit|quota|429/i.test(text)) {
    return "rate_limited";
  }
  if (/model .*(not|un)(supported|available|found)|does not exist/i.test(text)) {
    return "model";
  }
  if (/upgrade|update codex|too old/i.test(text)) {
    return "update_required";
  }
  return "api";
}

/**
 * Feeds `codex exec --json` objects in, emits events out. Codex reports whole
 * items rather than token deltas, so text arrives one message at a time.
 */
export function createCodexMapper(
  emit: (event: AgentEvent) => void,
  options: MapperOptions = {},
): (message: any) => "abort" | void {
  let errorEmitted = false;
  const toolName = (item: any): string => {
    switch (item?.type) {
      case "mcp_tool_call":
        return `mcp__${item.server || "unknown"}__${item.tool || "unknown"}`;
      case "web_search":
        return "WebSearch";
      case "command_execution":
        return "Shell";
      case "file_change":
        return "FileChange";
      default:
        return String(item?.type || "tool");
    }
  };
  const toolInput = (item: any): Record<string, unknown> | undefined => {
    if (item?.type === "mcp_tool_call" && item.arguments && typeof item.arguments === "object") {
      return item.arguments;
    }
    if (item?.type === "web_search" && typeof item.query === "string") {
      return { query: item.query };
    }
    if (item?.type === "command_execution" && typeof item.command === "string") {
      return { command: item.command };
    }
    return undefined;
  };
  const isTool = (item: any) =>
    ["mcp_tool_call", "web_search", "command_execution", "file_change"].includes(item?.type);

  return (message: any) => {
    if (!message || typeof message !== "object") {
      return;
    }
    switch (message.type) {
      case "thread.started":
        if (typeof message.thread_id === "string") {
          emit({ type: "session", sessionId: message.thread_id });
        }
        return;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = message.item || {};
        if (isTool(item)) {
          const name = toolName(item);
          if (options.isToolAllowed && !options.isToolAllowed(name)) {
            errorEmitted = true;
            emit({
              type: "error",
              kind: "unsafe",
              message: `The agent tried to use a tool Paperly did not give it (${name}), so the turn was stopped.`,
            });
            return "abort";
          }
          if (message.type !== "item.completed") {
            emit({ type: "tool_started", id: String(item.id), name, input: toolInput(item) });
            return;
          }
          emit({ type: "tool_started", id: String(item.id), name, input: toolInput(item) });
          const failed = item.status === "failed" || Boolean(item.error);
          const output = item.error
            ? String(item.error.message || item.error)
            : toolOutputPreview(item.result?.content ?? item.result ?? "");
          emit({ type: "tool_done", id: String(item.id), ok: !failed, output });
          return;
        }
        if (message.type !== "item.completed") {
          return;
        }
        if (item.type === "agent_message" && typeof item.text === "string" && item.text) {
          emit({ type: "text", delta: item.text, newBlock: true });
        } else if (item.type === "reasoning" && typeof item.text === "string" && item.text) {
          emit({ type: "thinking", delta: item.text, newBlock: true });
        } else if (item.type === "error" && typeof item.message === "string") {
          errorEmitted = true;
          emit({ type: "error", kind: classifyCodexError(item.message), message: item.message });
        }
        return;
      }
      case "turn.completed": {
        const usage = message.usage || {};
        emit({
          type: "done",
          ok: !errorEmitted,
          inputTokens: Number(usage.input_tokens) || 0,
          outputTokens:
            (Number(usage.output_tokens) || 0) + (Number(usage.reasoning_output_tokens) || 0),
        });
        return;
      }
      case "turn.failed": {
        const text = String(message.error?.message || "Codex could not finish this turn.");
        if (!errorEmitted) {
          errorEmitted = true;
          emit({ type: "error", kind: classifyCodexError(text), message: text });
        }
        emit({ type: "done", ok: false });
        return;
      }
      case "error": {
        const text = String(message.message || "");
        if (/reconnecting|retrying/i.test(text)) {
          const attempt = /(\d+)\s*\/\s*\d+/.exec(text);
          emit({ type: "retry", attempt: attempt ? Number(attempt[1]) : 1, reason: text });
          return;
        }
        if (text && !errorEmitted) {
          errorEmitted = true;
          emit({ type: "error", kind: classifyCodexError(text), message: text });
        }
        return;
      }
      default:
        return;
    }
  };
}
