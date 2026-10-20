// Shapes shared by Paperly Agent's service, runner and chat view.
//
// Kept free of runtime code so that the pure modules (streamParser,
// mcpProtocol, markdown) can import it with `import type` and still run
// under plain Node for their tests.

export type EngineId = "claude" | "codex";

export type AgentErrorKind =
  | "not_installed"
  | "not_signed_in"
  | "update_required"
  | "rate_limited"
  | "model"
  | "session_lost"
  | "unsafe"
  | "server_off"
  | "cli"
  | "api";

export interface TextPart {
  kind: "text";
  text: string;
}

export interface ThinkingPart {
  kind: "thinking";
  text: string;
}

export interface ToolPart {
  kind: "tool";
  id: string;
  name: string;
  input?: Record<string, unknown>;
  status: "running" | "ok" | "error";
  output?: string;
}

export interface ApprovalPart {
  kind: "approval";
  id: string;
  action: "add_note";
  title: string;
  preview: string;
  status: "pending" | "allowed" | "denied" | "expired";
  result?: string;
}

export interface NoticePart {
  kind: "notice";
  text: string;
}

export type AssistantPart =
  | TextPart
  | ThinkingPart
  | ToolPart
  | ApprovalPart
  | NoticePart;

export interface MessageMeta {
  engine?: EngineId;
  model?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  authMethod?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  createdAt: number;
  /** What the user wrote; user messages only. */
  text?: string;
  /** What the agent did and said, in order; assistant messages only. */
  parts?: AssistantPart[];
  status?: "running" | "done" | "stopped" | "error";
  error?: { kind: AgentErrorKind; message: string };
  meta?: MessageMeta;
}

export interface PaperRef {
  libraryID: number;
  /** The regular item's key, or the attachment's when it has no parent. */
  key: string;
  title: string;
}

export interface Conversation {
  version: 1;
  /** `${libraryID}_${key}` for a paper, "library" for the library at large. */
  key: string;
  engine: EngineId;
  sessionId?: string;
  paper?: PaperRef;
  messages: ChatMessage[];
  updatedAt: number;
}
