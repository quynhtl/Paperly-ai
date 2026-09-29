import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AssembledContext } from "../../services/contextAssembler";
import {
  callMCPToolDetailed,
  listMCPTools,
  type MCPToolDetailedCallOutcome,
  type MCPToolDetailedResult,
  type MCPToolResultItem,
  type MCPToolSummary,
} from "../../services/mcpClient";
import {
  parseCustomPresets,
  type Settings,
} from "../../services/settingsManager";
import type { ScopeContext } from "../../types/scope";
import { getPref, setPref } from "../../utils/prefs";
import { getRequestedLanguage, isChineseLocale } from "../../utils/locale";
import { type SidebarTheme } from "../theme";
import { typography } from "../typography";
import {
  buildLookupURL,
  DEFAULT_SERVICE_ID,
  getDefaultService,
  getServiceByID,
  hasStoredSession,
  isKnownServiceID,
  type WebAIService,
  type WebAIServiceId,
} from "../webAIServices";

type PromptSourceMode = "paper" | "selection" | "quick-prompt";
type WebAICommandKind =
  | "clear"
  | "export"
  | "mcp"
  | "new"
  | "pdf"
  | "skill"
  | "web";
type SessionSlashAction = "clear" | "export";
type SessionSlashScope = "all" | "current";

export interface IncomingWebPrompt {
  id: string;
  label: string;
  prompt: string;
  sourceMode?: PromptSourceMode;
}

export type WebAIPanelView = "web" | "chat";

interface WebAIWorkspaceProps {
  contextSummary: AssembledContext | null;
  customPresets?: string;
  hostWindow: Window;
  incomingPrompt?: IncomingWebPrompt | null;
  // Resolved by the shell, which owns the theme mode. Read locally it would be
  // read without that mode, and every surface here would follow the OS instead
  // of the toggle in the header.
  isDark: boolean;
  location: "library" | "reader";
  onIncomingPromptHandled?: (id: string) => void;
  onScopeRefresh?: () => void;
  // The selected provider is owned by the Sidebar, so that the one selector in
  // the shell header drives it. This component reacts to the change.
  // Raised when the reader's selection popup asks for a look-up. Separate from
  // `selectionText` because clicking Translate twice for different words must
  // act twice, and the provider may already be the right one.
  lookupRequest?: {
    id: string;
    serviceID: WebAIServiceId;
    text: string;
  } | null;
  onLookupRequestHandled?: (id: string) => void;
  // Reported up so the shell can hide the conversation's own chrome -- the
  // thinking-effort selector and the token meter -- while the web view is
  // showing. Both describe a prompt, and the web view has none.
  onPanelViewChange?: (view: WebAIPanelView) => void;
  onSelectService: (service: WebAIService) => void;
  // The live reader selection, the same value the selection bar shows. Look-up
  // providers follow it; chat providers do not, because there the selection
  // reaches the composer through an explicit Explain/Ask instead.
  selectionText?: string;
  service: WebAIService;
  settings: Settings;
  scope: ScopeContext | null;
  theme: SidebarTheme;
}

interface WebAISkill {
  aliases?: string[];
  description?: string;
  id: string;
  kind: WebAICommandKind;
  label: string;
  promptPrefix: string;
  slashCommand: string;
}

interface PromptInsertResult {
  method?: string;
  ok: boolean;
  reason?: string;
  submitAttempted?: boolean;
  submitted?: boolean;
}

interface MCPPromptContextResult {
  contextText: string;
  status: string | null;
}

type WebAIExecutionKind =
  | "assistant"
  | "mcp"
  | "pdf"
  | "skill"
  | "web"
  | "error";

interface WebAIExecutionRecord {
  body: string;
  createdAt: string;
  hidden?: boolean;
  id: string;
  kind: WebAIExecutionKind;
  sourcePrompt?: string;
  status: "done" | "error" | "running";
  subtitle?: string;
  thinking?: string;
  title: string;
  turnID?: string;
  userPrompt?: string;
}

interface WebAIChatSession {
  createdAt: string;
  id: string;
  records: WebAIExecutionRecord[];
  serviceID: WebAIServiceId;
  serviceLabel: string;
  title: string;
  updatedAt: string;
}

type WebAIExecutionRecordDraft = Omit<
  WebAIExecutionRecord,
  "createdAt" | "id"
>;

interface AssistantReplyRecordOptions {
  kind?: WebAIExecutionKind;
  pendingRecordID?: string;
  sourcePrompt?: string;
  subtitle?: string;
  title?: string;
  turnID?: string;
  userPrompt?: string;
}

interface WebSearchPromptContextResult {
  contextText: string;
  query: string;
  status: string | null;
}

interface WebSearchResult {
  snippet: string;
  title: string;
  url: string;
}

interface WebChatTextResult {
  ok: boolean;
  reason?: string;
  text?: string;
}

interface WebAITranscriptTurn {
  id: string;
  records: WebAIExecutionRecord[];
}

interface AssistantCaptureParts {
  body: string;
  thinking?: string;
}

interface AssistantCandidate {
  body: string;
  raw: string;
  thinking?: string;
}

interface SessionSlashCommand {
  action: SessionSlashAction;
  scope: SessionSlashScope;
}

interface ComposerImageAttachment {
  dataURL: string;
  name: string;
  type: string;
}

type MarkdownExportResult =
  | { status: "cancelled" }
  | { status: "copied" }
  | { status: "saved"; target: string };

interface MarkdownListItem {
  level: number;
  text: string;
}

type MarkdownBlock =
  | { text: string; type: "blockquote" | "code" | "math" | "paragraph" }
  | { items: MarkdownListItem[]; ordered: boolean; type: "list" }
  | { headers: string[]; rows: string[][]; type: "table" }
  | { level: 1 | 2 | 3; text: string; type: "heading" };

interface MCPBridgeRequest {
  arguments: Record<string, unknown>;
  id: string;
  raw: string;
  toolName: string;
}

interface FrameMessageManager {
  addMessageListener?: (
    name: string,
    listener: (message: { data?: PromptInsertResult | WebChatTextResult }) => void,
  ) => void;
  loadFrameScript?: (url: string, allowDelayedLoad: boolean) => void;
  removeMessageListener?: (
    name: string,
    listener: (message: { data?: PromptInsertResult | WebChatTextResult }) => void,
  ) => void;
}

const PROMPT_TEXT_LIMIT = 60000;
const ASSISTANT_CAPTURE_TEXT_LIMIT = 60000;
const MCP_CONTEXT_TEXT_LIMIT = 12000;
const MCP_ITEM_TEXT_LIMIT = 1800;
const MCP_SCHEMA_TEXT_LIMIT = 2200;
const MCP_TOOL_CATALOG_TEXT_LIMIT = 52000;
const MCP_BRIDGE_SCAN_TEXT_LIMIT = 120000;
const MCP_BRIDGE_POLL_MS = 900;
const EXECUTION_RECORD_LIMIT = 1000;
const SESSION_HISTORY_PREF = "webAIChatSessions";
const SESSION_HISTORY_LIMIT = 1000;
const SESSION_RECORD_LIMIT = 1000;
const WEB_SEARCH_RESULT_LIMIT = 6;
const WEB_SEARCH_CONTEXT_TEXT_LIMIT = 7000;
const COMPOSER_IMAGE_INPUT_ENABLED = false;
const ASSISTANT_CAPTURE_MAX_ATTEMPTS = 120;
const ASSISTANT_CAPTURE_INITIAL_POLL_MS = 1000;
const ASSISTANT_CAPTURE_POLL_MS = 1500;
const ASSISTANT_CAPTURE_STABLE_READS = 3;
const ASSISTANT_IMAGE_CAPTURE_MAX_ATTEMPTS = 480;
const ASSISTANT_IMAGE_CAPTURE_STABLE_READS = 5;
// Names a note in the user's library, not the product. It keeps the old name
// on purpose: renaming it would strand every note captured before the rename
// and start a second one alongside it.
const WEBAI_NOTE_TITLE = "Zotero WebAI Notes";
const FINAL_ANSWER_FORMAT_INSTRUCTION =
  "Final answer format: reply only with the user-facing result in Markdown. Use $$...$$ for display formulas. Do not expose Paperly AI instructions, raw JSON, MCP/web-search arguments, tool schemas, or intermediate execution steps.";
interface WebAIStrings {
  buttons: {
    aiWeb: string;
    appendNote: string;
    back: string;
    cancel: string;
    chatMode: string;
    clear: string;
    copy: string;
    edit: string;
    external: string;
    forward: string;
    googleSearch: string;
    hide: string;
    image: string;
    loginMode: string;
    loginWindow: string;
    next: string;
    openExternal: string;
    previous: string;
    regenerate: string;
    reload: string;
    save: string;
    send: string;
  };
  commands: {
    clearAllDescription: string;
    clearAllLabel: string;
    clearDescription: string;
    clearLabel: string;
    exportAllDescription: string;
    exportAllLabel: string;
    exportDescription: string;
    exportLabel: string;
    mcpDescription: string;
    mcpLabel: string;
    newDescription: string;
    newLabel: string;
    pdfDescription: string;
    pdfLabel: string;
    webDescription: string;
    webLabel: string;
  };
  composerPlaceholder: string;
  defaultStatus: string;
  emptyConversation: string;
  // "lookup" providers (dictionary, search) have no prompt/answer cycle.
  lookup: {
    hint: string;
    placeholder: string;
    submit: string;
  };
  errors: {
    currentPDFUnavailable: string;
    editedPromptEmpty: string;
    mcpUnavailable: string;
    noMessageOrCommand: string;
  };
  labels: {
    conversation: string;
    history: string;
    noSavedSessions: string;
    processHidden: string;
    user: string;
    zaiLoginMode: string;
  };
  record: {
    capturedWebAnswer: string;
    captureNeeded: string;
    currentPDFCommand: string;
    mcpAssistedAnswer: string;
    pdfAssistedAnswer: string;
    skillResult: (label: string) => string;
    webAnswer: string;
    webSearchAnswer: string;
  };
  status: {
    appendNote: (title: string, noteID: number) => string;
    captured: (serviceLabel: string) => string;
    clearSelectedCommandTitle: string;
    clearedAllSessions: string;
    clearedSession: string;
    copiedRecord: (title: string) => string;
    copiedUserPrompt: string;
    editPrompt: string;
    failed: (message: string) => string;
    imageAttached: (name: string) => string;
    imageRemoved: string;
    incomingReady: (label: string, serviceLabel: string) => string;
    loadedSession: (title: string) => string;
    loginWindowOpened: (serviceLabel: string) => string;
    noSessionsToExport: string;
    promptCopied: (prefix: string, length: number, serviceLabel: string) => string;
    promptInserted: (prefix: string, serviceLabel: string) => string;
    promptSent: (prefix: string, serviceLabel: string) => string;
    promptSentCaptureNeeded: string;
    regenerating: (title: string) => string;
    sendTitle: string;
    slashClear: string;
    slashClearAll: string;
    slashExport: string;
    slashExportAll: string;
    slashMCP: string;
    slashNew: string;
    slashPDF: string;
    slashSkill: (slashCommand: string) => string;
    slashWeb: string;
    startedConversation: (serviceLabel: string) => string;
    exportedSession: (target: string) => string;
    exportCopied: string;
    turnCount: (turns: number) => string;
    turnsSessions: (turns: number, sessions: number) => string;
    waiting: (serviceLabel: string) => string;
    zaiChatRestored: string;
    zaiLoginMode: string;
  };
}

const EN_STRINGS: WebAIStrings = {
  buttons: {
    aiWeb: "AI Web",
    appendNote: "Append Note",
    back: "Back",
    cancel: "Cancel",
    chatMode: "Chat Mode",
    clear: "Clear",
    copy: "Copy",
    edit: "Edit",
    external: "External",
    forward: "Forward",
    googleSearch: "Google Search",
    hide: "Hide",
    image: "Image",
    loginMode: "Login Mode",
    loginWindow: "Login Window",
    next: "Next",
    openExternal: "Open External",
    previous: "Previous",
    regenerate: "Regenerate",
    reload: "Reload",
    save: "Save",
    send: "Send",
  },
  commands: {
    clearAllDescription: "Clear every saved Paperly AI chat session",
    clearAllLabel: "Clear All",
    clearDescription: "Clear the current Paperly AI chat session",
    clearLabel: "Clear Current",
    exportAllDescription: "Export every saved Paperly AI chat session as Markdown",
    exportAllLabel: "Export All",
    exportDescription: "Export the current Paperly AI chat session as Markdown",
    exportLabel: "Export Current",
    mcpDescription: "Load zotero-mcp tools for this conversation",
    mcpLabel: "Zotero MCP",
    newDescription: "Start a clean chat session and reload the web chat",
    newLabel: "New Conversation",
    pdfDescription: "Attach current PDF or item full text to this prompt",
    pdfLabel: "Current PDF",
    webDescription: "Search the web and attach results to this prompt",
    webLabel: "Web Search",
  },
  composerPlaceholder:
    "Message in Markdown, /new conversation, or / for PDF, Web Search, Zotero MCP, Skills",
  defaultStatus: "Type / for PDF, Web Search, Zotero MCP, or custom skills.",
  emptyConversation:
    "Send a message to start a new turn, type / for commands, or use /new conversation to reset.",
  lookup: {
    hint: "Look-up pages have no conversation. Selected text in the reader is filled in here.",
    placeholder: "Word or phrase to look up",
    submit: "Look up",
  },
  errors: {
    currentPDFUnavailable: "Current PDF or Zotero item full text is unavailable.",
    editedPromptEmpty: "Edited prompt is empty.",
    mcpUnavailable: "MCP unavailable; check that zotero-mcp is running.",
    noMessageOrCommand: "Write a message or choose a / command.",
  },
  labels: {
    conversation: "Conversation",
    history: "History",
    noSavedSessions: "No saved sessions yet.",
    processHidden: "Process hidden",
    user: "User",
    zaiLoginMode: "Z.ai Login Mode",
  },
  record: {
    capturedWebAnswer: "Captured web answer",
    captureNeeded: "Capture needed",
    currentPDFCommand: "Current PDF command",
    mcpAssistedAnswer: "MCP-assisted answer",
    pdfAssistedAnswer: "PDF-assisted answer",
    skillResult: (label) => `Skill result: ${label}`,
    webAnswer: "Web answer",
    webSearchAnswer: "Web-search answer",
  },
  status: {
    appendNote: (title, noteID) =>
      `Appended ${title} to Zotero WebAI Notes (#${noteID}).`,
    captured: (serviceLabel) =>
      `Captured latest ${serviceLabel} answer into Paperly AI.`,
    clearSelectedCommandTitle: "Clear selected command",
    clearedAllSessions: "Cleared all saved sessions.",
    clearedSession: "Cleared the current session.",
    copiedRecord: (title) => `Copied ${title}.`,
    copiedUserPrompt: "Copied user prompt.",
    editPrompt: "Edit the user prompt in place, then save to generate a new answer.",
    failed: (message) => `Failed: ${message}`,
    imageAttached: (name) => `Attached image: ${name}.`,
    imageRemoved: "Image attachment removed.",
    incomingReady: (label, serviceLabel) =>
      `${label} is ready. Send inserts it into ${serviceLabel}.`,
    loadedSession: (title) => `Loaded session: ${title}`,
    loginWindowOpened: (serviceLabel) =>
      `Opened a larger ${serviceLabel} login window. After sign-in, return here and reload if needed.`,
    noSessionsToExport: "No conversation records to export.",
    promptCopied: (prefix, length, serviceLabel) =>
      `${prefix}Prompt copied (${length} characters). If it did not appear in ${serviceLabel}, click the web chat box and paste.`,
    promptInserted: (prefix, serviceLabel) =>
      `${prefix}Prompt inserted into ${serviceLabel}. Send it in the web chat, then click Capture if needed.`,
    promptSent: (prefix, serviceLabel) =>
      `${prefix}Prompt sent to ${serviceLabel}; waiting for result.`,
    promptSentCaptureNeeded:
      "Prompt sent. The answer was not captured automatically; read it in the web view.",
    regenerating: (title) => `Regenerating ${title}.`,
    sendTitle: "Insert prompt into the web chat, with clipboard fallback",
    slashClear: "Clear the current Paperly AI session.",
    slashClearAll: "Clear all saved Paperly AI sessions.",
    slashExport: "Export the current session as Markdown.",
    slashExportAll: "Export all saved sessions as Markdown.",
    slashMCP:
      "Zotero MCP selected. Send to load zotero-mcp tools; the web model can request real tool calls.",
    slashNew: "Start a new conversation and clear the current web chat context.",
    slashPDF:
      "Current PDF selected. Send to attach the current PDF/item full text to this prompt.",
    slashSkill: (slashCommand) =>
      `Skill /${slashCommand} selected. Write your question and send.`,
    slashWeb: "Web Search selected. Send to search the web and attach the results.",
    startedConversation: (serviceLabel) =>
      `Started a new ${serviceLabel} conversation.`,
    exportedSession: (target) => `Exported conversation Markdown to ${target}.`,
    exportCopied:
      "Conversation Markdown copied to clipboard because a file picker was unavailable.",
    turnCount: (turns) => `${turns} turns`,
    turnsSessions: (turns, sessions) => `${turns} turns / ${sessions} sessions`,
    waiting: (serviceLabel) => `Waiting for ${serviceLabel} answer...`,
    zaiChatRestored: "Z.ai Chat Mode restored. Send inserts prompts into the web chat.",
    zaiLoginMode: "Z.ai Login Mode gives the captcha the full sidebar height.",
  },
};

const ZH_STRINGS: WebAIStrings = {
  buttons: {
    aiWeb: "AI 网页",
    appendNote: "追加笔记",
    back: "返回",
    cancel: "取消",
    chatMode: "对话模式",
    clear: "清空",
    copy: "复制",
    edit: "修改",
    external: "外部打开",
    forward: "前进",
    googleSearch: "Google 搜索",
    hide: "隐藏",
    image: "图片",
    loginMode: "登录模式",
    loginWindow: "登录窗口",
    next: "下一条",
    openExternal: "外部打开",
    previous: "上一条",
    regenerate: "重新生成",
    reload: "刷新",
    save: "保存",
    send: "发送",
  },
  commands: {
    clearAllDescription: "清空所有已保存的 Paperly AI 会话",
    clearAllLabel: "清空全部",
    clearDescription: "清空当前 Paperly AI 会话",
    clearLabel: "清空当前",
    exportAllDescription: "把所有历史会话导出为 Markdown",
    exportAllLabel: "导出全部",
    exportDescription: "把当前会话导出为 Markdown",
    exportLabel: "导出当前",
    mcpDescription: "为本轮对话加载 zotero-mcp 工具",
    mcpLabel: "Zotero MCP",
    newDescription: "新建干净会话并刷新网页对话",
    newLabel: "新对话",
    pdfDescription: "把当前 PDF 或条目全文加入本次提示词",
    pdfLabel: "当前 PDF",
    webDescription: "联网搜索并把结果加入本次提示词",
    webLabel: "联网搜索",
  },
  composerPlaceholder:
    "输入 Markdown、/new conversation，或输入 / 调出 PDF、联网搜索、Zotero MCP、Skill",
  defaultStatus: "输入 / 可选择 PDF、联网搜索、Zotero MCP 或自定义 Skill。",
  emptyConversation:
    "发送消息开始新一轮对话，输入 / 调出命令，或使用 /new conversation 重置。",
  lookup: {
    hint: "查询页面没有对话记录。阅读器中选中的文本会自动填入。",
    placeholder: "要查询的单词或短语",
    submit: "查询",
  },
  errors: {
    currentPDFUnavailable: "当前 PDF 或 Zotero 条目全文不可用。",
    editedPromptEmpty: "修改后的提示词为空。",
    mcpUnavailable: "MCP 不可用，请确认 zotero-mcp 正在运行。",
    noMessageOrCommand: "请输入消息或选择一个 / 命令。",
  },
  labels: {
    conversation: "对话",
    history: "历史",
    noSavedSessions: "还没有保存的会话。",
    processHidden: "过程已折叠",
    user: "用户",
    zaiLoginMode: "Z.ai 登录模式",
  },
  record: {
    capturedWebAnswer: "已捕获网页回复",
    captureNeeded: "需要手动捕获",
    currentPDFCommand: "当前 PDF 命令",
    mcpAssistedAnswer: "MCP 辅助回答",
    pdfAssistedAnswer: "PDF 辅助回答",
    skillResult: (label) => `Skill 结果：${label}`,
    webAnswer: "网页回答",
    webSearchAnswer: "联网搜索回答",
  },
  status: {
    appendNote: (title, noteID) =>
      `已将 ${title} 追加到 Zotero WebAI Notes（#${noteID}）。`,
    captured: (serviceLabel) => `已捕获最新 ${serviceLabel} 回复到 Paperly AI。`,
    clearSelectedCommandTitle: "清除已选命令",
    clearedAllSessions: "已清空全部历史会话。",
    clearedSession: "已清空当前会话。",
    copiedRecord: (title) => `已复制 ${title}。`,
    copiedUserPrompt: "已复制用户提示词。",
    editPrompt: "直接修改用户提示词，保存后会生成新的结果。",
    failed: (message) => `失败：${message}`,
    imageAttached: (name) => `已添加图片：${name}。`,
    imageRemoved: "已移除图片附件。",
    incomingReady: (label, serviceLabel) =>
      `${label} 已准备好，发送后会插入 ${serviceLabel}。`,
    loadedSession: (title) => `已加载会话：${title}`,
    loginWindowOpened: (serviceLabel) =>
      `已打开更大的 ${serviceLabel} 登录窗口。登录后回到这里，必要时刷新。`,
    noSessionsToExport: "没有可导出的对话记录。",
    promptCopied: (prefix, length, serviceLabel) =>
      `${prefix}提示词已复制（${length} 字符）。如果没有出现在 ${serviceLabel}，请点击网页输入框后粘贴。`,
    promptInserted: (prefix, serviceLabel) =>
      `${prefix}提示词已插入 ${serviceLabel}。请在网页对话中发送，必要时点击捕获。`,
    promptSent: (prefix, serviceLabel) =>
      `${prefix}已发送到 ${serviceLabel}，正在等待结果。`,
    promptSentCaptureNeeded: "提示词已发送。未能自动捕获回复，请在网页视图中查看。",
    regenerating: (title) => `正在重新生成 ${title}。`,
    sendTitle: "把提示词插入网页对话，必要时使用剪贴板兜底",
    slashClear: "清空当前 Paperly AI 会话。",
    slashClearAll: "清空所有已保存的 Paperly AI 会话。",
    slashExport: "导出当前会话为 Markdown。",
    slashExportAll: "导出所有历史会话为 Markdown。",
    slashMCP:
      "已选择 Zotero MCP。发送后会加载 zotero-mcp 工具，网页模型可请求真实工具调用。",
    slashNew: "开始新对话并清空当前网页对话上下文。",
    slashPDF: "已选择当前 PDF。发送后会把当前 PDF/条目全文加入本次提示词。",
    slashSkill: (slashCommand) => `已选择 Skill /${slashCommand}。请输入问题后发送。`,
    slashWeb: "已选择联网搜索。发送后会搜索网页并附加结果。",
    startedConversation: (serviceLabel) => `已开始新的 ${serviceLabel} 对话。`,
    exportedSession: (target) => `已导出 Markdown 对话到 ${target}。`,
    exportCopied: "无法打开文件保存窗口，已将 Markdown 对话复制到剪贴板。",
    turnCount: (turns) => `${turns} 轮`,
    turnsSessions: (turns, sessions) => `${turns} 轮 / ${sessions} 个会话`,
    waiting: (serviceLabel) => `正在等待 ${serviceLabel} 回复...`,
    zaiChatRestored: "已恢复 Z.ai 对话模式。发送会把提示词插入网页对话。",
    zaiLoginMode: "Z.ai 登录模式会把验证码区域扩展到整个侧边栏高度。",
  },
};
const ZOTERO_MCP_COMMAND: WebAISkill = {
  description: "Load zotero-mcp tools for this conversation",
  id: "zotero-mcp",
  kind: "mcp",
  label: "Zotero MCP",
  promptPrefix: "",
  slashCommand: "zotero-mcp",
};
const NEW_CONVERSATION_COMMAND: WebAISkill = {
  aliases: ["new", "newconversation", "newchat"],
  description: "Start a clean chat session and reload the web chat",
  id: "new-conversation",
  kind: "new",
  label: "New Conversation",
  promptPrefix: "",
  slashCommand: "new conversation",
};
const CURRENT_PDF_COMMAND: WebAISkill = {
  description: "Attach current PDF or item full text to this prompt",
  id: "current-pdf",
  kind: "pdf",
  label: "Current PDF",
  promptPrefix: "",
  slashCommand: "pdf",
};
const WEB_SEARCH_COMMAND: WebAISkill = {
  description: "Search the web and attach results to this prompt",
  id: "web-search",
  kind: "web",
  label: "Web Search",
  promptPrefix: "",
  slashCommand: "websearch",
};
const CLEAR_CURRENT_COMMAND: WebAISkill = {
  aliases: ["clearcurrent"],
  description: "Clear the current Paperly AI chat session",
  id: "clear-current",
  kind: "clear",
  label: "Clear Current",
  promptPrefix: "",
  slashCommand: "clear",
};
const CLEAR_ALL_COMMAND: WebAISkill = {
  aliases: ["clearall"],
  description: "Clear every saved Paperly AI chat session",
  id: "clear-all",
  kind: "clear",
  label: "Clear All",
  promptPrefix: "",
  slashCommand: "clear all",
};
const EXPORT_CURRENT_COMMAND: WebAISkill = {
  aliases: ["exportcurrent"],
  description: "Export the current Paperly AI chat session as Markdown",
  id: "export-current",
  kind: "export",
  label: "Export Current",
  promptPrefix: "",
  slashCommand: "export",
};
const EXPORT_ALL_COMMAND: WebAISkill = {
  aliases: ["exportall"],
  description: "Export every saved Paperly AI chat session as Markdown",
  id: "export-all",
  kind: "export",
  label: "Export All",
  promptPrefix: "",
  slashCommand: "export all",
};
const INITIAL_CHAT_SESSIONS = loadChatSessions();

function resolveWebAILocale(hostWindow: Window): string {
  const requested = getRequestedLanguage();
  if (requested) {
    return requested;
  }
  return (
    hostWindow.navigator?.language ||
    ((globalThis as unknown as { navigator?: { language?: string } }).navigator
      ?.language || "")
  );
}

function getWebAIStrings(language: string): WebAIStrings {
  return isChineseLocale(language) ? ZH_STRINGS : EN_STRINGS;
}

function getLocalizedBuiltInCommands(text: WebAIStrings): WebAISkill[] {
  return [
    {
      ...NEW_CONVERSATION_COMMAND,
      description: text.commands.newDescription,
      label: text.commands.newLabel,
    },
    {
      ...CLEAR_CURRENT_COMMAND,
      description: text.commands.clearDescription,
      label: text.commands.clearLabel,
    },
    {
      ...CLEAR_ALL_COMMAND,
      description: text.commands.clearAllDescription,
      label: text.commands.clearAllLabel,
    },
    {
      ...EXPORT_CURRENT_COMMAND,
      description: text.commands.exportDescription,
      label: text.commands.exportLabel,
    },
    {
      ...EXPORT_ALL_COMMAND,
      description: text.commands.exportAllDescription,
      label: text.commands.exportAllLabel,
    },
    {
      ...CURRENT_PDF_COMMAND,
      description: text.commands.pdfDescription,
      label: text.commands.pdfLabel,
    },
    {
      ...WEB_SEARCH_COMMAND,
      description: text.commands.webDescription,
      label: text.commands.webLabel,
    },
    {
      ...ZOTERO_MCP_COMMAND,
      description: text.commands.mcpDescription,
      label: text.commands.mcpLabel,
    },
  ];
}

export const WebAIWorkspace: React.FC<WebAIWorkspaceProps> = ({
  contextSummary,
  customPresets = "",
  hostWindow,
  incomingPrompt,
  isDark,
  location,
  lookupRequest,
  onIncomingPromptHandled,
  onLookupRequestHandled,
  onPanelViewChange,
  onSelectService,
  scope,
  selectionText = "",
  service,
  settings,
  theme,
}) => {
  const isReaderWorkspace = location === "reader";
  const workspaceLayout = settings.workspaceLayout || "stacked";
  const isCompactLayout = workspaceLayout === "compact";
  const language = useMemo(() => resolveWebAILocale(hostWindow), [hostWindow]);
  const text = useMemo(() => getWebAIStrings(language), [language]);
  // Dictionary and search pages have a search box, not a prompt box: there is
  // nothing to inject and no answer to stream back, so the whole chat surface
  // (composer, Capture, transcript, web-search toggle) is hidden for them.
  const isLookupService = service.kind === "lookup";
  const [lookupQuery, setLookupQuery] = useState("");
  // "AI Web" returns to whichever chat provider was last in use, so toggling
  // Google Search on and off does not strand the user on a dictionary page.
  const [lastChatService, setLastChatService] = useState<WebAIService>(
    service.kind === "chat" ? service : getDefaultService(),
  );
  // Empty until something actually happens. The status line used to open with
  // "Loaded <provider>", which said the same thing on every switch and said it
  // where the page itself already showed it.
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [message, setMessage] = useState("");
  const [composerImage, setComposerImage] =
    useState<ComposerImageAttachment | null>(null);
  const [selectedSkillID, setSelectedSkillID] = useState<string | null>(null);
  const [editingTurnID, setEditingTurnID] = useState<string | null>(null);
  const [editingPrompt, setEditingPrompt] = useState("");
  const [turnVersionSelections, setTurnVersionSelections] = useState<
    Record<string, number>
  >({});
  const [historyVisible, setHistoryVisible] = useState(false);
  // One surface at a time. A ~400px column split in half leaves neither the
  // provider page nor the transcript usable, and "Hide Web" plus the drag
  // splitter were already an awkward two-mechanism version of this.
  const [panelView, setPanelView] = useState<WebAIPanelView>("web");
  const [zaiLoginMode, setZaiLoginMode] = useState(false);
  const [chatSessions, setChatSessions] = useState<WebAIChatSession[]>(() =>
    INITIAL_CHAT_SESSIONS,
  );
  const [activeSessionID, setActiveSessionIDState] = useState<string | null>(
    () => INITIAL_CHAT_SESSIONS[0]?.id || null,
  );
  const [executionRecords, setExecutionRecords] = useState<
    WebAIExecutionRecord[]
  >(() =>
    clampSessionRecords(INITIAL_CHAT_SESSIONS[0]?.records || []),
  );
  const [activeRecordID, setActiveRecordID] = useState<string | null>(
    () => INITIAL_CHAT_SESSIONS[0]?.records.find((record) => !record.hidden)?.id || null,
  );
  const executionRecordsRef = useRef<WebAIExecutionRecord[]>(executionRecords);
  const composerImageInputRef = useRef<HTMLInputElement>(null);
  const frameHostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<Element | null>(null);
  // One entry per provider that has been opened. Frames are hidden, never
  // removed: taking a <browser> out of the DOM destroys its frame loader, and
  // the page goes with it.
  const framesRef = useRef<Map<WebAIServiceId, FrameEntry>>(new Map());
  // Read by the load and navigation paths below, which must not re-run when
  // the theme changes -- switching to dark has to leave the open page alone.
  const darkRef = useRef(isDark);
  // Where the frame is and whether it has anywhere to go back to. Both change
  // without React's involvement -- the user clicks a link in the page -- so
  // they are fed by an nsIWebProgress listener rather than by the panel's own
  // navigation calls.
  const [frameNavigation, setFrameNavigation] = useState<FrameNavigation>({
    canGoBack: false,
    canGoForward: false,
    url: "",
  });
  const transcriptRef = useRef<HTMLDivElement>(null);
  const activeSessionIDRef = useRef<string | null>(activeSessionID);
  const activeMCPBridgeTokensRef = useRef<Set<string>>(new Set());
  const assistantCaptureRunRef = useRef(0);
  const handledMCPRequestsRef = useRef<Set<string>>(new Set());
  const lastCapturedAssistantTextRef = useRef("");
  const pendingCaptureRecordIDRef = useRef<string | null>(null);

  // Where the panel would put the frame on its own: the look-up result if there
  // is a query, otherwise the provider's own page.
  const frameHomeURL =
    isLookupService && lookupQuery.trim()
      ? buildLookupURL(service, lookupQuery)
      : service.url;
  // Where the frame actually is. It differs from frameHomeURL as soon as the
  // user follows a link, which is why Open External used to send them to the
  // provider's home page instead of the page they were reading.
  const currentFrameURL = frameNavigation.url || frameHomeURL;

  const stepThroughHistory = (direction: "back" | "forward") => {
    const browser = frameRef.current as
      | (Element & {
          goBack?: (requireUserInteraction?: boolean) => void;
          goForward?: (requireUserInteraction?: boolean) => void;
        })
      | null;
    try {
      // false so this matches what the buttons are enabled for. The default
      // comes from browser.navigation.requireUserInteraction and would skip
      // entries the panel loaded itself, such as a look-up result.
      if (direction === "back") {
        browser?.goBack?.(false);
      } else {
        browser?.goForward?.(false);
      }
    } catch (error) {
      ztoolkit.log(`Web AI frame refused go${direction}:`, String(error));
    }
  };

  const appendExecutionRecord = (
    draft: WebAIExecutionRecordDraft,
  ): string => {
    const record = createExecutionRecord(draft);
    const next = [record, ...executionRecordsRef.current].slice(
      0,
      EXECUTION_RECORD_LIMIT,
    );
    executionRecordsRef.current = next;
    setExecutionRecords(next);
    upsertChatSession(record);
    if (!record.hidden) {
      setActiveRecordID(record.id);
      if (record.turnID) {
        setTurnVersionSelections((current) => ({
          ...current,
          [record.turnID || ""]: Number.MAX_SAFE_INTEGER,
        }));
      }
    }
    return record.id;
  };

  const replaceExecutionRecord = (
    recordID: string,
    draft: WebAIExecutionRecordDraft,
  ): boolean => {
    const current = executionRecordsRef.current;
    const index = current.findIndex((record) => record.id === recordID);
    if (index < 0) {
      return false;
    }
    const existing = current[index];
    const updated: WebAIExecutionRecord = {
      ...existing,
      ...draft,
      createdAt: existing.createdAt,
      id: existing.id,
    };
    const next = [...current];
    next[index] = updated;
    executionRecordsRef.current = next;
    setExecutionRecords(next);
    const sessionID = activeSessionIDRef.current;
    if (sessionID) {
      setChatSessions((sessions) =>
        saveChatSessions(
          updateChatSessionsRecords(sessions, {
            records: next,
            serviceID: service.id,
            serviceLabel: service.label,
            sessionID,
          }),
        ),
      );
    }
    setActiveRecordID(recordID);
    return true;
  };

  const upsertChatSession = (record: WebAIExecutionRecord) => {
    const sessionID = activeSessionIDRef.current || createSessionID();
    if (!activeSessionIDRef.current) {
      setActiveSessionID(sessionID);
    }
    setChatSessions((current) =>
      saveChatSessions(
        updateChatSessionsWithRecord(current, {
          record,
          serviceID: service.id,
          serviceLabel: service.label,
          sessionID,
        }),
      ),
    );
  };

  const setActiveSessionID = (sessionID: string | null) => {
    activeSessionIDRef.current = sessionID;
    setActiveSessionIDState(sessionID);
  };

  const replaceActiveSessionRecords = (records: WebAIExecutionRecord[]) => {
    const sessionID = activeSessionIDRef.current;
    if (!sessionID) {
      executionRecordsRef.current = records;
      setExecutionRecords(records);
      return;
    }
    executionRecordsRef.current = records;
    setExecutionRecords(records);
    setChatSessions((current) =>
      saveChatSessions(
        updateChatSessionsRecords(current, {
          records,
          serviceID: service.id,
          serviceLabel: service.label,
          sessionID,
        }),
      ),
    );
  };

  const openSession = (session: WebAIChatSession) => {
    const records = clampSessionRecords(session.records);
    setActiveSessionID(session.id);
    executionRecordsRef.current = records;
    setExecutionRecords(records);
    setActiveRecordID(records.find((record) => !record.hidden)?.id || null);
    setEditingTurnID(null);
    setEditingPrompt("");
    setTurnVersionSelections({});
    setStatus(text.status.loadedSession(session.title));
    setIsError(false);
  };

  const resetConversationRuntime = () => {
    activeMCPBridgeTokensRef.current.clear();
    handledMCPRequestsRef.current.clear();
    lastCapturedAssistantTextRef.current = "";
    pendingCaptureRecordIDRef.current = null;
    assistantCaptureRunRef.current += 1;
  };

  const clearCurrentSession = () => {
    replaceActiveSessionRecords([]);
    setActiveRecordID(null);
    setEditingTurnID(null);
    setEditingPrompt("");
    setTurnVersionSelections({});
    setSelectedSkillID(null);
    setMessage("");
    setComposerImage(null);
    resetConversationRuntime();
    setStatus(text.status.clearedSession);
    setIsError(false);
  };

  const clearAllSessions = () => {
    saveChatSessions([]);
    setChatSessions([]);
    setActiveSessionID(null);
    executionRecordsRef.current = [];
    setExecutionRecords([]);
    setActiveRecordID(null);
    setEditingTurnID(null);
    setEditingPrompt("");
    setTurnVersionSelections({});
    setSelectedSkillID(null);
    setMessage("");
    setComposerImage(null);
    resetConversationRuntime();
    setStatus(text.status.clearedAllSessions);
    setIsError(false);
  };

  const customSkills = useMemo(
    () => buildCustomSkills(customPresets),
    [customPresets],
  );
  const builtInSlashCommands = useMemo(
    () => getLocalizedBuiltInCommands(text),
    [text],
  );
  const slashCommands = useMemo(
    () => [
      ...builtInSlashCommands,
      ...customSkills,
    ],
    [builtInSlashCommands, customSkills],
  );
  const selectedSkill =
    slashCommands.find((skill) => skill.id === selectedSkillID) || null;
  const slashQuery = getSlashQuery(message);
  const slashSuggestions = slashQuery
    ? filterSlashSkills(slashCommands, slashQuery.query)
    : [];
  const showSlashMenu = Boolean(slashQuery && slashSuggestions.length > 0);
  const isZAILoginMode = service.id === "zai" && zaiLoginMode;
  const visibleExecutionRecords = useMemo(
    () => executionRecords.filter((record) => !record.hidden),
    [executionRecords],
  );
  const transcriptTurns = useMemo(
    () => buildTranscriptTurns(visibleExecutionRecords),
    [visibleExecutionRecords],
  );

  useEffect(() => {
    if (selectedSkillID && !slashCommands.some((skill) => skill.id === selectedSkillID)) {
      setSelectedSkillID(null);
    }
  }, [selectedSkillID, slashCommands]);

  // One <browser> per provider, hidden rather than rebuilt.
  //
  // Switching used to tear the frame down and build a new one, and a <browser>
  // taken out of the DOM loses its frame loader -- so the page went with it:
  // search results, scroll position, a half-typed prompt. Keeping the element
  // and toggling `display` is how Zotero's own tab deck preserves reader tabs.
  //
  // The cost is one content process per provider the user has opened. Only
  // Reload, a look-up request and New Conversation navigate a frame now.
  useEffect(() => {
    const host = frameHostRef.current;
    if (!host) {
      return;
    }

    const onFrameNavigation = (next: FrameNavigation) => {
      setFrameNavigation((current) =>
        current.canGoBack === next.canGoBack &&
        current.canGoForward === next.canGoForward &&
        current.url === next.url
          ? current
          : next,
      );
    };

    const frames = framesRef.current;
    let entry = frames.get(service.id);
    if (!entry) {
      const frame = createWebFrame(host.ownerDocument || hostWindow.document);
      host.appendChild(frame);
      entry = { frame, loaded: false, loadedLookup: "", stopWatching: null };
      frames.set(service.id, entry);
      // Bridge bookkeeping belongs to a page, and this one has none yet.
      activeMCPBridgeTokensRef.current.clear();
      handledMCPRequestsRef.current.clear();
    }
    const active = entry;
    frames.forEach((other, id) => {
      (other.frame as HTMLElement).style.display =
        id === service.id ? "" : "none";
    });
    frameRef.current = active.frame;

    let observer: ResizeObserver | null = null;

    if (active.loaded) {
      // Restored, not reloaded. Nothing navigated, so no listener will fire --
      // the toolbar has to be told where this page was left.
      onFrameNavigation(readFrameNavigation(active.frame));
    } else {
      onFrameNavigation({ canGoBack: false, canGoForward: false, url: "" });

      // The panel often mounts while its Zotero container is still collapsed,
      // where the whole ancestor chain measures 0px wide. Loading then renders
      // the page into a zero-width viewport and it never becomes visible, so
      // wait until the host actually has width before loading -- which is also
      // the moment the user has opened the pane.
      const loadWhenSized = () => {
        if (active.loaded || !active.frame.isConnected) {
          return;
        }
        if (host.getBoundingClientRect().width < 1) {
          return;
        }
        active.loaded = true;
        observer?.disconnect();
        // Land on the result rather than the provider's home page when a
        // selection is already in hand -- switching to Cambridge from the
        // reader's selection popup should show the entry, not a search box.
        // `selectionText` is read from this render's closure rather than being
        // a dependency: this runs once per provider, at the moment its page is
        // first loaded, which is the only moment that matters.
        const pendingLookup =
          service.kind === "lookup"
            ? normalizeSelectionForLookup(selectionText)
            : "";
        active.loadedLookup = pendingLookup;
        loadFrameElement(
          active.frame,
          pendingLookup ? buildLookupURL(service, pendingLookup) : service.url,
        );
        // After the load, not before: primeBrowserRemoteness rebuilds the frame
        // loader, and with it the browsing context and the message manager
        // these three attach to.
        applyFrameColorScheme(active.frame, darkRef.current);
        active.stopWatching = watchFrameNavigation(active.frame, (next) => {
          // A process swap replaces the browsing context, and the colour-scheme
          // override goes with it.
          applyFrameColorScheme(active.frame, darkRef.current);
          // A hidden provider can still navigate on its own -- a redirect, a
          // client-side route -- and it must not take over the toolbar of the
          // one on screen.
          if (frameRef.current === active.frame) {
            onFrameNavigation(next);
          }
        });
        interceptFrameLinks(active.frame);
      };

      const ResizeObserverCtor = (hostWindow as Window & {
        ResizeObserver?: typeof ResizeObserver;
      }).ResizeObserver;
      observer = ResizeObserverCtor
        ? new ResizeObserverCtor(loadWhenSized)
        : null;
      observer?.observe(host);
      loadWhenSized();
    }

    return () => {
      // Only the observer. The frame outlives this effect on purpose; it is
      // destroyed when the workspace unmounts, below.
      observer?.disconnect();
    };
  }, [hostWindow.document, service]);

  useEffect(() => {
    darkRef.current = isDark;
    framesRef.current.forEach((entry) => {
      applyFrameColorScheme(entry.frame, isDark);
    });
  }, [isDark]);

  useEffect(() => {
    onPanelViewChange?.(panelView);
  }, [onPanelViewChange, panelView]);

  // Frames are the only thing here that owns an OS resource, so they get an
  // unmount-only teardown -- the effect above runs on every provider switch
  // and must not take them with it.
  useEffect(() => {
    const frames = framesRef.current;
    return () => {
      frames.forEach((entry) => {
        entry.stopWatching?.();
        try {
          entry.frame.remove();
        } catch {
          // Remote browser wrappers can throw during teardown.
        }
      });
      frames.clear();
      frameRef.current = null;
    };
  }, []);


  useEffect(() => {
    if (!incomingPrompt) {
      return;
    }

    // Not routed to the look-up box: buildReaderActionDraft wraps the excerpt
    // in a full instruction ("explain this excerpt from page N: ...") , which is
    // a prompt, not a search term. Look-up providers follow the raw selection
    // instead, in the effect above.
    setMessage(incomingPrompt.prompt);
    setComposerImage(null);
    setSelectedSkillID(null);
    setStatus(text.status.incomingReady(incomingPrompt.label, service.label));
    setIsError(false);
    onIncomingPromptHandled?.(incomingPrompt.id);
  }, [incomingPrompt, onIncomingPromptHandled, service, text]);

  useEffect(() => {
    if (!shouldUseMCPInConversation(settings)) {
      return;
    }

    let cancelled = false;
    let isPolling = false;
    let timerId: unknown = null;
    const timerHost = resolveTimerHost();

    const schedule = () => {
      if (cancelled) {
        return;
      }
      timerId = timerHost.setTimeout(() => {
        void pollForMCPBridgeRequests();
      }, MCP_BRIDGE_POLL_MS);
    };

    const pollForMCPBridgeRequests = async () => {
      if (cancelled || isPolling) {
        schedule();
        return;
      }
      isPolling = true;
      try {
        const requests = await extractMCPBridgeRequestsFromWebChat(
          frameRef.current,
          activeMCPBridgeTokensRef.current,
        );
        for (const request of requests) {
          if (cancelled || handledMCPRequestsRef.current.has(request.id)) {
            continue;
          }
          handledMCPRequestsRef.current.add(request.id);
          await runMCPBridgeRequest({
            appendExecutionRecord,
            request,
            serviceLabel: service.label,
            settings,
            setStatus,
          });
        }
      } catch (error) {
        ztoolkit.log("MCP bridge polling failed:", error);
      } finally {
        isPolling = false;
        schedule();
      }
    };

    schedule();
    return () => {
      cancelled = true;
      if (timerId != null) {
        timerHost.clearTimeout(timerId);
      }
    };
  }, [service.label, settings]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }
    if (activeRecordID) {
      const target = node.querySelector<HTMLElement>(
        `[data-record-id="${activeRecordID}"]`,
      );
      if (target) {
        // Scroll the transcript itself. scrollIntoView() walks up and scrolls
        // EVERY ancestor scroll frame, including the `overflow: hidden` wrappers
        // around the workspace, which have no scrollbar -- in `split` layout the
        // toolbar is the topmost grid row and is the first thing ejected.
        node.scrollTop +=
          target.getBoundingClientRect().bottom -
          node.getBoundingClientRect().bottom;
        return;
      }
    }
    node.scrollTop = node.scrollHeight;
  }, [activeRecordID, visibleExecutionRecords.length, historyVisible]);

  const recordAssistantReply = (
    captured: string,
    options: AssistantReplyRecordOptions = {},
  ) => {
    const normalized = normalizeAssistantCapture(
      captured,
      options.sourcePrompt,
      lastCapturedAssistantTextRef.current,
    );
    const dedupeKey = [normalized.body, normalized.thinking || ""].join("\n\n");
    if (
      !normalized.body ||
      dedupeKey === lastCapturedAssistantTextRef.current ||
      looksLikeInternalBridgeOutput(normalized.body)
    ) {
      return false;
    }
    lastCapturedAssistantTextRef.current = dedupeKey;
    const draft: WebAIExecutionRecordDraft = {
      body: normalized.body,
      kind: options.kind || "assistant",
      sourcePrompt: options.sourcePrompt,
      status: "done",
      subtitle: options.subtitle || service.label,
      thinking: normalized.thinking,
      title: options.title || text.record.capturedWebAnswer,
      turnID: options.turnID,
      userPrompt: options.userPrompt,
    };
    if (options.pendingRecordID && replaceExecutionRecord(options.pendingRecordID, draft)) {
      if (pendingCaptureRecordIDRef.current === options.pendingRecordID) {
        pendingCaptureRecordIDRef.current = null;
      }
      return true;
    }
    appendExecutionRecord(draft);
    if (
      options.pendingRecordID &&
      pendingCaptureRecordIDRef.current === options.pendingRecordID
    ) {
      pendingCaptureRecordIDRef.current = null;
    }
    return true;
  };

  const updatePendingAssistantReply = (
    captured: string,
    options?: AssistantReplyRecordOptions,
  ) => {
    if (!options?.pendingRecordID) {
      return;
    }
    const normalized = normalizeAssistantCapture(captured, options.sourcePrompt);
    if (!normalized.body || looksLikeInternalBridgeOutput(normalized.body)) {
      return;
    }
    replaceExecutionRecord(options.pendingRecordID, {
      body: normalized.body,
      kind: options.kind || "assistant",
      sourcePrompt: options.sourcePrompt,
      status: "running",
      subtitle: options.subtitle || service.label,
      thinking: normalized.thinking,
      title: options.title || text.record.webAnswer,
      turnID: options.turnID,
      userPrompt: options.userPrompt,
    });
  };

  const waitForAssistantReply = async (
    baselineText?: string,
    options?: AssistantReplyRecordOptions,
  ) => {
    const runId = ++assistantCaptureRunRef.current;
    try {
      setStatus(text.status.waiting(service.label));
      const captured = await waitForStableAssistantText(
        frameRef.current,
        baselineText || "",
        () => runId === assistantCaptureRunRef.current,
        options?.sourcePrompt,
        () => lastCapturedAssistantTextRef.current,
        (candidate) => updatePendingAssistantReply(candidate.body, options),
      );
      if (!captured || runId !== assistantCaptureRunRef.current) {
        if (runId === assistantCaptureRunRef.current) {
          markPendingCaptureNeeded(options);
        }
        return;
      }
      if (recordAssistantReply(captured, options)) {
        setStatus(text.status.captured(service.label));
      }
    } catch (error) {
      ztoolkit.log("Web AI automatic capture failed:", error);
      if (runId === assistantCaptureRunRef.current) {
        setStatus(text.status.promptSentCaptureNeeded);
        markPendingCaptureNeeded(options);
      }
    }
  };

  const markPendingCaptureNeeded = (options?: AssistantReplyRecordOptions) => {
    if (!options?.pendingRecordID) {
      return;
    }
    replaceExecutionRecord(options.pendingRecordID, {
      body: formatPendingCaptureNeededBody(text),
      kind: options.kind || "assistant",
      sourcePrompt: options.sourcePrompt,
      status: "running",
      subtitle: options.subtitle || service.label,
      title: text.record.captureNeeded,
      turnID: options.turnID,
      userPrompt: options.userPrompt,
    });
  };

  const deliverPrompt = async (
    prompt: string,
    statusPrefix?: string | null,
    captureOptions?: AssistantReplyRecordOptions,
    attachments: ComposerImageAttachment[] = [],
  ) => {
    const baselineText = await readLatestAssistantText(frameRef.current)
      .then((result) => (result.ok ? result.text || "" : ""))
      .catch(() => "");
    const nativeClipboardImageReady = attachments[0]
      ? copyComposerImageToNativeClipboard(attachments[0])
      : false;
    if (!nativeClipboardImageReady) {
      copyTextToClipboard(prompt);
    }
    const result = await insertPromptIntoWebChat(
      frameRef.current,
      prompt,
      true,
      attachments,
      nativeClipboardImageReady,
    );
    focusFrame(frameRef.current);
    const nextCaptureOptions = {
      ...captureOptions,
      sourcePrompt: captureOptions?.sourcePrompt || prompt,
    };
    const pendingRecordID = shouldCreatePendingReplyRecord(prompt)
        ? appendExecutionRecord({
          body: formatPendingReplyBody(result, service.label, prompt.length, text),
          kind: nextCaptureOptions.kind || "assistant",
          sourcePrompt: nextCaptureOptions.sourcePrompt,
          status: result.ok && result.submitted ? "running" : "error",
          subtitle: nextCaptureOptions.subtitle || service.label,
          title: nextCaptureOptions.title || text.record.webAnswer,
          turnID: nextCaptureOptions.turnID,
          userPrompt: nextCaptureOptions.userPrompt,
        })
      : null;
    if (pendingRecordID && result.ok && result.submitted) {
      pendingCaptureRecordIDRef.current = pendingRecordID;
      nextCaptureOptions.pendingRecordID = pendingRecordID;
    }
    if (result.ok && result.submitted) {
      setStatus(text.status.promptSent(formatStatusPrefix(statusPrefix), service.label));
      void waitForAssistantReply(baselineText, nextCaptureOptions);
    } else if (result.ok) {
      setStatus(text.status.promptInserted(formatStatusPrefix(statusPrefix), service.label));
    } else {
      setStatus(
        text.status.promptCopied(
          formatStatusPrefix(statusPrefix),
          prompt.length,
          service.label,
        ),
      );
    }
    setIsError(!(result.ok && result.submitted));
  };

  const copyRecord = (record: WebAIExecutionRecord) => {
    copyTextToClipboard(formatMarkdownForDisplay(record.body));
    setStatus(text.status.copiedRecord(record.title));
    setIsError(false);
  };

  const regenerateRecord = async (record: WebAIExecutionRecord) => {
    const turnID = record.turnID || getRecordTurnKey(record);
    const userPrompt = formatRecordSourceForChat(record);
    if (record.kind === "web") {
      const query = record.sourcePrompt || record.title.replace(/^Web search:\s*/i, "");
      await fetchWebSearchContextForConversation({
        appendExecutionRecord,
        contextSummary,
        message: query,
        scope,
        selectedSkill,
        setStatus,
      });
      setIsError(false);
      return;
    }
    if (record.kind === "pdf") {
      const reusablePrompt =
        record.sourcePrompt?.includes(
          `Command: /${CURRENT_PDF_COMMAND.slashCommand}`,
        ) && record.sourcePrompt.includes("Paper content:")
          ? record.sourcePrompt
          : "";
      if (!reusablePrompt && !contextSummary?.fullText?.trim()) {
        throw new Error(
          contextSummary?.blockingMessage ||
            text.errors.currentPDFUnavailable,
        );
      }
      const prompt =
        reusablePrompt ||
        buildWorkspacePrompt({
          contextSummary,
          includeFullText: true,
          mcpContext: "",
          message: record.sourcePrompt || "",
          scope,
          selectedSkill: CURRENT_PDF_COMMAND,
          webContext: "",
        });
      await deliverPrompt(prompt, text.status.regenerating(record.title), {
        ...buildPDFReplyRecordOptions(service.label, text),
        sourcePrompt: prompt,
        turnID,
        userPrompt,
      });
      return;
    }

    const prompt =
      record.sourcePrompt && record.kind !== "skill"
        ? record.sourcePrompt
        : buildRegeneratePrompt(record);
    await deliverPrompt(prompt, text.status.regenerating(record.title), {
      kind: record.kind === "skill" ? "skill" : "assistant",
      sourcePrompt: prompt,
      subtitle: service.label,
      title: `${text.buttons.regenerate}: ${record.title}`,
      turnID,
      userPrompt,
    });
  };

  const appendRecordToNote = async (record: WebAIExecutionRecord) => {
    const noteID = await appendResultToZoteroNote(scope, record);
    setStatus(text.status.appendNote(record.title, noteID));
    setIsError(false);
  };

  const selectComposerImage = () => {
    composerImageInputRef.current?.click();
  };

  const handleComposerImageChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0] || null;
    event.target.value = "";
    if (!file) {
      return;
    }
    await setComposerImageFromFile(file);
  };

  const handleComposerPaste = async (
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ) => {
    const items = Array.from(event.clipboardData?.items || []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    const file = imageItem?.getAsFile();
    if (!file) {
      return;
    }
    event.preventDefault();
    await setComposerImageFromFile(file);
  };

  const setComposerImageFromFile = async (file: File) => {
    const dataURL = await readFileAsDataURL(file);
    const imageName = file.name || createPastedImageFileName(dataURL);
    setComposerImage({
      dataURL,
      name: imageName,
      type: file.type || parseDataURLMimeType(dataURL) || "image/png",
    });
    setStatus(text.status.imageAttached(imageName));
    setIsError(false);
  };

  const removeComposerImage = () => {
    setComposerImage(null);
    setStatus(text.status.imageRemoved);
    setIsError(false);
    void removeWebChatComposerImages(frameRef.current);
  };

  const runSessionSlashCommand = async (command: SessionSlashCommand) => {
    if (command.action === "clear") {
      if (command.scope === "all") {
        clearAllSessions();
      } else {
        clearCurrentSession();
      }
      return;
    }

    const sessionsToExport =
      command.scope === "all"
        ? chatSessions
        : getCurrentExportSession({
            activeSessionID,
            executionRecords,
            serviceID: service.id,
            serviceLabel: service.label,
          });
    const sessions = Array.isArray(sessionsToExport)
      ? sessionsToExport
      : sessionsToExport
        ? [sessionsToExport]
        : [];
    const exportableSessions = sessions.filter((session) =>
      session.records.some((record) => !record.hidden || record.body.trim()),
    );
    if (!exportableSessions.length) {
      setStatus(text.status.noSessionsToExport);
      setIsError(true);
      return;
    }

    const markdown = buildSessionsExportMarkdown(exportableSessions);
    const result = await exportMarkdownWithPicker({
      hostWindow,
      markdown,
      suggestedName: buildConversationExportFileName(command.scope),
    });
    if (result.status === "saved") {
      setStatus(text.status.exportedSession(result.target));
    } else if (result.status === "copied") {
      setStatus(text.status.exportCopied);
    } else {
      setStatus(formatSlashCommandStatus(
        command.scope === "all" ? EXPORT_ALL_COMMAND : EXPORT_CURRENT_COMMAND,
        text,
      ));
    }
    setIsError(false);
  };

  const runAction = async (action: () => Promise<void> | void) => {
    try {
      await action();
    } catch (error) {
      const errorMessage =
        error instanceof Error && error.message ? error.message : String(error);
      setStatus(text.status.failed(errorMessage));
      setIsError(true);
      ztoolkit.log("Web AI action failed:", error);
    }
  };

  const chooseSkill = (skill: WebAISkill) => {
    if (skill.kind === "new") {
      startNewConversation();
      return;
    }
    const sessionCommand = getSessionSlashCommand(skill);
    if (sessionCommand) {
      setMessage("");
      setComposerImage(null);
      setSelectedSkillID(null);
      void runAction(() => runSessionSlashCommand(sessionCommand));
      return;
    }
    setSelectedSkillID(skill.id);
    setMessage(removeSlashToken(message, [skill, ...slashCommands]).trimStart());
    setStatus(formatSlashCommandStatus(skill, text));
    setIsError(false);
  };

  // Drag to resize the web frame against the conversation below it. Pointer
  // capture is essential: without it the embedded <browser> swallows the move
  // events as soon as the cursor crosses into it and the drag dies.
  // React to the provider changing, whoever changed it. Skips the first run so
  // that merely opening the panel never pops a login window -- that stays an
  // explicit act, as it was when the selector lived in this component's toolbar.
  const lastServiceIdRef = useRef(service.id);
  useEffect(() => {
    if (lastServiceIdRef.current === service.id) {
      return;
    }
    lastServiceIdRef.current = service.id;
    if (service.kind === "chat") {
      setLastChatService(service);
    }
    setZaiLoginMode(service.id === "zai" && !isReaderWorkspace);
    setPanelView("web");
    if (service.kind === "chat" && !hasStoredSession(service)) {
      openLoginWindow(hostWindow, service);
      setStatus(text.status.loginWindowOpened(service.label));
      setIsError(false);
    }
  }, [hostWindow, isReaderWorkspace, service, text]);

  // Keep the look-up box on the current selection. It used to be filled from
  // `incomingPrompt`, which only fires when the user picks Explain or Ask from
  // the selection popup -- so the box kept whatever the last such action put
  // there and ignored every plain selection after it.
  const lastAppliedSelectionRef = useRef("");

  // Navigation for a repeat request. The frame effect only re-runs when the
  // provider changes, so asking to translate a second word while already on
  // Google Translate would otherwise do nothing at all: setService receives the
  // very same object and React skips the render.
  useEffect(() => {
    if (!lookupRequest) {
      return;
    }
    if (lookupRequest.serviceID !== service.id || service.kind !== "lookup") {
      // The provider switch has not landed yet; wait for the next render.
      return;
    }
    const query = normalizeSelectionForLookup(lookupRequest.text);
    const entry = framesRef.current.get(service.id);
    if (query && query !== entry?.loadedLookup) {
      if (entry) {
        entry.loadedLookup = query;
      }
      setLookupQuery(query);
      setPanelView("web");
      // Safe without the size gate the frame effect uses: reaching this branch
      // means the frame was already built and shown for this provider.
      loadFrameElement(frameRef.current, buildLookupURL(service, query));
    }
    onLookupRequestHandled?.(lookupRequest.id);
  }, [lookupRequest, onLookupRequestHandled, service]);
  useEffect(() => {
    if (service.kind !== "lookup") {
      return;
    }
    const normalized = normalizeSelectionForLookup(selectionText);
    if (!normalized || normalized === lastAppliedSelectionRef.current) {
      return;
    }
    lastAppliedSelectionRef.current = normalized;
    setLookupQuery(normalized);
  }, [selectionText, service]);

  const runLookup = (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }
    loadFrameElement(frameRef.current, buildLookupURL(service, trimmed));
    setPanelView("web");
  };

  const openServiceLoginWindow = () => {
    openLoginWindow(hostWindow, service);
    setStatus(text.status.loginWindowOpened(service.label));
    setIsError(false);
  };

  const enterZAILoginMode = () => {
    setPanelView("web");
    setZaiLoginMode(true);
    setStatus(text.status.zaiLoginMode);
    setIsError(false);
  };

  const exitZAILoginMode = () => {
    setPanelView("web");
    setZaiLoginMode(false);
    setStatus(text.status.zaiChatRestored);
    setIsError(false);
  };

  const startNewConversation = () => {
    const session = createChatSession({
      records: [],
      serviceID: service.id,
      serviceLabel: service.label,
    });
    setMessage("");
    setComposerImage(null);
    setSelectedSkillID(null);
    setActiveSessionID(session.id);
    setExecutionRecords([]);
    setActiveRecordID(null);
    setEditingTurnID(null);
    setEditingPrompt("");
    setTurnVersionSelections({});
    setIsError(false);
    setChatSessions((current) => saveChatSessions([session, ...current]));
    resetConversationRuntime();
    loadFrameElement(frameRef.current, service.url);
    setStatus(text.status.startedConversation(service.label));
  };

  const sendPrompt = async (
    overrideMessage?: string,
    overrideTurnID?: string,
  ) => {
    const isComposerSend = typeof overrideMessage !== "string";
    const imageAttachment =
      COMPOSER_IMAGE_INPUT_ENABLED && isComposerSend ? composerImage : null;
    const rawMessage = isComposerSend ? message : overrideMessage;
    const skillForResolution = isComposerSend ? selectedSkill : null;
    if (isNewConversationCommand(rawMessage)) {
      startNewConversation();
      return;
    }

    const resolved = resolveSkillFromMessage(
      rawMessage,
      slashCommands,
      skillForResolution,
    );
    if (resolved.skill?.kind === "new") {
      startNewConversation();
      return;
    }
    const sessionCommand = getSessionSlashCommand(resolved.skill);
    if (sessionCommand) {
      if (isComposerSend) {
        setMessage("");
        setComposerImage(null);
      }
      setSelectedSkillID(null);
      setEditingTurnID(null);
      setEditingPrompt("");
      await runSessionSlashCommand(sessionCommand);
      return;
    }
    if (!resolved.skill && !resolved.message.trim() && !imageAttachment) {
      throw new Error(text.errors.noMessageOrCommand);
    }
    if (isComposerSend) {
      setMessage("");
      setComposerImage(null);
    }
    setSelectedSkillID(null);
    setEditingTurnID(null);
    setEditingPrompt("");
    const isMCPCommand = resolved.skill?.kind === "mcp";
    const isPDFCommand = resolved.skill?.kind === "pdf";
    const isWebSearchCommand = resolved.skill?.kind === "web";
    const turnID = overrideTurnID || createTurnID();
    const userPrompt = appendComposerImageToMessage(
      buildRecordUserPrompt(rawMessage, resolved.message, resolved.skill),
      imageAttachment,
    );

    const promptInput = {
      contextSummary,
      message: getMessageForPrompt(resolved.message, imageAttachment, text),
      scope,
      selectedSkill: resolved.skill,
    };
    if (isPDFCommand) {
      const pdfTextLength = contextSummary?.fullText?.trim().length || 0;
      appendExecutionRecord({
        body: formatPDFCommandExecutionBody({
          contextSummary,
          message: resolved.message,
          scope,
        }),
        kind: "pdf",
        hidden: true,
        sourcePrompt: resolved.message,
        status: pdfTextLength ? "done" : "error",
        subtitle: `/${CURRENT_PDF_COMMAND.slashCommand}`,
        title: text.record.currentPDFCommand,
        turnID,
        userPrompt,
      });
      if (!pdfTextLength) {
        throw new Error(
          contextSummary?.blockingMessage ||
            text.errors.currentPDFUnavailable,
        );
      }
    }
    if (resolved.skill?.kind === "skill") {
      appendExecutionRecord({
        body: formatSkillExecutionBody({
          contextSummary,
          message: resolved.message,
          scope,
          skill: resolved.skill,
        }),
        kind: "skill",
        hidden: true,
        sourcePrompt: resolved.message,
        status: "done",
        subtitle: `/${resolved.skill.slashCommand}`,
        title: `Skill: ${resolved.skill.label}`,
        turnID,
        userPrompt,
      });
    }
    const mcpBridgeToken = isMCPCommand && shouldUseMCPInConversation(settings)
      ? createMCPBridgeToken()
      : "";
    // Only the explicit /websearch command now. The toolbar toggle and the
    // keyword sniffer (shouldAutoUseWebSearch) both fired invisibly -- the
    // resulting record was appended with hidden: true -- so the feature looked
    // dead while quietly scraping DuckDuckGo on the user's behalf.
    const shouldUseWebSearch = isWebSearchCommand;
    const webContext = shouldUseWebSearch
      ? await fetchWebSearchContextForConversation({
          appendExecutionRecord,
          ...promptInput,
          setStatus,
        })
      : { contextText: "", query: "", status: null };
    const mcpContext = isMCPCommand
      ? await fetchMCPContextForConversation(settings, {
          mcpBridgeToken,
          setStatus,
        })
      : { contextText: "", status: null };
    if (isMCPCommand) {
      if (!mcpContext.contextText) {
        throw new Error(
          mcpContext.status || text.errors.mcpUnavailable,
        );
      }
      setStatus(
        mcpContext.status ||
          "MCP tool schema loaded. Waiting for the web model to request tools.",
      );
    }
    if (mcpBridgeToken && mcpContext.contextText) {
      activeMCPBridgeTokensRef.current.add(mcpBridgeToken);
    }
    const latestMCPContext = formatLatestMCPExecutionContext(
      executionRecordsRef.current,
    );
    const combinedMCPContext = [latestMCPContext, mcpContext.contextText]
      .filter(Boolean)
      .join("\n\n");
    const prompt = buildWorkspacePrompt({
      ...promptInput,
      includeFullText: isPDFCommand,
      mcpContext: combinedMCPContext,
      webContext: webContext.contextText,
    });
    await deliverPrompt(
      prompt,
      [webContext.status, mcpContext.status].filter(Boolean).join(" ") || null,
      {
        ...buildCommandReplyRecordOptions(resolved.skill, service.label, text),
        sourcePrompt: prompt,
        turnID,
        userPrompt,
      },
      imageAttachment ? [imageAttachment] : [],
    );
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isComposing =
      "isComposing" in event.nativeEvent && event.nativeEvent.isComposing;

    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void runAction(sendPrompt);
      return;
    }

    if (event.key === "Enter" && showSlashMenu && slashSuggestions[0]) {
      event.preventDefault();
      chooseSkill(slashSuggestions[0]);
      return;
    }

    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !isComposing
    ) {
      event.preventDefault();
      void runAction(sendPrompt);
    }
  };

  const selectTurnVersion = (turnID: string, index: number) => {
    setTurnVersionSelections((current) => ({
      ...current,
      [turnID]: index,
    }));
  };

  const beginEditingTurn = (turn: WebAITranscriptTurn, prompt: string) => {
    setEditingTurnID(turn.id);
    setEditingPrompt(prompt);
    setStatus(text.status.editPrompt);
    setIsError(false);
  };

  const submitEditedTurn = async (turn: WebAITranscriptTurn) => {
    const prompt = editingPrompt.trim();
    if (!prompt) {
      throw new Error(text.errors.editedPromptEmpty);
    }
    await sendPrompt(prompt, turn.id);
  };

  const renderTranscriptTurn = (turn: WebAITranscriptTurn) => {
    const activeIndex = turn.records.findIndex((record) => record.id === activeRecordID);
    const selectedIndex =
      turnVersionSelections[turn.id] ??
      (activeIndex >= 0 ? activeIndex : turn.records.length - 1);
    const versionIndex = clampVersionIndex(selectedIndex, turn.records.length);
    const record = turn.records[versionIndex] || turn.records[turn.records.length - 1];
    const displayPrompt = formatRecordSourceForChat(record);
    const isActive = activeRecordID === record.id;
    const isEditing = editingTurnID === turn.id;
    const hasVersions = turn.records.length > 1;

    return (
      <section
        data-record-id={record.id}
        key={turn.id}
        style={{
          ...styles.chatTurn,
          outline: isActive ? `1px solid ${theme.badgeBorder}` : "none",
        }}
      >
        {displayPrompt && (
          <div style={{ ...styles.messageRow, ...styles.userMessageRow }}>
            <article
              style={{
                ...styles.userBubble,
                background: theme.userMessageBackground,
                borderColor: theme.userMessageBorder,
              }}
            >
              <div style={styles.messageHeader}>
                <span style={{ ...styles.messageAuthor, color: theme.text }}>
                  {text.labels.user}
                </span>
                <span style={{ ...styles.messageTimestamp, color: theme.mutedText }}>
                  {formatRecordTimestamp(record.createdAt)}
                </span>
              </div>
              <div style={{ ...styles.userMessageBody, color: theme.text }}>
                {isEditing ? (
                  <textarea
                    onChange={(event) => setEditingPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                        event.preventDefault();
                        void runAction(() => submitEditedTurn(turn));
                      }
                    }}
                    style={{
                      ...styles.userEditInput,
                      background: theme.surfaceBackground,
                      borderColor: theme.buttonBorder,
                      color: theme.text,
                    }}
                    value={editingPrompt}
                  />
                ) : (
                  renderMarkdownContent(displayPrompt, theme)
                )}
              </div>
              <div style={styles.recordActions}>
                {isEditing ? (
                  <>
                    <button
                      style={{
                        ...styles.inlineActionButton,
                        borderColor: theme.buttonBorder,
                        color: theme.buttonText,
                      }}
                      onClick={() => void runAction(() => submitEditedTurn(turn))}
                      type="button"
                    >
                      {text.buttons.save}
                    </button>
                    <button
                      style={{
                        ...styles.inlineActionButton,
                        borderColor: theme.buttonBorder,
                        color: theme.buttonText,
                      }}
                      onClick={() => {
                        setEditingTurnID(null);
                        setEditingPrompt("");
                      }}
                      type="button"
                    >
                      {text.buttons.cancel}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      style={{
                        ...styles.inlineActionButton,
                        borderColor: theme.buttonBorder,
                        color: theme.buttonText,
                      }}
                      onClick={() => {
                        copyTextToClipboard(displayPrompt);
                        setStatus(text.status.copiedUserPrompt);
                        setIsError(false);
                      }}
                      type="button"
                    >
                      {text.buttons.copy}
                    </button>
                    <button
                      style={{
                        ...styles.inlineActionButton,
                        borderColor: theme.buttonBorder,
                        color: theme.buttonText,
                      }}
                      onClick={() => void runAction(() => regenerateRecord(record))}
                      type="button"
                    >
                      {text.buttons.regenerate}
                    </button>
                    <button
                      style={{
                        ...styles.inlineActionButton,
                        borderColor: theme.buttonBorder,
                        color: theme.buttonText,
                      }}
                      onClick={() => beginEditingTurn(turn, displayPrompt)}
                      type="button"
                    >
                      {text.buttons.edit}
                    </button>
                  </>
                )}
              </div>
            </article>
          </div>
        )}

        <div style={{ ...styles.messageRow, ...styles.assistantMessageRow }}>
          <article
            style={{
              ...styles.assistantBubble,
              ...(record.kind === "assistant" ? {} : styles.toolBubble),
              background: getRecordBubbleBackground(record.kind, theme),
              borderColor:
                record.status === "error"
                  ? theme.errorText
                  : getRecordBubbleBorder(record.kind, theme),
            }}
          >
            <div style={styles.messageHeader}>
              <span style={styles.assistantTitleLine}>
                <span
                  style={{
                    ...styles.executionKind,
                    background: getRecordBadgeBackground(record.kind, theme),
                    borderColor: getRecordBadgeBorder(record.kind, theme),
                    color:
                      record.status === "error"
                        ? theme.errorText
                        : getRecordBadgeText(record.kind, theme),
                  }}
                >
                  {getRecordKindLabel(record.kind)}
                </span>
                <span
                  style={{
                    ...styles.executionItemTitle,
                    color: theme.text,
                  }}
                >
                  {record.title}
                </span>
              </span>
              {!displayPrompt && (
                <span style={{ ...styles.messageTimestamp, color: theme.mutedText }}>
                  {formatRecordTimestamp(record.createdAt)}
                </span>
              )}
            </div>
            {record.subtitle && (
              <div
                style={{
                  ...styles.executionItemSubtitle,
                  color: theme.mutedText,
                }}
              >
                {record.subtitle}
              </div>
            )}
            <div style={{ ...styles.executionBody, color: theme.text }}>
              {renderMarkdownContent(record.body, theme)}
            </div>
            {record.thinking && (
              <details
                style={{
                  ...styles.thinkingDetails,
                  background: theme.panelBackground,
                  borderColor: theme.softBorder,
                }}
              >
                <summary
                  style={{
                    ...styles.thinkingSummary,
                    color: theme.mutedText,
                  }}
                >
                  {text.labels.processHidden}
                </summary>
                <pre
                  style={{
                    ...styles.thinkingBody,
                    color: theme.mutedText,
                  }}
                >
                  {record.thinking}
                </pre>
              </details>
            )}
            {record.status === "done" && (
            <div style={styles.recordActions}>
              <button
                style={{
                  ...styles.inlineActionButton,
                  borderColor: theme.buttonBorder,
                  color: theme.buttonText,
                }}
                onClick={() => copyRecord(record)}
                type="button"
              >
                {text.buttons.copy}
              </button>
              <button
                style={{
                  ...styles.inlineActionButton,
                  borderColor: theme.buttonBorder,
                  color: theme.buttonText,
                }}
                onClick={() => void runAction(() => regenerateRecord(record))}
                type="button"
              >
                {text.buttons.regenerate}
              </button>
              <button
                style={{
                  ...styles.inlineActionButton,
                  borderColor: theme.buttonBorder,
                  color: theme.buttonText,
                }}
                onClick={() => void runAction(() => appendRecordToNote(record))}
                type="button"
              >
                {text.buttons.appendNote}
              </button>
            </div>
            )}
            {hasVersions && (
              <div style={styles.versionPager}>
                <button
                  disabled={versionIndex <= 0}
                  style={{
                    ...styles.inlineActionButton,
                    borderColor: theme.buttonBorder,
                    color: versionIndex <= 0 ? theme.mutedText : theme.buttonText,
                    cursor: versionIndex <= 0 ? "not-allowed" : "pointer",
                  }}
                  onClick={() => selectTurnVersion(turn.id, versionIndex - 1)}
                  type="button"
                >
                  {text.buttons.previous}
                </button>
                <span style={{ ...styles.versionLabel, color: theme.mutedText }}>
                  {versionIndex + 1} / {turn.records.length}
                </span>
                <button
                  disabled={versionIndex >= turn.records.length - 1}
                  style={{
                    ...styles.inlineActionButton,
                    borderColor: theme.buttonBorder,
                    color:
                      versionIndex >= turn.records.length - 1
                        ? theme.mutedText
                        : theme.buttonText,
                    cursor:
                      versionIndex >= turn.records.length - 1
                        ? "not-allowed"
                        : "pointer",
                  }}
                  onClick={() => selectTurnVersion(turn.id, versionIndex + 1)}
                  type="button"
                >
                  {text.buttons.next}
                </button>
              </div>
            )}
          </article>
        </div>
      </section>
    );
  };

  return (
    <section
      className={[
        "zotero-webai-workspace",
        `zotero-webai-workspace--${workspaceLayout}`,
        isReaderWorkspace
          ? "zotero-webai-workspace--reader"
          : "zotero-webai-workspace--library",
        panelView === "chat" ? "zotero-webai-workspace--web-hidden" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-layout={workspaceLayout}
      data-location={location}
      style={{
        ...styles.container,
        ...(isCompactLayout ? styles.compactContainer : {}),
        background: theme.background,
        color: theme.text,
      }}
    >
      <div
        className="zotero-webai-web-shell"
        hidden={panelView !== "web"}
        style={{
          ...styles.frameShell,
          // Hidden rather than unmounted: tearing the host down would destroy
          // the <browser> inside it and log the user out of the provider.
          ...(panelView === "web" ? {} : { display: "none" }),
          borderColor: theme.softBorder,
        }}
      >
        {/* Where a browser puts Back and Forward: above the page, at its left
            edge. In the row under the frame they sat among the buttons that
            switch mode and read as one more of those. */}
        <div
          className="zotero-webai-frame-nav"
          style={{
            ...styles.frameNav,
            background: theme.surfaceBackground,
            borderBottomColor: theme.softBorder,
          }}
        >
          <HistoryButton
            direction="back"
            enabled={frameNavigation.canGoBack}
            label={text.buttons.back}
            onClick={() => stepThroughHistory("back")}
            theme={theme}
          />
          <HistoryButton
            direction="forward"
            enabled={frameNavigation.canGoForward}
            label={text.buttons.forward}
            onClick={() => stepThroughHistory("forward")}
            theme={theme}
          />
        </div>
        <div
          className="zotero-webai-web"
          data-collapsed={panelView === "chat" ? "true" : "false"}
          ref={frameHostRef}
          style={{
            ...styles.frameHost,
            background: theme.surfaceBackground,
          }}
        />
      </div>

      {/* The status line used to live in the composer footer, which only exists
          in Conversation mode -- so Capture from the web view reported neither
          success nor failure. It belongs to the whole workspace. */}
      {/* Only when there is something to say. In the web view the page is the
          whole surface; in Conversation the default line is the slash-command
          hint that belongs to the composer. */}
      {!isZAILoginMode && (status || panelView === "chat") && (
        <div
          className="zotero-webai-status"
          role="status"
          style={{
            ...styles.statusBar,
            color: isError ? theme.errorText : theme.mutedText,
          }}
        >
          {status || text.defaultStatus}
        </div>
      )}

      {isZAILoginMode ? (
        <div
          className="zotero-webai-login-bar"
          style={{
            ...styles.loginModeBar,
            background: theme.surfaceBackground,
            borderColor: theme.softBorder,
          }}
        >
          <div style={styles.loginModeText}>
            <span style={{ ...styles.loginModeTitle, color: theme.text }}>
              {text.labels.zaiLoginMode}
            </span>
            <span
              style={{
                ...styles.loginModeHint,
                color: isError ? theme.errorText : theme.mutedText,
              }}
            >
              {status}
            </span>
          </div>
          <div style={styles.frameActions}>
            <button
              style={{
                ...styles.miniButton,
                ...styles.primaryMiniButton,
                background: theme.badgeBackground,
                borderColor: theme.badgeBorder,
                color: theme.badgeText,
              }}
              onClick={openServiceLoginWindow}
              type="button"
            >
              {text.buttons.loginWindow}
            </button>
            <button
              style={{
                ...styles.miniButton,
                background: theme.surfaceBackground,
                borderColor: theme.buttonBorder,
                color: theme.buttonText,
              }}
              onClick={() =>
                void runAction(() =>
                  loadFrameElement(frameRef.current, service.url),
                )
              }
              type="button"
            >
              {text.buttons.reload}
            </button>
            <button
              style={{
                ...styles.miniButton,
                background: theme.surfaceBackground,
                borderColor: theme.buttonBorder,
                color: theme.buttonText,
              }}
              onClick={exitZAILoginMode}
              type="button"
            >
              {text.buttons.chatMode}
            </button>
            <button
              style={{
                ...styles.miniButton,
                background: theme.surfaceBackground,
                borderColor: theme.buttonBorder,
                color: theme.buttonText,
              }}
              onClick={() => openExternalURL(currentFrameURL)}
              type="button"
            >
              {text.buttons.external}
            </button>
          </div>
        </div>
      ) : (
      <div
        className="zotero-webai-toolbar"
        style={{
          ...styles.frameToolbar,
          background: theme.surfaceBackground,
          borderColor: theme.softBorder,
        }}
      >
        <div className="zotero-webai-toolbar-actions" style={styles.frameActions}>
          {/* One surface at a time: pick the page, or the transcript. */}
          <button
            style={{
              ...styles.miniButton,
              background: panelView === "web" && service.id === "google" ? theme.accentBackground : theme.surfaceBackground,
              borderColor: panelView === "web" && service.id === "google" ? theme.accentBorder : theme.buttonBorder,
              color: panelView === "web" && service.id === "google" ? theme.accentText : theme.buttonText,
            }}
            onClick={() => {
              onSelectService(getServiceByID("google"));
              setPanelView("web");
            }}
            type="button"
          >
            {text.buttons.googleSearch}
          </button>
          <button
            style={{
              ...styles.miniButton,
              background: panelView === "web" && service.kind === "chat" ? theme.accentBackground : theme.surfaceBackground,
              borderColor: panelView === "web" && service.kind === "chat" ? theme.accentBorder : theme.buttonBorder,
              color: panelView === "web" && service.kind === "chat" ? theme.accentText : theme.buttonText,
            }}
            onClick={() => {
              onSelectService(lastChatService);
              setPanelView("web");
            }}
            title={lastChatService.label}
            type="button"
          >
            {text.buttons.aiWeb}
          </button>
          <button
            style={{
              ...styles.miniButton,
              background: panelView === "chat" ? theme.accentBackground : theme.surfaceBackground,
              borderColor: panelView === "chat" ? theme.accentBorder : theme.buttonBorder,
              color: panelView === "chat" ? theme.accentText : theme.buttonText,
            }}
            onClick={() => setPanelView("chat")}
            type="button"
          >
            {text.labels.conversation}
          </button>
          <button
            style={{
              ...styles.miniButton,
              background: theme.surfaceBackground,
              borderColor: theme.buttonBorder,
              color: theme.buttonText,
            }}
            onClick={() =>
              void runAction(() =>
                loadFrameElement(frameRef.current, frameHomeURL),
              )
            }
            type="button"
          >
            {text.buttons.reload}
          </button>
          <button
            style={{
              ...styles.miniButton,
              background: theme.surfaceBackground,
              borderColor: theme.buttonBorder,
              color: theme.buttonText,
            }}
            onClick={() => openExternalURL(currentFrameURL)}
            title={currentFrameURL}
            type="button"
          >
            {text.buttons.openExternal}
          </button>
          {panelView === "chat" && (
            <>
              <button
                style={{
                  ...styles.miniButton,
                  background: historyVisible ? theme.accentBackground : theme.surfaceBackground,
                  borderColor: historyVisible ? theme.accentBorder : theme.buttonBorder,
                  color: historyVisible ? theme.accentText : theme.buttonText,
                }}
                onClick={() => setHistoryVisible((visible) => !visible)}
                type="button"
              >
                {text.labels.history}
              </button>
              {executionRecords.length > 0 && (
                <button
                  style={{
                    ...styles.miniButton,
                    background: theme.surfaceBackground,
                    borderColor: theme.buttonBorder,
                    color: theme.buttonText,
                  }}
                  onClick={clearCurrentSession}
                  type="button"
                >
                  {text.buttons.clear}
                </button>
              )}
            </>
          )}
          {service.id === "zai" && panelView === "web" && (
            <>
              <button
                style={{
                  ...styles.miniButton,
                  background: true ? theme.accentBackground : theme.surfaceBackground,
                  borderColor: true ? theme.accentBorder : theme.buttonBorder,
                  color: true ? theme.accentText : theme.buttonText,
                }}
                onClick={openServiceLoginWindow}
                type="button"
              >
                {text.buttons.loginWindow}
              </button>
              <button
                style={{
                  ...styles.miniButton,
                  background: theme.surfaceBackground,
                  borderColor: theme.buttonBorder,
                  color: theme.buttonText,
                }}
                onClick={enterZAILoginMode}
                type="button"
              >
                {text.buttons.loginMode}
              </button>
            </>
          )}
        </div>
      </div>
      )}

      {isLookupService && panelView === "web" && (
        <div
          className="zotero-webai-lookup"
          style={{
            ...styles.lookupBar,
            background: theme.surfaceBackground,
            borderColor: theme.softBorder,
          }}
        >
          <div style={styles.lookupRow}>
            <input
              className="zotero-webai-lookup-input"
              onChange={(event) => setLookupQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  runLookup(lookupQuery);
                }
              }}
              placeholder={text.lookup.placeholder}
              style={{
                ...styles.lookupInput,
                background: theme.inputBackground,
                borderColor: theme.buttonBorder,
                color: theme.text,
              }}
              type="text"
              value={lookupQuery}
            />
            <button
              disabled={!lookupQuery.trim()}
              onClick={() => runLookup(lookupQuery)}
              style={{
                ...styles.miniButton,
                ...styles.primaryMiniButton,
                background: theme.badgeBackground,
                borderColor: theme.badgeBorder,
                color: theme.badgeText,
                opacity: lookupQuery.trim() ? 1 : 0.5,
              }}
              type="button"
            >
              {text.lookup.submit}
            </button>
          </div>
          <span style={{ ...styles.lookupHint, color: theme.mutedText }}>
            {text.lookup.hint}
          </span>
        </div>
      )}

      {!isZAILoginMode && !isLookupService && panelView === "chat" && (
        <div
          className="zotero-webai-chat"
          style={{
            ...styles.executionPanel,
            ...(isReaderWorkspace ? styles.readerExecutionPanel : {}),
            ...(isCompactLayout ? styles.compactExecutionPanel : {}),
            background: theme.surfaceBackground,
            borderColor: theme.softBorder,
          }}
        >
          <div
            className="zotero-webai-chat-header"
            style={{
              ...styles.executionHeader,
              borderColor: theme.softBorder,
            }}
          >
            <span style={{ ...styles.executionTitle, color: theme.text }}>
              {text.labels.conversation}
            </span>
            <div style={styles.executionHeaderActions}>
              <span style={{ ...styles.executionMeta, color: theme.mutedText }}>
                {text.status.turnsSessions(transcriptTurns.length, chatSessions.length)}
              </span>
            </div>
          </div>
          <div className="zotero-webai-results-layout" style={styles.resultsLayout}>
              {historyVisible && (
                <aside
                  className="zotero-webai-history"
                  style={{
                    ...styles.historyPanel,
                    background: theme.panelBackground,
                    borderColor: theme.softBorder,
                  }}
                >
                  <div style={styles.historyHeader}>
                    <span style={{ ...styles.historyTitle, color: theme.text }}>
                      {text.labels.history}
                    </span>
                    <button
                      style={{
                        ...styles.inlineActionButton,
                        borderColor: theme.buttonBorder,
                        color: theme.buttonText,
                      }}
                      onClick={() => setHistoryVisible(false)}
                      type="button"
                    >
                      {text.buttons.hide}
                    </button>
                  </div>
                  <div style={styles.historyList}>
                    {chatSessions.length === 0 && (
                      <div
                        style={{
                          ...styles.historyEmpty,
                          color: theme.mutedText,
                        }}
                      >
                        {text.labels.noSavedSessions}
                      </div>
                    )}
                    {chatSessions.map((session) => {
                      const visibleCount = session.records.filter(
                        (record) => !record.hidden,
                      ).length;
                      return (
                      <button
                        key={`session-${session.id}`}
                        style={{
                          ...styles.historyItem,
                          background:
                            activeSessionID === session.id
                              ? theme.badgeBackground
                              : theme.surfaceBackground,
                          borderColor:
                            activeSessionID === session.id
                              ? theme.badgeBorder
                              : theme.softBorder,
                          color: theme.text,
                        }}
                        onClick={() => openSession(session)}
                        type="button"
                      >
                        <span style={styles.historyItemTitle}>
                          {session.title}
                        </span>
                        <span
                          style={{
                            ...styles.historyItemMeta,
                            color: theme.mutedText,
                          }}
                        >
                          {text.status.turnCount(visibleCount)} - {formatRecordTimestamp(session.updatedAt)}
                        </span>
                      </button>
                      );
                    })}
                  </div>
                </aside>
              )}
              <div
                className="zotero-webai-transcript"
                ref={transcriptRef}
                style={styles.executionList}
              >
                {transcriptTurns.length ? (
                  transcriptTurns.map(renderTranscriptTurn)
                ) : (
                  <div
                    style={{
                      ...styles.emptyConversation,
                      color: theme.mutedText,
                    }}
                  >
                    {text.emptyConversation}
                  </div>
                )}
              </div>
          </div>
        </div>
      )}

      {!isZAILoginMode && !isLookupService && panelView === "chat" && (
        <div
          className="zotero-webai-composer"
          style={{
            ...styles.composerPanel,
            ...(isCompactLayout ? styles.compactComposerPanel : {}),
            background: theme.surfaceBackground,
            borderColor: theme.softBorder,
          }}
        >
        {showSlashMenu && (
          <div
            className="zotero-webai-slash-menu"
            style={{
              ...styles.slashMenu,
              background: theme.surfaceBackground,
              borderColor: theme.softBorder,
            }}
          >
            {slashSuggestions.map((skill) => (
              <button
                key={skill.id}
                style={{
                  ...styles.skillOption,
                  color: theme.text,
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseSkill(skill)}
                type="button"
              >
                <span style={styles.skillOptionText}>
                  <span style={styles.skillOptionTitle}>{skill.label}</span>
                  {skill.description && (
                    <span
                      style={{
                        ...styles.skillOptionDescription,
                        color: theme.mutedText,
                      }}
                    >
                      {skill.description}
                    </span>
                  )}
                </span>
                <span style={{ ...styles.skillOptionCommand, color: theme.mutedText }}>
                  /{skill.slashCommand}
                </span>
              </button>
            ))}
          </div>
        )}

        {selectedSkill && (
          <button
            style={{
              ...styles.selectedSkill,
              background: theme.badgeBackground,
              borderColor: theme.badgeBorder,
              color: theme.badgeText,
            }}
            onClick={() => setSelectedSkillID(null)}
            title={text.status.clearSelectedCommandTitle}
            type="button"
          >
            /{selectedSkill.slashCommand} {selectedSkill.label}
          </button>
        )}

        <textarea
          className="zotero-webai-composer-input"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={
            COMPOSER_IMAGE_INPUT_ENABLED
              ? (event) => void runAction(() => handleComposerPaste(event))
              : undefined
          }
          placeholder={text.composerPlaceholder}
          style={{
            ...styles.composerInput,
            background: "transparent",
            color: theme.text,
          }}
          value={message}
        />

        {COMPOSER_IMAGE_INPUT_ENABLED && (
          <input
            accept="image/*"
            onChange={(event) => void runAction(() => handleComposerImageChange(event))}
            ref={composerImageInputRef}
            style={styles.hiddenFileInput}
            type="file"
          />
        )}

        {COMPOSER_IMAGE_INPUT_ENABLED && composerImage && (
          <div
            style={{
              ...styles.composerImagePreview,
              background: theme.inputBackground,
              borderColor: theme.softBorder,
            }}
          >
            <img
              alt={composerImage.name}
              src={composerImage.dataURL}
              style={styles.composerImageThumb}
            />
            <span
              style={{
                ...styles.composerImageName,
                color: theme.text,
              }}
            >
              {composerImage.name}
            </span>
            <button
              style={{
                ...styles.inlineActionButton,
                borderColor: theme.buttonBorder,
                color: theme.buttonText,
              }}
              onClick={removeComposerImage}
              type="button"
            >
              {text.buttons.clear}
            </button>
          </div>
        )}

        <div className="zotero-webai-composer-footer" style={styles.composerFooter}>
          {COMPOSER_IMAGE_INPUT_ENABLED && (
            <button
              style={{
                ...styles.inlineActionButton,
                borderColor: composerImage ? theme.badgeBorder : theme.buttonBorder,
                color: composerImage ? theme.badgeText : theme.buttonText,
              }}
              onClick={selectComposerImage}
              type="button"
            >
              {text.buttons.image}
            </button>
          )}
          <button
            style={{
              ...styles.sendButton,
              background: theme.badgeBackground,
              borderColor: theme.badgeBorder,
              color: theme.badgeText,
            }}
            onClick={() => void runAction(sendPrompt)}
            title={text.status.sendTitle}
            type="button"
          >
            {text.buttons.send}
          </button>
        </div>
        </div>
      )}
    </section>
  );
};

function buildCustomSkills(customPresetsValue: string): WebAISkill[] {
  return parseCustomPresets(customPresetsValue).presets
    .filter((preset) => preset.label?.trim() && preset.promptPrefix?.trim())
    .map((preset) => {
      const label = String(preset.label || preset.id).trim();
      return {
        description: String(preset.description || "").trim(),
        id: preset.id,
        kind: "skill",
        label,
        promptPrefix: String(preset.promptPrefix || "").trim(),
        slashCommand: normalizeSlashCommand(
          preset.slashCommand || preset.label || preset.id,
        ),
      };
    });
}

function formatSlashCommandStatus(skill: WebAISkill, text: WebAIStrings): string {
  if (skill.kind === "new") {
    return text.status.slashNew;
  }
  if (skill.kind === "clear") {
    return getSessionSlashCommand(skill)?.scope === "all"
      ? text.status.slashClearAll
      : text.status.slashClear;
  }
  if (skill.kind === "export") {
    return getSessionSlashCommand(skill)?.scope === "all"
      ? text.status.slashExportAll
      : text.status.slashExport;
  }
  if (skill.kind === "pdf") {
    return text.status.slashPDF;
  }
  if (skill.kind === "web") {
    return text.status.slashWeb;
  }
  if (skill.kind === "mcp") {
    return text.status.slashMCP;
  }
  return text.status.slashSkill(skill.slashCommand);
}

function getSessionSlashCommand(
  skill: WebAISkill | null,
): SessionSlashCommand | null {
  if (!skill || (skill.kind !== "clear" && skill.kind !== "export")) {
    return null;
  }
  return {
    action: skill.kind,
    scope:
      skill.id.endsWith("-all") ||
      normalizeSlashCommand(skill.slashCommand).toLowerCase().endsWith("all")
        ? "all"
        : "current",
  };
}

function appendComposerImageToMessage(
  value: string,
  image: ComposerImageAttachment | null,
): string {
  if (!image) {
    return value;
  }
  const imageMarkdown = `![${escapeMarkdownImageText(image.name)}](${escapeMarkdownImageURL(image.dataURL)})`;
  return [value.trim(), imageMarkdown].filter(Boolean).join("\n\n");
}

function getMessageForPrompt(
  value: string,
  image: ComposerImageAttachment | null,
  text: WebAIStrings,
): string {
  if (value.trim() || !image) {
    return value;
  }
  return text === ZH_STRINGS ? "请分析这张图片。" : "Please analyze this image.";
}

function buildRecordUserPrompt(
  rawMessage: string,
  resolvedMessage: string,
  skill: WebAISkill | null,
): string {
  const raw = normalizeCapturedText(rawMessage);
  if (raw.startsWith("/")) {
    return raw;
  }
  const message = normalizeCapturedText(resolvedMessage);
  if (skill && skill.kind !== "new") {
    return message ? `/${skill.slashCommand} ${message}` : `/${skill.slashCommand}`;
  }
  return message || raw;
}

function filterSlashSkills(skills: WebAISkill[], query: string): WebAISkill[] {
  const normalized = normalizeSlashCommand(query).toLowerCase();
  if (!normalized) {
    return skills.slice(0, 1000);
  }

  return skills
    .filter((skill) => {
      const tokens = buildSlashSearchTokens(skill);
      return tokens.some((token) => token.includes(normalized));
    })
    .slice(0, 1000);
}

function getSlashQuery(value: string): { query: string } | null {
  const match = value.match(/^\s*\/([^\r\n]*)$/);
  return match ? { query: match[1] || "" } : null;
}

function isNewConversationCommand(value: string): boolean {
  const normalized = normalizeSlashCommand(value).toLowerCase();
  return ["new", "newconversation", "newchat"].includes(normalized);
}

function removeSlashToken(value: string, skills: WebAISkill[]): string {
  const matchedSkill = matchLeadingSlashSkill(value, skills);
  if (matchedSkill) {
    return value.slice(matchedSkill.consumed).replace(/^\s+/, "");
  }
  return value.replace(/^\s*\/[^\s]*(?:\s+)?/, "");
}

function resolveSkillFromMessage(
  value: string,
  skills: WebAISkill[],
  selectedSkill: WebAISkill | null,
): { message: string; skill: WebAISkill | null } {
  const matched = matchLeadingSlashSkill(value, skills);
  if (!matched) {
    return { message: value, skill: selectedSkill };
  }
  return {
    message: value.slice(matched.consumed).replace(/^\s+/, ""),
    skill: matched.skill || selectedSkill,
  };
}

function buildSlashSearchTokens(skill: WebAISkill): string[] {
  const rawTokens = [
    skill.label,
    skill.slashCommand,
    skill.id,
    skill.description || "",
    ...(skill.aliases || []),
  ];
  return rawTokens.flatMap((token) => {
    const lower = String(token || "").toLowerCase();
    const normalized = normalizeSlashCommand(lower).toLowerCase();
    return normalized && normalized !== lower ? [lower, normalized] : [lower];
  });
}

function matchesSlashSkill(skill: WebAISkill, command: string): boolean {
  const normalizedCommand = normalizeSlashCommand(command).toLowerCase();
  return buildSlashSearchTokens(skill).some(
    (token) => normalizeSlashCommand(token).toLowerCase() === normalizedCommand,
  );
}

function matchLeadingSlashSkill(
  value: string,
  skills: WebAISkill[],
): { consumed: number; skill: WebAISkill } | null {
  const match = value.match(/^\s*\/([\s\S]*)$/);
  if (!match || match.index !== 0) {
    return null;
  }
  const leadingLength = value.match(/^\s*\//)?.[0]?.length || 0;
  const tail = match[1] || "";
  const candidates = skills
    .flatMap((skill) =>
      buildSlashSearchTokens(skill).map((token) => ({
        normalized: normalizeSlashCommand(token).toLowerCase(),
        skill,
      })),
    )
    .filter((candidate) => candidate.normalized)
    .sort((left, right) => right.normalized.length - left.normalized.length);

  const normalizedTail = normalizeSlashCommand(tail).toLowerCase();
  for (const candidate of candidates) {
    if (!normalizedTail.startsWith(candidate.normalized)) {
      continue;
    }
    const consumedTail = consumeSlashCommandCharacters(tail, candidate.normalized);
    if (consumedTail > 0) {
      return {
        consumed: leadingLength + consumedTail,
        skill: candidate.skill,
      };
    }
  }
  return null;
}

function consumeSlashCommandCharacters(value: string, normalizedCommand: string): number {
  let normalized = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (/\s/.test(character)) {
      if (normalized.length >= normalizedCommand.length) {
        return index;
      }
      continue;
    }
    normalized += character.toLowerCase();
    if (normalized === normalizedCommand) {
      return index + 1;
    }
    if (!normalizedCommand.startsWith(normalized)) {
      return 0;
    }
  }
  return normalized === normalizedCommand ? value.length : 0;
}

function normalizeSlashCommand(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\s+/g, "");
}

/**
 * One direction of the frame's session history.
 *
 * An icon rather than a word: it sits among text buttons that switch mode
 * ("Google Search", "AI Web", "Conversation"), and a labelled "Back" among
 * them reads as one more mode. A chevron pair reads as navigation at a glance,
 * which is the whole point of the control.
 */
const HistoryButton: React.FC<{
  direction: "back" | "forward";
  enabled: boolean;
  label: string;
  onClick: () => void;
  theme: SidebarTheme;
}> = ({ direction, enabled, label, onClick, theme }) => (
  <button
    aria-label={label}
    disabled={!enabled}
    onClick={onClick}
    style={{
      ...styles.miniButton,
      alignItems: "center",
      background: theme.surfaceBackground,
      borderColor: theme.buttonBorder,
      color: theme.buttonText,
      cursor: enabled ? "pointer" : "default",
      display: "inline-flex",
      justifyContent: "center",
      // Dimmed rather than hidden: the pair keeps its place in the row, so
      // nothing shifts under the pointer when a page becomes reachable.
      opacity: enabled ? 1 : 0.35,
      padding: "4px 7px",
    }}
    title={label}
    type="button"
  >
    <svg
      aria-hidden="true"
      fill="none"
      height="12"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 12 12"
      width="12"
    >
      <path d={direction === "back" ? "M7.5 2L3.5 6l4 4" : "M4.5 2l4 4-4 4"} />
    </svg>
  </button>
);

interface FrameNavigation {
  canGoBack: boolean;
  canGoForward: boolean;
  url: string;
}

/** One live `<browser>`, kept for as long as the workspace is mounted. */
interface FrameEntry {
  frame: Element;
  /** Whether the first load has actually started. A frame created while the
   *  column was too narrow is still waiting on the size gate, and switching
   *  away disconnects the observer -- so the gate has to be re-armed on the
   *  way back rather than assumed to have run. */
  loaded: boolean;
  /** The look-up query this frame was last loaded with, so a repeat request
   *  for the same text does not navigate it a second time. Per frame, because
   *  each look-up provider is on its own page. */
  loadedLookup: string;
  stopWatching: (() => void) | null;
}

// nsIWebProgress.NOTIFY_LOCATION. Read from the interface when it is reachable
// so a Gecko renumbering cannot silently turn the listener into a no-op.
function locationChangeMask(): number {
  try {
    return (
      Components.interfaces.nsIWebProgress as unknown as {
        NOTIFY_LOCATION: number;
      }
    ).NOTIFY_LOCATION;
  } catch {
    return 0x80;
  }
}

/**
 * Reports where the frame is and whether it can go back.
 *
 * The frame moves without React ever hearing about it -- the user clicks a
 * link in the page. For a remote browser nsIWebProgress is the parent
 * process's only notification, and `BrowsingContext.webProgress` survives the
 * process switch a cross-origin navigation triggers, which a listener on the
 * frame loader would not.
 */
/**
 * Where the frame is and where it can go, read on demand.
 *
 * Also used when switching back to a frame that was only hidden: it has not
 * navigated, so no listener fires, but the toolbar still has to catch up with
 * wherever that page was left.
 */
function readFrameNavigation(frame: Element): FrameNavigation {
  const browser = frame as Element & {
    canGoBack?: boolean;
    canGoBackIgnoringUserInteraction?: boolean;
    canGoForward?: boolean;
    currentURI?: nsIURI;
  };
  let canGoBack = false;
  let canGoForward = false;
  let url = "";
  try {
    // sessionHistory.index > 0, which is what goBack(false) acts on.
    // `canGoBack` is stricter -- it also demands user interaction on the entry
    // -- and would disable the button on pages it can in fact leave.
    canGoBack = Boolean(
      browser.canGoBackIgnoringUserInteraction ?? browser.canGoBack,
    );
    // index < count - 1, which is exactly what goForward() gates on, so no
    // equivalent correction is needed here.
    canGoForward = Boolean(browser.canGoForward);
    url = browser.currentURI?.spec || "";
  } catch {
    // A frame that has not been primed yet has no navigation to report.
  }
  return { canGoBack, canGoForward, url: url === "about:blank" ? "" : url };
}

function watchFrameNavigation(
  frame: Element,
  onChange: (next: FrameNavigation) => void,
): (() => void) | null {
  const browser = frame as Element & {
    webProgress?: {
      addProgressListener?: (listener: unknown, mask: number) => void;
      removeProgressListener?: (listener: unknown) => void;
    };
  };
  const webProgress = browser.webProgress;
  if (typeof webProgress?.addProgressListener !== "function") {
    return null;
  }

  const listener = {
    QueryInterface: ChromeUtils.generateQI([
      "nsIWebProgressListener",
      "nsISupportsWeakReference",
    ]),
    onLocationChange() {
      onChange(readFrameNavigation(frame));
    },
  };

  try {
    webProgress.addProgressListener(listener, locationChangeMask());
  } catch (error) {
    ztoolkit.log("Could not watch Web AI frame navigation:", String(error));
    return null;
  }

  return () => {
    try {
      webProgress.removeProgressListener?.(listener);
    } catch {
      // Teardown races the frame's own removal.
    }
  };
}

/**
 * Turns a `target="_blank"` click into an ordinary navigation of this frame.
 *
 * Zotero answers a new-window request with a hidden browser it never loads
 * (see modules/webAINewWindow.ts), and which of Gecko's four
 * nsIBrowserDOMWindow entry points a given click reaches depends on process
 * routing that is not visible from the parent. Catching the click in the page
 * removes the guesswork: Gecko is never asked for a new window at all.
 *
 * `allowDelayedLoad` is true because the script has to come back after every
 * navigation and after the process switch a cross-origin load triggers.
 */
function interceptFrameLinks(frame: Element): void {
  const messageManager = getFrameMessageManager(frame);
  if (typeof messageManager?.loadFrameScript !== "function") {
    return;
  }

  const source = `
    (function () {
      if (this.__zoteroWebAILinksHooked) {
        return;
      }
      this.__zoteroWebAILinksHooked = true;
      addEventListener(
        "click",
        function (event) {
          try {
            if (event.defaultPrevented || event.button !== 0) {
              return;
            }
            // Let the platform shortcuts through untouched.
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
              return;
            }
            // composedPath crosses shadow roots, which provider UIs use.
            var path =
              typeof event.composedPath === "function" ? event.composedPath() : [];
            var anchor = null;
            for (var i = 0; i < path.length; i++) {
              if (path[i] && path[i].localName === "a" && path[i].href) {
                anchor = path[i];
                break;
              }
            }
            if (!anchor) {
              return;
            }
            var target = String(anchor.getAttribute("target") || "").toLowerCase();
            if (
              !target ||
              target === "_self" ||
              target === "_top" ||
              target === "_parent"
            ) {
              return;
            }
            var href = String(anchor.href || "");
            if (!/^https?:\/\//i.test(href)) {
              return;
            }
            event.preventDefault();
            var view = anchor.ownerDocument && anchor.ownerDocument.defaultView;
            var top = view && view.top ? view.top : content;
            top.location.href = href;
          } catch (error) {
            // Never break a page over one link.
          }
        },
        true,
      );
    }).call(this);
  `;

  try {
    messageManager.loadFrameScript(
      `data:application/javascript;charset=utf-8,${encodeURIComponent(source)}`,
      true,
    );
  } catch (error) {
    ztoolkit.log("Could not install the Web AI link interceptor:", String(error));
  }
}

// Creates the frame only; the caller appends it and then loads it on a later
// tick. See the mount effect for why the load cannot happen synchronously.
function createWebFrame(doc: Document): Element {
  const maybeXULDoc = doc as Document & {
    createXULElement?: (tagName: string) => Element;
  };
  const browser = maybeXULDoc.createXULElement?.("browser");
  if (browser) {
    browser.classList.add("ai-assistant-web-browser");
    browser.setAttribute("type", "content");
    // Remoteness is set in primeBrowserRemoteness once the element is in the
    // document and the target URI is known. Note that the custom element reads
    // `hasAttribute("remote")`, not its value, so remote="false" would still mean
    // remote -- only absence of the attribute means non-remote.
    browser.setAttribute("maychangeremoteness", "true");
    browser.setAttribute("disableglobalhistory", "true");
    browser.setAttribute("allowfullscreen", "true");
    browser.setAttribute("flex", "1");
    return browser;
  }

  const iframe = doc.createElement("iframe");
  iframe.className = "ai-assistant-web-browser";
  iframe.setAttribute(
    "sandbox",
    [
      "allow-downloads",
      "allow-forms",
      "allow-modals",
      "allow-pointer-lock",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-same-origin",
      "allow-scripts",
      "allow-storage-access-by-user-activation",
      "allow-top-navigation-by-user-activation",
    ].join(" "),
  );
  iframe.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen");
  iframe.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
  return iframe;
}

/**
 * Makes the embedded page follow the panel's theme.
 *
 * A third-party page picks its own colours from `prefers-color-scheme`, which
 * normally comes from the OS -- so the panel could be dark while the page
 * inside it stayed white. Gecko lets a single browsing context override that
 * query; it is the same switch DevTools' colour-scheme simulation uses. The
 * <iframe> fallback has no browsing context to override and is left alone.
 */
function applyFrameColorScheme(frame: Element | null, dark: boolean): void {
  const context = (
    frame as (Element & {
      browsingContext?: { prefersColorSchemeOverride?: string };
    }) | null
  )?.browsingContext;
  if (!context) {
    return;
  }
  try {
    context.prefersColorSchemeOverride = dark ? "dark" : "light";
  } catch (error) {
    // Not fatal: the page keeps whatever the system told it.
    ztoolkit.log("Could not set the Web AI frame colour scheme:", String(error));
  }
}

// A freshly created XUL <browser> is not actually ready to load remote content
// just because remote="true" is set as an attribute -- every real example of
// Zotero itself loading a third-party site into a dynamically created browser
// (import/mendeley/authViewer.js, HiddenBrowser.mjs) explicitly calls
// changeRemoteness() then construct() first. Skipping that step is what made
// Zotero 11's content process die with a channel error and segfault the parent
// the moment this browser tried to load http(s) content -- see
// docs/PAPERLY-FORK.md for the failed attempts that preceded this fix.
function primeBrowserRemoteness(frame: Element, uri: nsIURI): void {
  const maybeBrowser = frame as Element & {
    changeRemoteness?: (options: { remoteType: string | null }) => void;
    construct?: () => void;
    _zoteroWebAIPrimed?: boolean;
  };
  // Once only. changeRemoteness() tears the frameLoader down and construct()
  // builds a new one, so re-priming an already-loaded browser drops the
  // loadURI() that follows on the floor -- silently, because nothing throws.
  // Every navigation after the first (Reload, Look up) went nowhere because of
  // it. A fresh frame is created whenever the provider changes, so this flag
  // never needs clearing.
  if (maybeBrowser._zoteroWebAIPrimed) {
    return;
  }
  if (
    typeof maybeBrowser.changeRemoteness !== "function" ||
    typeof maybeBrowser.construct !== "function"
  ) {
    return;
  }
  maybeBrowser._zoteroWebAIPrimed = true;

  // Out-of-process. In-process content shares the Zotero UI thread, so a
  // provider's own analytics bundles hit the slow-script timeout ("Script
  // terminated by timeout") and the page never finishes initializing. It is also
  // how Zotero loads third-party sites itself (HiddenBrowser.mjs, authViewer.js).
  const { E10SUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/E10SUtils.sys.mjs",
  );
  // Not in zotero-types' generated Gecko defs; this is HiddenBrowser.mjs's own
  // runtime call (chrome/content/zotero/HiddenBrowser.mjs in zotero-client).
  const predictRemoteTypeForURI = (
    ChromeUtils as unknown as {
      predictRemoteTypeForURI: (
        target: nsIURI,
        options: {
          preferredRemoteType: string;
          useRemoteTabs: boolean;
          useRemoteSubframes: boolean;
        },
      ) => string;
    }
  ).predictRemoteTypeForURI;
  const remoteType = predictRemoteTypeForURI(uri, {
    preferredRemoteType: E10SUtils.DEFAULT_REMOTE_TYPE,
    useRemoteTabs: true,
    useRemoteSubframes: false,
  });

  frame.setAttribute("remote", "true");
  frame.setAttribute("remoteType", remoteType);
  maybeBrowser.changeRemoteness({ remoteType });
  maybeBrowser.construct();
  applyPlainUserAgent(frame);
}

// Strip "Zotero/[version]" from the User-Agent for the embedded page.
//
// Cloudflare Turnstile is the reason: Zotero's own source says so in
// xpcom/zotero.js -- "Turnstile won't pass with Zotero/ in the UA string, and
// future requests need the same UA as the one that passed Turnstile". That is
// why Claude's login spun forever; claude.ai serves a Turnstile challenge from
// /cdn-cgi/challenge-platform and it never cleared.
//
// Scoped to this browsingContext rather than Zotero.VersionHeader
// .registerPlainUAHost(), which is global and would change the UA of Zotero's
// own requests (translators, sync) to the same host. Zotero's
// http-on-modify-request observer still runs afterwards, but its 'full' branch
// looks for "Zotero/" and finds nothing, so it leaves this UA alone.
//
// Applied to every provider, not just Claude: these are consumer web apps that
// have no reason to be told they are inside Zotero, and a UA that no real
// browser sends is a fingerprint in itself.
function applyPlainUserAgent(frame: Element): void {
  const context = (frame as Element & {
    browsingContext?: { customUserAgent?: string };
  }).browsingContext;
  if (!context) {
    return;
  }
  try {
    const ua = (
      Zotero as unknown as {
        VersionHeader?: { getPlainFirefoxUA?: () => string };
      }
    ).VersionHeader?.getPlainFirefoxUA?.();
    if (ua) {
      context.customUserAgent = ua;
    }
  } catch (error) {
    // A stale browsingContext throws; the page still loads with the default UA.
    ztoolkit.log("plain user agent not applied:", error);
  }
}

// The browser must already be in the document: a detached <browser> has no
// frameLoader, so loadURI() fails silently -- which is exactly how upstream
// avoided ever loading anything on Zotero 11.
// PDF selections carry soft hyphens and hard line breaks from the column
// layout, and none of it belongs in a query string.
function normalizeSelectionForLookup(value: string): string {
  return value
    .replace(/\u00ad/g, "")
    .replace(/-\s*\n\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function loadFrameElement(frame: Element | null, url: string): void {
  if (!frame || !frame.isConnected) {
    return;
  }

  const maybeBrowser = frame as Element & {
    loadURI?: (uri: string | nsIURI, options?: unknown) => void;
  };

  if (typeof maybeBrowser.loadURI === "function") {
    try {
      const uri = Services.io.newURI(url);
      primeBrowserRemoteness(frame, uri);
      // authViewer.js -- Zotero's own precedent for loading a third-party site
      // into a dynamically created browser -- uses the system principal here.
      maybeBrowser.loadURI(uri, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      return;
    } catch (error) {
      ztoolkit.log("Failed to load Web AI browser:", String(error));
    }
  }

  if ("src" in frame) {
    (frame as HTMLIFrameElement).src = url;
  }
}

function focusFrame(frame: Element | null): void {
  try {
    (frame as HTMLElement | null)?.focus?.();
    (frame as HTMLIFrameElement | null)?.contentWindow?.focus?.();
  } catch {
    // Cross-origin focus may fail. Copying the prompt is the key handoff.
  }
}

async function insertPromptIntoWebChat(
  frame: Element | null,
  prompt: string,
  submit = false,
  attachments: ComposerImageAttachment[] = [],
  pasteImageFromNativeClipboard = false,
): Promise<PromptInsertResult> {
  if (!frame) {
    return { ok: false, reason: "web-frame-missing" };
  }

  const directResult = await insertPromptDirectly(
    frame,
    prompt,
    submit,
    attachments,
    pasteImageFromNativeClipboard,
  );
  if (directResult.ok) {
    if (submit && !directResult.submitted) {
      const scriptedResult = await insertPromptWithFrameScript(
        frame,
        prompt,
        submit,
        attachments,
        pasteImageFromNativeClipboard,
      );
      if (scriptedResult.ok && scriptedResult.submitted) {
        return scriptedResult;
      }
      const hostKeyboardResult = await submitFocusedWebChatWithHostKeyboard(
        frame,
        prompt,
      );
      if (hostKeyboardResult.ok) {
        return hostKeyboardResult;
      }
      if (scriptedResult.ok) {
        return scriptedResult;
      }
    }
    return directResult;
  }

  const scriptedResult = await insertPromptWithFrameScript(
    frame,
    prompt,
    submit,
    attachments,
    pasteImageFromNativeClipboard,
  );
  if (submit && (!scriptedResult.ok || !scriptedResult.submitted)) {
    const hostKeyboardResult = await submitFocusedWebChatWithHostKeyboard(
      frame,
      prompt,
    );
    if (hostKeyboardResult.ok) {
      return hostKeyboardResult;
    }
  }
  return scriptedResult;
}

async function removeWebChatComposerImages(frame: Element | null): Promise<void> {
  if (!frame) {
    return;
  }
  try {
    const doc = (frame as HTMLIFrameElement).contentWindow?.document;
    if (doc) {
      removeImagesFromDocument(doc);
    } else {
      await removeImagesWithFrameScript(frame);
    }
  } catch (error) {
    // ignore
  }
}

async function removeImagesWithFrameScript(frame: Element): Promise<void> {
  const messageManager = getFrameMessageManager(frame);
  if (typeof messageManager?.loadFrameScript !== "function") {
    return;
  }

  const source = `
    (function() {
      ${findWebChatComposer.toString()}
      ${removeImagesFromDocument.toString()}
      removeImagesFromDocument(content.document);
    })();
  `;

  try {
    messageManager.loadFrameScript(
      `data:application/javascript;charset=utf-8,${encodeURIComponent(source)}`,
      false,
    );
  } catch (error) {
    // ignore
  }
}

function removeImagesFromDocument(doc: Document): void {
  const composer = findWebChatComposer(doc);
  if (!composer) {
    return;
  }
  const wrapper =
    (composer.closest(
      "form, [class*='composer'], [class*='input'], [class*='chat-input'], [class*='prompt']",
    ) || doc.body || doc.documentElement) as Element;

  const selectors = [
    "button[aria-label*='Remove']",
    "button[aria-label*='Delete']",
    "button[aria-label*='clear']",
    "button[aria-label*='移除']",
    "button[aria-label*='删除']",
    "button[aria-label*='清除']",
    "[data-testid='remove-file']",
    "[class*='close'] button",
    "[class*='Close'] button",
    "button [class*='close']",
    "button [class*='Close']",
    "[class*='remove']",
    "[class*='delete']",
  ];

  for (const selector of selectors) {
    try {
      const buttons = wrapper.querySelectorAll(selector);
      Array.from(buttons).forEach((btn: any) => {
        if (btn instanceof HTMLElement && btn !== composer) {
          btn.click();
        }
      });
    } catch (e) {
      // ignore
    }
  }
}

async function submitFocusedWebChatWithHostKeyboard(
  frame: Element,
  prompt: string,
): Promise<PromptInsertResult> {
  const doc = frame.ownerDocument;
  if (!doc) {
    return { ok: false, reason: "host-document-missing" };
  }
  focusFrame(frame);
  try {
    (frame as HTMLElement).focus?.();
  } catch {
    // Browser wrappers can reject focus while remoteness changes.
  }
  await sleepWithHostTimer(120);
  const enterSent = sendNativeEnter(doc);
  if (!enterSent) {
    return {
      ok: false,
      method: "host-keyboard",
      reason: "host-enter-unavailable",
      submitAttempted: true,
    };
  }
  await sleepWithHostTimer(700);
  return {
    ok: true,
    method: "host-keyboard-enter",
    reason: "host-enter-dispatched",
    submitAttempted: true,
    submitted: true,
  };
}

function insertPromptDirectly(
  frame: Element,
  prompt: string,
  submit: boolean,
  attachments: ComposerImageAttachment[],
  pasteImageFromNativeClipboard: boolean,
): Promise<PromptInsertResult> {
  try {
    const doc = (frame as HTMLIFrameElement).contentWindow?.document;
    if (!doc) {
      return Promise.resolve({ ok: false, reason: "content-document-missing" });
    }
    return insertPromptIntoDocument(
      doc,
      prompt,
      "direct-dom",
      submit,
      attachments,
      pasteImageFromNativeClipboard,
    );
  } catch (error) {
    return Promise.resolve({
      ok: false,
      reason:
        error instanceof Error && error.message
          ? error.message
          : "direct-dom-unavailable",
    });
  }
}

function insertPromptWithFrameScript(
  frame: Element,
  prompt: string,
  submit: boolean,
  attachments: ComposerImageAttachment[],
  pasteImageFromNativeClipboard: boolean,
): Promise<PromptInsertResult> {
  const messageManager = getFrameMessageManager(frame);
  const addMessageListener = messageManager?.addMessageListener;
  const loadFrameScript = messageManager?.loadFrameScript;
  const removeMessageListener = messageManager?.removeMessageListener;
  if (
    typeof addMessageListener !== "function" ||
    typeof loadFrameScript !== "function"
  ) {
    return Promise.resolve({ ok: false, reason: "frame-script-unavailable" });
  }

  const messageName = `ZoteroWebAI:PromptInsert:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  const source = buildPromptInsertFrameScript(
    messageName,
    prompt,
    submit,
    attachments,
    pasteImageFromNativeClipboard,
  );

  return new Promise((resolve) => {
    const timerHost = resolveTimerHost();
    let settled = false;
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        removeMessageListener?.call(messageManager, messageName, listener);
      } catch {
        // The frame may have navigated while the script was running.
      }
    };
    const listener = (message: { data?: PromptInsertResult | WebChatTextResult }) => {
      const data = (message.data || {
        ok: false,
        reason: "empty-frame-result",
      }) as PromptInsertResult;
      cleanup();
      resolve(data);
    };
    const timeoutId = timerHost.setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "frame-script-timeout" });
    }, submit ? 45000 : 1800);

    const finish = (result: PromptInsertResult) => {
      timerHost.clearTimeout(timeoutId);
      cleanup();
      resolve(result);
    };

    try {
      addMessageListener.call(messageManager, messageName, listener);
      loadFrameScript.call(
        messageManager,
        `data:application/javascript;charset=utf-8,${encodeURIComponent(source)}`,
        false,
      );
    } catch (error) {
      finish({
        ok: false,
        reason:
          error instanceof Error && error.message
            ? error.message
            : "frame-script-error",
      });
    }
  });
}

async function readWebChatText(
  frame: Element | null,
): Promise<WebChatTextResult> {
  if (!frame) {
    return { ok: false, reason: "web-frame-missing" };
  }

  const directResult = readWebChatTextDirectly(frame);
  if (directResult.ok) {
    return directResult;
  }

  return readWebChatTextWithFrameScript(frame);
}

async function readLatestAssistantText(
  frame: Element | null,
): Promise<WebChatTextResult> {
  if (!frame) {
    return { ok: false, reason: "web-frame-missing" };
  }

  const directResult = readLatestAssistantTextDirectly(frame);
  if (directResult.ok) {
    return directResult;
  }

  return readLatestAssistantTextWithFrameScript(frame);
}

function readWebChatTextDirectly(frame: Element): WebChatTextResult {
  try {
    const doc = (frame as HTMLIFrameElement).contentWindow?.document;
    if (!doc) {
      return { ok: false, reason: "content-document-missing" };
    }
    return {
      ok: true,
      text: readWebChatTextFromDocument(doc),
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.message
          ? error.message
          : "direct-dom-unavailable",
    };
  }
}

function readLatestAssistantTextDirectly(frame: Element): WebChatTextResult {
  try {
    const doc = (frame as HTMLIFrameElement).contentWindow?.document;
    if (!doc) {
      return { ok: false, reason: "content-document-missing" };
    }
    return {
      ok: true,
      text: readLatestAssistantTextFromDocument(doc),
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.message
          ? error.message
          : "direct-dom-unavailable",
    };
  }
}

function readWebChatTextWithFrameScript(
  frame: Element,
): Promise<WebChatTextResult> {
  const messageManager = getFrameMessageManager(frame);
  const addMessageListener = messageManager?.addMessageListener;
  const loadFrameScript = messageManager?.loadFrameScript;
  const removeMessageListener = messageManager?.removeMessageListener;
  if (
    typeof addMessageListener !== "function" ||
    typeof loadFrameScript !== "function"
  ) {
    return Promise.resolve({ ok: false, reason: "frame-script-unavailable" });
  }

  const messageName = `ZoteroWebAI:ChatText:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  const source = buildWebChatTextFrameScript(messageName);

  return new Promise((resolve) => {
    const timerHost = resolveTimerHost();
    let settled = false;
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        removeMessageListener?.call(messageManager, messageName, listener);
      } catch {
        // The frame may have navigated while the script was running.
      }
    };
    const listener = (message: { data?: PromptInsertResult | WebChatTextResult }) => {
      const data = (message.data || {
        ok: false,
        reason: "empty-frame-result",
      }) as WebChatTextResult;
      cleanup();
      resolve(data);
    };
    const timeoutId = timerHost.setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "frame-script-timeout" });
    }, 1500);

    const finish = (result: WebChatTextResult) => {
      timerHost.clearTimeout(timeoutId);
      cleanup();
      resolve(result);
    };

    try {
      addMessageListener.call(messageManager, messageName, listener);
      loadFrameScript.call(
        messageManager,
        `data:application/javascript;charset=utf-8,${encodeURIComponent(source)}`,
        false,
      );
    } catch (error) {
      finish({
        ok: false,
        reason:
          error instanceof Error && error.message
            ? error.message
            : "frame-script-error",
      });
    }
  });
}

function readLatestAssistantTextWithFrameScript(
  frame: Element,
): Promise<WebChatTextResult> {
  const messageManager = getFrameMessageManager(frame);
  const addMessageListener = messageManager?.addMessageListener;
  const loadFrameScript = messageManager?.loadFrameScript;
  const removeMessageListener = messageManager?.removeMessageListener;
  if (
    typeof addMessageListener !== "function" ||
    typeof loadFrameScript !== "function"
  ) {
    return Promise.resolve({ ok: false, reason: "frame-script-unavailable" });
  }

  const messageName = `ZoteroWebAI:LatestAssistant:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  const source = buildLatestAssistantTextFrameScript(messageName);

  return new Promise((resolve) => {
    const timerHost = resolveTimerHost();
    let settled = false;
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        removeMessageListener?.call(messageManager, messageName, listener);
      } catch {
        // The frame may have navigated while the script was running.
      }
    };
    const listener = (message: { data?: PromptInsertResult | WebChatTextResult }) => {
      const data = (message.data || {
        ok: false,
        reason: "empty-frame-result",
      }) as WebChatTextResult;
      cleanup();
      resolve(data);
    };
    const timeoutId = timerHost.setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "frame-script-timeout" });
    }, 1500);

    const finish = (result: WebChatTextResult) => {
      timerHost.clearTimeout(timeoutId);
      cleanup();
      resolve(result);
    };

    try {
      addMessageListener.call(messageManager, messageName, listener);
      loadFrameScript.call(
        messageManager,
        `data:application/javascript;charset=utf-8,${encodeURIComponent(source)}`,
        false,
      );
    } catch (error) {
      finish({
        ok: false,
        reason:
          error instanceof Error && error.message
            ? error.message
            : "frame-script-error",
      });
    }
  });
}

function getFrameMessageManager(frame: Element): FrameMessageManager | null {
  return (
    (frame as Element & {
      messageManager?: FrameMessageManager;
    }).messageManager || null
  );
}

function resolveTimerHost(): {
  clearTimeout: (timerId: unknown) => void;
  setTimeout: (callback: () => void, timeoutMs: number) => unknown;
} {
  const globalTimerHost = globalThis as unknown as {
    clearTimeout?: (timerId: unknown) => void;
    setTimeout?: (callback: () => void, timeoutMs: number) => unknown;
  };
  if (
    typeof globalTimerHost.setTimeout === "function" &&
    typeof globalTimerHost.clearTimeout === "function"
  ) {
    const hostSetTimeout = globalTimerHost.setTimeout;
    const hostClearTimeout = globalTimerHost.clearTimeout;
    return {
      clearTimeout: (timerId) => hostClearTimeout(timerId),
      setTimeout: (callback, timeoutMs) => hostSetTimeout(callback, timeoutMs),
    };
  }

  const mainWindow = Zotero.getMainWindow?.() as
    | {
        clearTimeout?: (timerId: unknown) => void;
        setTimeout?: (callback: () => void, timeoutMs: number) => unknown;
      }
    | undefined;
  if (
    typeof mainWindow?.setTimeout === "function" &&
    typeof mainWindow.clearTimeout === "function"
  ) {
    const windowSetTimeout = mainWindow.setTimeout;
    const windowClearTimeout = mainWindow.clearTimeout;
    return {
      clearTimeout: (timerId) => windowClearTimeout(timerId),
      setTimeout: (callback, timeoutMs) => windowSetTimeout(callback, timeoutMs),
    };
  }

  return {
    clearTimeout: () => undefined,
    setTimeout: (callback) => {
      void Promise.resolve().then(callback);
      return 0;
    },
  };
}

function buildPromptInsertFrameScript(
  messageName: string,
  prompt: string,
  submit: boolean,
  attachments: ComposerImageAttachment[],
  pasteImageFromNativeClipboard: boolean,
): string {
  return `
(async function () {
  const messageName = ${JSON.stringify(messageName)};
  const prompt = ${JSON.stringify(prompt)};
  const submit = ${JSON.stringify(submit)};
  const attachments = ${JSON.stringify(attachments)};
  const pasteImageFromNativeClipboard = ${JSON.stringify(pasteImageFromNativeClipboard)};
  ${insertPromptIntoDocumentSource()}
  try {
    const result = await insertPromptIntoDocument(content.document, prompt, "frame-script", submit, attachments, pasteImageFromNativeClipboard);
    sendAsyncMessage(messageName, result);
  } catch (error) {
    sendAsyncMessage(messageName, {
      ok: false,
      reason: error && error.message ? error.message : "frame-script-exception"
    });
  }
})();`;
}

function buildWebChatTextFrameScript(messageName: string): string {
  return `
(function () {
  const messageName = ${JSON.stringify(messageName)};
  const MCP_BRIDGE_SCAN_TEXT_LIMIT = ${MCP_BRIDGE_SCAN_TEXT_LIMIT};
  ${readWebChatTextFromDocument.toString()}
  try {
    sendAsyncMessage(messageName, {
      ok: true,
      text: readWebChatTextFromDocument(content.document)
    });
  } catch (error) {
    sendAsyncMessage(messageName, {
      ok: false,
      reason: error && error.message ? error.message : "frame-script-exception"
    });
  }
})();`;
}

function buildLatestAssistantTextFrameScript(messageName: string): string {
  return `
(function () {
  const messageName = ${JSON.stringify(messageName)};
  const MCP_BRIDGE_SCAN_TEXT_LIMIT = ${MCP_BRIDGE_SCAN_TEXT_LIMIT};
  ${readLatestAssistantTextFromDocumentSource()}
  try {
    sendAsyncMessage(messageName, {
      ok: true,
      text: readLatestAssistantTextFromDocument(content.document)
    });
  } catch (error) {
    sendAsyncMessage(messageName, {
      ok: true,
      reason: error && error.message ? error.message : "frame-script-fallback",
      text: readLatestAssistantPlainTextFromDocument(content.document)
    });
  }
})();`;
}

async function insertPromptIntoDocument(
  doc: Document,
  prompt: string,
  method: string,
  submit = false,
  attachments: ComposerImageAttachment[] = [],
  pasteImageFromNativeClipboard = false,
): Promise<PromptInsertResult> {
  let composer = findWebChatComposer(doc);
  if (!composer) {
    return { ok: false, method, reason: "composer-not-found" };
  }
  if (attachments.length) {
    await attachImagesToWebChatComposer(
      doc,
      composer,
      attachments,
      pasteImageFromNativeClipboard,
    );
    composer = findWebChatComposer(doc) || composer;
  }
  writePromptToComposer(composer, prompt);
  await waitForPromptHydration(doc, composer, prompt);
  const submitted = submit
    ? await submitWebChatPrompt(doc, composer, prompt, attachments.length > 0)
    : false;
  return {
    ok: true,
    method,
    reason: submit && !submitted ? "submit-not-confirmed" : undefined,
    submitAttempted: submit,
    submitted,
  };
}

function readWebChatTextFromDocument(doc: Document): string {
  const root =
    doc.querySelector("main") ||
    doc.querySelector('[role="main"]') ||
    doc.body ||
    doc.documentElement;
  const text =
    root && "innerText" in root
      ? (root as HTMLElement).innerText
      : root?.textContent || "";
  return text.slice(-MCP_BRIDGE_SCAN_TEXT_LIMIT);
}

function readLatestAssistantTextFromDocument(doc: Document): string {
  const scanLimit = MCP_BRIDGE_SCAN_TEXT_LIMIT;
  const root =
    doc.querySelector("main") ||
    doc.querySelector('[role="main"]') ||
    doc.body ||
    doc.documentElement;
  if (!root) {
    return "";
  }

  const normalizeText = (value: string) =>
    String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const stripAssistantDisclaimerLines = (value: string) =>
    normalizeText(value)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !isAssistantDisclaimerLine(line))
      .join("\n")
      .trim();

  const isUsableAssistantText = (value: string) => {
    const withoutDisclaimer = stripAssistantDisclaimerLines(value);
    return Boolean(withoutDisclaimer && withoutDisclaimer.length >= 2);
  };

  const getAssistantContentElement = (element: Element) => {
    const contentSelectors = [
      "[data-testid*='assistant-message']",
      "[class*='markdown']",
      "[class*='Markdown']",
      "[class*='prose']",
      "[class*='ds-markdown']",
      "[class*='markdown-body']",
    ];
    for (const selector of contentSelectors) {
      try {
        const content = element.querySelector(selector);
        if (content) {
          return content;
        }
      } catch {
        // Ignore selector incompatibilities in embedded pages.
      }
    }
    return element;
  };

  const getElementText = (element: Element) => {
    const textSource = element.cloneNode(true) as Element;
    markDeepSeekThinkingElements(textSource);
    textSource
      .querySelectorAll(
        "button,svg,nav,header,footer,textarea,input,select,option,[role='button'],[role='toolbar'],[aria-hidden='true'],[hidden]",
      )
      .forEach((node: Element) => {
        if (node.closest("[data-zotero-webai-thinking='true']")) {
          return;
        }
        node.remove();
      });
    const structured = elementHasMarkdownStructure(textSource);
    const raw = structured
      ? serializeElementToMarkdown(textSource)
      : "innerText" in textSource
        ? String((textSource as HTMLElement).innerText || "")
        : String(textSource.textContent || "");
    const noiseLinePattern =
      /^(copy|copied|share|regenerate|retry|stop generating|continue|edit|delete|like|dislike|复制|已复制|分享|重新生成|停止生成|继续生成|编辑|删除|赞|踩)$/i;
    const normalized = structured
      ? cleanupSerializedMarkdown(raw)
      : normalizeText(raw)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .join("\n");
    const cleaned = normalized
      .split("\n")
      .filter((line) => !noiseLinePattern.test(line.trim()))
      .filter(
        (line) =>
          !/^(copy|copied|share|regenerate|retry|stop generating|continue|edit|delete|like|dislike|deep think|search|web search|复制|已复制|分享|重新生成|停止生成|继续生成|编辑|删除|点赞|点踩|深度思考|智能搜索|联网搜索|搜索)$/i.test(
            line.trim(),
          ),
      )
      .join("\n")
      .trim();
    return stripAssistantDisclaimerLines(cleaned);
  };

  const isVisible = (element: Element) => {
    const htmlElement = element as HTMLElement;
    const rect = htmlElement.getBoundingClientRect?.();
    const style = doc.defaultView?.getComputedStyle?.(htmlElement);
    return Boolean(
      rect &&
        rect.width > 8 &&
        rect.height > 8 &&
        style?.display !== "none" &&
        style?.visibility !== "hidden" &&
        style?.opacity !== "0" &&
        !htmlElement.hidden &&
        !htmlElement.closest?.(
          "textarea,input,select,option,form,[role='textbox'],[aria-hidden='true'],[hidden]",
        ),
    );
  };

  const getElementDescriptor = (element: Element) =>
    [
      element.tagName,
      element.id,
      element.className,
      element.getAttribute("role"),
      element.getAttribute("data-role"),
      element.getAttribute("data-author"),
      element.getAttribute("data-message-author-role"),
      element.getAttribute("data-testid"),
      element.getAttribute("aria-label"),
    ]
      .join(" ")
      .toLowerCase();

  const hasComposerControls = (element: Element) =>
    Boolean(
      element.querySelector(
        "textarea,input,select,option,form,[role='textbox'],[contenteditable='true']",
      ),
    );

  const hasMultipleMessageContainers = (element: Element) =>
    element.querySelectorAll(
      "[data-message-author-role], [data-role='assistant'], [class*='message'], [class*='Message']",
    ).length > 4;

  const isAnswerLikeContainer = (element: Element) => {
    const descriptor = getElementDescriptor(element);
    if (
      /user|human|prompt|question|composer|input|textarea|toolbar|sidebar|nav|menu|footer|header/.test(
        descriptor,
      )
    ) {
      return false;
    }
    return /assistant|answer|response|bot|ai|message|markdown|prose|ds-markdown|chat|content|article/.test(
      descriptor,
    );
  };

  const expandToFullAnswerElement = (element: Element) => {
    let best = element;
    let bestText = getElementText(best);
    let current: Element | null = element.parentElement;
    let depth = 0;
    while (current && current !== root && depth < 8) {
      depth += 1;
      if (
        !isVisible(current) ||
        hasComposerControls(current) ||
        hasMultipleMessageContainers(current)
      ) {
        current = current.parentElement;
        continue;
      }
      if (!isAnswerLikeContainer(current) && depth > 3) {
        current = current.parentElement;
        continue;
      }
      const text = getElementText(current);
      if (
        isUsableAssistantText(text) &&
        text.length > bestText.length + 24 &&
        text.length <= 24000
      ) {
        best = current;
        bestText = text;
      }
      current = current.parentElement;
    }
    return best;
  };

  const candidateSelectors = [
    "[data-message-author-role='assistant'] [class*='markdown']",
    "[data-message-author-role='assistant'] [class*='prose']",
    "[data-message-author-role='assistant']",
    "[data-testid*='assistant-message']",
    "[data-role='assistant']",
    "[data-author='assistant']",
    "[data-from='assistant']",
    "[class*='assistant-message']",
    "[class*='ds-markdown']",
    "[class*='markdown-body']",
    "[data-testid*='assistant']",
    "[data-testid*='answer']",
    "[data-testid*='message']",
    "[class*='assistant']",
    "[class*='Assistant']",
    "[class*='answer']",
    "[class*='Answer']",
    "[class*='response']",
    "[class*='Response']",
    "[class*='message']",
    "[class*='Message']",
    "[class*='markdown']",
    "[class*='Markdown']",
    "[class*='prose']",
    "[role='article']",
    "article",
  ];

  const candidates = new Set<Element>();
  for (const selector of candidateSelectors) {
    try {
      root
        .querySelectorAll(selector)
        .forEach((node: Element) => candidates.add(node));
    } catch {
      // Some embedded pages do not support every selector variant.
    }
  }

  const strictAssistantSelectors = [
    "[data-message-author-role='assistant']",
    "[data-testid*='assistant-message']",
    "[data-role='assistant']",
    "[data-author='assistant']",
    "[data-from='assistant']",
    "[class*='assistant-message']",
  ];
  const strictCandidates = new Set<Element>();
  for (const selector of strictAssistantSelectors) {
    try {
      root
        .querySelectorAll(selector)
        .forEach((node: Element) => strictCandidates.add(node));
    } catch {
      // Some embedded pages do not support every selector variant.
    }
  }

  const strictRanked = Array.from(strictCandidates)
    .map((element, index) => {
      const contentElement = getAssistantContentElement(element);
      const expanded = expandToFullAnswerElement(contentElement);
      const text = getElementText(expanded);
      const rect = (expanded as HTMLElement).getBoundingClientRect?.();
      return {
        element: expanded,
        index,
        rectBottom: rect?.bottom || 0,
        text,
      };
    })
    .filter(
      (candidate) =>
        isVisible(candidate.element) && isUsableAssistantText(candidate.text),
    )
    .sort((left, right) => {
      if (right.rectBottom !== left.rectBottom) {
        return right.rectBottom - left.rectBottom;
      }
      return right.index - left.index;
    });

  const strictBest = strictRanked[0]?.text || "";
  if (strictBest) {
    return strictBest.slice(-scanLimit);
  }

  const scoreCandidate = (element: Element, text: string) => {
    if (!isVisible(element) || !isUsableAssistantText(text)) {
      return Number.NEGATIVE_INFINITY;
    }

    const htmlElement = element as HTMLElement;
    const rect = htmlElement.getBoundingClientRect();
    const descriptor = getElementDescriptor(element);
    const allNodes = Array.from(root.querySelectorAll("*"));
    const domIndex = allNodes.indexOf(element);
    let score =
      rect.bottom * 20 +
      (domIndex >= 0 ? domIndex : 0) +
      Math.min(text.length, 5000);

    if (/assistant|answer|response|bot|ai|markdown|prose|ds-markdown/.test(descriptor)) {
      score += 12000;
    }
    if (element.querySelector("h1,h2,h3,h4,h5,h6,ul,ol,table")) {
      score += 9000;
    }
    if (/^#{1,3}\s/m.test(text) || /\n\s*[-*]\s+/.test(text) || /\|.+\|/.test(text)) {
      score += 6500;
    }
    if (text.length >= 400) {
      score += 5000;
    }
    if (text.length < 120 && !element.querySelector("h1,h2,h3,h4,h5,h6")) {
      score -= 6500;
    }
    if (/message|article|conversation|chat/.test(descriptor)) {
      score += 1200;
    }
    if (/user|human|prompt|question|composer|input|textarea|toolbar|sidebar|nav|menu/.test(descriptor)) {
      score -= 10000;
    }
    if (text.length > 20000 && !/assistant|answer|response|markdown/.test(descriptor)) {
      score -= 12000;
    }
    if (element.querySelectorAll("[data-message-author-role], [data-role='assistant'], [class*='message'], [class*='Message']").length > 3) {
      score -= 8000;
    }
    if ((element.querySelectorAll("button,input,textarea,[contenteditable='true']").length || 0) > 4) {
      score -= 2500;
    }
    if (/User message:|Zotero context:|Paper content:|Final answer format:/i.test(text)) {
      score -= 16000;
    }
    if (text.split("\n").every((line) => isAssistantDisclaimerLine(line))) {
      score -= 50000;
    }

    return score;
  };

  const ranked = Array.from(candidates)
    .map((element, index) => {
      const expanded = expandToFullAnswerElement(element);
      const text = getElementText(expanded);
      return {
        element: expanded,
        index,
        score: scoreCandidate(expanded, text),
        text,
      };
    })
    .filter((candidate) => Number.isFinite(candidate.score) && candidate.text)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.index - left.index;
    });

  const best = ranked[0]?.text || "";
  if (best) {
    return best.slice(-scanLimit);
  }

  const fallbackText =
    "innerText" in root
      ? String((root as HTMLElement).innerText || "")
      : String(root.textContent || "");
  return normalizeText(fallbackText).slice(-scanLimit);
}

function readLatestAssistantPlainTextFromDocument(doc: Document): string {
  const root =
    doc.querySelector("main") ||
    doc.querySelector('[role="main"]') ||
    doc.body ||
    doc.documentElement;
  const text =
    root && "innerText" in root
      ? String((root as HTMLElement).innerText || "")
      : String(root?.textContent || "");
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(-MCP_BRIDGE_SCAN_TEXT_LIMIT);
}

function elementHasMarkdownStructure(element: Element): boolean {
  return Boolean(
    element.querySelector("[data-zotero-webai-thinking='true']") ||
    element.querySelector(
      "h1,h2,h3,h4,h5,h6,p,ul,ol,li,table,thead,tbody,tr,th,td,blockquote,pre,code,strong,b,em,i,a,img,picture",
    ),
  );
}

function serializeElementToMarkdown(element: Element): string {
  const chunks = getElementChildNodes(element)
    .map((node) => serializeMarkdownNode(node, 0))
    .filter(Boolean);
  return cleanupSerializedMarkdown(chunks.join("\n\n"));
}

function markDeepSeekThinkingElements(root: Element): void {
  if (!isDeepSeekDocument(root)) {
    return;
  }
  const candidates = Array.from(
    new Set(
      [
        ...getDeepSeekExplicitThinkingElements(root),
        ...(([root, ...Array.from(root.querySelectorAll("*"))] as Element[])
          .map(resolveDeepSeekThinkingElement)
          .filter(Boolean) as Element[]),
      ],
    ),
  )
    .sort(
      (left, right) =>
        Number(isDeepSeekExplicitThinkingElement(right)) -
          Number(isDeepSeekExplicitThinkingElement(left)) ||
        getElementTextLength(right) - getElementTextLength(left),
    );
  candidates.forEach((element) => {
    if (element.closest("[data-zotero-webai-thinking='true']")) {
      return;
    }
    if (hasMarkedThinkingDescendant(element)) {
      return;
    }
    element.setAttribute("data-zotero-webai-thinking", "true");
  });
}

function isDeepSeekDocument(root: Element): boolean {
  try {
    const host = root.ownerDocument?.location?.hostname || "";
    return /(^|\.)deepseek\.com$/i.test(host);
  } catch {
    return false;
  }
}

function resolveDeepSeekThinkingElement(element: Element): Element | null {
  const descriptor = getDeepSeekElementDescriptor(element);
  const label = getDeepSeekElementOwnLabel(element);
  const descriptorLooksLikeThinking = isDeepSeekThinkingDescriptor(descriptor);
  const labelLooksLikeThinking = isDeepSeekThinkingLabel(label);
  if (!descriptorLooksLikeThinking && !labelLooksLikeThinking) {
    return null;
  }
  if (
    descriptorLooksLikeThinking &&
    isDeepSeekThinkingWrapper(element, label)
  ) {
    return element;
  }
  if (
    labelLooksLikeThinking &&
    isDeepSeekExplicitThinkingElement(element) &&
    isDeepSeekThinkingWrapper(element, label)
  ) {
    return element;
  }

  let current = element.parentElement;
  let depth = 0;
  while (current && depth < 5) {
    depth += 1;
    const currentDescriptor = getDeepSeekElementDescriptor(current);
    if (
      isDeepSeekAnswerDescriptor(currentDescriptor) &&
      !isDeepSeekThinkingDescriptor(currentDescriptor)
    ) {
      return null;
    }
    if (
      isDeepSeekThinkingDescriptor(currentDescriptor) &&
      isDeepSeekThinkingWrapper(current, label)
    ) {
      return current;
    }
    if (
      labelLooksLikeThinking &&
      isDeepSeekExplicitThinkingElement(current) &&
      isDeepSeekThinkingWrapper(current, label)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function getDeepSeekExplicitThinkingElements(root: Element): Element[] {
  const selectors = [
    ".ds-think-content",
    "[class*='ds-think-content']",
    "[class*='ds-markdown--think']",
    "[class*='think-content']",
    "[class*='thinking-content']",
    "[class*='reasoning-content']",
    "[data-testid*='think']",
    "[data-testid*='reason']",
    "[data-test*='think']",
    "[data-test*='reason']",
  ];
  return Array.from(
    new Set(
      selectors.flatMap((selector) => {
        try {
          return Array.from(root.querySelectorAll(selector)) as Element[];
        } catch {
          return [];
        }
      }),
    ),
  ).filter((element) => isDeepSeekThinkingWrapper(element));
}

function isDeepSeekExplicitThinkingElement(element: Element): boolean {
  try {
    return element.matches(
      ".ds-think-content,[class*='ds-think-content'],[class*='ds-markdown--think'],[class*='think-content'],[class*='thinking-content'],[class*='reasoning-content'],[data-testid*='think'],[data-testid*='reason'],[data-test*='think'],[data-test*='reason']",
    );
  } catch {
    return false;
  }
}

function isDeepSeekThinkingLabel(value: string): boolean {
  return (
    /^(?:reasoned|thought|thinking)\s+for\s+.+$/i.test(value) ||
    /^(?:thinking|reasoning|reasoning process|chain of thought)$/i.test(value) ||
    /^(?:\u5df2)?\u6df1\u5ea6\u601d\u8003(?:\s*(?:中|完成|[\d.]+\s*(?:秒|秒钟|s|sec|seconds?)|[（(].*[）)]))?$/i.test(
      value,
    ) ||
    /^(?:\u601d\u8003\u4e2d|\u601d\u8003\u5b8c\u6210|\u601d\u8003\u8fc7\u7a0b|\u601d\u8003\u94fe|\u63a8\u7406\u8fc7\u7a0b|\u63a8\u7406)$/i.test(
      value,
    )
  );
}

function isDeepSeekThinkingDescriptor(value: string): boolean {
  if (/(?:enable|enabled|button|btn|switch|toggle|control|toolbar|header|icon)/i.test(value)) {
    return false;
  }
  return /(?:^|[\s_-])(?:ds[\s_-]*)?(?:deep[\s_-]*think|deepthink|think|thinking|reasoning|reasoner|cot|chain[\s_-]*of[\s_-]*thought)(?:[\s_-]*(?:content|container|wrapper|block|panel|markdown|body|text|process|chain)|$)/i.test(
    value,
  );
}

function isDeepSeekAnswerDescriptor(value: string): boolean {
  return /(?:markdown|prose|answer|response|assistant-message|message-content|ds-markdown)/i.test(
    value,
  ) && !/(?:think|reason|cot|chain)/i.test(value);
}

function hasDeepSeekThinkingContent(element: Element, label = ""): boolean {
  const textLength = getElementTextLength(element);
  const labelLength = normalizeCapturedText(label).length;
  return (
    textLength >= Math.max(24, labelLength + 24) &&
    textLength <= 16000
  );
}

function isDeepSeekThinkingWrapper(element: Element, label = ""): boolean {
  const descriptor = getDeepSeekElementDescriptor(element);
  if (
    isDeepSeekAnswerDescriptor(descriptor) &&
    !isDeepSeekThinkingDescriptor(descriptor)
  ) {
    return false;
  }
  if (
    /user|human|prompt|question|composer|input|textarea|toolbar|sidebar|nav|menu|footer|header/.test(
      descriptor,
    )
  ) {
    return false;
  }
  if (
    element.querySelector(
      "textarea,input,select,option,form,[role='textbox'],[contenteditable='true']",
    )
  ) {
    return false;
  }
  return hasDeepSeekThinkingContent(element, label);
}

function getDeepSeekElementDescriptor(element: Element): string {
  return [
    element.tagName,
    element.id,
    element.className,
    element.getAttribute("role"),
    element.getAttribute("data-testid"),
    element.getAttribute("data-test"),
    element.getAttribute("data-role"),
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
  ]
    .join(" ")
    .toLowerCase();
}

function getDeepSeekElementOwnLabel(element: Element): string {
  const parts = [
    element.getAttribute("aria-label") || "",
    element.getAttribute("title") || "",
  ];
  getElementChildNodes(element).forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const child = node as Element;
    if (/^(span|summary|label|button)$/i.test(child.tagName)) {
      parts.push(child.textContent || "");
    }
  });
  return normalizeInlineMarkdownText(parts.join(" "));
}

function getElementTextLength(element: Element): number {
  return normalizeCapturedText(element.textContent || "").length;
}

function hasMarkedThinkingDescendant(element: Element): boolean {
  return Boolean(
    element.querySelector("[data-zotero-webai-thinking='true']"),
  );
}

function serializeDeepSeekThinkingElement(
  element: Element,
  listDepth: number,
): string {
  const elementClone = element.cloneNode(true) as Element;
  elementClone.removeAttribute("data-zotero-webai-thinking");
  const markdown =
    serializeContainerMarkdown(elementClone, listDepth) ||
    serializeInlineMarkdown(elementClone).trim() ||
    normalizeCapturedText(elementClone.textContent || "");
  const text = cleanupSerializedMarkdown(markdown);
  return text ? `<think>\n${text}\n</think>` : "";
}

function serializeMarkdownNode(node: Node, listDepth: number): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeInlineMarkdownText(node.textContent || "");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (element.getAttribute("data-zotero-webai-thinking") === "true") {
    return serializeDeepSeekThinkingElement(element, listDepth);
  }
  if (
    element.matches(
      "button,svg,nav,header,footer,textarea,input,select,option,[role='button'],[role='toolbar'],[aria-hidden='true'],[hidden]",
    ) &&
    !element.closest("[data-zotero-webai-thinking='true']")
  ) {
    return "";
  }

  if (/^h[1-6]$/.test(tag)) {
    const level = Math.min(Number(tag.slice(1)) || 3, 3);
    const text = serializeInlineMarkdown(element).trim();
    return text ? `${"#".repeat(level)} ${text}` : "";
  }
  if (tag === "p" || tag === "div" || tag === "section" || tag === "article") {
    const childBlocks = serializeContainerMarkdown(element, listDepth);
    if (childBlocks) {
      return childBlocks;
    }
    return serializeInlineMarkdown(element).trim();
  }
  if (tag === "br") {
    return "\n";
  }
  if (tag === "img") {
    return serializeImageMarkdown(element);
  }
  if (tag === "ul" || tag === "ol") {
    return serializeListMarkdown(element, tag === "ol", listDepth);
  }
  if (tag === "blockquote") {
    return serializeElementToMarkdown(element)
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
  }
  if (tag === "pre") {
    const code = (element.textContent || "").replace(/\s+$/g, "");
    return code ? `\`\`\`\n${code}\n\`\`\`` : "";
  }
  if (tag === "table") {
    return serializeTableMarkdown(element);
  }
  if (tag === "li") {
    return serializeListItemMarkdown(element, false, listDepth, 1);
  }

  return serializeInlineMarkdown(element).trim();
}

function serializeContainerMarkdown(element: Element, listDepth: number): string {
  const blockChildren = getElementChildNodes(element).filter((child) =>
    isMarkdownBlockNode(child),
  );
  if (!blockChildren.length) {
    return "";
  }

  const chunks: string[] = [];
  const inlineBefore: string[] = [];
  for (const child of getElementChildNodes(element)) {
    if (isMarkdownBlockNode(child)) {
      const inline = normalizeInlineMarkdownText(inlineBefore.join(""));
      if (inline) {
        chunks.push(inline);
      }
      inlineBefore.length = 0;
      const block = serializeMarkdownNode(child, listDepth);
      if (block) {
        chunks.push(block);
      }
      continue;
    }
    inlineBefore.push(serializeInlineMarkdownNode(child));
  }
  const trailingInline = normalizeInlineMarkdownText(inlineBefore.join(""));
  if (trailingInline) {
    chunks.push(trailingInline);
  }
  return chunks.filter(Boolean).join("\n\n");
}

function isMarkdownBlockNode(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  if ((node as Element).getAttribute("data-zotero-webai-thinking") === "true") {
    return true;
  }
  const tag = (node as Element).tagName.toLowerCase();
  return /^(h[1-6]|p|ul|ol|li|table|blockquote|pre|section|article|img|picture)$/.test(tag);
}

function serializeListMarkdown(
  listElement: Element,
  ordered: boolean,
  listDepth: number,
): string {
  const items = getElementChildren(listElement).filter(
    (child) => child.tagName.toLowerCase() === "li",
  );
  return items
    .map((item, index) =>
      serializeListItemMarkdown(item, ordered, listDepth, index + 1),
    )
    .filter(Boolean)
    .join("\n");
}

function serializeListItemMarkdown(
  item: Element,
  ordered: boolean,
  listDepth: number,
  index: number,
): string {
  const nestedLists: Element[] = [];
  const inlineParts: string[] = [];
  const childBlocks: string[] = [];

  getElementChildNodes(item).forEach((child) => {
    if (
      child.nodeType === Node.ELEMENT_NODE &&
      /^(ul|ol)$/i.test((child as Element).tagName)
    ) {
      nestedLists.push(child as Element);
      return;
    }
    if (isMarkdownBlockNode(child) && (child as Element).tagName.toLowerCase() !== "p") {
      const block = serializeMarkdownNode(child, listDepth + 1);
      if (block) {
        childBlocks.push(block);
      }
      return;
    }
    inlineParts.push(serializeInlineMarkdownNode(child));
  });

  const text = normalizeInlineMarkdownText(inlineParts.join(""));
  const marker = ordered ? `${index}.` : "*";
  const indent = "  ".repeat(listDepth);
  const continuationIndent = `${indent}  `;
  const lines = [
    `${indent}${marker} ${text || childBlocks.shift() || ""}`.trimEnd(),
  ];

  childBlocks.forEach((block) => {
    lines.push(
      block
        .split("\n")
        .map((line) => `${continuationIndent}${line}`)
        .join("\n"),
    );
  });
  nestedLists.forEach((nested) => {
    const nestedMarkdown = serializeListMarkdown(
      nested,
      nested.tagName.toLowerCase() === "ol",
      listDepth + 1,
    );
    if (nestedMarkdown) {
      lines.push(nestedMarkdown);
    }
  });
  return lines.join("\n");
}

function serializeTableMarkdown(table: Element): string {
  const rows = (Array.from(table.querySelectorAll("tr")) as Element[])
    .map((row) =>
      getElementChildren(row)
        .filter((cell) => /^(th|td)$/i.test(cell.tagName))
        .map((cell) => serializeInlineMarkdown(cell).trim()),
    )
    .filter((row) => row.length);
  if (!rows.length) {
    return "";
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => escapeMarkdownTableCell(row[index] || "")),
  );
  const header = normalizedRows[0];
  const separator = header.map(() => ":---");
  return [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...normalizedRows.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function serializeInlineMarkdown(element: Element): string {
  return normalizeInlineMarkdownText(
    getElementChildNodes(element)
      .map((child) => serializeInlineMarkdownNode(child))
      .join(""),
  );
}

function serializeInlineMarkdownNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (element.getAttribute("data-zotero-webai-thinking") === "true") {
    return `\n${serializeDeepSeekThinkingElement(element, 0)}\n`;
  }
  if (
    element.matches(
      "button,svg,nav,header,footer,textarea,input,select,option,[role='button'],[role='toolbar'],[aria-hidden='true'],[hidden]",
    ) &&
    !element.closest("[data-zotero-webai-thinking='true']")
  ) {
    return "";
  }
  if (tag === "br") {
    return "\n";
  }
  if (tag === "img") {
    return serializeImageMarkdown(element);
  }
  if (tag === "strong" || tag === "b") {
    const text = serializeInlineMarkdown(element);
    return text ? `**${text}**` : "";
  }
  if (tag === "em" || tag === "i") {
    const text = serializeInlineMarkdown(element);
    return text ? `*${text}*` : "";
  }
  if (tag === "code") {
    const text = normalizeInlineMarkdownText(element.textContent || "");
    return text ? `\`${text.replace(/`/g, "\\`")}\`` : "";
  }
  if (tag === "a") {
    const text = serializeInlineMarkdown(element);
    const href = element.getAttribute("href") || "";
    return text && /^https?:\/\//i.test(href) ? `[${text}](${href})` : text;
  }
  if (/^(ul|ol|table|blockquote|pre|h[1-6])$/.test(tag)) {
    return `\n${serializeMarkdownNode(element, 0)}\n`;
  }
  return getElementChildNodes(element)
    .map((child) => serializeInlineMarkdownNode(child))
    .join("");
}

function serializeImageMarkdown(element: Element): string {
  const image = element as HTMLImageElement;
  let src = (
    image.currentSrc ||
    image.src ||
    element.getAttribute("src") ||
    element.getAttribute("data-src") ||
    ""
  ).trim();
  if (!src) {
    return "";
  }

  const doc = element.ownerDocument;
  if (!doc) {
    return "";
  }

  // Resolve relative URLs to absolute URLs relative to the document
  try {
    const baseURI = doc.baseURI || doc.location?.href;
    if (baseURI) {
      src = new URL(src, baseURI).href;
    }
  } catch (e) {
    // ignore
  }

  // Try to convert to base64 Data URL to handle blob URLs and session-restricted images
  let dataURL = "";
  try {
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      const canvas = doc.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d") as any;
      if (ctx) {
        ctx.drawImage(image, 0, 0);
        dataURL = canvas.toDataURL("image/png");
      }
    }
  } catch (e) {
    // ignore SecurityError for cross-origin tainted canvas
  }

  const finalSrc = dataURL || src;
  if (!isRenderableImageURL(finalSrc)) {
    return "";
  }

  const alt = escapeMarkdownImageText(
    element.getAttribute("alt") ||
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      "image",
  );
  return `![${alt}](${escapeMarkdownImageURL(finalSrc)})`;
}

function isRenderableImageURL(value: string): boolean {
  const url = String(value || "").trim();
  return /^(?:https?:|data:image\/|blob:|file:|zotero:|\/\/)/i.test(url);
}

function escapeMarkdownImageText(value: string): string {
  return normalizeInlineMarkdownText(value)
    .replace(/[[\]\r\n]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function escapeMarkdownImageURL(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function hasMarkdownImage(value: string): boolean {
  return /!\[[^\]\n]*\]\((?:https?:|data:image\/|blob:|file:|zotero:|\/\/)[^)]+\)/i.test(
    value,
  );
}

function shouldUseLongImageCapture(sourcePrompt: string): boolean {
  const prompt = normalizeCapturedText(sourcePrompt).toLowerCase();
  if (!prompt) {
    return false;
  }
  return (
    /\b(generate|create|draw|render|make|show|insert|display)\b[\s\S]{0,80}\b(image|picture|photo|figure|diagram|chart|graph|illustration|plot)\b/i.test(prompt) ||
    /\b(image|picture|photo|figure|diagram|chart|graph|illustration|plot)\b[\s\S]{0,80}\b(generate|create|draw|render|make|show|insert|display)\b/i.test(prompt) ||
    /(生成|创建|绘制|画|画一张|出图|做图|生成图片|生成图像|图片生成|图像生成|插图|配图|图示|流程图|示意图|图表|曲线图|柱状图|折线图|散点图|饼图)/.test(prompt)
  );
}

function getElementChildNodes(element: Element): Node[] {
  return Array.prototype.slice.call(element.childNodes).filter(Boolean) as Node[];
}

function getElementChildren(element: Element): Element[] {
  return Array.prototype.slice.call(element.children).filter(Boolean) as Element[];
}

function normalizeInlineMarkdownText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, "<br>");
}

function cleanupSerializedMarkdown(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sleepInDocument(doc: Document, timeoutMs: number): Promise<void> {
  const win = doc.defaultView;
  return new Promise((resolve) => {
    const timer =
      win?.setTimeout ||
      ((globalThis as unknown as {
        setTimeout?: (callback: () => void, timeoutMs: number) => unknown;
      }).setTimeout);
    if (timer) {
      timer(resolve, timeoutMs);
      return;
    }
    void Promise.resolve().then(resolve);
  });
}

function findWebChatComposer(doc: Document): HTMLElement | null {
  const selectors = [
    "textarea:not([disabled]):not([readonly])",
    '[contenteditable="true"]',
    '[role="textbox"]',
    'input[type="text"]:not([disabled]):not([readonly])',
  ];
  const candidates: HTMLElement[] = [];
  selectors.forEach((selector) => {
    const nodes = doc.querySelectorAll(selector) as NodeListOf<Element>;
    for (let index = 0; index < nodes.length; index += 1) {
      const element = nodes.item(index);
      if (element.nodeType === Node.ELEMENT_NODE) {
        candidates.push(element as HTMLElement);
      }
    }
  });
  const visibleCandidates = candidates
    .filter(isVisibleComposerCandidate)
    .sort(
      (left, right) => scoreComposerCandidate(right) - scoreComposerCandidate(left),
    );
  return visibleCandidates[0] || null;
}

async function submitWebChatPrompt(
  doc: Document,
  composer: HTMLElement,
  prompt: string,
  preserveComposerAttachments = false,
): Promise<boolean> {
  focusComposerForSubmit(composer);
  const fingerprint = createPromptFingerprint(prompt || getComposerText(composer));
  if (
    !preserveComposerAttachments &&
    (await submitComposerWithPasteAndEnter(doc, composer, prompt, fingerprint))
  ) {
    return true;
  }
  const delays = [80, 120, 180, 260, 360, 520, 760, 1000, 1300, 1800];
  for (const delay of delays) {
    await sleepInDocument(doc, delay);
    const activeComposer = findWebChatComposer(doc) || composer;
    if (!preserveComposerAttachments) {
      ensureComposerContainsPrompt(activeComposer, prompt, fingerprint);
    }
    focusComposerForSubmit(activeComposer);
    dispatchComposerEvents(activeComposer, getComposerText(activeComposer));

    if (dispatchEnterToComposer(doc, activeComposer)) {
      if (await waitForPromptSubmitted(doc, activeComposer, fingerprint, 900)) {
        return true;
      }
    }

    const submitButtons = findWebChatSubmitButtons(doc, activeComposer);
    for (const submitButton of submitButtons.slice(0, 14)) {
      clickSubmitButton(submitButton);
      if (await waitForPromptSubmitted(doc, activeComposer, fingerprint, 620)) {
        return true;
      }
      const clickableParent = findClickableAncestor(submitButton, activeComposer);
      if (clickableParent && clickableParent !== submitButton) {
        clickSubmitButton(clickableParent);
        if (await waitForPromptSubmitted(doc, activeComposer, fingerprint, 620)) {
          return true;
        }
      }
      const clickableChild = findClickableDescendant(submitButton);
      if (clickableChild && clickableChild !== submitButton) {
        clickSubmitButton(clickableChild);
        if (await waitForPromptSubmitted(doc, activeComposer, fingerprint, 620)) {
          return true;
        }
      }
    }

    if (clickComposerSubmitHotspots(doc, activeComposer)) {
      if (await waitForPromptSubmitted(doc, activeComposer, fingerprint, 720)) {
        return true;
      }
    }

    if (dispatchModifiedEnterToComposer(doc, activeComposer, "ctrl")) {
      if (await waitForPromptSubmitted(doc, activeComposer, fingerprint, 520)) {
        return true;
      }
    }
    if (dispatchModifiedEnterToComposer(doc, activeComposer, "meta")) {
      if (await waitForPromptSubmitted(doc, activeComposer, fingerprint, 520)) {
        return true;
      }
    }
    if (submitNearestComposerForm(activeComposer)) {
      if (await waitForPromptSubmitted(doc, activeComposer, fingerprint, 720)) {
        return true;
      }
    }
  }

  return false;
}

async function submitComposerWithPasteAndEnter(
  doc: Document,
  composer: HTMLElement,
  prompt: string,
  fingerprint: { head: string; tail: string },
): Promise<boolean> {
  let activeComposer = findWebChatComposer(doc) || composer;
  activateComposerForNativeInput(doc, activeComposer);
  await sleepInDocument(doc, 80);
  activeComposer = findWebChatComposer(doc) || activeComposer;
  replaceComposerSelectionWithPrompt(doc, activeComposer, prompt);
  await waitForPromptHydration(doc, activeComposer, prompt);
  activeComposer = findWebChatComposer(doc) || activeComposer;
  ensureComposerContainsPrompt(activeComposer, prompt, fingerprint);
  activateComposerForNativeInput(doc, activeComposer);
  await sleepInDocument(doc, 120);

  const nativeEnterSent = sendNativeEnter(doc);
  const domEnterSent = dispatchKeyboardSubmitToComposer(doc, activeComposer, {});
  if (nativeEnterSent || domEnterSent) {
    if (await waitForPromptSubmitted(doc, activeComposer, fingerprint, 1500)) {
      return true;
    }
  }

  const submitButtons = findWebChatSubmitButtons(doc, activeComposer);
  for (const submitButton of submitButtons.slice(0, 8)) {
    clickSubmitButton(submitButton);
    if (await waitForPromptSubmitted(doc, activeComposer, fingerprint, 800)) {
      return true;
    }
  }

  if (clickComposerSubmitHotspots(doc, activeComposer)) {
    if (await waitForPromptSubmitted(doc, activeComposer, fingerprint, 900)) {
      return true;
    }
  }
  if (clickViewportSubmitHotspots(doc, activeComposer)) {
    if (await waitForPromptSubmitted(doc, activeComposer, fingerprint, 900)) {
      return true;
    }
  }

  // DeepSeek, Z.ai and ChatGPT can keep the prompt visible while generation starts.
  // Once a trusted Enter was sent into the focused web composer, continue capture
  // instead of falling back to "copied only".
  return nativeEnterSent;
}

function activateComposerForNativeInput(
  doc: Document,
  composer: HTMLElement,
): void {
  try {
    composer.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  } catch {
    // Some embedded pages reject scroll options.
  }
  focusComposerForSubmit(composer);
  const center = getElementCenter(composer);
  sendNativeMouseClick(doc, center.x, center.y);
  focusComposerForSubmit(composer);
}

function replaceComposerSelectionWithPrompt(
  doc: Document,
  composer: HTMLElement,
  prompt: string,
): void {
  focusComposerForSubmit(composer);
  selectComposerContents(doc, composer);
  const fingerprint = createPromptFingerprint(prompt);
  if (sendNativeShortcut(doc, 65) && sendNativeShortcut(doc, 86)) {
    dispatchComposerEvents(composer, prompt);
    if (textMatchesPromptFingerprint(getComposerText(composer), fingerprint)) {
      return;
    }
  }
  let pasted = false;
  try {
    pasted = doc.execCommand("paste");
  } catch {
    pasted = false;
  }
  if (!pasted || !textMatchesPromptFingerprint(getComposerText(composer), fingerprint)) {
    writePromptToComposer(composer, prompt);
  } else {
    dispatchComposerEvents(composer, prompt);
  }
}

function selectComposerContents(doc: Document, composer: HTMLElement): void {
  const tagName = composer.tagName.toLowerCase();
  if (tagName === "textarea" || tagName === "input") {
    const input = composer as HTMLTextAreaElement | HTMLInputElement;
    try {
      input.focus();
      input.setSelectionRange(0, String(input.value || "").length);
      return;
    } catch {
      // Fall through to document selection for unusual input wrappers.
    }
  }
  try {
    const selection = doc.defaultView?.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(composer);
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch {
    // Best effort; writePromptToComposer will still replace the value.
  }
}

async function attachImagesToWebChatComposer(
  doc: Document,
  composer: HTMLElement,
  attachments: ComposerImageAttachment[],
  pasteImageFromNativeClipboard = false,
): Promise<boolean> {
  const files = attachments
    .map((attachment) => createFileFromComposerImage(doc, attachment))
    .filter(Boolean) as File[];
  if (!files.length) {
    return false;
  }
  focusComposerForSubmit(composer);
  if (pasteImageFromNativeClipboard && pasteNativeClipboardImageToComposer(doc, composer)) {
    await waitForComposerImageAttachment(doc, composer, 8000);
    await sleepInDocument(doc, 500);
    return true;
  }
  if (assignImagesToNearestFileInput(doc, composer, files)) {
    await waitForComposerImageAttachment(doc, composer, 8000);
    await sleepInDocument(doc, 500);
    return true;
  }
  if (dispatchImagePasteToComposer(doc, composer, files)) {
    await waitForComposerImageAttachment(doc, composer, 6000);
    await sleepInDocument(doc, 400);
    return true;
  }
  return false;
}


async function waitForComposerImageAttachment(
  doc: Document,
  composer: HTMLElement,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (hasComposerImageAttachment(doc, composer)) {
      return true;
    }
    await sleepInDocument(doc, 180);
  }
  return hasComposerImageAttachment(doc, composer);
}

function hasComposerImageAttachment(doc: Document, composer: HTMLElement): boolean {
  const wrapper = getComposerAttachmentWrapper(doc, composer);
  return Boolean(
    wrapper.querySelector(
      "img,canvas,picture,[data-testid*='attachment'],[data-testid*='file'],[class*='attachment'],[class*='upload'],[class*='file-preview'],[class*='image-preview']",
    ),
  );
}

function getComposerAttachmentWrapper(doc: Document, composer: HTMLElement): Element {
  return (
    composer.closest(
      "form,[class*='composer'],[class*='input'],[class*='chat-input'],[class*='prompt'],[data-testid*='composer']",
    ) || doc.body || doc.documentElement || composer
  );
}

function createFileFromComposerImage(
  doc: Document,
  attachment: ComposerImageAttachment,
): File | null {
  const win = doc.defaultView;
  const dataURLMatch = attachment.dataURL.match(
    /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i,
  );
  if (!dataURLMatch) {
    return null;
  }
  const mimeType = attachment.type || dataURLMatch[1] || "image/png";
  const payload = dataURLMatch[3] || "";
  let binary = "";
  if (dataURLMatch[2]) {
    const decodeBase64 = win?.atob?.bind(win);
    if (!decodeBase64) {
      return null;
    }
    binary = decodeBase64(payload);
  } else {
    binary = decodeURIComponent(payload);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  try {
    return new (win?.File || File)([bytes], attachment.name || "image.png", {
      type: mimeType,
    });
  } catch {
    return null;
  }
}

function dispatchImagePasteToComposer(
  doc: Document,
  composer: HTMLElement,
  files: File[],
): boolean {
  const win = doc.defaultView;
  try {
    const dataTransfer = new (win?.DataTransfer || DataTransfer)();
    files.forEach((file) => dataTransfer.items.add(file));
    const event = new (win?.ClipboardEvent || ClipboardEvent)("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    } as ClipboardEventInit);
    const targets = Array.from(
      new Set<EventTarget>(
        [composer, doc.activeElement, doc, win].filter(Boolean) as EventTarget[],
      ),
    );
    targets.forEach((target) => target.dispatchEvent(event));
    return true;
  } catch {
    return false;
  }
}

function pasteNativeClipboardImageToComposer(
  doc: Document,
  composer: HTMLElement,
): boolean {
  activateComposerForNativeInput(doc, composer);
  return sendNativeShortcut(doc, 86);
}

function assignImagesToNearestFileInput(
  doc: Document,
  composer: HTMLElement,
  files: File[],
): boolean {
  const win = doc.defaultView;
  const dataTransfer = new (win?.DataTransfer || DataTransfer)();
  files.forEach((file) => dataTransfer.items.add(file));
  const fileInputs = queryElementsDeep(
    doc,
    "input[type='file']",
  ) as HTMLInputElement[];
  const composerRect = composer.getBoundingClientRect();
  const candidates = fileInputs
    .filter((input) => acceptsImageFileInput(input))
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (
        Math.abs(leftRect.top - composerRect.top) +
        Math.abs(leftRect.left - composerRect.left) -
        (Math.abs(rightRect.top - composerRect.top) +
          Math.abs(rightRect.left - composerRect.left))
      );
    });
  for (const input of candidates.slice(0, 4)) {
    try {
      if (typeof input.mozSetFileArray === "function") {
        input.mozSetFileArray(files);
      } else {
        input.files = dataTransfer.files;
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch {
      // Some browsers disallow programmatic files assignment.
    }
  }
  return false;
}

function acceptsImageFileInput(input: HTMLInputElement): boolean {
  const accept = String(input.accept || "").toLowerCase();
  return !accept || accept.includes("image") || accept.includes("*/*");
}

function ensureComposerContainsPrompt(
  composer: HTMLElement,
  prompt: string,
  fingerprint: { head: string; tail: string },
): void {
  if (!prompt || textMatchesPromptFingerprint(getComposerText(composer), fingerprint)) {
    return;
  }
  writePromptToComposer(composer, prompt);
}

function findWebChatSubmitButtons(
  doc: Document,
  composer: HTMLElement,
): HTMLElement[] {
  const selector = [
    "button",
    "[role='button']",
    "[aria-label]",
    "[title]",
    "[data-testid]",
    "[data-test]",
    "[data-qa]",
    "[class*='send']",
    "[class*='Send']",
    "[class*='submit']",
    "[class*='Submit']",
  ].join(",");
  const scopedButtons = getSubmitCandidateContainers(composer).flatMap((container) =>
    queryElementsDeep(container, selector),
  );
  const buttons = [...scopedButtons, ...queryElementsDeep(doc, selector)];
  const visibleButtons = buttons
    .filter((button, index, list) => list.indexOf(button) === index)
    .filter((button) => isVisibleSubmitCandidate(button, composer))
    .sort(
      (left, right) =>
        scoreSubmitCandidate(right, composer) -
        scoreSubmitCandidate(left, composer),
    );
  return visibleButtons;
}

function isVisibleSubmitCandidate(
  element: HTMLElement,
  composer?: HTMLElement,
): boolean {
  const rect = element.getBoundingClientRect();
  const doc = element.ownerDocument;
  if (!doc) {
    return false;
  }
  const style = doc.defaultView?.getComputedStyle(element);
  const label = [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-testid"),
    element.getAttribute("data-test"),
    element.getAttribute("data-qa"),
    element.getAttribute("class"),
    element.textContent,
  ]
    .join(" ")
    .toLowerCase();
  const disabled =
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true" ||
    element.getAttribute("data-disabled") === "true";
  const composerRect = composer?.getBoundingClientRect();
  const nearComposer = composerRect
    ? rect.bottom >= composerRect.top - 180 &&
      rect.top <= composerRect.bottom + 180 &&
      rect.right >= composerRect.left - 40 &&
      rect.left <= composerRect.right + 220
    : false;
  const iconLike = Boolean(
    element.querySelector("svg") ||
      /arrow|send|paper|plane|up|submit|发送|送出|提交|发送消息/i.test(label),
  );
  return Boolean(
    !disabled &&
      rect.width >= 18 &&
      rect.height >= 18 &&
      rect.width <= 140 &&
      rect.height <= 140 &&
      style?.display !== "none" &&
      style?.visibility !== "hidden" &&
      !element.closest("[aria-hidden='true']") &&
      (/(send|submit|发送|送出|提交|发送消息|arrow|paper|plane|up|chat)/i.test(
        label,
      ) ||
        (nearComposer && iconLike)),
  );
}

function scoreSubmitCandidate(
  element: HTMLElement,
  composer?: HTMLElement,
): number {
  const rect = element.getBoundingClientRect();
  const label = [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-testid"),
    element.getAttribute("data-test"),
    element.getAttribute("data-qa"),
    element.getAttribute("class"),
    element.textContent,
  ]
    .join(" ")
    .toLowerCase();
  const composerRect = composer?.getBoundingClientRect();
  let score = rect.bottom * 10 + rect.right;
  if (/(send|发送|送出|提交|发送消息|submit)/i.test(label)) score += 100000;
  if (/(arrow|paper|plane|up)/i.test(label)) score += 25000;
  if (element.tagName.toLowerCase() === "button") score += 10000;
  if (element.querySelector("svg")) score += 8000;
  if (composerRect) {
    const verticalDistance = Math.min(
      Math.abs(rect.top - composerRect.top),
      Math.abs(rect.bottom - composerRect.bottom),
      Math.abs(rect.top - composerRect.bottom),
    );
    score += Math.max(0, 20000 - verticalDistance * 160);
    if (rect.left >= composerRect.left + composerRect.width * 0.45) {
      score += 12000;
    }
    if (rect.left < composerRect.left - 30 || rect.top < composerRect.top - 140) {
      score -= 30000;
    }
  }
  return score;
}

function getSubmitCandidateContainers(composer: HTMLElement): HTMLElement[] {
  const containers: HTMLElement[] = [composer];
  let current = composer.parentElement as HTMLElement | null;
  let depth = 0;
  while (current && depth < 7) {
    depth += 1;
    containers.push(current);
    const rect = current.getBoundingClientRect();
    const label = [
      current.getAttribute("role"),
      current.getAttribute("aria-label"),
      current.getAttribute("data-testid"),
      current.getAttribute("data-test"),
      current.getAttribute("class"),
    ]
      .join(" ")
      .toLowerCase();
    if (
      current.tagName.toLowerCase() === "form" ||
      current.getAttribute("role") === "form" ||
      (rect.width >= 260 &&
        rect.height >= 48 &&
        /(composer|prompt|chat|input|textarea|message|search|form)/i.test(label))
    ) {
      break;
    }
    current = current.parentElement as HTMLElement | null;
  }
  return Array.from(new Set(containers));
}

function queryElementsDeep(
  root: Document | Element | ShadowRoot,
  selector: string,
): HTMLElement[] {
  const results: HTMLElement[] = [];
  const visit = (scope: Document | Element | ShadowRoot) => {
    try {
      const selectedNodes = scope.querySelectorAll(selector) as NodeListOf<Element>;
      for (let index = 0; index < selectedNodes.length; index += 1) {
        const element = selectedNodes.item(index) as HTMLElement;
        if (typeof element.getBoundingClientRect === "function") {
          results.push(element);
        }
      }
      const allNodes = scope.querySelectorAll("*") as NodeListOf<Element>;
      for (let index = 0; index < allNodes.length; index += 1) {
        const shadowRoot = (allNodes.item(index) as HTMLElement).shadowRoot;
        if (shadowRoot) {
          visit(shadowRoot);
        }
      }
    } catch {
      // Some embedded pages reject selectors in shadow roots.
    }
  };
  visit(root);
  return Array.from(new Set(results));
}

function focusComposerForSubmit(composer: HTMLElement): void {
  const doc = composer.ownerDocument;
  if (!doc) {
    return;
  }
  try {
    composer.focus();
  } catch {
    // Focus can fail while the embedded page is navigating.
  }
  const tagName = composer.tagName.toLowerCase();
  if (tagName === "textarea" || tagName === "input") {
    const input = composer as HTMLTextAreaElement | HTMLInputElement;
    try {
      const textLength = String(input.value || "").length;
      input.setSelectionRange(textLength, textLength);
    } catch {
      // Some inputs reject selection updates.
    }
    return;
  }
  try {
    const selection = doc.defaultView?.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch {
    // Contenteditable selections are best effort.
  }
}

function clickSubmitButton(element: HTMLElement): void {
  const doc = element.ownerDocument;
  if (!doc) {
    element.click();
    return;
  }
  const win = doc.defaultView;
  const center = getElementCenter(element);
  try {
    element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  } catch {
    // Some embedded pages reject scrollIntoView options.
  }
  try {
    element.focus?.();
  } catch {
    // Not every clickable element is focusable.
  }
  if (sendNativeMouseClick(doc, center.x, center.y)) {
    return;
  }
  dispatchPointerMouseSequence(element, center);
  try {
    element.click();
  } catch {
    // Synthetic clicks are a final fallback.
  }
  invokeFrameworkClickHandlers(element);
}

function getElementCenter(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + Math.max(1, rect.width / 2),
    y: rect.top + Math.max(1, rect.height / 2),
  };
}

function getWindowUtils(doc: Document): {
  sendKeyEvent?: (
    type: string,
    keyCode: number,
    charCode: number,
    modifiers: number,
    flags?: number,
  ) => void;
  sendNativeKeyEvent?: (
    keyboardLayout: number,
    nativeKeyCode: number,
    modifiers: number,
    chars: string,
    unmodifiedChars: string,
  ) => void;
  sendMouseEvent?: (
    type: string,
    x: number,
    y: number,
    button: number,
    clickCount: number,
    modifiers: number,
  ) => void;
} | null {
  const win = doc.defaultView as
    | (Window & {
        QueryInterface?: (interfaceType: unknown) => {
          getInterface?: (interfaceType: unknown) => unknown;
        };
        windowUtils?: {
          sendKeyEvent?: (
            type: string,
            keyCode: number,
            charCode: number,
            modifiers: number,
            flags?: number,
          ) => void;
          sendNativeKeyEvent?: (
            keyboardLayout: number,
            nativeKeyCode: number,
            modifiers: number,
            chars: string,
            unmodifiedChars: string,
          ) => void;
          sendMouseEvent?: (
            type: string,
            x: number,
            y: number,
            button: number,
            clickCount: number,
            modifiers: number,
          ) => void;
        };
      })
    | null;
  if (!win) {
    return null;
  }
  if (win.windowUtils) {
    return win.windowUtils;
  }
  try {
    const components = (globalThis as unknown as { Components?: typeof Components })
      .Components;
    const interfaces = components?.interfaces;
    if (
      interfaces?.nsIInterfaceRequestor &&
      interfaces.nsIDOMWindowUtils &&
      typeof win.QueryInterface === "function"
    ) {
      const requestor = win.QueryInterface(interfaces.nsIInterfaceRequestor);
      const utils = requestor.getInterface?.(interfaces.nsIDOMWindowUtils);
      return (utils || null) as ReturnType<typeof getWindowUtils>;
    }
  } catch {
    // nsIDOMWindowUtils is available only from privileged Zotero contexts.
  }
  return null;
}

function sendNativeMouseClick(doc: Document, x: number, y: number): boolean {
  const utils = getWindowUtils(doc);
  if (!utils || typeof utils.sendMouseEvent !== "function") {
    return false;
  }
  const clientX = Math.max(1, Math.round(x));
  const clientY = Math.max(1, Math.round(y));
  try {
    utils.sendMouseEvent("mousemove", clientX, clientY, 0, 0, 0);
    utils.sendMouseEvent("mousedown", clientX, clientY, 0, 1, 0);
    utils.sendMouseEvent("mouseup", clientX, clientY, 0, 1, 0);
    return true;
  } catch {
    return false;
  }
}

function sendNativeEnter(doc: Document): boolean {
  const utils = getWindowUtils(doc);
  if (
    !utils ||
    (typeof utils.sendKeyEvent !== "function" &&
      typeof utils.sendNativeKeyEvent !== "function")
  ) {
    return false;
  }
  let sent = false;
  const nativeKeySender = utils.sendNativeKeyEvent;
  if (typeof nativeKeySender === "function") {
    try {
      nativeKeySender.call(utils, 0, 13, 0, "\r", "\r");
      sent = true;
    } catch {
      // Fall through to DOM window-utils key events.
    }
  }
  if (typeof utils.sendKeyEvent !== "function") {
    return sent;
  }
  try {
    utils.sendKeyEvent("keydown", 13, 0, 0);
    utils.sendKeyEvent("keypress", 0, 13, 0);
    utils.sendKeyEvent("keypress", 13, 13, 0);
    utils.sendKeyEvent("keyup", 13, 0, 0);
    return true;
  } catch {
    return sent;
  }
}

function sendNativeShortcut(doc: Document, keyCode: number, charCode = 0): boolean {
  const utils = getWindowUtils(doc);
  if (!utils || typeof utils.sendKeyEvent !== "function") {
    return false;
  }
  const modifiers = [0x0002, 0x0008];
  for (const modifier of modifiers) {
    try {
      utils.sendKeyEvent("keydown", keyCode, 0, modifier);
      utils.sendKeyEvent("keypress", charCode ? 0 : keyCode, charCode, modifier);
      utils.sendKeyEvent("keyup", keyCode, 0, modifier);
      return true;
    } catch {
      // Try the next platform modifier.
    }
  }
  return false;
}

function clickComposerSubmitHotspots(doc: Document, composer: HTMLElement): boolean {
  const containers = getSubmitCandidateContainers(composer);
  const rects = Array.from(new Set([composer, ...containers]))
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width >= 80 && rect.height >= 24);
  const points: Array<{ x: number; y: number }> = [];
  rects.forEach((rect) => {
    const rightInset = Math.min(42, Math.max(18, rect.width * 0.08));
    const bottomInset = Math.min(42, Math.max(18, rect.height * 0.28));
    points.push(
      { x: rect.right - rightInset, y: rect.bottom - bottomInset },
      { x: rect.right - rightInset, y: rect.top + rect.height / 2 },
      { x: rect.right - rightInset * 0.75, y: rect.bottom - 28 },
    );
  });
  let attempted = false;
  points.forEach((point) => {
    const x = Math.max(1, Math.round(point.x));
    const y = Math.max(1, Math.round(point.y));
    const target = doc.elementFromPoint(x, y) as HTMLElement | null;
    if (target && typeof target.getBoundingClientRect === "function") {
      attempted = true;
      const clickableAncestor = findClickableAncestor(target, composer);
      clickSubmitButton(clickableAncestor || target);
      return;
    }
    attempted = sendNativeMouseClick(doc, x, y) || attempted;
  });
  return attempted;
}

function clickViewportSubmitHotspots(doc: Document, composer: HTMLElement): boolean {
  const win = doc.defaultView;
  const viewportWidth = Math.max(
    doc.documentElement?.clientWidth || 0,
    win?.innerWidth || 0,
  );
  const viewportHeight = Math.max(
    doc.documentElement?.clientHeight || 0,
    win?.innerHeight || 0,
  );
  const rects = getSubmitCandidateContainers(composer)
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width >= 160 && rect.height >= 40);
  rects.unshift(composer.getBoundingClientRect());

  const points: Array<{ x: number; y: number }> = [];
  rects.forEach((rect) => {
    points.push(
      { x: rect.right - 28, y: rect.bottom - 28 },
      { x: rect.right - 44, y: rect.bottom - 24 },
      { x: rect.right - 32, y: rect.top + rect.height / 2 },
    );
  });
  if (viewportWidth && viewportHeight) {
    points.push(
      { x: viewportWidth - 42, y: viewportHeight - 42 },
      { x: viewportWidth - 70, y: viewportHeight - 48 },
    );
  }

  let attempted = false;
  points.forEach((point) => {
    const x = Math.max(1, Math.round(Math.min(point.x, viewportWidth || point.x)));
    const y = Math.max(1, Math.round(Math.min(point.y, viewportHeight || point.y)));
    const target = doc.elementFromPoint(x, y) as HTMLElement | null;
    if (target && typeof target.getBoundingClientRect === "function") {
      attempted = true;
      const clickableAncestor = findClickableAncestor(target, composer);
      clickSubmitButton(clickableAncestor || target);
    } else {
      attempted = sendNativeMouseClick(doc, x, y) || attempted;
    }
  });
  return attempted;
}

function invokeFrameworkClickHandlers(element: HTMLElement): void {
  const candidates: HTMLElement[] = [];
  let current: HTMLElement | null = element;
  let depth = 0;
  while (current && depth < 5) {
    candidates.push(current);
    current = current.parentElement as HTMLElement | null;
    depth += 1;
  }
  candidates.forEach((candidate) => {
    const propertyNames = Object.getOwnPropertyNames(candidate);
    propertyNames.forEach((name) => {
      if (!/^__react(Props|EventHandlers)\$/.test(name)) {
        return;
      }
      const props = (candidate as unknown as Record<string, unknown>)[name] as
        | Record<string, unknown>
        | undefined;
      const handlers = [
        props?.onPointerDown,
        props?.onMouseDown,
        props?.onClick,
        props?.onPointerUp,
        props?.onMouseUp,
      ];
      handlers.forEach((handler) => {
        if (typeof handler !== "function") {
          return;
        }
        try {
          handler({
            button: 0,
            buttons: 1,
            currentTarget: candidate,
            defaultPrevented: false,
            isDefaultPrevented: () => false,
            isPropagationStopped: () => false,
            nativeEvent: {},
            preventDefault: () => undefined,
            stopPropagation: () => undefined,
            target: element,
            type: "click",
          });
        } catch {
          // Framework internals are best effort and differ by provider.
        }
      });
    });
  });
}

function dispatchPointerMouseSequence(
  element: HTMLElement,
  center: { x: number; y: number },
): void {
  const doc = element.ownerDocument;
  if (!doc) {
    return;
  }
  const win = doc.defaultView;
  const mouseOptions: MouseEventInit = {
    bubbles: true,
    button: 0,
    buttons: 1,
    cancelable: true,
    clientX: center.x,
    clientY: center.y,
    screenX: center.x,
    screenY: center.y,
    view: win || undefined,
  };
  const pointerOptions: PointerEventInit = {
    ...mouseOptions,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
  };
  const pointerCtor = win?.PointerEvent || PointerEvent;
  const mouseCtor = win?.MouseEvent || MouseEvent;
  const dispatch = (
    target: HTMLElement,
    type: string,
    ctor: typeof MouseEvent | typeof PointerEvent,
    options: MouseEventInit | PointerEventInit,
  ) => {
    try {
      target.dispatchEvent(new ctor(type, options));
    } catch {
      target.dispatchEvent(new mouseCtor(type, mouseOptions));
    }
  };
  ["pointerover", "pointerenter", "pointermove", "pointerdown"].forEach((type) =>
    dispatch(element, type, pointerCtor, pointerOptions),
  );
  ["mouseover", "mouseenter", "mousemove", "mousedown"].forEach((type) =>
    dispatch(element, type, mouseCtor, mouseOptions),
  );
  ["pointerup", "mouseup", "click"].forEach((type) =>
    dispatch(
      element,
      type,
      type.startsWith("pointer") ? pointerCtor : mouseCtor,
      type.startsWith("pointer")
        ? { ...pointerOptions, buttons: 0 }
        : { ...mouseOptions, buttons: 0 },
    ),
  );
}

function dispatchEnterToComposer(doc: Document, composer: HTMLElement): boolean {
  focusComposerForSubmit(composer);
  const nativeSubmitted = sendNativeEnter(doc);
  const domSubmitted = dispatchKeyboardSubmitToComposer(doc, composer, {});
  return nativeSubmitted || domSubmitted;
}

function dispatchModifiedEnterToComposer(
  doc: Document,
  composer: HTMLElement,
  modifier: "ctrl" | "meta",
): boolean {
  return dispatchKeyboardSubmitToComposer(doc, composer, {
    ctrlKey: modifier === "ctrl",
    metaKey: modifier === "meta",
  });
}

function dispatchKeyboardSubmitToComposer(
  doc: Document,
  composer: HTMLElement,
  modifiers: Partial<KeyboardEventInit>,
): boolean {
  const win = doc.defaultView;
  try {
    const targets = Array.from(
      new Set<EventTarget>(
        [composer, doc.activeElement, doc, win].filter(Boolean) as EventTarget[],
      ),
    );
    targets.forEach((target) => {
      ["keydown", "keypress", "keyup"].forEach((type) => {
        target.dispatchEvent(
          new (win?.KeyboardEvent || KeyboardEvent)(type, {
            bubbles: true,
            cancelable: true,
            code: "Enter",
            key: "Enter",
            keyCode: 13,
            shiftKey: false,
            which: 13,
            ...modifiers,
          } as KeyboardEventInit),
        );
      });
    });
    return true;
  } catch {
    return false;
  }
}

function submitNearestComposerForm(composer: HTMLElement): boolean {
  const form = composer.closest("form") as HTMLFormElement | null;
  if (!form) {
    return false;
  }
  try {
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return true;
    }
  } catch {
    // Some chat apps intercept synthetic form submissions.
  }
  try {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;
  } catch {
    return false;
  }
}

function findClickableAncestor(
  element: HTMLElement,
  composer: HTMLElement,
): HTMLElement | null {
  const composerRect = composer.getBoundingClientRect();
  let current = element.parentElement as HTMLElement | null;
  let depth = 0;
  while (current && depth < 4) {
    depth += 1;
    const rect = current.getBoundingClientRect();
    if (
      rect.width >= 18 &&
      rect.height >= 18 &&
      rect.width <= 180 &&
      rect.height <= 180 &&
      rect.bottom >= composerRect.top - 180 &&
      rect.top <= composerRect.bottom + 180 &&
      rect.right >= composerRect.left - 40 &&
      rect.left <= composerRect.right + 220
    ) {
      return current;
    }
    current = current.parentElement as HTMLElement | null;
  }
  return null;
}

function findClickableDescendant(element: HTMLElement): HTMLElement | null {
  const descendants = Array.from(
    element.querySelectorAll(
      "button,[role='button'],svg,[aria-label],[title],[data-testid],[data-test],[data-qa]",
    ),
  ) as HTMLElement[];
  return descendants.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.width >= 12 && rect.height >= 12;
  }) || null;
}

function getComposerText(element: HTMLElement): string {
  if ("value" in element) {
    return String((element as HTMLTextAreaElement | HTMLInputElement).value || "");
  }
  const htmlElement = element as HTMLElement & { innerText?: string };
  return String(htmlElement.innerText || element.textContent || "");
}

function normalizeComposerProbeText(value: string): string {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function createPromptFingerprint(prompt: string): { head: string; tail: string } {
  const normalized = normalizeComposerProbeText(prompt);
  return {
    head: normalized.slice(0, Math.min(96, normalized.length)),
    tail: normalized.slice(Math.max(0, normalized.length - 96)),
  };
}

function textMatchesPromptFingerprint(
  text: string,
  fingerprint: { head: string; tail: string },
): boolean {
  const normalized = normalizeComposerProbeText(text);
  if (!fingerprint.head) {
    return false;
  }
  if (normalized.includes(fingerprint.head)) {
    return true;
  }
  return fingerprint.tail.length >= 24 && normalized.includes(fingerprint.tail);
}

async function waitForPromptSubmitted(
  doc: Document,
  composer: HTMLElement,
  fingerprint: { head: string; tail: string },
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    await sleepInDocument(doc, 90);
    const currentComposer = findWebChatComposer(doc) || composer;
    const composerStillHasPrompt = textMatchesPromptFingerprint(
      getComposerText(currentComposer),
      fingerprint,
    );
    if (!composerStillHasPrompt) {
      return true;
    }
    if (hasWebChatGeneratingIndicator(doc, composer)) {
      return true;
    }
  }
  return false;
}

function hasWebChatGeneratingIndicator(doc: Document, composer: HTMLElement): boolean {
  const composerRect = composer.getBoundingClientRect();
  return queryElementsDeep(
    doc,
    "button,[role='button'],[aria-label],[title],[data-testid],[class]",
  ).some((element) => {
    const rect = element.getBoundingClientRect();
    const label = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-testid"),
      element.getAttribute("class"),
      element.textContent,
    ]
      .join(" ")
      .toLowerCase();
    const nearComposer =
      rect.bottom >= composerRect.top - 220 &&
      rect.top <= composerRect.bottom + 220;
    return (
      nearComposer &&
      /(stop|abort|cancel|generating|responding|loading|\u505c\u6b62|\u4e2d\u6b62|\u53d6\u6d88|\u751f\u6210\u4e2d|\u56de\u7b54\u4e2d)/i.test(
        label,
      )
    );
  });
}

function isVisibleComposerCandidate(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const doc = element.ownerDocument;
  if (!doc) {
    return false;
  }
  const style = doc.defaultView?.getComputedStyle(element);
  return Boolean(
    rect.width >= 120 &&
      rect.height >= 18 &&
      style?.display !== "none" &&
      style?.visibility !== "hidden" &&
      !element.closest("[aria-hidden='true']"),
  );
}

function scoreComposerCandidate(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const tagName = element.tagName.toLowerCase();
  const tagBoost = tagName === "textarea" ? 100000 : tagName === "input" ? 80000 : 0;
  const editableBoost =
    element.isContentEditable || element.getAttribute("contenteditable") === "true"
      ? 50000
      : 0;
  return tagBoost + editableBoost + rect.bottom * 100 + rect.width + rect.height;
}

function writePromptToComposer(element: HTMLElement, prompt: string): void {
  const doc = element.ownerDocument;
  if (!doc) {
    throw new Error("Composer document is unavailable");
  }
  element.focus();
  const tagName = element.tagName.toLowerCase();
  if (tagName === "textarea" || tagName === "input") {
    setNativeInputValue(element as HTMLTextAreaElement | HTMLInputElement, prompt);
  } else {
    const selection = doc.defaultView?.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (!doc.execCommand("insertText", false, prompt)) {
      element.replaceChildren(doc.createTextNode(prompt));
    }
  }
  dispatchComposerEvents(element, prompt);
}

function setNativeInputValue(
  element: HTMLTextAreaElement | HTMLInputElement,
  value: string,
): void {
  const win = element.ownerDocument?.defaultView;
  const tagName = element.tagName.toLowerCase();
  const prototype =
    tagName === "textarea"
      ? (win?.HTMLTextAreaElement || HTMLTextAreaElement).prototype
      : (win?.HTMLInputElement || HTMLInputElement).prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  const previousValue = element.value;
  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
  try {
    const tracker = (
      element as HTMLTextAreaElement & {
        _valueTracker?: { setValue: (value: string) => void };
      }
    )._valueTracker;
    tracker?.setValue(previousValue);
  } catch {
    // React's private value tracker is optional and may not exist.
  }
}

function dispatchComposerEvents(element: HTMLElement, prompt: string): void {
  const doc = element.ownerDocument;
  if (!doc) {
    return;
  }
  const win = doc.defaultView;
  try {
    element.dispatchEvent(
      new (win?.InputEvent || InputEvent)("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: prompt,
        inputType: "insertText",
      }),
    );
  } catch {
    // Older embedded Gecko builds can reject constructed InputEvent objects.
  }
  try {
    element.dispatchEvent(
      new (win?.InputEvent || InputEvent)("input", {
        bubbles: true,
        data: prompt,
        inputType: "insertText",
      }),
    );
  } catch {
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
  element.dispatchEvent(new Event("change", { bubbles: true }));
  try {
    element.dispatchEvent(new Event("compositionend", { bubbles: true }));
  } catch {
    // Some pages do not use composition events.
  }
}

async function waitForPromptHydration(
  doc: Document,
  composer: HTMLElement,
  prompt: string,
): Promise<void> {
  const target = prompt.slice(0, Math.min(prompt.length, 128)).trim();
  for (const delay of [40, 80, 120, 180]) {
    await sleepInDocument(doc, delay);
    const text =
      "value" in composer
        ? String((composer as HTMLTextAreaElement | HTMLInputElement).value || "")
        : String(composer.textContent || "");
    if (!target || text.includes(target)) {
      return;
    }
    dispatchComposerEvents(composer, prompt);
  }
}

function insertPromptIntoDocumentSource(): string {
  return `${findWebChatComposer.toString()}
${isVisibleComposerCandidate.toString()}
${scoreComposerCandidate.toString()}
${writePromptToComposer.toString()}
${setNativeInputValue.toString()}
${dispatchComposerEvents.toString()}
${waitForPromptHydration.toString()}
${sleepInDocument.toString()}
${submitWebChatPrompt.toString()}
${submitComposerWithPasteAndEnter.toString()}
${activateComposerForNativeInput.toString()}
${replaceComposerSelectionWithPrompt.toString()}
${selectComposerContents.toString()}
${attachImagesToWebChatComposer.toString()}
${waitForComposerImageAttachment.toString()}
${hasComposerImageAttachment.toString()}
${getComposerAttachmentWrapper.toString()}
${createFileFromComposerImage.toString()}
${dispatchImagePasteToComposer.toString()}
${pasteNativeClipboardImageToComposer.toString()}
${assignImagesToNearestFileInput.toString()}
${acceptsImageFileInput.toString()}
${ensureComposerContainsPrompt.toString()}
${findWebChatSubmitButtons.toString()}
${queryElementsDeep.toString()}
${isVisibleSubmitCandidate.toString()}
${scoreSubmitCandidate.toString()}
${getSubmitCandidateContainers.toString()}
${focusComposerForSubmit.toString()}
${clickSubmitButton.toString()}
${getElementCenter.toString()}
${getWindowUtils.toString()}
${sendNativeMouseClick.toString()}
${sendNativeEnter.toString()}
${sendNativeShortcut.toString()}
${clickComposerSubmitHotspots.toString()}
${clickViewportSubmitHotspots.toString()}
${invokeFrameworkClickHandlers.toString()}
${dispatchPointerMouseSequence.toString()}
${dispatchEnterToComposer.toString()}
${dispatchModifiedEnterToComposer.toString()}
${dispatchKeyboardSubmitToComposer.toString()}
${submitNearestComposerForm.toString()}
${findClickableAncestor.toString()}
${findClickableDescendant.toString()}
${getComposerText.toString()}
${normalizeComposerProbeText.toString()}
${createPromptFingerprint.toString()}
${textMatchesPromptFingerprint.toString()}
${waitForPromptSubmitted.toString()}
${hasWebChatGeneratingIndicator.toString()}
${insertPromptIntoDocument.toString()}`;
}

function readLatestAssistantTextFromDocumentSource(): string {
  return `${readLatestAssistantPlainTextFromDocument.toString()}
${isAssistantDisclaimerLine.toString()}
${normalizeCapturedText.toString()}
${elementHasMarkdownStructure.toString()}
${serializeElementToMarkdown.toString()}
${markDeepSeekThinkingElements.toString()}
${isDeepSeekDocument.toString()}
${resolveDeepSeekThinkingElement.toString()}
${getDeepSeekExplicitThinkingElements.toString()}
${isDeepSeekExplicitThinkingElement.toString()}
${isDeepSeekThinkingLabel.toString()}
${isDeepSeekThinkingDescriptor.toString()}
${isDeepSeekAnswerDescriptor.toString()}
${hasDeepSeekThinkingContent.toString()}
${isDeepSeekThinkingWrapper.toString()}
${getDeepSeekElementDescriptor.toString()}
${getDeepSeekElementOwnLabel.toString()}
${getElementTextLength.toString()}
${hasMarkedThinkingDescendant.toString()}
${serializeDeepSeekThinkingElement.toString()}
${serializeMarkdownNode.toString()}
${serializeContainerMarkdown.toString()}
${isMarkdownBlockNode.toString()}
${serializeListMarkdown.toString()}
${serializeListItemMarkdown.toString()}
${serializeTableMarkdown.toString()}
${serializeInlineMarkdown.toString()}
${serializeInlineMarkdownNode.toString()}
${serializeImageMarkdown.toString()}
${isRenderableImageURL.toString()}
${escapeMarkdownImageText.toString()}
${escapeMarkdownImageURL.toString()}
${getElementChildNodes.toString()}
${getElementChildren.toString()}
${normalizeInlineMarkdownText.toString()}
${escapeMarkdownTableCell.toString()}
${cleanupSerializedMarkdown.toString()}
${readLatestAssistantTextFromDocument.toString()}`;
}

function openExternalURL(url: string): void {
  try {
    if (typeof Zotero.launchURL === "function") {
      Zotero.launchURL(url);
      return;
    }
  } catch (error) {
    ztoolkit.log("Zotero.launchURL failed:", error);
  }

  const componentClasses = Components.classes as Record<
    string,
    { getService: (interfaceType: unknown) => nsIExternalProtocolService }
  >;
  const externalProtocolService = componentClasses[
    "@mozilla.org/uriloader/external-protocol-service;1"
  ].getService(Components.interfaces.nsIExternalProtocolService);
  externalProtocolService.loadURI(Services.io.newURI(url));
}

// A cookie cannot prove a session is still valid, only that one existed. Two
// filters keep the guess useful: auth cookies are Secure or HttpOnly (analytics
// cookies are typically neither), and an expired cookie means a stale sign-in.
// The base domain is checked too because Google keeps Gemini's auth cookies on
// google.com rather than gemini.google.com.
function openLoginWindow(hostWindow: Window, service: WebAIService): void {
  const features =
    "chrome,centerscreen,resizable,scrollbars,width=1120,height=840";
  const name = `zotero-webai-${service.id}-login`;

  try {
    const opened = hostWindow.open(service.url, name, features);
    if (opened) {
      opened.focus?.();
      return;
    }
  } catch (error) {
    ztoolkit.log("window.open login window failed:", error);
  }

  try {
    const componentClasses = Components.classes as Record<
      string,
      { getService: (interfaceType: unknown) => { openWindow?: (...args: unknown[]) => Window | null } }
    >;
    const windowWatcher = componentClasses[
      "@mozilla.org/embedcomp/window-watcher;1"
    ].getService(Components.interfaces.nsIWindowWatcher);
    const opened = windowWatcher.openWindow?.(
      hostWindow,
      service.url,
      name,
      features,
      null,
    );
    if (opened) {
      opened.focus?.();
      return;
    }
  } catch (error) {
    ztoolkit.log("window watcher login window failed:", error);
  }

  openExternalURL(service.url);
}

async function extractMCPBridgeRequestsFromWebChat(
  frame: Element | null,
  activeTokens: Set<string>,
): Promise<MCPBridgeRequest[]> {
  if (!activeTokens.size) {
    return [];
  }

  const result = await readWebChatText(frame);
  if (!result.ok || !result.text) {
    return [];
  }

  return parseMCPBridgeRequests(result.text, activeTokens);
}

function parseMCPBridgeRequests(
  text: string,
  activeTokens: Set<string>,
): MCPBridgeRequest[] {
  const requests: MCPBridgeRequest[] = [];
  const markerPattern =
    /ZOTERO_WEBAI_MCP_REQUEST\s*([\s\S]*?)\s*END_ZOTERO_WEBAI_MCP_REQUEST/g;
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(text)) !== null) {
    const rawPayload = stripMarkdownCodeFence(match[1] || "");
    const parsed = parseMCPBridgePayload(rawPayload, activeTokens, match[0]);
    if (parsed) {
      requests.push(parsed);
    }
  }
  return requests;
}

function stripMarkdownCodeFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseMCPBridgePayload(
  value: string,
  activeTokens: Set<string>,
  raw: string,
): MCPBridgeRequest | null {
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    record = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const token = String(record.token || "").trim();
  if (!activeTokens.has(token)) {
    return null;
  }

  const toolName = String(record.tool || record.toolName || record.name || "").trim();
  if (!toolName) {
    return null;
  }

  const argsRecord =
    record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
      ? (record.arguments as Record<string, unknown>)
      : {};
  const requestId =
    String(record.id || "").trim() || `${token}:${toolName}:${stableHash(JSON.stringify(argsRecord))}`;

  return {
    arguments: argsRecord,
    id: requestId,
    raw,
    toolName,
  };
}

async function runMCPBridgeRequest({
  appendExecutionRecord,
  request,
  serviceLabel,
  settings,
  setStatus,
}: {
  appendExecutionRecord: (draft: WebAIExecutionRecordDraft) => string;
  request: MCPBridgeRequest;
  serviceLabel: string;
  settings: Settings;
  setStatus: (status: string) => void;
}): Promise<void> {
  try {
    setStatus(`Running Zotero MCP tool ${request.toolName}...`);
    const detailed = await callMCPToolDetailed(
      settings,
      request.toolName,
      request.arguments,
    );
    const body = formatMCPBridgeResultRecordBody(request, detailed);
    appendExecutionRecord({
      body,
      kind: "mcp",
      sourcePrompt: request.raw,
      status: "done",
      subtitle: `/${ZOTERO_MCP_COMMAND.slashCommand} ${request.toolName}`,
      title: `Zotero MCP result: ${request.toolName}`,
    });
    setStatus(`MCP ${request.toolName} result added to Paperly AI conversation.`);
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : String(error);
    const body = [
      "MCP tool error:",
      `Tool: ${request.toolName}`,
      `Arguments: ${safeJSONStringify(request.arguments)}`,
      `Error: ${message}`,
    ].join("\n");
    appendExecutionRecord({
      body,
      kind: "mcp",
      sourcePrompt: request.raw,
      status: "error",
      subtitle: `/${ZOTERO_MCP_COMMAND.slashCommand} ${request.toolName}`,
      title: `Zotero MCP error: ${request.toolName}`,
    });
    setStatus(`MCP ${request.toolName} failed; error added to conversation.`);
  }
}

function formatMCPBridgeResultRecordBody(
  request: MCPBridgeRequest,
  result: MCPToolDetailedResult,
): string {
  const resultText =
    formatMCPDisplayContext(result.results, {
      toolName: result.toolName || request.toolName,
      usedFallback: false,
    }) ||
    truncateText(result.text || safeJSONStringify(result.raw), MCP_CONTEXT_TEXT_LIMIT) ||
    "MCP tool returned no structured or text content.";
  return [
    "MCP tool result:",
    `Tool: ${request.toolName}`,
    `Arguments: ${safeJSONStringify(request.arguments)}`,
    "",
    resultText,
  ].join("\n");
}

function formatLatestMCPExecutionContext(
  records: WebAIExecutionRecord[],
): string {
  const latest = records.find(
    (record) =>
      !record.hidden &&
      record.kind === "mcp" &&
      (record.status === "done" || record.status === "error") &&
      record.body.trim(),
  );
  if (!latest) {
    return "";
  }
  return truncateText(
    [
      "Latest Zotero MCP execution result:",
      "This is the most recent MCP tool output from the Paperly AI conversation. Use it as prior local Zotero context when it is relevant to the next answer.",
      `Status: ${latest.status}`,
      latest.subtitle ? `Source: ${latest.subtitle}` : "",
      "",
      latest.body,
    ]
      .filter(Boolean)
      .join("\n"),
    MCP_CONTEXT_TEXT_LIMIT,
  );
}

function createMCPBridgeToken(): string {
  return `zotero-webai-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

async function fetchMCPContextForConversation(
  settings: Settings,
  {
    mcpBridgeToken,
    setStatus,
  }: {
    mcpBridgeToken: string;
    setStatus: (status: string) => void;
  },
): Promise<MCPPromptContextResult> {
  if (!shouldUseMCPInConversation(settings)) {
    return {
      contextText: "",
      status: "MCP endpoint is not configured.",
    };
  }

  try {
    setStatus("Loading zotero-mcp tools for this / command...");
    const tools = await listMCPTools(settings);
    const planningContext = buildMCPPlanningContext(tools, mcpBridgeToken);
    return {
      contextText: planningContext,
      status: tools.length
        ? `MCP tool schema loaded (${tools.length} tools).`
        : "MCP returned no tool schema.",
    };
  } catch (error) {
    ztoolkit.log("MCP tool schema unavailable for Web AI prompt:", error);
    return {
      contextText: "",
      status: "MCP unavailable; check that zotero-mcp is running.",
    };
  }
}

function shouldUseMCPInConversation(settings: Settings): boolean {
  return Boolean(settings.mcpEndpoint?.trim());
}

function buildMCPPlanningContext(
  tools: MCPToolSummary[],
  mcpBridgeToken: string,
): string {
  const catalog = formatMCPToolCatalog(tools);
  return [
    "Zotero MCP bridge:",
    "The user explicitly selected /zotero-mcp. Paperly AI can run local zotero-mcp tools for this conversation; decide whether a tool is needed and choose schema-valid arguments.",
    "If Zotero MCP is needed, do not invent the tool result. Reply only with an MCP request block using the markers named below. Paperly AI will execute it and show each tool result in the Paperly AI Conversation panel below the web page.",
    "Start marker: ZOTERO_WEBAI_MCP_REQUEST",
    "End marker: END_ZOTERO_WEBAI_MCP_REQUEST",
    `Required JSON fields inside the block: {"token":"${mcpBridgeToken}","id":"short-unique-id","tool":"tool_name","arguments":{...}}`,
    "Use the inputSchema for each tool to decide parameter names and values. Prefer complete/standard modes and limit 1000 when available. For Zotero library search, prefer search_library with {q, limit:1000, mode:\"complete\", relevanceScoring:true, sort:\"relevance\"}; then use itemKey/key with get_item_details or get_content when the user needs abstracts, notes, attachments, or full text. Keep write tools for explicit user requests that modify Zotero notes, tags, metadata, or items.",
    catalog,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatMCPToolCatalog(tools: MCPToolSummary[]): string {
  if (!tools.length) {
    return "Available Zotero MCP tools: none returned by tools/list.";
  }

  const render = (schemaLimit: number) =>
    [
      `Available Zotero MCP tools (${tools.length}):`,
      ...tools.map((tool) => {
        const lines = [`- ${tool.name}`];
        if (tool.description?.trim()) {
          lines.push(`  description: ${tool.description.trim()}`);
        }
        if (tool.inputSchema) {
          lines.push(
            `  inputSchema: ${truncateText(safeJSONStringify(tool.inputSchema), schemaLimit)}`,
          );
        }
        return lines.join("\n");
      }),
    ].join("\n");

  const fullCatalog = render(MCP_SCHEMA_TEXT_LIMIT);
  return fullCatalog.length <= MCP_TOOL_CATALOG_TEXT_LIMIT
    ? fullCatalog
    : render(900);
}

function formatMCPPromptContext(
  results: MCPToolResultItem[],
  outcome?: Pick<MCPToolDetailedCallOutcome, "toolName" | "usedFallback">,
): string {
  const formattedItems = results
    .map((result, index) => formatMCPPromptItem(result, index))
    .filter(Boolean);
  if (!formattedItems.length) {
    return "";
  }
  return truncateText(
    [
      "MCP context:",
      outcome?.toolName ? `Tool used: ${outcome.toolName}` : "",
      outcome?.usedFallback ? "The configured MCP tool failed, so Paperly AI selected this read-only fallback tool from tools/list." : "",
      "Use the following MCP tool output as external/local Zotero context for this conversation. Separate MCP evidence from paper evidence, and mention uncertainty when the MCP output is incomplete.",
      ...formattedItems,
    ].join("\n\n"),
    MCP_CONTEXT_TEXT_LIMIT,
  );
}

function formatMCPDisplayContext(
  results: MCPToolResultItem[],
  outcome?: Pick<MCPToolDetailedCallOutcome, "toolName" | "usedFallback">,
): string {
  const formattedItems = results
    .map((result, index) => formatMCPPromptItem(result, index))
    .filter(Boolean);
  if (!formattedItems.length) {
    return "";
  }
  return truncateText(
    [
      outcome?.toolName ? `Tool used: ${outcome.toolName}` : "",
      outcome?.usedFallback ? "Mode: automatic fallback" : "",
      ...formattedItems,
    ].join("\n\n"),
    MCP_CONTEXT_TEXT_LIMIT,
  );
}

function formatMCPPromptItem(
  result: MCPToolResultItem,
  index: number,
): string {
  const headerParts = [
    `${index + 1}. ${result.title?.trim() || "MCP result"}`,
    result.key?.trim() ? `{key: ${result.key.trim()}}` : "",
    result.year?.trim() ? `(${result.year.trim()})` : "",
    result.source?.trim() ? `[${result.source.trim()}]` : "",
  ].filter(Boolean);
  const lines = [headerParts.join(" ")];
  if (result.url?.trim()) {
    lines.push(`URL: ${result.url.trim()}`);
  }
  const content = truncateText(result.content || "", MCP_ITEM_TEXT_LIMIT);
  if (content) {
    lines.push(content);
  }
  return lines.join("\n").trim();
}

function buildWorkspacePrompt({
  contextSummary,
  includeFullText,
  mcpContext,
  message,
  scope,
  selectedSkill,
  webContext,
}: {
  contextSummary: AssembledContext | null;
  includeFullText: boolean;
  mcpContext: string;
  message: string;
  scope: ScopeContext | null;
  selectedSkill: WebAISkill | null;
  webContext: string;
}): string {
  const instruction = message.trim();
  if (!selectedSkill && !instruction) {
    throw new Error("Write a message or choose a custom skill with /.");
  }

  const title = scope?.label || "Current Zotero context";
  const metadata = contextSummary?.metadata || "";
  const selectedText =
    scope?.selectedText?.trim() || contextSummary?.selectedText?.trim() || "";
  const fullText = includeFullText
    ? truncateText(contextSummary?.fullText || "", PROMPT_TEXT_LIMIT)
    : "";
  const commandInstruction = formatCommandPromptInstruction(
    selectedSkill,
    includeFullText,
  );
  const fallbackInstruction =
    !instruction && selectedSkill?.kind === "pdf"
      ? "Summarize the current PDF, extract the key findings, methods, limitations, and useful notes for Zotero."
      : !instruction && selectedSkill?.kind === "web"
        ? "Use the web search context to answer with concise citations."
        : "";
  const parts = [
    FINAL_ANSWER_FORMAT_INSTRUCTION,
    commandInstruction,
    instruction || fallbackInstruction
      ? `User message:\n${instruction || fallbackInstruction}`
      : "",
    `Zotero context:\n${title}`,
    metadata ? `Metadata:\n${metadata}` : "",
    selectedText ? `Selected passage:\n${selectedText}` : "",
    fullText ? `Paper content:\n${fullText}` : "",
    webContext,
    mcpContext,
  ];

  if (
    includeFullText &&
    contextSummary?.fullText &&
    contextSummary.fullText.length > fullText.length
  ) {
    parts.push(
      "Note: the paper text was truncated by Paperly AI; continue from the available excerpt first.",
    );
  }

  return parts.filter(Boolean).join("\n\n");
}

function formatCommandPromptInstruction(
  selectedSkill: WebAISkill | null,
  includeFullText: boolean,
): string {
  if (!selectedSkill) {
    return "";
  }
  if (selectedSkill.kind === "skill") {
    return `Skill: ${selectedSkill.label}\n${selectedSkill.promptPrefix}`;
  }
  if (selectedSkill.kind === "pdf") {
    return [
      `Command: /${selectedSkill.slashCommand}`,
      includeFullText
        ? "The user explicitly attached the current Zotero PDF or item full text. Treat the Paper content section as the primary source."
        : "The user selected the PDF command, but no full text was attached.",
    ].join("\n");
  }
  if (selectedSkill.kind === "web") {
    return [
      `Command: /${selectedSkill.slashCommand}`,
      "The user explicitly requested built-in web search. Use the Web search context below when it is available, cite URLs when relying on it, and separate web context from Zotero context.",
    ].join("\n");
  }
  if (selectedSkill.kind === "mcp") {
    return `Command: /${selectedSkill.slashCommand}\nUse zotero-mcp only when a real local Zotero tool result is needed. If a tool is needed, request it through the MCP bridge instructions below.`;
  }
  return "";
}

function createExecutionRecord(
  draft: WebAIExecutionRecordDraft,
): WebAIExecutionRecord {
  return {
    ...draft,
    createdAt: new Date().toISOString(),
    id: `exec-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
  };
}

function createSessionID(): string {
  return `session-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function createTurnID(): string {
  return `turn-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function createChatSession({
  records,
  serviceID,
  serviceLabel,
}: {
  records: WebAIExecutionRecord[];
  serviceID: WebAIServiceId;
  serviceLabel: string;
}): WebAIChatSession {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    id: createSessionID(),
    records: clampSessionRecords(records),
    serviceID,
    serviceLabel,
    title: buildSessionTitle(records, serviceLabel),
    updatedAt: now,
  };
}

function loadChatSessions(): WebAIChatSession[] {
  const value = getPref(SESSION_HISTORY_PREF);
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return clampChatSessions(
      parsed.map(normalizeChatSession).filter(isChatSession),
    );
  } catch (error) {
    ztoolkit.log("Failed to load Paperly AI chat sessions:", error);
    return [];
  }
}

function saveChatSessions(sessions: WebAIChatSession[]): WebAIChatSession[] {
  const normalized = clampChatSessions(sessions);
  try {
    setPref(SESSION_HISTORY_PREF, JSON.stringify(normalized));
  } catch (error) {
    ztoolkit.log("Failed to save Paperly AI chat sessions:", error);
  }
  return normalized;
}

function normalizeChatSession(value: unknown): WebAIChatSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value as Partial<WebAIChatSession>;
  const records = clampSessionRecords(
    Array.isArray(source.records)
      ? source.records.map(normalizeExecutionRecord).filter(isExecutionRecord)
      : [],
  );
  const now = new Date().toISOString();
  const serviceID: WebAIServiceId = isKnownServiceID(source.serviceID)
    ? source.serviceID
    : DEFAULT_SERVICE_ID;
  const serviceLabel =
    typeof source.serviceLabel === "string" && source.serviceLabel.trim()
      ? source.serviceLabel.trim()
      : getServiceByID(serviceID).label;
  return {
    createdAt:
      typeof source.createdAt === "string" && source.createdAt
        ? source.createdAt
        : records.at(-1)?.createdAt || now,
    id:
      typeof source.id === "string" && source.id.trim()
        ? source.id.trim()
        : createSessionID(),
    records,
    serviceID,
    serviceLabel,
    title:
      typeof source.title === "string" && source.title.trim()
        ? source.title.trim()
        : buildSessionTitle(records, serviceLabel),
    updatedAt:
      typeof source.updatedAt === "string" && source.updatedAt
        ? source.updatedAt
        : records[0]?.createdAt || now,
  };
}

function isChatSession(
  session: WebAIChatSession | null,
): session is WebAIChatSession {
  return Boolean(session);
}

function normalizeExecutionRecord(value: unknown): WebAIExecutionRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value as Partial<WebAIExecutionRecord>;
  if (typeof source.body !== "string" || typeof source.title !== "string") {
    return null;
  }
  const kind: WebAIExecutionKind =
    source.kind === "assistant" ||
    source.kind === "mcp" ||
    source.kind === "pdf" ||
    source.kind === "skill" ||
    source.kind === "web" ||
    source.kind === "error"
      ? source.kind
      : "assistant";
  const status: WebAIExecutionRecord["status"] =
    source.status === "running" ||
    source.status === "error" ||
    source.status === "done"
      ? source.status
      : "done";
  return {
    body: source.body,
    createdAt:
      typeof source.createdAt === "string" && source.createdAt
        ? source.createdAt
        : new Date().toISOString(),
    hidden: Boolean(source.hidden),
    id:
      typeof source.id === "string" && source.id.trim()
        ? source.id.trim()
        : `exec-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,
    kind,
    sourcePrompt:
      typeof source.sourcePrompt === "string" ? source.sourcePrompt : undefined,
    status,
    subtitle: typeof source.subtitle === "string" ? source.subtitle : undefined,
    thinking: typeof source.thinking === "string" ? source.thinking : undefined,
    title: source.title,
    turnID: typeof source.turnID === "string" ? source.turnID : undefined,
    userPrompt:
      typeof source.userPrompt === "string" ? source.userPrompt : undefined,
  };
}

function isExecutionRecord(
  record: WebAIExecutionRecord | null,
): record is WebAIExecutionRecord {
  return Boolean(record);
}

function updateChatSessionsWithRecord(
  sessions: WebAIChatSession[],
  {
    record,
    serviceID,
    serviceLabel,
    sessionID,
  }: {
    record: WebAIExecutionRecord;
    serviceID: WebAIServiceId;
    serviceLabel: string;
    sessionID: string;
  },
): WebAIChatSession[] {
  const index = sessions.findIndex((session) => session.id === sessionID);
  if (index < 0) {
    const session = createChatSession({
      records: [record],
      serviceID,
      serviceLabel,
    });
    return [{ ...session, id: sessionID }, ...sessions];
  }

  const existing = sessions[index];
  const records = clampSessionRecords([record, ...existing.records]);
  const updated: WebAIChatSession = {
    ...existing,
    records,
    serviceID,
    serviceLabel,
    title: buildSessionTitle(records, serviceLabel),
    updatedAt: record.createdAt,
  };
  return [updated, ...sessions.filter((session) => session.id !== sessionID)];
}

function updateChatSessionsRecords(
  sessions: WebAIChatSession[],
  {
    records,
    serviceID,
    serviceLabel,
    sessionID,
  }: {
    records: WebAIExecutionRecord[];
    serviceID: WebAIServiceId;
    serviceLabel: string;
    sessionID: string;
  },
): WebAIChatSession[] {
  const normalizedRecords = clampSessionRecords(records);
  const now = new Date().toISOString();
  const index = sessions.findIndex((session) => session.id === sessionID);
  if (index < 0) {
    const session = createChatSession({
      records: normalizedRecords,
      serviceID,
      serviceLabel,
    });
    return [{ ...session, id: sessionID }, ...sessions];
  }

  const existing = sessions[index];
  const updated: WebAIChatSession = {
    ...existing,
    records: normalizedRecords,
    serviceID,
    serviceLabel,
    title: buildSessionTitle(normalizedRecords, serviceLabel),
    updatedAt: normalizedRecords[0]?.createdAt || now,
  };
  return [updated, ...sessions.filter((session) => session.id !== sessionID)];
}

function getCurrentExportSession({
  activeSessionID,
  executionRecords,
  serviceID,
  serviceLabel,
}: {
  activeSessionID: string | null;
  executionRecords: WebAIExecutionRecord[];
  serviceID: WebAIServiceId;
  serviceLabel: string;
}): WebAIChatSession | null {
  const records = clampSessionRecords(executionRecords);
  if (!records.length && !activeSessionID) {
    return null;
  }
  const session = createChatSession({
    records,
    serviceID,
    serviceLabel,
  });
  return activeSessionID ? { ...session, id: activeSessionID } : session;
}

function buildSessionsExportMarkdown(sessions: WebAIChatSession[]): string {
  const exportTime = new Date().toISOString();
  const orderedSessions = [...sessions].sort(
    (left, right) =>
      Date.parse(left.createdAt || "") - Date.parse(right.createdAt || ""),
  );
  return [
    "# Paperly AI Conversation Export",
    "",
    `Exported: ${exportTime}`,
    `Sessions: ${orderedSessions.length}`,
    "",
    ...orderedSessions.map(formatSessionExportMarkdown),
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function formatSessionExportMarkdown(session: WebAIChatSession): string {
  const records = [...session.records]
    .filter((record) => record.body.trim() || formatRecordSourceForChat(record))
    .reverse();
  return [
    `## ${escapeMarkdownHeadingText(session.title || session.serviceLabel)}`,
    "",
    `- Service: ${session.serviceLabel}`,
    `- Created: ${formatRecordTimestamp(session.createdAt)}`,
    `- Updated: ${formatRecordTimestamp(session.updatedAt)}`,
    "",
    ...records.map(formatRecordExportMarkdown),
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function formatRecordExportMarkdown(record: WebAIExecutionRecord): string {
  const prompt = formatRecordSourceForChat(record);
  const body = formatMarkdownForDisplay(record.body);
  const parts = [
    `### ${escapeMarkdownHeadingText(record.title)}`,
    "",
    `- Type: ${getRecordKindLabel(record.kind)}`,
    record.subtitle ? `- Context: ${record.subtitle}` : "",
    `- Status: ${record.status}`,
    `- Time: ${formatRecordTimestamp(record.createdAt)}`,
    record.hidden ? "- Visibility: internal context" : "",
    "",
    prompt ? `**User**\n\n${prompt}` : "",
    body ? `**Result**\n\n${body}` : "",
    record.thinking
      ? [
          "<details>",
          "<summary>Process / Thinking</summary>",
          "",
          formatMarkdownForDisplay(record.thinking),
          "",
          "</details>",
        ].join("\n")
      : "",
    "",
  ];
  return parts.filter((part) => part !== "").join("\n");
}

function escapeMarkdownHeadingText(value: string): string {
  return normalizeWhitespace(value || "Untitled")
    .replace(/^#+\s*/, "")
    .replace(/\s+#*$/, "")
    .trim() || "Untitled";
}

function buildConversationExportFileName(scope: SessionSlashScope): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rawName = `Paperly-AI-${scope}-${stamp}.md`;
  try {
    return Zotero.File.getValidFileName(rawName);
  } catch {
    return rawName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
  }
}

async function exportMarkdownWithPicker({
  hostWindow,
  markdown,
  suggestedName,
}: {
  hostWindow: Window;
  markdown: string;
  suggestedName: string;
}): Promise<MarkdownExportResult> {
  try {
    const target = await chooseMarkdownExportFile(hostWindow, suggestedName);
    if (!target) {
      return { status: "cancelled" };
    }
    await Zotero.File.putContentsAsync(target, markdown, "utf-8");
    return {
      status: "saved",
      target: getFileDisplayPath(target) || suggestedName,
    };
  } catch (error) {
    ztoolkit.log("Paperly AI Markdown export fell back to clipboard:", error);
    copyTextToClipboard(markdown);
    return { status: "copied" };
  }
}

function chooseMarkdownExportFile(
  hostWindow: Window,
  suggestedName: string,
): Promise<nsIFile | null> {
  const browsingContext = (hostWindow as Window & {
    browsingContext?: BrowsingContext;
  }).browsingContext;
  if (!browsingContext) {
    throw new Error("No browsing context is available for file export");
  }
  const componentClasses = Components.classes as Record<
    string,
    { createInstance: (interfaceType: unknown) => nsIFilePicker }
  >;
  const picker = componentClasses[
    "@mozilla.org/filepicker;1"
  ].createInstance(Components.interfaces.nsIFilePicker);
  const modeSave = (picker.modeSave ?? 1) as nsIFilePicker.Mode;
  const returnOK = (picker.returnOK ?? 0) as nsIFilePicker.ResultCode;
  const returnReplace = (picker.returnReplace ?? 2) as nsIFilePicker.ResultCode;
  picker.init(
    browsingContext,
    "Export Paperly AI conversation",
    modeSave,
  );
  picker.defaultString = suggestedName;
  picker.defaultExtension = "md";
  picker.appendFilter("Markdown", "*.md");
  if (picker.filterAll) {
    picker.appendFilters(picker.filterAll);
  }
  return new Promise((resolve) => {
    picker.open({
      done(result) {
        if (result === returnOK || result === returnReplace) {
          resolve(picker.file);
          return;
        }
        resolve(null);
      },
    });
  });
}

function getFileDisplayPath(file: nsIFile): string {
  return (file as nsIFile & { path?: string }).path || file.leafName || "";
}

function clampChatSessions(sessions: WebAIChatSession[]): WebAIChatSession[] {
  const seen = new Set<string>();
  return sessions
    .filter((session) => {
      if (!session.id || seen.has(session.id)) {
        return false;
      }
      seen.add(session.id);
      return true;
    })
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""),
    )
    .slice(0, SESSION_HISTORY_LIMIT);
}

function clampSessionRecords(
  records: WebAIExecutionRecord[],
): WebAIExecutionRecord[] {
  return records.slice(0, SESSION_RECORD_LIMIT);
}

function buildTranscriptTurns(
  records: WebAIExecutionRecord[],
): WebAITranscriptTurn[] {
  const turns: WebAITranscriptTurn[] = [];
  const turnByID = new Map<string, WebAITranscriptTurn>();
  for (const record of [...records].reverse()) {
    const turnID = getRecordTurnKey(record);
    const existing = turnByID.get(turnID);
    if (existing) {
      existing.records.push(record);
      continue;
    }
    const turn = {
      id: turnID,
      records: [record],
    };
    turnByID.set(turnID, turn);
    turns.push(turn);
  }
  return turns;
}

function getRecordTurnKey(record: WebAIExecutionRecord): string {
  if (record.turnID?.trim()) {
    return record.turnID.trim();
  }
  const prompt = formatRecordSourceForChat(record);
  return prompt
    ? `prompt-${stableHash(prompt)}`
    : `record-${record.id || stableHash(record.title + record.createdAt)}`;
}

function clampVersionIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  if (!Number.isFinite(index)) {
    return length - 1;
  }
  return Math.max(0, Math.min(length - 1, index));
}

function buildSessionTitle(
  records: WebAIExecutionRecord[],
  serviceLabel: string,
): string {
  const visibleRecord = records.find((record) => !record.hidden);
  const source =
    visibleRecord?.sourcePrompt &&
    (extractPromptSection(visibleRecord.sourcePrompt, "User message") ||
      (!hasPromptSections(visibleRecord.sourcePrompt)
        ? visibleRecord.sourcePrompt
        : ""));
  const titleSource = normalizeCapturedText(source || visibleRecord?.title || "");
  if (titleSource) {
    return truncateTextForDisplay(titleSource, 64).replace(/\n+/g, " ");
  }
  return `${serviceLabel} session`;
}

function formatRecordSourceForChat(record: WebAIExecutionRecord): string {
  const explicitPrompt = normalizeCapturedText(record.userPrompt || "");
  if (explicitPrompt) {
    return truncateTextForDisplay(explicitPrompt, 1200);
  }

  const source = normalizeCapturedText(record.sourcePrompt || "");
  if (!source) {
    return "";
  }
  if (record.kind === "mcp" && /ZOTERO_WEBAI_MCP_REQUEST/i.test(source)) {
    return "";
  }

  const command = extractPromptLine(source, "Command");
  const userMessage =
    extractPromptSection(source, "User message") ||
    (!hasPromptSections(source) ? source : "");
  const compactMessage = truncateTextForDisplay(userMessage, 1200);

  if (command) {
    return compactMessage ? `${command}\n\n${compactMessage}` : command;
  }
  if (record.kind === "web" && compactMessage) {
    return `/${WEB_SEARCH_COMMAND.slashCommand} ${compactMessage}`;
  }
  if (record.kind === "mcp" && compactMessage) {
    return `/${ZOTERO_MCP_COMMAND.slashCommand} ${compactMessage}`;
  }
  if (record.kind === "pdf" && compactMessage) {
    return `/${CURRENT_PDF_COMMAND.slashCommand} ${compactMessage}`;
  }
  return compactMessage;
}

function shouldCreatePendingReplyRecord(prompt: string): boolean {
  const text = normalizeCapturedText(prompt);
  if (!text) {
    return false;
  }
  return !/Paperly AI MCP tool (result|error):/i.test(text);
}

function formatPendingReplyBody(
  result: PromptInsertResult,
  serviceLabel: string,
  promptLength: number,
  text: WebAIStrings,
): string {
  if (result.ok && result.submitted) {
    return text.status.promptSent("", serviceLabel);
  }
  if (result.ok) {
    return text.status.promptInserted("", serviceLabel);
  }
  return text.status.promptCopied("", promptLength, serviceLabel);
}

function formatPendingCaptureNeededBody(text: WebAIStrings): string {
  return text === ZH_STRINGS
    ? "提示词已发送到网页对话。Paperly AI 未能自动捕获回复，请切换到网页视图查看。"
    : "Prompt sent to the web chat. Paperly AI could not capture the answer automatically \u2014 read it in the web view.";
}

function formatStatusPrefix(prefix?: string | null): string {
  return prefix ? `${prefix} ` : "";
}

function getRecordKindLabel(kind: WebAIExecutionKind): string {
  if (kind === "assistant") {
    return "AI";
  }
  if (kind === "mcp") {
    return "MCP";
  }
  if (kind === "pdf") {
    return "PDF";
  }
  if (kind === "skill") {
    return "Skill";
  }
  if (kind === "web") {
    return "Web";
  }
  return "Error";
}

function getRecordBubbleBackground(
  kind: WebAIExecutionKind,
  theme: SidebarTheme,
): string {
  if (kind === "error") {
    return theme.errorBackground;
  }
  if (kind === "web") {
    return theme.noticeBackground;
  }
  if (kind === "mcp") {
    return theme.accentBackground;
  }
  return theme.assistantMessageBackground;
}

function getRecordBubbleBorder(
  kind: WebAIExecutionKind,
  theme: SidebarTheme,
): string {
  if (kind === "error") {
    return theme.errorBorder;
  }
  if (kind === "web") {
    return theme.noticeBorder;
  }
  if (kind === "mcp") {
    return theme.accentBorder;
  }
  return theme.assistantMessageBorder;
}

function getRecordBadgeBackground(
  kind: WebAIExecutionKind,
  theme: SidebarTheme,
): string {
  if (kind === "error") {
    return theme.errorBackground;
  }
  if (kind === "web") {
    return theme.noticeBackground;
  }
  if (kind === "mcp") {
    return theme.accentBackground;
  }
  return theme.badgeBackground;
}

function getRecordBadgeBorder(
  kind: WebAIExecutionKind,
  theme: SidebarTheme,
): string {
  if (kind === "error") {
    return theme.errorBorder;
  }
  if (kind === "web") {
    return theme.noticeBorder;
  }
  if (kind === "mcp") {
    return theme.accentBorder;
  }
  return theme.badgeBorder;
}

function getRecordBadgeText(
  kind: WebAIExecutionKind,
  theme: SidebarTheme,
): string {
  if (kind === "error") {
    return theme.errorText;
  }
  if (kind === "web") {
    return theme.noticeText;
  }
  if (kind === "mcp") {
    return theme.accentText;
  }
  return theme.badgeText;
}

function extractPromptLine(text: string, label: string): string {
  const match = text.match(new RegExp(`(?:^|\\n)${escapeRegExp(label)}:\\s*(.+)`));
  return match?.[1]?.trim() || "";
}

function extractPromptSection(text: string, label: string): string {
  const sectionNames = [
    "Command",
    "User message",
    "Zotero context",
    "Metadata",
    "Selected passage",
    "Paper content",
    "Web search context",
    "MCP context",
    "Zotero MCP bridge",
    "Note",
  ];
  const nextSectionPattern = sectionNames
    .filter((name) => name !== label)
    .map(escapeRegExp)
    .join("|");
  const pattern = new RegExp(
    `(?:^|\\n)${escapeRegExp(label)}:\\s*\\n?([\\s\\S]*?)(?=\\n(?:${nextSectionPattern}):|$)`,
  );
  return pattern.exec(text)?.[1]?.trim() || "";
}

function hasPromptSections(text: string): boolean {
  return /(^|\n)(Command|User message|Zotero context|Metadata|Selected passage|Paper content|Web search context|MCP context|Zotero MCP bridge):/i.test(
    text,
  );
}

function truncateTextForDisplay(text: string, limit: number): string {
  const normalized = normalizeCapturedText(text);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit).trim()}\n\n[Hidden long context]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatSkillExecutionBody({
  contextSummary,
  message,
  scope,
  skill,
}: {
  contextSummary: AssembledContext | null;
  message: string;
  scope: ScopeContext | null;
  skill: WebAISkill;
}): string {
  const selectedText =
    scope?.selectedText?.trim() || contextSummary?.selectedText?.trim() || "";
  return [
    `Skill: ${skill.label}`,
    `Command: /${skill.slashCommand}`,
    "",
    "Skill instruction:",
    skill.promptPrefix,
    message.trim() ? `\nUser message:\n${message.trim()}` : "",
    scope?.label ? `\nZotero context:\n${scope.label}` : "",
    contextSummary?.metadata ? `\nMetadata:\n${contextSummary.metadata}` : "",
    selectedText ? `\nSelected passage:\n${truncateText(selectedText, 2400)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSkillReplyRecordOptions(
  skill: WebAISkill,
  serviceLabel: string,
  text: WebAIStrings,
): AssistantReplyRecordOptions {
  return {
    kind: "skill",
    subtitle: `/${skill.slashCommand} via ${serviceLabel}`,
    title: text.record.skillResult(skill.label),
  };
}

function buildCommandReplyRecordOptions(
  skill: WebAISkill | null,
  serviceLabel: string,
  text: WebAIStrings,
): AssistantReplyRecordOptions {
  if (!skill) {
    return {};
  }
  if (skill.kind === "skill") {
    return buildSkillReplyRecordOptions(skill, serviceLabel, text);
  }
  if (skill.kind === "mcp") {
    return buildMCPReplyRecordOptions(serviceLabel, text);
  }
  if (skill.kind === "pdf") {
    return buildPDFReplyRecordOptions(serviceLabel, text);
  }
  if (skill.kind === "web") {
    return {
      kind: "assistant",
      subtitle: `/${WEB_SEARCH_COMMAND.slashCommand} via ${serviceLabel}`,
      title: text.record.webSearchAnswer,
    };
  }
  return {};
}

function buildPDFReplyRecordOptions(
  serviceLabel: string,
  text: WebAIStrings,
): AssistantReplyRecordOptions {
  return {
    kind: "pdf",
    subtitle: `/${CURRENT_PDF_COMMAND.slashCommand} via ${serviceLabel}`,
    title: text.record.pdfAssistedAnswer,
  };
}

function buildMCPReplyRecordOptions(
  serviceLabel: string,
  text: WebAIStrings,
): AssistantReplyRecordOptions {
  return {
    kind: "mcp",
    subtitle: `/${ZOTERO_MCP_COMMAND.slashCommand} via ${serviceLabel}`,
    title: text.record.mcpAssistedAnswer,
  };
}

function formatMCPCommandExecutionBody({
  message,
  status,
}: {
  message: string;
  status: string | null;
}): string {
  return [
    `Command: /${ZOTERO_MCP_COMMAND.slashCommand}`,
    status ? `Status: ${status}` : "",
    "",
    message.trim() ? `User message:\n${message.trim()}` : "",
    "The web model received the zotero-mcp tool catalog and can request real tools by emitting a ZOTERO_WEBAI_MCP_REQUEST block.",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatPDFCommandExecutionBody({
  contextSummary,
  message,
  scope,
}: {
  contextSummary: AssembledContext | null;
  message: string;
  scope: ScopeContext | null;
}): string {
  const fullTextLength = contextSummary?.fullText?.trim().length || 0;
  const attachedLength = Math.min(fullTextLength, PROMPT_TEXT_LIMIT);
  const selectedText =
    scope?.selectedText?.trim() || contextSummary?.selectedText?.trim() || "";
  return [
    `Command: /${CURRENT_PDF_COMMAND.slashCommand}`,
    fullTextLength
      ? `Status: attached ${attachedLength} of ${fullTextLength} characters from the current PDF/item full text.`
      : "Status: current PDF/item full text unavailable.",
    contextSummary?.fullTextSource
      ? `Source: ${contextSummary.fullTextSource}`
      : "",
    scope?.label ? `Zotero context: ${scope.label}` : "",
    message.trim() ? `User message:\n${message.trim()}` : "",
    selectedText
      ? `Selected passage:\n${truncateText(selectedText, 2400)}`
      : "",
    contextSummary?.blockingMessage
      ? `Blocking message: ${contextSummary.blockingMessage}`
      : "",
    contextSummary?.warnings?.length
      ? `Warnings:\n${contextSummary.warnings.join("\n")}`
      : "",
    fullTextLength > PROMPT_TEXT_LIMIT
      ? "Note: the paper text will be truncated in the prompt."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatMCPDetailedRecordBody(
  result: MCPToolDetailedResult,
  options?: {
    arguments?: Record<string, unknown>;
    usedFallback?: boolean;
  },
): string {
  const resultText =
    formatMCPDisplayContext(result.results, {
      toolName: result.toolName,
      usedFallback: Boolean(options?.usedFallback),
    }) ||
    truncateText(result.text || safeJSONStringify(result.raw), MCP_CONTEXT_TEXT_LIMIT) ||
    "MCP tool returned no structured or text content.";
  return [
    `Tool: ${result.toolName}`,
    options?.arguments
      ? `Arguments:\n${safeJSONStringify(options.arguments)}`
      : "",
    options?.usedFallback ? "Mode: automatic fallback" : "",
    "",
    resultText,
  ]
    .filter(Boolean)
    .join("\n");
}

async function fetchWebSearchContextForConversation({
  appendExecutionRecord,
  contextSummary,
  message,
  scope,
  selectedSkill,
  setStatus,
}: {
  appendExecutionRecord: (draft: WebAIExecutionRecordDraft) => string;
  contextSummary: AssembledContext | null;
  message: string;
  scope: ScopeContext | null;
  selectedSkill: WebAISkill | null;
  setStatus: (status: string) => void;
}): Promise<WebSearchPromptContextResult> {
  const query = buildWebSearchQuery({
    contextSummary,
    message,
    scope,
    selectedSkill,
  });
  if (!query) {
    return { contextText: "", query: "", status: null };
  }

  try {
    setStatus(`Searching web: ${query}`);
    const results = await searchWeb(query);
    const body = formatWebSearchRecordBody(query, results);
    appendExecutionRecord({
      body,
      hidden: true,
      kind: "web",
      sourcePrompt: query,
      status: results.length ? "done" : "error",
      subtitle: `${results.length} web results`,
      title: `Web search: ${query}`,
    });
    return {
      contextText: results.length
        ? formatWebSearchPromptContext(query, results)
        : "",
      query,
      status: results.length
        ? `Web search added (${results.length} results).`
        : "Web search returned no readable results.",
    };
  } catch (error) {
    const messageText =
      error instanceof Error && error.message ? error.message : String(error);
    appendExecutionRecord({
      body: `Query: ${query}\n\n${messageText}`,
      hidden: true,
      kind: "error",
      sourcePrompt: query,
      status: "error",
      subtitle: "built-in web search",
      title: "Web search failed",
    });
    ztoolkit.log("Web search failed:", error);
    return {
      contextText: "",
      query,
      status: "Web search unavailable; continuing without web context.",
    };
  }
}

function buildWebSearchQuery({
  contextSummary,
  message,
  scope,
  selectedSkill,
}: {
  contextSummary: AssembledContext | null;
  message: string;
  scope: ScopeContext | null;
  selectedSkill: WebAISkill | null;
}): string {
  const explicit = cleanSearchQuery(message);
  if (explicit) {
    return explicit;
  }
  const metadataTitle = contextSummary?.metadata
    ?.split(/\r?\n/)
    .find((line) => /title|题名|标题/i.test(line))
    ?.replace(/^.*?:\s*/, "")
    .trim();
  return truncateText(
    [
      selectedSkill?.label || "",
      scope?.label || metadataTitle || "",
    ]
      .filter(Boolean)
      .join(" ")
      .trim(),
    240,
  );
}

function cleanSearchQuery(value: string): string {
  return truncateText(
    value
      .replace(/^\s*\/\S+\s*/, "")
      .replace(/^(搜索|联网搜索|网页搜索|查找|查一下|search|web search)\s*[:：]?\s*/i, "")
      .trim(),
    240,
  );
}

async function searchWeb(query: string): Promise<WebSearchResult[]> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url);
  return parseDuckDuckGoHTML(html).slice(0, WEB_SEARCH_RESULT_LIMIT);
}

async function fetchText(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 Paperly AI",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } catch {
    const xhr = await Zotero.HTTP.request("GET", url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 Paperly AI",
      },
      responseType: "text",
      timeout: 20000,
    });
    return String(xhr.responseText || "");
  }
}

function parseDuckDuckGoHTML(html: string): WebSearchResult[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const results: WebSearchResult[] = [];
  const nodes = Array.from(doc.querySelectorAll(".result")) as HTMLElement[];
  for (const node of nodes) {
    const anchor = node.querySelector<HTMLAnchorElement>(".result__a");
    const title = normalizeWhitespace(anchor?.textContent || "");
    const rawURL = anchor?.getAttribute("href") || "";
    const snippet = normalizeWhitespace(
      node.querySelector(".result__snippet")?.textContent || "",
    );
    const url = unwrapDuckDuckGoURL(rawURL);
    if (title && url) {
      results.push({ snippet, title, url });
    }
  }
  return results;
}

function unwrapDuckDuckGoURL(url: string): string {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    return parsed.searchParams.get("uddg") || parsed.href;
  } catch {
    return url;
  }
}

function formatWebSearchRecordBody(
  query: string,
  results: WebSearchResult[],
): string {
  if (!results.length) {
    return `Query: ${query}\n\nNo readable web results returned.`;
  }
  return [
    `Query: ${query}`,
    "",
    ...results.map((result, index) =>
      [
        `${index + 1}. ${result.title}`,
        result.url,
        result.snippet,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n\n");
}

function formatWebSearchPromptContext(
  query: string,
  results: WebSearchResult[],
): string {
  return truncateText(
    [
      "Web search context:",
      `Query: ${query}`,
      "Use these web results as external context. Cite URLs when relying on them and distinguish web context from Zotero/PDF context.",
      "",
      ...results.map((result, index) =>
        [
          `${index + 1}. ${result.title}`,
          `URL: ${result.url}`,
          result.snippet,
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    ].join("\n\n"),
    WEB_SEARCH_CONTEXT_TEXT_LIMIT,
  );
}

function buildRegeneratePrompt(record: WebAIExecutionRecord): string {
  return [
    "Regenerate the following Paperly AI result with improved clarity and completeness.",
    `Result type: ${record.kind}`,
    `Title: ${record.title}`,
    record.subtitle ? `Context: ${record.subtitle}` : "",
    "",
    "Previous result:",
    record.body,
  ]
    .filter(Boolean)
    .join("\n");
}

async function appendResultToZoteroNote(
  scope: ScopeContext | null,
  record: WebAIExecutionRecord,
): Promise<number> {
  const parentItem = resolveNoteParentItem(scope);
  if (!parentItem) {
    throw new Error("No current Zotero item is available for appending a note.");
  }

  const note = await getOrCreateWebAINote(parentItem);
  const existing = note.getNote?.() || Zotero.Notes.defaultNote;
  note.setNote(appendHTMLToZoteroNote(existing, formatRecordNoteHTML(record)));
  await note.saveTx();
  return note.id;
}

function resolveNoteParentItem(scope: ScopeContext | null): Zotero.Item | null {
  const itemID = scope?.itemIds?.[0] || scope?.readerAttachmentId || 0;
  if (!itemID) {
    return null;
  }
  const item = Zotero.Items.get(itemID);
  if (!item) {
    return null;
  }
  return item.isRegularItem?.() ? item : item.parentItem || item.topLevelItem || item;
}

async function getOrCreateWebAINote(parentItem: Zotero.Item): Promise<Zotero.Item> {
  const noteIDs = parentItem.getNotes?.(false) || [];
  for (const noteID of noteIDs) {
    const note = Zotero.Items.get(noteID);
    if (note?.isNote?.() && note.getNoteTitle?.() === WEBAI_NOTE_TITLE) {
      return note;
    }
  }

  const note = new Zotero.Item("note");
  const mutableNote = note as Zotero.Item & {
    libraryID?: number;
    parentID?: number | false;
  };
  mutableNote.libraryID = parentItem.libraryID;
  mutableNote.parentID = parentItem.id;
  note.setNote(
    `<div class="zotero-note znv1"><h1>${escapeHTML(WEBAI_NOTE_TITLE)}</h1></div>`,
  );
  await note.saveTx();
  return note;
}

function appendHTMLToZoteroNote(existing: string, addition: string): string {
  const inner = existing
    .replace(/^<div class="zotero-note znv1">\s*/i, "")
    .replace(/\s*<\/div>\s*$/i, "");
  return `<div class="zotero-note znv1">${inner}${addition}</div>`;
}

function formatRecordNoteHTML(record: WebAIExecutionRecord): string {
  const body = formatMarkdownForDisplay(record.body);
  return [
    "<hr/>",
    `<h2>${escapeHTML(record.title)}</h2>`,
    `<p><strong>${escapeHTML(record.kind.toUpperCase())}</strong>${
      record.subtitle ? ` · ${escapeHTML(record.subtitle)}` : ""
    } · ${escapeHTML(formatRecordTimestamp(record.createdAt))}</p>`,
    `<pre>${escapeHTML(body)}</pre>`,
  ].join("");
}

function formatRecordTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isAssistantDisclaimerLine(value: string): boolean {
  const line = String(value || "").replace(/\s+/g, " ").trim();
  if (!line) {
    return false;
  }
  return (
    /^ChatGPT\s+(?:can|may)\s+make\s+mistakes\.?\s*(?:Check\s+important\s+(?:info|information)\.?)?$/i.test(
      line,
    ) ||
    /^ChatGPT\s*(?:\u4e5f\u53ef\u80fd\u4f1a\u72af\u9519|\u53ef\u80fd\u4f1a\u72af\u9519|\u4e5f\u53ef\u80fd\u6703\u72af\u932f|\u53ef\u80fd\u6703\u72af\u932f)[\u3002.]?\s*(?:\u8bf7\u6838\u67e5\u91cd\u8981\u4fe1\u606f|\u8bf7\u67e5\u6838\u91cd\u8981\u4fe1\u606f|\u8acb\u6838\u67e5\u91cd\u8981\u8cc7\u8a0a|\u8acb\u67e5\u6838\u91cd\u8981\u8cc7\u8a0a)[\u3002.]?$/.test(
      line,
    )
  );
}

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Recognises a provider's auth screen from the captured text. Deliberately
// requires two independent markers in a short body: a real answer that happens
// to discuss signing in will be longer and will not hit several at once.
function extractAssistantCandidate(
  text: string,
  sourcePrompt = "",
  previousCapture = "",
): AssistantCandidate {
  const cleaned = text
    .replace(/ZOTERO_WEBAI_MCP_REQUEST[\s\S]*?END_ZOTERO_WEBAI_MCP_REQUEST/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) {
    return { body: "", raw: "" };
  }

  const markerMatches = [
    "Paperly AI MCP tool result:",
    "Use this Zotero MCP result to continue answering",
    "Zotero context:",
    "Paper content:",
  ];
  let lastMarker = "";
  let lastMarkerIndex = -1;
  for (const marker of markerMatches) {
    const markerIndex = cleaned.lastIndexOf(marker);
    if (markerIndex > lastMarkerIndex) {
      lastMarker = marker;
      lastMarkerIndex = markerIndex;
    }
  }
  const candidate =
    lastMarkerIndex >= 0
      ? cleaned.slice(lastMarkerIndex + lastMarker.length).trim()
      : cleaned;
  const stripped = stripPromptEcho(candidate || cleaned, sourcePrompt);
  const normalized = normalizeAssistantCapture(
    stripped,
    sourcePrompt,
    previousCapture,
  );
  return {
    body: normalized.body,
    raw: normalized.body,
    thinking: normalized.thinking,
  };
}

function normalizeAssistantCapture(
  captured: string,
  sourcePrompt = "",
  previousCapture = "",
): AssistantCaptureParts {
  const normalized = stripAssistantWebNoise(
    stripPromptEcho(captured, sourcePrompt),
  );
  const split = splitThinkingFromAnswer(
    stripRepeatedCapturePrefix(normalized, previousCapture),
  );
  return {
    body: truncateText(
      stripAssistantWebNoise(split.body),
      ASSISTANT_CAPTURE_TEXT_LIMIT,
    ),
    thinking: split.thinking
      ? truncateText(stripAssistantWebNoise(split.thinking), ASSISTANT_CAPTURE_TEXT_LIMIT)
      : undefined,
  };
}

function stripPromptEcho(value: string, sourcePrompt = ""): string {
  let text = normalizeCapturedText(value);
  const prompt = normalizeCapturedText(sourcePrompt);
  if (!text || !prompt) {
    return text;
  }

  const exactIndex = text.lastIndexOf(prompt);
  if (exactIndex >= 0) {
    text = text.slice(exactIndex + prompt.length).trim();
  }

  const promptEndMarkers = [
    "Note: the paper text was truncated by Paperly AI; continue from the available excerpt first.",
    "Use the following MCP tool output as external/local Zotero context for this conversation.",
    "Use these web results as external context.",
  ];
  for (const marker of promptEndMarkers) {
    const index = text.lastIndexOf(marker);
    if (index >= 0) {
      text = text.slice(index + marker.length).trim();
    }
  }

  const promptLines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 48);
  for (const line of promptLines.slice(-12)) {
    const index = text.lastIndexOf(line);
    if (index >= 0) {
      text = text.slice(index + line.length).trim();
    }
  }

  if (looksLikePromptEcho(text)) {
    return "";
  }
  return text;
}

function normalizeCapturedText(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripAssistantWebNoise(value: string): string {
  const text = normalizeCapturedText(value)
    .replace(/本回答由\s*AI\s*生成[，,]?\s*内容仅供参考[，,]?\s*请仔细甄别/g, "")
    .replace(/内容由\s*AI\s*生成[，,]?\s*请仔细甄别/g, "");
  const noiseLinePattern =
    /^(深度思考|智能搜索|联网搜索|搜索|复制|分享|重新生成|停止生成|继续生成|给\s*(DeepSeek|Z\.ai|ChatGPT)\s*发送消息)$/i;
  return text
    .split(/\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line && !noiseLinePattern.test(line) && !isAssistantDisclaimerLine(line),
    )
    .filter(
      (line) =>
        !/^(deep think|thinking|reasoning|search|web search|copy|copied|share|regenerate|retry|stop generating|continue generating|continue|edit|delete|like|dislike|复制|已复制|分享|重新生成|重试|停止生成|继续生成|继续|编辑|删除|点赞|点踩|深度思考|推理过程|思考过程|智能搜索|联网搜索|搜索|给\s*(DeepSeek|Z\.ai|ChatGPT)\s*发送消息)$/i.test(
          line,
        ),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripRepeatedCapturePrefix(value: string, previousCapture = ""): string {
  const text = normalizeCapturedText(value);
  const previous = normalizeCapturedText(previousCapture);
  if (!text || !previous || previous.length < 80) {
    return text;
  }

  if (text.startsWith(previous)) {
    return text.slice(previous.length).trim();
  }

  const previousTail = previous.slice(-Math.min(previous.length, 1200));
  const index = text.lastIndexOf(previousTail);
  if (index >= 0) {
    return text.slice(index + previousTail.length).trim();
  }

  return text;
}

function splitThinkingFromAnswer(value: string): AssistantCaptureParts {
  const text = normalizeCapturedText(value);
  const tagMatches = Array.from(text.matchAll(/<think>([\s\S]*?)<\/think>/gi));
  if (tagMatches.length) {
    const thinking = tagMatches
      .map((match) => match[1]?.trim())
      .filter(Boolean)
      .join("\n\n");
    return {
      body: text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(),
      thinking: thinking || undefined,
    };
  }

  const openThinkIndex = text.search(/<\s*think\s*>/i);
  if (openThinkIndex >= 0) {
    const before = text.slice(0, openThinkIndex).trim();
    const afterOpen = text.slice(openThinkIndex).replace(/<\s*think\s*>/i, "");
    const finalAnswerMatch = afterOpen.match(
      /(?:^|\n)\s*(?:最终答案|答案|回答|结果|结论|Answer|Final answer|Result|Response)\s*[:：]\s*/i,
    );
    if (finalAnswerMatch?.index !== undefined) {
      const thinking = afterOpen.slice(0, finalAnswerMatch.index).trim();
      const body = [
        before,
        afterOpen.slice(finalAnswerMatch.index + finalAnswerMatch[0].length).trim(),
      ]
        .filter(Boolean)
        .join("\n\n");
      return { body, thinking: thinking || undefined };
    }
  }

  const splitBySections = splitInternalSectionsFromAnswer(text);
  if (splitBySections.thinking) {
    return splitBySections;
  }

  return { body: text };
}

function splitInternalSectionsFromAnswer(value: string): AssistantCaptureParts {
  const lines = value.split(/\n/);
  const bodyLines: string[] = [];
  const internalLines: string[] = [];
  let mode: "body" | "internal" = "body";
  let sawInternal = false;
  let sawAnswer = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (isInternalProcessHeading(line)) {
      mode = "internal";
      sawInternal = true;
      internalLines.push(rawLine);
      continue;
    }
    if (isFinalAnswerHeading(line)) {
      mode = "body";
      sawAnswer = true;
      continue;
    }

    if (mode === "internal") {
      internalLines.push(rawLine);
    } else {
      bodyLines.push(rawLine);
    }
  }

  const body = bodyLines.join("\n").trim();
  const thinking = internalLines.join("\n").trim();
  if (!sawInternal) {
    return { body: value };
  }
  if (!body && !sawAnswer) {
    return { body: "", thinking };
  }
  return { body, thinking: thinking || undefined };
}

function isInternalProcessHeading(value: string): boolean {
  if (
    /^(思考链|思考过程|推理过程|深度思考|运行代码|代码运行|运行过程|执行过程|工具调用|工具执行|中间步骤|过程|Reasoning|Thinking|Chain of thought|Running code|Code execution|Execution process|Tool call|Tool calls|Tool output|Intermediate steps?)\s*[:：]?$/i.test(
      value,
    )
  ) {
    return true;
  }
  return /^(思考链|思考过程|推理过程|深度思考|运行代码|代码运行|运行过程|执行过程|工具调用|工具执行|中间步骤|过程|Reasoning|Thinking|Chain of thought|Running code|Code execution|Execution process|Tool call|Tool calls|Tool output|Intermediate steps?)\s*[:：]?$/i.test(
    value,
  );
}

function isFinalAnswerHeading(value: string): boolean {
  if (/^(最终答案|答案|回答|结论|结果|正文|Answer|Final answer|Result|Response)\s*[:：]?$/i.test(value)) {
    return true;
  }
  return /^(最终答案|答案|回答|结论|结果|正文|Answer|Final answer|Result|Response)\s*[:：]?$/i.test(
    value,
  );
}

function looksLikePromptEcho(value: string): boolean {
  const text = normalizeCapturedText(value);
  if (!text) {
    return false;
  }
  const hasPromptSections =
    /(^|\n)(User message|Zotero context|Metadata|Selected passage|Paper content|MCP context|Web search context):/i.test(
      text,
    );
  const hasZoteroTruncation = text.includes(
    "Note: the paper text was truncated by Paperly AI",
  );
  const hasMCPJsonEcho =
    /"appliedModeConfig"|"pagination"|"searchTime"|"hasMore"/.test(text);
  if (
    /(^|\n)(用户消息|当前文献|论文内容|网页搜索上下文|User message|Zotero context|Paper content|MCP context|Web search context)[:：]/i.test(
      text,
    ) &&
    /Final answer format|ZOTERO_WEBAI_MCP_REQUEST|Available Zotero MCP tools|Note: the paper text was truncated by Paperly AI/i.test(
      text,
    )
  ) {
    return true;
  }
  return (hasPromptSections && (hasZoteroTruncation || hasMCPJsonEcho)) ||
    (hasPromptSections && text.length > 1200 && !/[。！？.!?]\s*\n/.test(text));
}

function looksLikeInternalBridgeOutput(value: string): boolean {
  const text = normalizeCapturedText(value);
  if (!text) {
    return false;
  }
  if (
    /ZOTERO_WEBAI_MCP_REQUEST|END_ZOTERO_WEBAI_MCP_REQUEST/.test(text) ||
    /Paperly AI MCP tool (result|error):/i.test(text) ||
    /Zotero MCP bridge:/i.test(text) ||
    /Available Zotero MCP tools \(\d+\):/i.test(text) ||
    /Final answer format:\s*reply only with the user-facing result/i.test(text)
  ) {
    return true;
  }

  const hasToolArguments =
    /(^|\n)Tool:\s*\S+/i.test(text) && /(^|\n)Arguments:\s*[{[]/i.test(text);
  const hasBridgeInstruction =
    /Use this Zotero MCP result|MCP context:|Tool used:|inputSchema:/i.test(
      text,
    );
  if (hasToolArguments && hasBridgeInstruction) {
    return true;
  }

  const rawJSONMarkers = [
    '"appliedModeConfig"',
    '"pagination"',
    '"searchTime"',
    '"matchedChunks"',
    '"structuredContent"',
    '"isError"',
  ].filter((marker) => text.includes(marker));
  return rawJSONMarkers.length >= 2 && /^[\s{[]/.test(text);
}

function renderMarkdownContent(
  value: string,
  theme: SidebarTheme,
): React.ReactNode {
  const blocks = parseMarkdownBlocks(formatMarkdownForDisplay(value));
  if (!blocks.length) {
    return null;
  }

  return (
    <div style={styles.markdownRoot}>
      {blocks.map((block, index) => renderMarkdownBlock(block, index, theme))}
    </div>
  );
}

function formatMarkdownForDisplay(value: string): string {
  const text = normalizeCapturedText(value);
  if (!text) {
    return "";
  }
  if (looksLikeReadableMarkdown(text)) {
    return text;
  }
  return enrichPlainTextAsMarkdown(text)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeReadableMarkdown(value: string): boolean {
  const text = normalizeCapturedText(value);
  if (!text) {
    return false;
  }
  return (
    /(^|\n)\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|```|\$\$)/.test(text) ||
    /\|.+\|\s*\n\s*\|[-:\s|]+\|/.test(text)
  );
}

function enrichPlainTextAsMarkdown(value: string): string {
  let formatted = normalizeCapturedText(value).replace(/[ \t]{2,}/g, " ");
  formatted = promoteDenseOrdinalHeadings(formatted);
  formatted = promoteSummaryHeading(formatted);
  formatted = promoteInlineLabelsToBullets(formatted);
  formatted = splitLongPlainParagraphs(formatted);
  return formatted;
}

function promoteDenseOrdinalHeadings(value: string): string {
  const cjkOrdinal =
    "\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341";
  const headingPattern = new RegExp(
    `(^|[\\s\\u3002\\uff01\\uff1f!?;\\uff1b])((?:[${cjkOrdinal}]+\\u3001|[\\uff08(][${cjkOrdinal}]+[\\uff09)]))\\s*([^\\n\\u3002\\uff01\\uff1f!?;\\uff1b:：]{1,34}?)[\\uff1a:]\\s*`,
    "g",
  );
  return value.replace(
    headingPattern,
    (match: string, prefix: string, marker: string, title: string) => {
      const lead = prefix && /\S/.test(prefix) ? `${prefix.trim()}\n\n` : "\n\n";
      const spacer = marker.endsWith("\u3001") ? "" : " ";
      return `${lead}## ${marker}${spacer}${title.trim()}\n\n`;
    },
  );
}

function promoteSummaryHeading(value: string): string {
  const summaryPattern =
    /([\u3002\uff01\uff1f!?])\s*((?:\u7efc\u4e0a\u6240\u8ff0|\u603b\u4e4b|\u56e0\u6b64)[\uff0c,])/g;
  return value.replace(
    summaryPattern,
    (match: string, prefix: string, summaryLead: string) =>
      `${prefix}\n\n## \u603b\u7ed3\n\n${summaryLead}`,
  );
}

function promoteInlineLabelsToBullets(value: string): string {
  const labelPattern =
    /(^|[\n\u3002\uff01\uff1f\uff1b;!?])\s*([\u3400-\u9fffA-Za-z][\u3400-\u9fffA-Za-z0-9\uff08\uff09()\/\-.\s]{1,26})[\uff1a:]\s*/g;
  return value.replace(
    labelPattern,
    (match: string, prefix: string, label: string) => {
      const normalizedLabel = normalizeInlineLabel(label);
      if (!shouldPromoteInlineLabel(normalizedLabel)) {
        return match;
      }
      const lead = prefix && /\S/.test(prefix) ? `${prefix}\n` : "\n";
      return `${lead}- **${normalizedLabel}\uFF1A** `;
    },
  );
}

function normalizeInlineLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function shouldPromoteInlineLabel(label: string): boolean {
  if (label.length < 2 || label.length > 26) {
    return false;
  }
  if (/[,\uFF0C\u3002\uFF01\uFF1F!?;\uFF1B:\uFF1A]/.test(label)) {
    return false;
  }
  if (
    /^(query|tool|arguments|command|user message|metadata|source|url|doi|pmid|arxiv|json|xml)$/i.test(
      label,
    )
  ) {
    return false;
  }
  if (/\d$|\d{2,}/.test(label)) {
    return false;
  }
  const cjkMatches = label.match(/[\u3400-\u9fff]/g) || [];
  return cjkMatches.length >= 2 || /^[A-Za-z][A-Za-z /.-]{2,26}$/.test(label);
}

function splitLongPlainParagraphs(value: string): string {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => splitLongPlainParagraph(paragraph.trim()))
    .filter(Boolean)
    .join("\n\n");
}

function splitLongPlainParagraph(paragraph: string): string {
  if (
    paragraph.length < 280 ||
    /^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|```|\$\$)/.test(paragraph)
  ) {
    return paragraph;
  }

  const sentences =
    paragraph.match(/[^\u3002\uff01\uff1f!?]+[\u3002\uff01\uff1f!?]?/g) || [];
  const cleanSentences = sentences.map((sentence) => sentence.trim()).filter(Boolean);
  if (cleanSentences.length <= 1) {
    return paragraph;
  }

  const groups: string[] = [];
  let current = "";
  cleanSentences.forEach((sentence) => {
    if (current && current.length + sentence.length > 220) {
      groups.push(current);
      current = sentence;
      return;
    }
    current = current ? `${current} ${sentence}` : sentence;
  });
  if (current) {
    groups.push(current);
  }
  return groups.join("\n\n");
}

function parseMarkdownBlocks(value: string): MarkdownBlock[] {
  const lines = normalizeCapturedText(value).split("\n");
  const blocks: MarkdownBlock[] = [];
  const paragraphLines: string[] = [];

  const flushParagraph = () => {
    const text = paragraphLines.join("\n").trim();
    if (text) {
      blocks.push({ text, type: "paragraph" });
    }
    paragraphLines.length = 0;
  };

  for (let index = 0; index < lines.length;) {
    const rawLine = lines[index] || "";
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      flushParagraph();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({
        text: codeLines.join("\n").replace(/\s+$/, ""),
        type: "code",
      });
      continue;
    }

    if (line.startsWith("$$")) {
      flushParagraph();
      if (line.endsWith("$$") && line.length > 4) {
        blocks.push({ text: line.slice(2, -2).trim(), type: "math" });
        index += 1;
        continue;
      }
      const mathLines: string[] = [];
      const firstLine = line.replace(/^\$\$\s*/, "");
      if (firstLine) {
        mathLines.push(firstLine);
      }
      index += 1;
      while (index < lines.length) {
        const currentLine = lines[index] || "";
        if (currentLine.trim().endsWith("$$")) {
          const closingLine = currentLine.replace(/\s*\$\$\s*$/, "");
          if (closingLine.trim()) {
            mathLines.push(closingLine);
          }
          index += 1;
          break;
        }
        mathLines.push(currentLine);
        index += 1;
      }
      blocks.push({ text: mathLines.join("\n").trim(), type: "math" });
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      blocks.push({
        level: headingMatch[1].length as 1 | 2 | 3,
        text: headingMatch[2].trim(),
        type: "heading",
      });
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      flushParagraph();
      const tableLines: string[] = [];
      while (index < lines.length && isMarkdownTableLine(lines[index] || "")) {
        tableLines.push(lines[index] || "");
        index += 1;
      }
      const table = parseMarkdownTable(tableLines);
      if (table) {
        blocks.push(table);
      }
      continue;
    }

    const unorderedMatch = line.match(/^[-*+]\s+(.+)$/);
    const orderedMatch = line.match(/^\d+[.)]\s+(.+)$/);
    if (unorderedMatch || orderedMatch) {
      flushParagraph();
      const ordered = Boolean(orderedMatch);
      const items: MarkdownListItem[] = [];
      let currentItem: MarkdownListItem | null = null;
      const pushCurrentItem = () => {
        if (currentItem?.text.trim()) {
          items.push({
            level: currentItem.level,
            text: currentItem.text.trim(),
          });
        }
        currentItem = null;
      };
      while (index < lines.length) {
        const currentRaw = lines[index] || "";
        const current = currentRaw.trim();
        if (!current) {
          break;
        }
        const match = ordered
          ? currentRaw.match(/^(\s*)\d+[.)]\s+(.+)$/)
          : currentRaw.match(/^(\s*)[-*+]\s+(.+)$/);
        if (match) {
          pushCurrentItem();
          currentItem = {
            level: Math.floor((match[1] || "").replace(/\t/g, "  ").length / 2),
            text: match[2].trim(),
          };
          index += 1;
          continue;
        }
        if (isMarkdownBlockBoundary(current)) {
          break;
        }
        if (currentItem) {
          currentItem.text = `${currentItem.text}\n${currentRaw.trim()}`;
        } else {
          currentItem = {
            level: 0,
            text: currentRaw.trim(),
          };
        }
        index += 1;
      }
      pushCurrentItem();
      blocks.push({ items, ordered, type: "list" });
      continue;
    }

    if (line.startsWith(">")) {
      flushParagraph();
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ text: quoteLines.join("\n").trim(), type: "blockquote" });
      continue;
    }

    paragraphLines.push(rawLine);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

function isMarkdownBlockBoundary(line: string): boolean {
  return /^(#{1,6}\s+|```|\$\$|>\s+)/.test(line) || isMarkdownTableLine(line);
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  return (
    isMarkdownTableLine(lines[index] || "") &&
    Boolean((lines[index + 1] || "").match(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/))
  );
}

function isMarkdownTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && /^\|?.+\|.+\|?$/.test(trimmed);
}

function parseMarkdownTable(lines: string[]): MarkdownBlock | null {
  if (lines.length < 2) {
    return null;
  }
  const rows = lines
    .filter((line, index) => index !== 1)
    .map(splitMarkdownTableRow)
    .filter((row) => row.length);
  if (!rows.length) {
    return null;
  }
  return {
    headers: rows[0],
    rows: rows.slice(1),
    type: "table",
  };
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of trimmed) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function renderMarkdownBlock(
  block: MarkdownBlock,
  index: number,
  theme: SidebarTheme,
): React.ReactNode {
  const key = `md-${index}`;
  if (block.type === "heading") {
    return (
      <div
        key={key}
        style={{
          ...styles.markdownHeading,
          color: theme.text,
          fontSize:
            block.level === 1
              ? typography.headingMd
              : block.level === 2
                ? typography.headingSm
                : typography.body,
        }}
      >
        {renderInlineMarkdown(block.text, key, theme)}
      </div>
    );
  }
  if (block.type === "list") {
    const ListTag = block.ordered ? "ol" : "ul";
    return (
      <ListTag key={key} style={styles.markdownList}>
        {block.items.map((item, itemIndex) => (
          <li
            key={`${key}-item-${itemIndex}`}
            style={{
              ...styles.markdownListItem,
              marginLeft: item.level ? `${item.level * 18}px` : 0,
            }}
          >
            {renderInlineMarkdown(item.text, `${key}-item-${itemIndex}`, theme)}
          </li>
        ))}
      </ListTag>
    );
  }
  if (block.type === "table") {
    return (
      <div key={key} style={styles.markdownTableWrapper}>
        <table style={styles.markdownTable}>
          <thead>
            <tr>
              {block.headers.map((header, headerIndex) => (
                <th
                  key={`${key}-head-${headerIndex}`}
                  style={{
                    ...styles.markdownTableHeader,
                    background: theme.inputBackground,
                    borderColor: theme.softBorder,
                    color: theme.text,
                  }}
                >
                  {renderInlineMarkdown(header, `${key}-head-${headerIndex}`, theme)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${key}-row-${rowIndex}`}>
                {block.headers.map((_, cellIndex) => (
                  <td
                    key={`${key}-cell-${rowIndex}-${cellIndex}`}
                    style={{
                      ...styles.markdownTableCell,
                      borderColor: theme.softBorder,
                      color: theme.text,
                    }}
                  >
                    {renderInlineMarkdown(
                      row[cellIndex] || "",
                      `${key}-cell-${rowIndex}-${cellIndex}`,
                      theme,
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.type === "blockquote") {
    return (
      <blockquote
        key={key}
        style={{
          ...styles.markdownBlockquote,
          borderColor: theme.badgeBorder,
          color: theme.mutedText,
        }}
      >
        {renderInlineMarkdown(block.text, key, theme)}
      </blockquote>
    );
  }
  if (block.type === "code") {
    return (
      <pre
        key={key}
        style={{
          ...styles.markdownCodeBlock,
          background: theme.inputBackground,
          borderColor: theme.softBorder,
          color: theme.text,
        }}
      >
        {block.text}
      </pre>
    );
  }
  if (block.type === "math") {
    return (
      <pre
        key={key}
        style={{
          ...styles.markdownMathBlock,
          background: theme.inputBackground,
          borderColor: theme.badgeBorder,
          color: theme.text,
        }}
      >
        {`$$\n${block.text}\n$$`}
      </pre>
    );
  }
  return (
    <p key={key} style={styles.markdownParagraph}>
      {renderInlineMarkdown(block.text, key, theme)}
    </p>
  );
}

function renderInlineMarkdown(
  text: string,
  keyPrefix: string,
  theme: SidebarTheme,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenPattern =
    /(\$\$[\s\S]+?\$\$|!\[[^\]\n]*\]\([^)]+\)|`[^`\n]+`|\*\*[\s\S]+?\*\*|\*[^*\n]+?\*|\[[^\]\n]+\]\([^)]+\))/g;
  const appendPlain = (plain: string) => {
    if (!plain) {
      return;
    }
    const parts = plain.split("\n");
    parts.forEach((part, partIndex) => {
      if (part) {
        nodes.push(
          <React.Fragment key={`${keyPrefix}-text-${nodes.length}`}>
            {part}
          </React.Fragment>,
        );
      }
      if (partIndex < parts.length - 1) {
        nodes.push(<br key={`${keyPrefix}-br-${nodes.length}`} />);
      }
    });
  };

  let lastIndex = 0;
  for (const match of text.matchAll(tokenPattern)) {
    appendPlain(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-inline-${nodes.length}`;
    if (token.startsWith("$$")) {
      nodes.push(
        <code
          key={key}
          style={{
            ...styles.markdownInlineMath,
            background: theme.inputBackground,
            borderColor: theme.badgeBorder,
            color: theme.text,
          }}
        >
          {token}
        </code>,
      );
    } else if (token.startsWith("![")) {
      const imageMatch = token.match(/^!\[([^\]\n]*)\]\(([^)]+)\)$/);
      const label = imageMatch?.[1] || "image";
      const url = imageMatch?.[2] || "";
      if (isRenderableImageURL(url)) {
        nodes.push(
          <a
            href={url}
            key={key}
            onClick={(event) => {
              event.preventDefault();
              openExternalURL(url);
            }}
            rel="noreferrer"
            style={styles.markdownImageLink}
            title={label}
          >
            <img alt={label} src={url} style={styles.markdownImage} />
          </a>,
        );
      } else {
        appendPlain(label);
      }
    } else if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          style={{
            ...styles.markdownInlineCode,
            background: theme.inputBackground,
            borderColor: theme.softBorder,
            color: theme.text,
          }}
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={key}>
          {renderInlineMarkdown(token.slice(2, -2), key, theme)}
        </strong>,
      );
    } else if (token.startsWith("*")) {
      nodes.push(
        <em key={key}>
          {renderInlineMarkdown(token.slice(1, -1), key, theme)}
        </em>,
      );
    } else {
      const linkMatch = token.match(/^\[([^\]\n]+)\]\(([^)]+)\)$/);
      const label = linkMatch?.[1] || token;
      const url = linkMatch?.[2] || "";
      nodes.push(
        <a
          href={url || undefined}
          key={key}
          onClick={(event) => {
            if (/^https?:\/\//i.test(url)) {
              event.preventDefault();
              openExternalURL(url);
            }
          }}
          rel="noreferrer"
          style={{ ...styles.markdownLink, color: theme.badgeText }}
        >
          {label}
        </a>,
      );
    }
    lastIndex = (match.index || 0) + token.length;
  }
  appendPlain(text.slice(lastIndex));
  return nodes;
}

async function waitForStableAssistantText(
  frame: Element | null,
  baselineText: string,
  shouldContinue: () => boolean,
  sourcePrompt = "",
  getPreviousCapture: () => string = () => "",
  onCandidate?: (candidate: AssistantCandidate) => void,
): Promise<string> {
  const baseline = extractAssistantCandidate(
    baselineText,
    sourcePrompt,
    getPreviousCapture(),
  ).body;
  let bestCandidate = "";
  let stableReads = 0;
  const expectsImage = shouldUseLongImageCapture(sourcePrompt);
  const maxAttempts = expectsImage
    ? ASSISTANT_IMAGE_CAPTURE_MAX_ATTEMPTS
    : ASSISTANT_CAPTURE_MAX_ATTEMPTS;
  const requiredStableReads = expectsImage
    ? ASSISTANT_IMAGE_CAPTURE_STABLE_READS
    : ASSISTANT_CAPTURE_STABLE_READS;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!shouldContinue()) {
      return "";
    }
    await sleepWithHostTimer(
      attempt < 2
        ? ASSISTANT_CAPTURE_INITIAL_POLL_MS
        : ASSISTANT_CAPTURE_POLL_MS,
    );
    const result = await readLatestAssistantText(frame);
    if (!result.ok || !result.text) {
      continue;
    }
    const candidate = extractAssistantCandidate(
      result.text,
      sourcePrompt,
      getPreviousCapture(),
    );
    if (
      !candidate.body ||
      candidate.body === baseline ||
      candidate.body.trim().length < 1 ||
      looksLikeInternalBridgeOutput(candidate.body)
    ) {
      continue;
    }
    if (candidate.body === bestCandidate) {
      stableReads += 1;
    } else {
      bestCandidate = candidate.body;
      stableReads = 0;
      onCandidate?.(candidate);
    }
    if (
      stableReads >= requiredStableReads &&
      (!expectsImage || hasMarkdownImage(bestCandidate))
    ) {
      return bestCandidate;
    }
  }

  return bestCandidate;
}

function sleepWithHostTimer(timeoutMs: number): Promise<void> {
  const timerHost = resolveTimerHost();
  return new Promise((resolve) => {
    timerHost.setTimeout(resolve, timeoutMs);
  });
}

function truncateText(text: string, limit: number): string {
  const normalized = text.trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}\n\n[Truncated by Paperly AI]`;
}

function safeJSONStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stableHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () =>
      reject(reader.error || new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}

function parseDataURLMimeType(value: string): string {
  const match = value.match(/^data:([^;,]+)/i);
  return match?.[1] || "";
}

function createPastedImageFileName(dataURL: string): string {
  const mimeType = parseDataURLMimeType(dataURL);
  const extension = mimeType.includes("jpeg")
    ? "jpg"
    : mimeType.includes("webp")
      ? "webp"
      : mimeType.includes("gif")
        ? "gif"
        : "png";
  return `pasted-image.${extension}`;
}

function copyComposerImageToNativeClipboard(
  image: ComposerImageAttachment,
): boolean {
  const dataURLMatch = image.dataURL.match(/^data:([^;,]+)?;base64,([\s\S]*)$/i);
  if (!dataURLMatch) {
    return false;
  }
  try {
    const mimeType = image.type || dataURLMatch[1] || "image/png";
    const binary = atobInHost(dataURLMatch[2] || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const componentClasses = Components.classes as Record<
      string,
      {
        createInstance?: (interfaceType: unknown) => unknown;
        getService?: (interfaceType: unknown) => unknown;
      }
    >;
    const imageTools = componentClasses[
      "@mozilla.org/image/tools;1"
    ].getService?.(Components.interfaces.imgITools) as imgITools;
    const imageContainer = imageTools.decodeImageFromArrayBuffer(
      bytes.buffer,
      mimeType,
    );
    const transferable = componentClasses[
      "@mozilla.org/widget/transferable;1"
    ].createInstance?.(Components.interfaces.nsITransferable) as nsITransferable;
    transferable.init(null as unknown as nsILoadContext);
    const nativeImageFlavor = "application/x-moz-nativeimage";
    transferable.addDataFlavor(nativeImageFlavor);
    transferable.setTransferData(nativeImageFlavor, imageContainer);
    const clipboard = componentClasses[
      "@mozilla.org/widget/clipboard;1"
    ].getService?.(Components.interfaces.nsIClipboard) as nsIClipboard;
    clipboard.setData(
      transferable,
      null as unknown as nsIClipboardOwner,
      Components.interfaces.nsIClipboard.kGlobalClipboard,
    );
    return true;
  } catch (error) {
    ztoolkit.log("Paperly AI failed to copy image to native clipboard:", error);
    return false;
  }
}

function atobInHost(value: string): string {
  const hostWindow = Zotero.getMainWindow?.() as
    | { atob?: (source: string) => string }
    | undefined;
  if (typeof hostWindow?.atob === "function") {
    return hostWindow.atob(value);
  }
  const globalAtob = (globalThis as unknown as { atob?: (source: string) => string })
    .atob;
  if (typeof globalAtob === "function") {
    return globalAtob(value);
  }
  throw new Error("No base64 decoder is available");
}

function copyTextToClipboard(text: string): void {
  try {
    Zotero.Utilities.Internal.copyTextToClipboard(text);
    return;
  } catch {
    // Fall through to platform clipboard helper.
  }

  const componentClasses = Components.classes as Record<
    string,
    { getService: (interfaceType: unknown) => nsIClipboardHelper }
  >;
  const clipboardHelper = componentClasses[
    "@mozilla.org/widget/clipboardhelper;1"
  ].getService(Components.interfaces.nsIClipboardHelper);
  clipboardHelper.copyString(text);
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    boxSizing: "border-box",
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    fontFamily:
      '"Noto Sans CJK SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif',
    gap: "10px",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    padding: "8px",
    width: "100%",
  },
  compactContainer: {
    gap: "7px",
    padding: "6px",
  },
  // The page and the navigation strip above it read as one surface, so the
  // border and the rounding live here rather than on either half. `clip`, not
  // `hidden`: an `overflow: hidden` box is programmatically scrollable, and
  // focus() inside the frame would scroll the strip out of sight.
  frameShell: {
    border: "1px solid #e0e0e0",
    borderRadius: "8px",
    boxSizing: "border-box",
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    overflow: "clip",
    width: "100%",
  },
  frameNav: {
    alignItems: "center",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    boxSizing: "border-box",
    display: "flex",
    flex: "0 0 auto",
    gap: "4px",
    padding: "3px 5px",
  },
  frameHost: {
    boxSizing: "border-box",
    display: "flex",
    // Fills the panel: it is the only surface on screen when it is on screen.
    // The old maxHeight/minHeight pair sized it as the top half of a split.
    flex: "1 1 auto",
    maxHeight: "none",
    maxWidth: "100%",
    minHeight: 0,
    minWidth: 0,
    overflow: "auto",
    width: "100%",
  },
  loginModeBar: {
    alignItems: "center",
    border: "1px solid #e0e0e0",
    borderRadius: "8px",
    boxSizing: "border-box",
    display: "flex",
    flex: "0 0 auto",
    flexWrap: "wrap",
    gap: "8px",
    justifyContent: "space-between",
    minWidth: 0,
    padding: "8px",
  },
  loginModeText: {
    display: "flex",
    flex: "1 1 220px",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
  },
  loginModeTitle: {
    fontSize: typography.label,
    fontWeight: 700,
    lineHeight: 1.25,
  },
  loginModeHint: {
    fontSize: typography.meta,
    lineHeight: 1.35,
    minWidth: 0,
    overflow: "hidden",
    overflowWrap: "anywhere",
    textOverflow: "ellipsis",
  },
  frameToolbar: {
    alignItems: "center",
    border: "1px solid #e0e0e0",
    borderRadius: "10px",
    boxSizing: "border-box",
    display: "flex",
    flex: "0 0 auto",
    flexWrap: "wrap",
    gap: "8px",
    justifyContent: "space-between",
    minWidth: 0,
    padding: "8px",
  },
  statusBar: {
    flex: "0 0 auto",
    fontSize: typography.meta,
    lineHeight: 1.4,
    minWidth: 0,
    overflow: "hidden",
    padding: "0 4px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  frameActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
  },
  lookupBar: {
    border: "1px solid #e0e0e0",
    borderRadius: "12px",
    boxSizing: "border-box",
    display: "flex",
    flex: "0 0 auto",
    flexDirection: "column",
    gap: "6px",
    minWidth: 0,
    padding: "10px",
  },
  lookupRow: {
    display: "flex",
    gap: "6px",
    minWidth: 0,
  },
  lookupInput: {
    appearance: "none",
    border: "1px solid #c9c9c9",
    borderRadius: "8px",
    flex: "1 1 auto",
    fontSize: typography.body,
    minHeight: "30px",
    minWidth: 0,
    padding: "4px 9px",
  },
  lookupHint: {
    fontSize: typography.meta,
    lineHeight: 1.4,
  },
  miniButton: {
    appearance: "none",
    border: "1px solid #c9c9c9",
    borderRadius: "8px",
    cursor: "pointer",
    fontSize: typography.label,
    fontWeight: 600,
    minHeight: "30px",
    padding: "4px 9px",
    whiteSpace: "nowrap",
  },
  primaryMiniButton: {
    fontWeight: 700,
  },
  executionPanel: {
    border: "1px solid #e0e0e0",
    borderRadius: "12px",
    boxSizing: "border-box",
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    gap: 0,
    height: "clamp(360px, 48vh, 620px)",
    maxHeight: "min(78vh, 720px)",
    minHeight: "260px",
    minWidth: 0,
    overflow: "hidden",
    padding: 0,
    resize: "vertical",
    width: "100%",
  },
  compactExecutionPanel: {
    minHeight: "220px",
    height: "340px",
  },
  readerExecutionPanel: {
    flex: "1 1 auto",
    height: "560px",
    maxHeight: "none",
    minHeight: "280px",
    resize: "vertical",
  },
  executionHeader: {
    alignItems: "center",
    borderBottom: "1px solid #e0e0e0",
    display: "flex",
    gap: "8px",
    justifyContent: "space-between",
    minWidth: 0,
    padding: "9px 12px",
  },
  executionHeaderActions: {
    alignItems: "center",
    display: "flex",
    flex: "0 0 auto",
    gap: "6px",
    minWidth: 0,
  },
  executionTitle: {
    fontSize: typography.label,
    fontWeight: 700,
    lineHeight: 1.3,
  },
  executionMeta: {
    fontSize: typography.meta,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  resultsLayout: {
    display: "flex",
    flex: "1 1 auto",
    gap: 0,
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
  },
  historyPanel: {
    border: "1px solid #e0e0e0",
    borderBottom: 0,
    borderLeft: 0,
    borderTop: 0,
    borderRadius: 0,
    boxSizing: "border-box",
    display: "flex",
    flex: "0 0 220px",
    flexDirection: "column",
    gap: "8px",
    maxHeight: "100%",
    maxWidth: "360px",
    minHeight: 0,
    minWidth: "170px",
    overflow: "auto",
    padding: "10px",
    resize: "horizontal",
  },
  historyHeader: {
    alignItems: "center",
    display: "flex",
    gap: "6px",
    justifyContent: "space-between",
    minWidth: 0,
  },
  historyTitle: {
    fontSize: typography.label,
    fontWeight: 700,
    lineHeight: 1.3,
  },
  historyList: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    minHeight: 0,
    overflow: "auto",
  },
  historyItem: {
    appearance: "none",
    background: "transparent",
    border: "1px solid #e0e0e0",
    borderRadius: "8px",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minHeight: "54px",
    minWidth: 0,
    padding: "8px",
    textAlign: "left",
  },
  historyItemTitle: {
    fontSize: typography.meta,
    fontWeight: 700,
    lineHeight: 1.25,
    overflow: "hidden",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
  },
  historyItemMeta: {
    fontSize: typography.caption,
    lineHeight: 1.25,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  historyEmpty: {
    fontSize: typography.meta,
    lineHeight: 1.45,
    padding: "8px",
  },
  executionList: {
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    gap: "16px",
    maxHeight: "100%",
    maxWidth: "100%",
    minWidth: 0,
    minHeight: 0,
    overflowX: "hidden",
    overflowY: "auto",
    padding: "12px",
    width: "100%",
  },
  emptyConversation: {
    alignItems: "center",
    display: "flex",
    flex: "1 1 auto",
    fontSize: typography.meta,
    justifyContent: "center",
    lineHeight: 1.5,
    minHeight: "120px",
    padding: "16px",
    textAlign: "center",
  },
  chatTurn: {
    borderRadius: "12px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    minWidth: 0,
    outlineOffset: "2px",
    padding: "2px",
  },
  messageRow: {
    display: "flex",
    minWidth: 0,
    width: "100%",
  },
  userMessageRow: {
    justifyContent: "flex-end",
  },
  assistantMessageRow: {
    justifyContent: "flex-start",
  },
  userBubble: {
    border: "1px solid #d7eed7",
    borderRadius: "12px",
    boxSizing: "border-box",
    maxWidth: "88%",
    minWidth: "160px",
    overflow: "auto",
    padding: "10px 12px",
    MozUserSelect: "text",
    userSelect: "text",
  },
  assistantBubble: {
    border: "1px solid #e2e2e2",
    borderRadius: "12px",
    boxSizing: "border-box",
    maxWidth: "100%",
    minHeight: "80px",
    minWidth: "220px",
    overflow: "auto",
    padding: "12px 14px",
    MozUserSelect: "text",
    userSelect: "text",
    width: "100%",
  },
  messageHeader: {
    alignItems: "center",
    display: "flex",
    gap: "10px",
    justifyContent: "space-between",
    marginBottom: "7px",
    minWidth: 0,
  },
  messageAuthor: {
    fontSize: typography.body,
    fontWeight: 700,
    lineHeight: 1.3,
  },
  messageTimestamp: {
    flex: "0 0 auto",
    fontSize: typography.caption,
    lineHeight: 1.25,
    whiteSpace: "nowrap",
  },
  userMessageBody: {
    fontSize: typography.body,
    lineHeight: 1.58,
    MozUserSelect: "text",
    overflowWrap: "anywhere",
    userSelect: "text",
    whiteSpace: "normal",
    wordBreak: "break-word",
  },
  userEditInput: {
    border: "1px solid #c9c9c9",
    borderRadius: "8px",
    boxSizing: "border-box",
    font: "inherit",
    fontSize: typography.body,
    lineHeight: 1.55,
    minHeight: "92px",
    outline: "none",
    padding: "8px 10px",
    resize: "vertical",
    width: "100%",
  },
  assistantTitleLine: {
    alignItems: "center",
    display: "flex",
    flex: "1 1 auto",
    flexWrap: "wrap",
    gap: "8px",
    minWidth: 0,
  },
  executionItem: {
    border: "1px solid #e0e0e0",
    borderRadius: "6px",
    padding: "6px",
  },
  executionSummary: {
    alignItems: "center",
    cursor: "pointer",
    display: "flex",
    gap: "8px",
    listStyle: "none",
    minWidth: 0,
  },
  executionKind: {
    border: "1px solid #c9c9c9",
    borderRadius: "999px",
    flex: "0 0 auto",
    fontSize: typography.meta,
    fontWeight: 700,
    lineHeight: 1.25,
    padding: "2px 8px",
  },
  toolBubble: {
    borderStyle: "solid",
    boxShadow: "inset 3px 0 0 rgba(42, 90, 134, 0.26)",
  },
  executionSummaryText: {
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    minWidth: 0,
  },
  executionItemTitle: {
    fontSize: typography.body,
    fontWeight: 700,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  executionItemSubtitle: {
    fontSize: typography.meta,
    lineHeight: 1.35,
    marginBottom: "8px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  executionBody: {
    background: "transparent",
    border: 0,
    fontFamily: "inherit",
    fontSize: typography.body,
    lineHeight: 1.72,
    margin: "10px 0 0",
    maxHeight: "none",
    overflow: "auto",
    padding: 0,
    MozUserSelect: "text",
    userSelect: "text",
    whiteSpace: "normal",
    wordBreak: "break-word",
  },
  markdownRoot: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    minWidth: 0,
    MozUserSelect: "text",
    userSelect: "text",
    width: "100%",
  },
  markdownParagraph: {
    lineHeight: 1.72,
    margin: "0 0 2px",
    overflowWrap: "anywhere",
    whiteSpace: "normal",
    wordBreak: "break-word",
  },
  markdownHeading: {
    fontWeight: 700,
    lineHeight: 1.38,
    margin: "6px 0 1px",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
  },
  markdownList: {
    lineHeight: 1.68,
    margin: "0 0 2px",
    paddingInlineStart: "22px",
  },
  markdownListItem: {
    margin: "5px 0",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
  },
  markdownTableWrapper: {
    maxWidth: "100%",
    overflow: "auto",
  },
  markdownTable: {
    borderCollapse: "collapse",
    fontSize: typography.meta,
    lineHeight: 1.55,
    minWidth: "100%",
    tableLayout: "auto",
  },
  markdownTableHeader: {
    border: "1px solid #e0e0e0",
    fontWeight: 700,
    padding: "6px 8px",
    textAlign: "left",
    verticalAlign: "top",
    whiteSpace: "normal",
  },
  markdownTableCell: {
    border: "1px solid #e0e0e0",
    padding: "6px 8px",
    textAlign: "left",
    verticalAlign: "top",
    whiteSpace: "normal",
  },
  markdownBlockquote: {
    borderLeft: "3px solid #d6e5f4",
    lineHeight: 1.65,
    margin: 0,
    padding: "4px 0 4px 10px",
    whiteSpace: "pre-wrap",
  },
  markdownCodeBlock: {
    border: "1px solid #e0e0e0",
    borderRadius: "6px",
    boxSizing: "border-box",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
    fontSize: typography.meta,
    lineHeight: 1.5,
    margin: 0,
    maxWidth: "100%",
    overflow: "auto",
    padding: "8px 10px",
    whiteSpace: "pre",
  },
  markdownMathBlock: {
    border: "1px solid #d6e5f4",
    borderRadius: "6px",
    boxSizing: "border-box",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
    fontSize: typography.meta,
    lineHeight: 1.55,
    margin: 0,
    maxWidth: "100%",
    overflow: "auto",
    padding: "8px 10px",
    whiteSpace: "pre-wrap",
  },
  markdownInlineCode: {
    border: "1px solid #e0e0e0",
    borderRadius: "4px",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
    fontSize: "0.94em",
    padding: "1px 4px",
    whiteSpace: "break-spaces",
  },
  markdownInlineMath: {
    border: "1px solid #d6e5f4",
    borderRadius: "4px",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
    fontSize: "0.94em",
    padding: "1px 4px",
    whiteSpace: "break-spaces",
  },
  markdownImageLink: {
    display: "inline-block",
    margin: "6px 6px 6px 0",
    maxWidth: "100%",
    verticalAlign: "middle",
  },
  markdownImage: {
    borderRadius: "6px",
    display: "inline-block",
    height: "auto",
    maxHeight: "520px",
    maxWidth: "100%",
    objectFit: "contain",
  },
  markdownLink: {
    cursor: "pointer",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    wordBreak: "break-word",
  },
  thinkingDetails: {
    border: "1px solid #e0e0e0",
    borderRadius: "9px",
    marginTop: "10px",
    padding: "7px 9px",
  },
  thinkingSummary: {
    cursor: "pointer",
    fontSize: typography.meta,
    fontWeight: 600,
    lineHeight: 1.35,
  },
  thinkingBody: {
    background: "transparent",
    border: 0,
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
    fontSize: typography.meta,
    lineHeight: 1.45,
    margin: "6px 0 0",
    maxHeight: "140px",
    overflow: "auto",
    padding: 0,
    userSelect: "text",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  recordActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    justifyContent: "flex-end",
    marginTop: "12px",
  },
  versionPager: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    justifyContent: "flex-end",
    marginTop: "10px",
  },
  versionLabel: {
    fontSize: typography.meta,
    fontWeight: 600,
    lineHeight: 1.3,
    padding: "2px 4px",
  },
  inlineActionButton: {
    appearance: "none",
    background: "transparent",
    border: "1px solid #c9c9c9",
    borderRadius: "999px",
    cursor: "pointer",
    fontSize: typography.meta,
    fontWeight: 600,
    minHeight: "24px",
    padding: "3px 9px",
    whiteSpace: "nowrap",
  },
  composerPanel: {
    border: "1px solid #e0e0e0",
    borderRadius: "14px",
    boxSizing: "border-box",
    display: "flex",
    flex: "0 0 auto",
    flexDirection: "column",
    gap: "8px",
    minHeight: "132px",
    minWidth: 0,
    overflow: "visible",
    padding: "10px",
    position: "relative",
    width: "100%",
  },
  compactComposerPanel: {
    minHeight: "122px",
  },
  slashMenu: {
    border: "1px solid #e0e0e0",
    borderRadius: "12px",
    boxShadow: "0 -4px 24px rgba(0, 0, 0, 0.12)",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    maxHeight: "220px",
    overflow: "auto",
    padding: "6px",
    position: "absolute",
    bottom: "100%",
    left: 0,
    right: 0,
    zIndex: 1000,
    marginBottom: "8px",
  },
  skillOption: {
    alignItems: "center",
    appearance: "none",
    background: "transparent",
    border: 0,
    borderRadius: "9px",
    cursor: "pointer",
    display: "flex",
    gap: "8px",
    justifyContent: "space-between",
    minHeight: "32px",
    padding: "6px 8px",
    textAlign: "left",
    width: "100%",
  },
  skillOptionText: {
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    minWidth: 0,
  },
  skillOptionTitle: {
    fontSize: typography.body,
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  skillOptionDescription: {
    fontSize: typography.meta,
    lineHeight: 1.25,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  skillOptionCommand: {
    flexShrink: 0,
    fontSize: typography.meta,
  },
  selectedSkill: {
    alignSelf: "flex-start",
    appearance: "none",
    border: "1px solid #d6e5f4",
    borderRadius: "999px",
    cursor: "pointer",
    fontSize: typography.label,
    fontWeight: 600,
    maxWidth: "100%",
    overflow: "hidden",
    padding: "3px 8px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  composerInput: {
    border: 0,
    boxSizing: "border-box",
    font: "inherit",
    fontSize: typography.body,
    lineHeight: 1.55,
    maxHeight: "200px",
    minHeight: "76px",
    outline: "none",
    padding: "4px 2px",
    resize: "vertical",
    width: "100%",
  },
  hiddenFileInput: {
    display: "none",
  },
  composerImagePreview: {
    alignItems: "center",
    border: "1px solid #e0e0e0",
    borderRadius: "8px",
    display: "flex",
    gap: "8px",
    minHeight: "42px",
    minWidth: 0,
    padding: "6px",
  },
  composerImageThumb: {
    borderRadius: "6px",
    flex: "0 0 auto",
    height: "34px",
    objectFit: "cover",
    width: "46px",
  },
  composerImageName: {
    flex: "1 1 auto",
    fontSize: typography.meta,
    fontWeight: 600,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  composerFooter: {
    alignItems: "center",
    display: "flex",
    flexWrap: "nowrap",
    gap: "8px",
    justifyContent: "space-between",
    minWidth: 0,
  },
  sendButton: {
    appearance: "none",
    border: "1px solid #d6e5f4",
    borderRadius: "999px",
    cursor: "pointer",
    flex: "0 0 auto",
    fontSize: typography.label,
    fontWeight: 700,
    minHeight: "34px",
    minWidth: "64px",
    padding: "5px 14px",
  },
};
