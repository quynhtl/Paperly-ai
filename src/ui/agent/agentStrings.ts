// Paperly Agent's words, in the panel's two languages.

import type { AgentErrorKind, EngineId } from "../../modules/agent/types";

export interface AgentStrings {
  title: string;
  placeholderPaper: (engine: string) => string;
  placeholderLibrary: (engine: string) => string;
  emptyPaperTitle: string;
  emptyLibraryTitle: string;
  emptyBody: (engine: string) => string;
  library: string;
  send: string;
  stop: string;
  newConversation: string;
  saveAsNote: string;
  useWebMode: string;
  useAgentMode: string;
  copy: string;
  copied: string;
  thinking: string;
  thoughtProcess: string;
  working: string;
  stopped: string;
  status: {
    checking: string;
    ready: (method?: string, plan?: string) => string;
    notInstalled: string;
    notSignedIn: string;
    unknown: string;
  };
  menu: {
    engine: string;
    model: string;
    effort: string;
    webSearch: string;
    defaultModel: string;
    defaultEffort: string;
    efforts: Record<string, string>;
  };
  quick: {
    explainSelection: string;
    explainEquation: string;
    summarizeSection: string;
    mainIdea: string;
  };
  quickPrompts: {
    explainSelection: string;
    explainEquation: string;
    summarizeSection: (page?: number) => string;
    mainIdea: string;
    explainPassage: (page: number, text: string) => string;
    askPassage: (page: number, text: string) => string;
  };
  tools: {
    running: (name: string, input?: Record<string, unknown>) => string;
    done: (name: string, input?: Record<string, unknown>) => string;
    more: (count: number) => string;
  };
  approval: {
    title: string;
    allow: string;
    deny: string;
    allowed: string;
    denied: string;
    expired: string;
    pending: string;
  };
  errors: Record<AgentErrorKind, string>;
  setup: {
    installTitle: (engine: string) => string;
    installBody: string;
    checkAgain: string;
    signInTitle: (engine: string) => string;
    signInBody: (engine: string) => string;
    signIn: string;
    signInTerminal: (command: string) => string;
    openPage: string;
    pasteCode: string;
    codePlaceholder: string;
    submitCode: string;
    deviceCode: string;
    waiting: string;
    checkingSignIn: string;
    signedIn: string;
    tryAgain: string;
    cancel: string;
    updateTitle: (engine: string) => string;
    updateBody: (command: string) => string;
    chooseModel: string;
  };
  saved: string;
  meta: {
    seconds: (value: number) => string;
    tokens: (value: string) => string;
    subscription: string;
    apiKey: string;
  };
}

function toolSubject(name: string, input?: Record<string, unknown>): { verb: string; ing: string } {
  const page = (value: unknown) => (typeof value === "number" ? value : undefined);
  const quoted = (value: unknown) => (typeof value === "string" && value ? `“${value.length > 40 ? `${value.slice(0, 40)}…` : value}”` : "");
  const short = name.replace(/^mcp__paperly__/, "");
  switch (short) {
    case "get_current_paper":
      return { verb: "Looked at the paper", ing: "Looking at the paper" };
    case "read_pages": {
      const from = page(input?.from);
      const to = page(input?.to);
      const range = from ? (to && to !== from ? `pages ${from}–${to}` : `page ${from}`) : "pages";
      return { verb: `Read ${range}`, ing: `Reading ${range}` };
    }
    case "get_selection":
      return { verb: "Read your selection", ing: "Reading your selection" };
    case "get_annotations":
      return { verb: "Read your highlights", ing: "Reading your highlights" };
    case "search_library":
      return { verb: `Searched your library ${quoted(input?.query)}`.trim(), ing: `Searching your library ${quoted(input?.query)}`.trim() };
    case "find_related":
      return { verb: `Looked for related work ${quoted(input?.query)}`.trim(), ing: `Looking for related work ${quoted(input?.query)}`.trim() };
    case "add_note":
      return { verb: "Asked to save a note", ing: "Asking to save a note" };
    case "WebSearch":
      return { verb: `Searched the web ${quoted(input?.query)}`.trim(), ing: `Searching the web ${quoted(input?.query)}`.trim() };
    default:
      return { verb: `Used ${short}`, ing: `Using ${short}` };
  }
}

const en: AgentStrings = {
  title: "Paperly Agent",
  placeholderPaper: (engine) => `Ask ${engine} about this paper…`,
  placeholderLibrary: (engine) => `Ask ${engine} about your library…`,
  emptyPaperTitle: "Ask about this paper",
  emptyLibraryTitle: "Ask about your library",
  emptyBody: (engine) =>
    `${engine} reads only the pages it needs, using your own sign-in. Nothing is saved to your library unless you allow it.`,
  library: "Library",
  send: "Send",
  stop: "Stop",
  newConversation: "New conversation",
  saveAsNote: "Save chat as note",
  useWebMode: "Use the web page instead",
  useAgentMode: "Paperly Agent",
  copy: "Copy",
  copied: "Copied",
  thinking: "Thinking…",
  thoughtProcess: "Thought process",
  working: "Working…",
  stopped: "Stopped",
  status: {
    checking: "Checking…",
    ready: (method, plan) =>
      method === "api_key" || method === "API key"
        ? "Signed in with an API key (billed per use)"
        : `Signed in${plan ? ` · ${plan}` : method ? ` · ${method}` : ""}`,
    notInstalled: "Not installed",
    notSignedIn: "Not signed in",
    unknown: "Status unknown",
  },
  menu: {
    engine: "Agent",
    model: "Model",
    effort: "Effort",
    webSearch: "Web search",
    defaultModel: "Default",
    defaultEffort: "Default",
    efforts: { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" },
  },
  quick: {
    explainSelection: "Explain selection",
    explainEquation: "Explain equation",
    summarizeSection: "Summarize section",
    mainIdea: "Main idea",
  },
  quickPrompts: {
    explainSelection:
      "Explain the passage I have selected in this paper (use get_selection). Use plain language, define the technical terms, and say how it fits the paper's argument.",
    explainEquation:
      "Explain the equation I have selected (use get_selection; if nothing is selected, the main equation on the page I am reading). Go through each symbol and step, and say what it means in the paper.",
    summarizeSection: (page) =>
      `Summarize the section I am reading${page ? ` (I am on page ${page})` : ""}. Read only the pages you need, and keep it short.`,
    mainIdea:
      "What is the main idea of this paper? Give its key contributions and how the paper supports them, briefly.",
    explainPassage: (page, text) =>
      `Explain this passage from page ${page} of the paper in clear language. Define the technical terms and say how it fits the paper's argument.\n\n> ${text.trim().replace(/\n/g, "\n> ")}`,
    askPassage: (page, text) => `About this passage on page ${page}:\n\n> ${text.trim().replace(/\n/g, "\n> ")}\n\n`,
  },
  tools: {
    running: (name, input) => `${toolSubject(name, input).ing}…`,
    done: (name, input) => toolSubject(name, input).verb,
    more: (count) => `+${count} more`,
  },
  approval: {
    title: "Save this note on the paper?",
    allow: "Save note",
    deny: "Don't save",
    allowed: "Note saved",
    denied: "Not saved",
    expired: "No answer, not saved",
    pending: "Waiting for you",
  },
  errors: {
    not_installed: "The agent CLI is not installed.",
    not_signed_in: "The agent CLI is not signed in.",
    update_required: "The agent CLI needs an update.",
    rate_limited: "Your plan's usage limit is reached.",
    model: "That model is not available. Choose another one in the menu.",
    session_lost: "The earlier conversation could not be restored.",
    unsafe: "The turn was stopped for safety.",
    server_off: "Paperly's local server is off.",
    cli: "The agent stopped unexpectedly.",
    api: "The agent reported an error.",
  },
  setup: {
    installTitle: (engine) => `Install ${engine}`,
    installBody: "Paperly Agent uses the CLI on your computer. Run this in Terminal, then check again:",
    checkAgain: "Check again",
    signInTitle: (engine) => `Sign in to ${engine}`,
    signInBody: (engine) =>
      engine === "Codex"
        ? "Sign in with your ChatGPT account on OpenAI's own page. Paperly never sees your password."
        : "Sign in with your Claude account on Anthropic's own page. Paperly never sees your password.",
    signIn: "Sign in",
    signInTerminal: (command) => `Or run \`${command}\` in Terminal.`,
    openPage: "Open the sign-in page again",
    pasteCode: "When the page shows a code, paste it here:",
    codePlaceholder: "Paste the code",
    submitCode: "Continue",
    deviceCode: "Enter this code on the page that opened:",
    waiting: "Waiting for you to finish in the browser…",
    checkingSignIn: "Checking the sign-in…",
    signedIn: "Signed in",
    tryAgain: "Try again",
    cancel: "Cancel",
    updateTitle: (engine) => `Update ${engine}`,
    updateBody: (command) => `Run \`${command}\` in Terminal, then try again.`,
    chooseModel: "Choose another model in the menu above.",
  },
  saved: "Saved",
  meta: {
    seconds: (value) => `${value < 10 ? value.toFixed(1) : Math.round(value)} s`,
    tokens: (value) => `${value} tokens`,
    subscription: "your plan",
    apiKey: "API key",
  },
};

const zh: AgentStrings = {
  ...en,
  placeholderPaper: (engine) => `向 ${engine} 询问这篇论文…`,
  placeholderLibrary: (engine) => `向 ${engine} 询问你的文献库…`,
  emptyPaperTitle: "询问这篇论文",
  emptyLibraryTitle: "询问你的文献库",
  emptyBody: (engine) => `${engine} 只读取需要的页面，并使用你自己的登录。未经你允许，不会向文献库写入任何内容。`,
  library: "文献库",
  send: "发送",
  stop: "停止",
  newConversation: "新对话",
  saveAsNote: "将对话保存为笔记",
  useWebMode: "改用网页",
  copy: "复制",
  copied: "已复制",
  thinking: "思考中…",
  thoughtProcess: "思考过程",
  working: "处理中…",
  stopped: "已停止",
  quick: { explainSelection: "解释选区", explainEquation: "解释公式", summarizeSection: "总结本节", mainIdea: "核心观点" },
  approval: { title: "将这条笔记保存到论文？", allow: "保存笔记", deny: "不保存", allowed: "笔记已保存", denied: "未保存", expired: "未回应，未保存", pending: "等待你确认" },
  saved: "已保存",
};

export function agentStrings(isZh: boolean): AgentStrings {
  return isZh ? zh : en;
}

export const ENGINE_NAMES: Record<EngineId, string> = { claude: "Claude Code", codex: "Codex" };
