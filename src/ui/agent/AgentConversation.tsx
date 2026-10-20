// Paperly Agent's chat, shown in the panel's Conversation view.
//
// The view follows the paper in front: each paper has its own conversation,
// and switching tabs switches conversations. Everything it shows comes from
// agentService; it never talks to the CLI itself.

import React, { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  answerApproval,
  beginSignIn,
  cancelSignIn,
  CLAUDE_MODELS,
  clearSignIn,
  EFFORTS,
  getAgentSettings,
  getConversation,
  getEngineStatus,
  getSignInState,
  getTurnState,
  openConversation,
  paperFromScope,
  retryLastMessage,
  saveConversationAsNote,
  sendAgentMessage,
  setAgentSettings,
  startNewConversation,
  stateKeyFor,
  stopAgentTurn,
  submitSignInCode,
  subscribeAgent,
} from "../../modules/agent/agentService";
import type { AgentEffort } from "../../modules/agent/agentService";
import { INSTALL_COMMANDS, cachedCliStatus } from "../../modules/agent/cli";
import type { CliStatus } from "../../modules/agent/cli";
import type { ApprovalPart, AssistantPart, ChatMessage, EngineId, ThinkingPart, ToolPart } from "../../modules/agent/types";
import type { ScopeContext } from "../../types/scope";
import { copyTextToClipboard } from "../../utils/clipboard";
import type { SidebarTheme } from "../theme";
import { AgentMarkdown } from "./AgentMarkdown";
import { ENGINE_NAMES, agentStrings } from "./agentStrings";
import type { AgentStrings } from "./agentStrings";

export interface AgentIncomingPrompt {
  id: string;
  action: "explain" | "ask" | "prompt";
  text: string;
  page?: number;
}

export interface AgentConversationProps {
  theme: SidebarTheme;
  isDark: boolean;
  isZh: boolean;
  scope: ScopeContext | null;
  incoming: AgentIncomingPrompt | null;
  onIncomingHandled: (id: string) => void;
  onUseWebMode: () => void;
}

const drafts = new Map<string, string>();

function themeVariables(theme: SidebarTheme, isDark: boolean): React.CSSProperties {
  return {
    "--pa-bg": theme.surfaceBackground,
    "--pa-panel": theme.panelBackground,
    "--pa-text": theme.text,
    "--pa-muted": theme.mutedText,
    "--pa-border": theme.softBorder,
    "--pa-strong-border": theme.border,
    "--pa-accent": theme.brandAccent,
    "--pa-accent-soft": theme.selectionHighlight,
    "--pa-user-bg": theme.badgeBackground,
    "--pa-user-border": theme.badgeBorder,
    "--pa-hover": theme.hoverBackground,
    "--pa-active": theme.activeBackground,
    "--pa-focus": theme.focusRing,
    "--pa-input-bg": theme.inputBackground,
    "--pa-input-border": theme.inputBorder,
    "--pa-think-bg": theme.thinkingBackground,
    "--pa-think-border": theme.thinkingBorder,
    "--pa-think-text": theme.thinkingText,
    "--pa-quick-bg": theme.quickPromptBackground,
    "--pa-quick-border": theme.quickPromptBorder,
    "--pa-quick-hover": theme.quickPromptHover,
    "--pa-quick-text": theme.quickPromptText,
    "--pa-error-bg": theme.errorBackground,
    "--pa-error-border": theme.errorBorder,
    "--pa-error-text": theme.errorText,
    "--pa-warn-bg": theme.warningBackground,
    "--pa-warn-border": theme.warningBorder,
    "--pa-warn-text": theme.warningText,
    "--pa-ok": theme.modelOnlineIndicator,
    "--pa-bad": theme.modelOfflineIndicator,
    "--pa-shadow": theme.cardShadow,
    "--pa-dropdown-shadow": theme.dropdownShadow,
    "--pa-divider": theme.divider,
    "--pa-code-bg": isDark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.045)",
    "--pa-scroll-thumb": theme.scrollbarThumb,
  } as React.CSSProperties;
}

/* ------------------------------------------------------------------ icons */

const Icon = {
  chevron: (open = false) => (
    <svg aria-hidden="true" className={open ? "pa-chevron pa-chevron--open" : "pa-chevron"} height="10" viewBox="0 0 10 10" width="10">
      <path d="M3 2l3.5 3L3 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  ),
  check: () => (
    <svg aria-hidden="true" height="12" viewBox="0 0 12 12" width="12">
      <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
    </svg>
  ),
  warn: () => (
    <svg aria-hidden="true" height="12" viewBox="0 0 12 12" width="12">
      <path d="M6 1.5l4.8 8.5H1.2z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.3" />
      <path d="M6 5v2.3M6 8.6v.1" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
    </svg>
  ),
  send: () => (
    <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
      <path d="M7 11.5V2.8M3.2 6.4L7 2.6l3.8 3.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  ),
  stop: () => (
    <svg aria-hidden="true" height="12" viewBox="0 0 12 12" width="12">
      <rect fill="currentColor" height="8" rx="1.6" width="8" x="2" y="2" />
    </svg>
  ),
  plus: () => (
    <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
      <path d="M2.5 3.5a1.5 1.5 0 011.5-1.5h6a1.5 1.5 0 011.5 1.5v4a1.5 1.5 0 01-1.5 1.5H6.2L3.6 11.3V9H4a1.5 1.5 0 01-1.5-1.5z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.2" />
      <path d="M7 4v3.2M5.4 5.6h3.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" />
    </svg>
  ),
  note: () => (
    <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
      <path d="M3.5 1.8h5l2.7 2.7v7.2a.6.6 0 01-.6.6H3.5a.6.6 0 01-.6-.6V2.4a.6.6 0 01.6-.6z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.2" />
      <path d="M8.4 1.9v2.7h2.7M4.8 7.2h4.4M4.8 9.3h3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" />
    </svg>
  ),
  copy: () => (
    <svg aria-hidden="true" height="12" viewBox="0 0 12 12" width="12">
      <rect fill="none" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.1" width="6.5" x="3.8" y="3.6" />
      <path d="M2.4 8.2V2.6a1 1 0 011-1h4.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.1" />
    </svg>
  ),
  paper: () => (
    <svg aria-hidden="true" height="12" viewBox="0 0 12 12" width="12">
      <path d="M3 1.3h4.2L9.4 3.5v7a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V1.8a.5.5 0 01.5-.5z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1" />
      <path d="M4.2 5.5h3.6M4.2 7.4h3.6M4.2 9.2h2.2" stroke="currentColor" strokeLinecap="round" strokeWidth="0.9" />
    </svg>
  ),
};

/* --------------------------------------------------------------- motion */

/**
 * New messages arrive on a spring rather than an eased fade: k=260, c=20
 * (damping ratio 0.62). Simulated over a 14px travel it overshoots by about
 * 1px and settles in ~460ms -- a visible give, never a wobble.
 */
function useSpringIn(ref: React.RefObject<HTMLElement>, enabled: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current;
    const win = element?.ownerDocument?.defaultView;
    if (!element || !win || !enabled) {
      return;
    }
    const stiffness = 260;
    const damping = 20;
    const travel = 14;
    let position = 0;
    let velocity = 0;
    let last = 0;
    let frame = 0;
    const step = (now: number) => {
      const dt = last ? Math.min(0.032, (now - last) / 1000) : 1 / 60;
      last = now;
      const acceleration = stiffness * (1 - position) - damping * velocity;
      velocity += acceleration * dt;
      position += velocity * dt;
      element.style.transform = `translateY(${((1 - position) * travel).toFixed(2)}px)`;
      element.style.opacity = String(Math.max(0, Math.min(1, position * 1.5)));
      if (Math.abs(1 - position) * travel < 0.05 && Math.abs(velocity) * travel < 0.5) {
        element.style.transform = "";
        element.style.opacity = "";
        return;
      }
      frame = win.requestAnimationFrame(step);
    };
    element.style.opacity = "0";
    frame = win.requestAnimationFrame(step);
    return () => {
      win.cancelAnimationFrame(frame);
      element.style.transform = "";
      element.style.opacity = "";
    };
    // Once, when the message first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/* ------------------------------------------------------------ messages */

type PartGroup =
  | { kind: "tools"; tools: ToolPart[]; key: string }
  | { kind: "part"; part: Exclude<AssistantPart, ToolPart>; key: string };

function groupParts(parts: AssistantPart[]): PartGroup[] {
  const groups: PartGroup[] = [];
  parts.forEach((part, index) => {
    if (part.kind === "tool") {
      const last = groups[groups.length - 1];
      if (last && last.kind === "tools") {
        last.tools.push(part);
      } else {
        groups.push({ kind: "tools", tools: [part], key: `tools-${part.id}` });
      }
    } else {
      groups.push({ kind: "part", part, key: `${part.kind}-${index}` });
    }
  });
  return groups;
}

function ToolRun({ tools, t }: { tools: ToolPart[]; t: AgentStrings }) {
  const [open, setOpen] = useState(false);
  const running = tools.find((tool) => tool.status === "running");
  const failed = tools.some((tool) => tool.status === "error");
  const labels = tools.map((tool) => t.tools.done(tool.name, tool.input));
  const summary = running
    ? t.tools.running(running.name, running.input)
    : labels.slice(0, 2).join(" · ") + (labels.length > 2 ? ` · ${t.tools.more(labels.length - 2)}` : "");
  return (
    <div className="pa-toolrun">
      <button
        aria-expanded={open}
        className={`pa-toolrun-head${failed ? " is-error" : ""}${running ? " is-running" : ""}`}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="pa-toolrun-icon">{running ? <span className="pa-spinner" /> : failed ? Icon.warn() : Icon.check()}</span>
        <span className="pa-toolrun-label">{summary}</span>
        {Icon.chevron(open)}
      </button>
      {open && (
        <div className="pa-toolrun-list">
          {tools.map((tool) => (
            <div className={`pa-tool pa-tool--${tool.status}`} key={tool.id}>
              <div className="pa-tool-title">
                <span className="pa-toolrun-icon">
                  {tool.status === "running" ? <span className="pa-spinner" /> : tool.status === "error" ? Icon.warn() : Icon.check()}
                </span>
                {tool.status === "running" ? t.tools.running(tool.name, tool.input) : t.tools.done(tool.name, tool.input)}
              </div>
              {tool.output && <pre className="pa-tool-output">{tool.output}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ part, live, t }: { part: ThinkingPart; live: boolean; t: AgentStrings }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pa-thinking">
      <button aria-expanded={open} className={`pa-thinking-head${live ? " is-live" : ""}`} onClick={() => setOpen((value) => !value)} type="button">
        <span>{live ? t.thinking : t.thoughtProcess}</span>
        {Icon.chevron(open)}
      </button>
      {open && <div className="pa-thinking-body">{part.text}</div>}
    </div>
  );
}

function ApprovalCard({ part, t }: { part: ApprovalPart; t: AgentStrings }) {
  const settled = part.status !== "pending";
  return (
    <div className={`pa-approval pa-approval--${part.status}`}>
      <div className="pa-approval-title">
        {Icon.note()}
        <span>{t.approval.title}</span>
      </div>
      <div className="pa-approval-name">{part.title}</div>
      <div className="pa-approval-preview">
        <AgentMarkdown copiedLabel={t.copied} copyLabel={t.copy} text={part.preview} />
      </div>
      {settled ? (
        <div className="pa-approval-status">
          {part.status === "allowed" ? Icon.check() : null}
          {part.status === "allowed" ? t.approval.allowed : part.status === "denied" ? t.approval.denied : t.approval.expired}
        </div>
      ) : (
        <div className="pa-approval-actions">
          <button className="pa-button" onClick={() => answerApproval(part.id, false)} type="button">
            {t.approval.deny}
          </button>
          <button className="pa-button pa-button--primary" onClick={() => answerApproval(part.id, true)} type="button">
            {t.approval.allow}
          </button>
        </div>
      )}
    </div>
  );
}

function prettyModel(model?: string): string {
  if (!model) {
    return "";
  }
  const name = model.replace(/\[.*?\]$/, "").replace(/^claude-/, "");
  return name
    .split("-")
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ")
    .replace(/(\d) (\d)/g, "$1.$2");
}

function compactNumber(value: number): string {
  return value >= 10000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function assistantText(message: ChatMessage): string {
  return (message.parts || [])
    .filter((part): part is Extract<AssistantPart, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n\n");
}

function ErrorNote({ message, engine, t, onRetry }: { message: ChatMessage; engine: EngineId; t: AgentStrings; onRetry: () => void }) {
  const error = message.error!;
  const engineName = ENGINE_NAMES[engine];
  if (error.kind === "not_installed" || error.kind === "not_signed_in") {
    return <div className="pa-error pa-error--soft">{error.kind === "not_installed" ? t.setup.installTitle(engineName) : t.setup.signInTitle(engineName)} ↓</div>;
  }
  return (
    <div className="pa-error">
      <div className="pa-error-title">
        {Icon.warn()}
        <span>{t.errors[error.kind]}</span>
      </div>
      {error.message && error.message !== t.errors[error.kind] && <div className="pa-error-detail">{error.message}</div>}
      {error.kind === "update_required" && (
        <div className="pa-error-detail">{t.setup.updateBody(engine === "claude" ? "claude update" : "codex update")}</div>
      )}
      {error.kind !== "unsafe" && (
        <button className="pa-button pa-button--small" onClick={onRetry} type="button">
          {t.setup.tryAgain}
        </button>
      )}
    </div>
  );
}

function MessageView({
  message,
  isLast,
  running,
  notice,
  engine,
  t,
  stateKey,
  animate,
}: {
  message: ChatMessage;
  animate: boolean;
  isLast: boolean;
  running: boolean;
  notice?: string;
  engine: EngineId;
  t: AgentStrings;
  stateKey: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useSpringIn(ref, animate);
  const [copied, setCopied] = useState(false);

  if (message.role === "user") {
    return (
      <div className="pa-row pa-row--user" ref={ref}>
        <div className="pa-bubble">{message.text}</div>
      </div>
    );
  }

  const live = running && isLast && message.status === "running";
  const parts = message.parts || [];
  const groups = groupParts(parts);
  const hasOutput = parts.some((part) => part.kind === "text" && part.text.trim());
  const lastPart = parts[parts.length - 1];
  const meta = message.meta || {};
  const metaBits = [
    prettyModel(meta.model) || ENGINE_NAMES[meta.engine || engine],
    meta.durationMs ? t.meta.seconds(meta.durationMs / 1000) : "",
    meta.inputTokens || meta.outputTokens
      ? t.meta.tokens(compactNumber((meta.inputTokens || 0) + (meta.outputTokens || 0)))
      : "",
  ].filter(Boolean);

  return (
    <div className="pa-row pa-row--assistant" ref={ref}>
      {groups.map((group) => {
        if (group.kind === "tools") {
          return <ToolRun key={group.key} t={t} tools={group.tools} />;
        }
        const part = group.part;
        switch (part.kind) {
          case "text":
            return <AgentMarkdown copiedLabel={t.copied} copyLabel={t.copy} key={group.key} text={part.text} />;
          case "thinking":
            return <ThinkingBlock key={group.key} live={live && lastPart === part} part={part} t={t} />;
          case "approval":
            return <ApprovalCard key={group.key} part={part} t={t} />;
          case "notice":
            return (
              <div className="pa-notice" key={group.key}>
                {part.text}
              </div>
            );
          default:
            return null;
        }
      })}
      {live && (!hasOutput || notice) && (
        <div className="pa-typing">
          <span className="pa-dots">
            <i />
            <i />
            <i />
          </span>
          <span>{notice || (parts.length ? t.working : t.thinking)}</span>
        </div>
      )}
      {message.error && <ErrorNote engine={meta.engine || engine} message={message} onRetry={() => void retryLastMessage(stateKey)} t={t} />}
      {!live && (
        <div className="pa-meta">
          {message.status === "stopped" && <span className="pa-meta-stopped">{t.stopped}</span>}
          <span>{metaBits.join(" · ")}</span>
          {hasOutput && (
            <button
              className="pa-ghost-icon"
              onClick={() => {
                copyTextToClipboard(assistantText(message));
                setCopied(true);
                Zotero.getMainWindow()?.setTimeout(() => setCopied(false), 1500);
              }}
              title={copied ? t.copied : t.copy}
              type="button"
            >
              {copied ? Icon.check() : Icon.copy()}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- setup */

function SetupCard({ engine, status, t }: { engine: EngineId; status: CliStatus | null; t: AgentStrings }) {
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const signIn = getSignInState(engine);
  const engineName = ENGINE_NAMES[engine];
  const command = INSTALL_COMMANDS[engine];

  if (!status) {
    return null;
  }

  if (!status.path) {
    return (
      <div className="pa-setup">
        <div className="pa-setup-title">{t.setup.installTitle(engineName)}</div>
        <div className="pa-setup-body">{t.setup.installBody}</div>
        <div className="pa-command">
          <code>{command}</code>
          <button
            className="pa-ghost-icon"
            onClick={() => {
              copyTextToClipboard(command);
              setCopied(true);
              Zotero.getMainWindow()?.setTimeout(() => setCopied(false), 1500);
            }}
            title={copied ? t.copied : t.copy}
            type="button"
          >
            {copied ? Icon.check() : Icon.copy()}
          </button>
        </div>
        <button className="pa-button" onClick={() => void getEngineStatus(engine, true)} type="button">
          {t.setup.checkAgain}
        </button>
      </div>
    );
  }

  if (status.signedIn !== false && !signIn) {
    return null;
  }

  if (signIn && signIn.phase === "succeeded") {
    return (
      <div className="pa-setup pa-setup--ok">
        <div className="pa-setup-title">
          {Icon.check()} {t.setup.signedIn}
        </div>
        <button className="pa-button pa-button--small" onClick={() => clearSignIn(engine)} type="button">
          OK
        </button>
      </div>
    );
  }

  const waiting = signIn && ["starting", "waiting", "checking"].includes(signIn.phase);
  return (
    <div className="pa-setup">
      <div className="pa-setup-title">{t.setup.signInTitle(engineName)}</div>
      <div className="pa-setup-body">{t.setup.signInBody(engineName)}</div>
      {!waiting && (
        <>
          {signIn?.phase === "failed" && signIn.message && <div className="pa-error-detail">{signIn.message}</div>}
          <div className="pa-setup-actions">
            <button className="pa-button pa-button--primary" onClick={() => void beginSignIn(engine)} type="button">
              {signIn?.phase === "failed" ? t.setup.tryAgain : t.setup.signIn}
            </button>
          </div>
          <div className="pa-setup-hint">{t.setup.signInTerminal(engine === "claude" ? "claude auth login" : "codex login")}</div>
        </>
      )}
      {waiting && signIn && (
        <>
          {signIn.phase === "starting" && <div className="pa-setup-body">{t.working}</div>}
          {signIn.phase === "checking" && <div className="pa-setup-body">{t.setup.checkingSignIn}</div>}
          {signIn.phase === "waiting" && engine === "claude" && (
            <>
              <div className="pa-setup-body">{t.setup.pasteCode}</div>
              <form
                className="pa-code-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (submitSignInCode(engine, code)) {
                    setCode("");
                  }
                }}
              >
                <input
                  autoFocus
                  className="pa-code-input"
                  onChange={(event) => setCode(event.target.value)}
                  placeholder={t.setup.codePlaceholder}
                  type="text"
                  value={code}
                />
                <button className="pa-button pa-button--primary" disabled={!code.trim() || signIn.codeSent} type="submit">
                  {t.setup.submitCode}
                </button>
              </form>
            </>
          )}
          {signIn.phase === "waiting" && engine === "codex" && signIn.userCode && (
            <>
              <div className="pa-setup-body">{t.setup.deviceCode}</div>
              <div className="pa-device-code">{signIn.userCode}</div>
              <div className="pa-setup-hint">{t.setup.waiting}</div>
            </>
          )}
          <div className="pa-setup-actions">
            {signIn.url && signIn.phase === "waiting" && (
              <button className="pa-link-button" onClick={() => Zotero.launchURL(signIn.url!)} type="button">
                {t.setup.openPage}
              </button>
            )}
            <button className="pa-link-button" onClick={() => cancelSignIn(engine)} type="button">
              {t.setup.cancel}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- menu */

function EngineMenu({
  engine,
  t,
  onClose,
  onUseWebMode,
}: {
  engine: EngineId;
  t: AgentStrings;
  onClose: () => void;
  onUseWebMode: () => void;
}) {
  const settings = getAgentSettings();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const doc = ref.current?.ownerDocument;
    if (!doc) {
      return;
    }
    const onPointer = (event: Event) => {
      const target = event.target as Node | null;
      if (target && ref.current && !ref.current.contains(target) && !(target as Element).closest?.(".pa-engine")) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    doc.addEventListener("pointerdown", onPointer, true);
    doc.addEventListener("keydown", onKey, true);
    return () => {
      doc.removeEventListener("pointerdown", onPointer, true);
      doc.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const statusLine = (id: EngineId) => {
    const status = cachedCliStatus(id);
    if (!status) return t.status.checking;
    if (!status.path) return t.status.notInstalled;
    if (status.signedIn === false) return t.status.notSignedIn;
    if (status.signedIn === null) return t.status.unknown;
    return t.status.ready(status.method, status.plan);
  };
  const models = engine === "claude" ? CLAUDE_MODELS : [""];
  const currentModel = engine === "claude" ? settings.claudeModel : settings.codexModel;
  const effortLabel = (effort: AgentEffort) => (effort ? t.menu.efforts[effort] || effort : t.menu.defaultEffort);

  return (
    <div className="pa-menu" ref={ref} role="menu">
      <div className="pa-menu-label">{t.menu.engine}</div>
      {(["claude", "codex"] as EngineId[]).map((id) => {
        const status = cachedCliStatus(id);
        const ready = Boolean(status?.path && status.signedIn);
        return (
          <button
            className={`pa-menu-engine${id === engine ? " is-selected" : ""}`}
            key={id}
            onClick={() => {
              setAgentSettings({ engine: id });
              void getEngineStatus(id);
            }}
            type="button"
          >
            <span className={`pa-dot${ready ? " is-ok" : status ? " is-bad" : ""}`} />
            <span className="pa-menu-engine-name">{ENGINE_NAMES[id]}</span>
            <span className="pa-menu-engine-status">{statusLine(id)}</span>
          </button>
        );
      })}
      <div className="pa-menu-label">{t.menu.model}</div>
      <div className="pa-segmented">
        {models.map((model) => (
          <button
            className={model === currentModel ? "is-selected" : ""}
            key={model || "default"}
            onClick={() => setAgentSettings(engine === "claude" ? { claudeModel: model } : { codexModel: model })}
            type="button"
          >
            {model ? model.charAt(0).toUpperCase() + model.slice(1) : t.menu.defaultModel}
          </button>
        ))}
        {engine === "codex" && currentModel && <button className="is-selected" type="button">{currentModel}</button>}
      </div>
      <div className="pa-menu-label">{t.menu.effort}</div>
      <div className="pa-segmented">
        {EFFORTS.filter((effort) => engine === "claude" || !["xhigh", "max"].includes(effort)).map((effort) => (
          <button
            className={effort === settings.effort ? "is-selected" : ""}
            key={effort || "default"}
            onClick={() => setAgentSettings({ effort })}
            type="button"
          >
            {effortLabel(effort)}
          </button>
        ))}
      </div>
      <label className="pa-menu-toggle">
        <input checked={settings.webSearch} onChange={(event) => setAgentSettings({ webSearch: event.target.checked })} type="checkbox" />
        <span>{t.menu.webSearch}</span>
      </label>
      <div className="pa-menu-divider" />
      <button
        className="pa-menu-item"
        onClick={() => {
          onClose();
          onUseWebMode();
        }}
        type="button"
      >
        {t.useWebMode}
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------- view */

export const AgentConversation: React.FC<AgentConversationProps> = ({
  theme,
  isDark,
  isZh,
  scope,
  incoming,
  onIncomingHandled,
  onUseWebMode,
}) => {
  const t = agentStrings(isZh);
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => subscribeAgent(rerender), []);

  const settings = getAgentSettings();
  const engine = settings.engine;
  const scopeItem = scope && (scope.type === "pdf" || scope.type === "paper") ? scope.itemIds[0] : null;
  const paper = useMemo(() => paperFromScope(scope), [scope?.type, scopeItem]);
  const expectedKey = stateKeyFor(engine, paper);
  // Only messages that arrive while this conversation is on screen spring in;
  // switching to a paper shows its history still.
  const shownSince = useMemo(() => Date.now(), [expectedKey]);

  const [stateKey, setStateKey] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void openConversation(engine, paper).then((key) => {
      if (alive) {
        setStateKey(key);
      }
    });
    return () => {
      alive = false;
    };
  }, [expectedKey]);

  useEffect(() => {
    void getEngineStatus(engine);
  }, [engine]);
  const status = cachedCliStatus(engine);
  const ready = Boolean(status?.path && status.signedIn !== false);

  const conversation = stateKey === expectedKey ? getConversation(stateKey) : null;
  const turn = stateKey ? getTurnState(stateKey) : { running: false };
  const messages = conversation?.messages || [];

  const [draft, setDraftState] = useState("");
  useEffect(() => {
    setDraftState(drafts.get(expectedKey) || "");
  }, [expectedKey]);
  const setDraft = (value: string) => {
    drafts.set(expectedKey, value);
    setDraftState(value);
  };

  const [menuOpen, setMenuOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const showFlash = (text: string) => {
    setFlash(text);
    Zotero.getMainWindow()?.setTimeout(() => setFlash((current) => (current === text ? null : current)), 3500);
  };

  // Keep the newest words in view while they stream, unless the user scrolled up.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  });

  const resizeInput = () => {
    const element = textareaRef.current;
    if (!element) {
      return;
    }
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 168)}px`;
  };
  useLayoutEffect(resizeInput, [draft]);

  const send = (text: string) => {
    if (!conversation || turn.running) {
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed === "/new") {
      setDraft("");
      void startNewConversation(expectedKey);
      return;
    }
    if (trimmed === "/save") {
      setDraft("");
      void saveConversationAsNote(expectedKey).then((result) => showFlash(result.message));
      return;
    }
    stickToBottom.current = true;
    setDraft("");
    void sendAgentMessage(expectedKey, trimmed);
  };

  // Explain / Ask from the reader's selection popup.
  const handledIncoming = useRef<string | null>(null);
  useEffect(() => {
    if (!incoming || !conversation || handledIncoming.current === incoming.id) {
      return;
    }
    handledIncoming.current = incoming.id;
    onIncomingHandled(incoming.id);
    const page = incoming.page || scope?.readerPage || 1;
    if (incoming.action === "explain" && incoming.text) {
      send(t.quickPrompts.explainPassage(page, incoming.text));
    } else if (incoming.action === "ask" && incoming.text) {
      setDraft(t.quickPrompts.askPassage(page, incoming.text));
      Zotero.getMainWindow()?.setTimeout(() => {
        const element = textareaRef.current;
        if (element) {
          element.focus();
          element.selectionStart = element.selectionEnd = element.value.length;
        }
      }, 0);
    } else if (incoming.text) {
      setDraft(incoming.text);
    }
  }, [incoming?.id, conversation]);

  const engineName = ENGINE_NAMES[engine];
  const readyDot = status ? (status.path && status.signedIn ? "is-ok" : "is-bad") : "";
  const modelChoice = engine === "claude" ? settings.claudeModel : settings.codexModel;
  const hasAnswer = messages.some((message) => message.role === "assistant" && (message.parts || []).some((part) => part.kind === "text"));
  const quickPrompts: Array<[string, string]> = paper
    ? [
        [t.quick.explainSelection, t.quickPrompts.explainSelection],
        [t.quick.explainEquation, t.quickPrompts.explainEquation],
        [t.quick.summarizeSection, t.quickPrompts.summarizeSection(scope?.readerPage)],
        [t.quick.mainIdea, t.quickPrompts.mainIdea],
      ]
    : [];

  return (
    <div className="paperly-agent" style={themeVariables(theme, isDark)}>
      <div className="pa-header">
        <div className="pa-header-row">
          <button
            aria-expanded={menuOpen}
            className="pa-engine"
            onClick={() => setMenuOpen((open) => !open)}
            title={status?.version ? `${engineName} ${status.version}` : engineName}
            type="button"
          >
            <span className={`pa-dot ${readyDot}`} />
            <span className="pa-engine-name">{engineName}</span>
            {modelChoice && <span className="pa-engine-model">{modelChoice}</span>}
            {Icon.chevron(menuOpen)}
          </button>
          <div className="pa-header-spacer" />
          <button
            className="pa-icon-button"
            disabled={turn.running || !messages.length}
            onClick={() => void startNewConversation(expectedKey)}
            title={t.newConversation}
            type="button"
          >
            {Icon.plus()}
          </button>
          <button
            className="pa-icon-button"
            disabled={!hasAnswer}
            onClick={() => void saveConversationAsNote(expectedKey).then((result) => showFlash(result.message))}
            title={t.saveAsNote}
            type="button"
          >
            {Icon.note()}
          </button>
        </div>
        <div className="pa-paper" title={paper?.title || t.library}>
          {Icon.paper()}
          <span>{paper ? paper.title : t.library}</span>
        </div>
        {flash && <div className="pa-flash">{flash}</div>}
        {menuOpen && <EngineMenu engine={engine} onClose={() => setMenuOpen(false)} onUseWebMode={onUseWebMode} t={t} />}
      </div>

      <div
        className="pa-transcript"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
        }}
        ref={scrollRef}
      >
        {!messages.length && (
          <div className="pa-empty">
            <div className="pa-empty-title">{paper ? t.emptyPaperTitle : t.emptyLibraryTitle}</div>
            <div className="pa-empty-body">{t.emptyBody(engineName)}</div>
          </div>
        )}
        {conversation &&
          messages.map((message, index) => (
            <MessageView
              animate={message.createdAt >= shownSince}
              engine={engine}
              isLast={index === messages.length - 1}
              key={message.id}
              message={message}
              notice={turn.notice}
              running={turn.running}
              stateKey={expectedKey}
              t={t}
            />
          ))}
        <SetupCard engine={engine} status={status} t={t} />
      </div>

      <div className="pa-composer">
        {quickPrompts.length > 0 && (
          <div className="pa-quick">
            {quickPrompts.map(([label, prompt]) => (
              <button
                className="pa-quick-button"
                disabled={turn.running || !ready || !conversation}
                key={label}
                onClick={() => send(prompt)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="pa-input">
          <textarea
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send(draft);
              }
            }}
            placeholder={paper ? t.placeholderPaper(engineName) : t.placeholderLibrary(engineName)}
            ref={textareaRef}
            rows={1}
            value={draft}
          />
          {turn.running ? (
            <button className="pa-send pa-send--stop" onClick={() => stopAgentTurn(expectedKey)} title={t.stop} type="button">
              {Icon.stop()}
            </button>
          ) : (
            <button
              className="pa-send"
              disabled={!draft.trim() || !conversation || (status !== null && !ready)}
              onClick={() => send(draft)}
              title={t.send}
              type="button"
            >
              {Icon.send()}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
