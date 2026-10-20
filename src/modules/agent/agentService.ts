// Paperly Agent's state: each paper's conversation, the turn that is running,
// approvals waiting on the user, and sign-ins. The chat view subscribes and
// re-renders from snapshots; everything that changes goes through here.

import { version } from "../../../package.json";
import { getPref, setPref } from "../../utils/prefs";
import type { ScopeContext } from "../../types/scope";
import { ENGINE_LABELS, getCliStatus } from "./cli";
import type { CliStatus } from "./cli";
import { endpointURL, registerAgentEndpoint, unregisterAgentEndpoint } from "./endpoint";
import { markdownToNoteHtml } from "./markdown";
import { createPaperToolHost, describePaper } from "./paperTools";
import type { NoteApprovalRequest } from "./paperTools";
import { buildSystemPrompt } from "./prompt";
import { startTurn } from "./runner";
import type { RunningTurn } from "./runner";
import { startSignIn } from "./signIn";
import type { SignInFlow, SignInState } from "./signIn";
import { archiveConversation, conversationKey, loadConversation, saveConversation } from "./store";
import type { AgentEvent } from "./streamParser";
import type {
  AgentErrorKind,
  ApprovalPart,
  AssistantPart,
  ChatMessage,
  Conversation,
  EngineId,
  PaperRef,
  ToolPart,
} from "./types";
import { errorMessage, later, newUuid, randomHex, setLibrary } from "./util";

/* -------------------------------------------------------------- settings */

export type ConversationMode = "agent" | "web";
export type AgentEffort = "" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentSettings {
  mode: ConversationMode;
  engine: EngineId;
  claudeModel: string;
  codexModel: string;
  effort: AgentEffort;
  webSearch: boolean;
}

export const CLAUDE_MODELS = ["", "opus", "sonnet", "haiku"];
export const EFFORTS: AgentEffort[] = ["", "low", "medium", "high", "xhigh", "max"];

function stringPref(name: string, fallback: string): string {
  const value = getPref(name);
  return typeof value === "string" ? value : fallback;
}

export function getAgentSettings(): AgentSettings {
  const engine = stringPref("agent.engine", "claude");
  const effort = stringPref("agent.effort", "") as AgentEffort;
  return {
    mode: stringPref("agent.conversationMode", "agent") === "web" ? "web" : "agent",
    engine: engine === "codex" ? "codex" : "claude",
    claudeModel: stringPref("agent.claudeModel", ""),
    codexModel: stringPref("agent.codexModel", ""),
    effort: EFFORTS.includes(effort) ? effort : "",
    webSearch: getPref("agent.webSearch") !== false,
  };
}

export function setAgentSettings(patch: Partial<AgentSettings>): void {
  if (patch.mode !== undefined) setPref("agent.conversationMode", patch.mode);
  if (patch.engine !== undefined) setPref("agent.engine", patch.engine);
  if (patch.claudeModel !== undefined) setPref("agent.claudeModel", patch.claudeModel);
  if (patch.codexModel !== undefined) setPref("agent.codexModel", patch.codexModel);
  if (patch.effort !== undefined) setPref("agent.effort", patch.effort);
  if (patch.webSearch !== undefined) setPref("agent.webSearch", patch.webSearch);
  notify(true);
}

function endpointToken(): string {
  let token = stringPref("agent.token", "");
  if (!/^[0-9a-f]{64}$/.test(token)) {
    token = randomHex(32);
    setPref("agent.token", token);
  }
  return token;
}

/* ------------------------------------------------------------ listeners */

const listeners = new Set<() => void>();
let notifyPending: (() => void) | null = null;

export function subscribeAgent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Streaming text arrives many times a second; the view redraws at most ~25 times. */
function notify(immediate = false): void {
  const run = () => {
    notifyPending = null;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        Zotero.logError(error as Error);
      }
    }
  };
  if (immediate) {
    notifyPending?.();
    run();
    return;
  }
  if (!notifyPending) {
    notifyPending = later(run, 40);
  }
}

/* --------------------------------------------------------- conversations */

interface ActiveTurn {
  turnId: string;
  stateKey: string;
  assistantId: string;
  run: RunningTurn | null;
  stopRequested: boolean;
  notice?: string;
  approvals: Map<string, (answer: "allowed" | "denied" | "expired") => void>;
}

const conversations = new Map<string, Conversation>();
const loading = new Map<string, Promise<Conversation>>();
const activeTurns = new Map<string, ActiveTurn>();
const turnsById = new Map<string, ActiveTurn>();
const pendingSaves = new Map<string, () => void>();

export function stateKeyFor(engine: EngineId, paper: PaperRef | null): string {
  return `${engine}:${conversationKey(paper)}`;
}

/** The paper a panel scope is about, or null for the library at large. */
export function paperFromScope(scope: ScopeContext | null): PaperRef | null {
  if (!scope || (scope.type !== "pdf" && scope.type !== "paper") || !scope.itemIds.length) {
    return null;
  }
  const item = Zotero.Items.get(scope.itemIds[0]) as Zotero.Item | false;
  if (!item || item.deleted || item.isNote()) {
    return null;
  }
  const paper = item.isAttachment() && item.parentItem ? (item.parentItem as Zotero.Item) : item;
  return { libraryID: paper.libraryID, key: paper.key, title: paper.getDisplayTitle() || "Untitled" };
}

export async function openConversation(engine: EngineId, paper: PaperRef | null): Promise<string> {
  const key = stateKeyFor(engine, paper);
  if (conversations.has(key)) {
    const existing = conversations.get(key)!;
    if (paper && existing.paper?.title !== paper.title) {
      existing.paper = paper;
    }
    return key;
  }
  let pending = loading.get(key);
  if (!pending) {
    pending = loadConversation(engine, paper);
    loading.set(key, pending);
  }
  const conversation = await pending;
  loading.delete(key);
  if (!conversations.has(key)) {
    conversations.set(key, conversation);
  }
  notify(true);
  return key;
}

export function getConversation(stateKey: string): Conversation | null {
  return conversations.get(stateKey) || null;
}

export function getTurnState(stateKey: string): { running: boolean; notice?: string } {
  const turn = activeTurns.get(stateKey);
  return turn ? { running: true, notice: turn.notice } : { running: false };
}

function scheduleSave(stateKey: string): void {
  if (pendingSaves.has(stateKey)) {
    return;
  }
  pendingSaves.set(
    stateKey,
    later(() => {
      pendingSaves.delete(stateKey);
      void flushSave(stateKey);
    }, 500),
  );
}

async function flushSave(stateKey: string): Promise<void> {
  const conversation = conversations.get(stateKey);
  if (!conversation) {
    return;
  }
  try {
    await saveConversation(conversation);
  } catch (error) {
    Zotero.logError(error as Error);
  }
}

function findMessage(conversation: Conversation, id: string): ChatMessage | undefined {
  return conversation.messages.find((message) => message.id === id);
}

function appendText(message: ChatMessage, kind: "text" | "thinking", delta: string, newBlock?: boolean): void {
  const parts = (message.parts ||= []);
  const last = parts[parts.length - 1];
  if (!newBlock && last && last.kind === kind) {
    last.text += delta;
    return;
  }
  parts.push({ kind, text: delta });
}

function setError(message: ChatMessage, kind: AgentErrorKind, text: string): void {
  message.error = { kind, message: text };
  message.status = "error";
}

/* ----------------------------------------------------------------- turns */

const APPROVAL_TIMEOUT_MS = 9 * 60_000;

function applyEvent(turn: ActiveTurn, event: AgentEvent): void {
  const conversation = conversations.get(turn.stateKey);
  const message = conversation && findMessage(conversation, turn.assistantId);
  if (!conversation || !message) {
    return;
  }
  const meta = (message.meta ||= {});
  switch (event.type) {
    case "session":
      conversation.sessionId = event.sessionId;
      if (event.model) meta.model = event.model;
      if (event.authSource) meta.authMethod = event.authSource;
      scheduleSave(turn.stateKey);
      break;
    case "text":
    case "thinking":
      turn.notice = undefined;
      appendText(message, event.type, event.delta, event.newBlock);
      break;
    case "tool_started": {
      turn.notice = undefined;
      const parts = (message.parts ||= []);
      const existing = parts.find((part): part is ToolPart => part.kind === "tool" && part.id === event.id);
      if (existing) {
        existing.name = event.name || existing.name;
        if (event.input) existing.input = event.input;
      } else {
        parts.push({ kind: "tool", id: event.id, name: event.name, input: event.input, status: "running" });
      }
      break;
    }
    case "tool_done": {
      const part = message.parts?.find((candidate): candidate is ToolPart => candidate.kind === "tool" && candidate.id === event.id);
      if (part) {
        part.status = event.ok ? "ok" : "error";
        part.output = event.output;
      }
      break;
    }
    case "retry":
      turn.notice = `Retrying (attempt ${event.attempt})${event.reason ? `: ${event.reason}` : ""}…`;
      break;
    case "rate_limit":
      if (event.status === "allowed_warning") {
        turn.notice = "You are close to your plan's usage limit.";
      } else if (event.status === "rejected") {
        const when = event.resetsAt ? new Date(event.resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
        turn.notice = `Your plan's usage limit is reached${when ? `; it resets at ${when}` : ""}.`;
      }
      break;
    case "error":
      setError(message, event.kind, event.message);
      break;
    case "done":
      if (event.model) meta.model = event.model;
      if (event.durationMs !== undefined) meta.durationMs = event.durationMs;
      if (event.inputTokens !== undefined) meta.inputTokens = event.inputTokens;
      if (event.outputTokens !== undefined) meta.outputTokens = event.outputTokens;
      if (event.costUsd !== undefined) meta.costUsd = event.costUsd;
      if (!event.ok && !message.error) {
        setError(message, event.errorKind || "api", event.message || "The agent stopped with an error.");
      } else if (event.ok && !message.error) {
        message.status = "done";
      }
      break;
    default:
      break;
  }
  conversation.updatedAt = Date.now();
  notify();
}

function requestNoteApproval(request: NoteApprovalRequest): Promise<"allowed" | "denied" | "expired" | "no_turn"> {
  const turn = turnsById.get(request.turnId);
  const conversation = turn && conversations.get(turn.stateKey);
  const message = turn && conversation && findMessage(conversation, turn.assistantId);
  if (!turn || !message || turn.stopRequested) {
    return Promise.resolve("no_turn");
  }
  const part: ApprovalPart = {
    kind: "approval",
    id: randomHex(8),
    action: "add_note",
    title: request.title,
    preview: request.markdown,
    status: "pending",
  };
  (message.parts ||= []).push(part);
  notify(true);
  return new Promise((resolve) => {
    const settle = (answer: "allowed" | "denied" | "expired") => {
      cancel();
      turn.approvals.delete(part.id);
      part.status = answer;
      notify(true);
      scheduleSave(turn.stateKey);
      resolve(answer);
    };
    const cancel = later(() => settle("expired"), APPROVAL_TIMEOUT_MS);
    turn.approvals.set(part.id, settle);
  });
}

export function answerApproval(approvalId: string, allow: boolean): void {
  for (const turn of turnsById.values()) {
    const settle = turn.approvals.get(approvalId);
    if (settle) {
      settle(allow ? "allowed" : "denied");
      return;
    }
  }
}

function effortFor(engine: EngineId, effort: AgentEffort): string | undefined {
  if (!effort) {
    return undefined;
  }
  if (engine === "codex") {
    return effort === "xhigh" || effort === "max" ? "high" : effort;
  }
  return effort;
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function sendAgentMessage(stateKey: string, rawText: string): Promise<void> {
  const conversation = conversations.get(stateKey);
  const text = rawText.trim();
  if (!conversation || !text || activeTurns.has(stateKey)) {
    return;
  }
  const engine = conversation.engine;
  const settings = getAgentSettings();
  const now = Date.now();
  const userMessage: ChatMessage = { id: randomHex(8), role: "user", createdAt: now, text };
  const assistant: ChatMessage = {
    id: randomHex(8),
    role: "assistant",
    createdAt: now,
    parts: [],
    status: "running",
    meta: { engine },
  };
  conversation.messages.push(userMessage, assistant);
  conversation.updatedAt = now;

  const turn: ActiveTurn = {
    turnId: randomHex(16),
    stateKey,
    assistantId: assistant.id,
    run: null,
    stopRequested: false,
    approvals: new Map(),
  };
  activeTurns.set(stateKey, turn);
  turnsById.set(turn.turnId, turn);
  notify(true);
  scheduleSave(stateKey);

  try {
    const status = await getCliStatus(engine);
    if (!status.path) {
      setError(assistant, "not_installed", `${ENGINE_LABELS[engine]} is not installed on this computer.`);
      return;
    }
    if (status.signedIn === false) {
      setError(assistant, "not_signed_in", `${ENGINE_LABELS[engine]} is not signed in.`);
      return;
    }
    const url = endpointURL();
    if (!url) {
      setError(assistant, "server_off", "Paperly's local server is turned off, so the agent cannot reach your library. Turn it back on in Settings → Advanced.");
      return;
    }
    let retriedLostSession = false;
    for (;;) {
      const paper = conversation.paper || null;
      const described = paper ? await describePaper(paper.libraryID, paper.key) : null;
      const systemPrompt = buildSystemPrompt({
        paper: paper && described ? { ...paper, title: described.title } : paper,
        authors: described?.authors,
        year: described?.year,
        webSearch: settings.webSearch,
        today: todayText(),
      });
      const sessionId = conversation.sessionId;
      turn.run = await startTurn({
        engine,
        cliPath: status.path,
        // The CLI treats a leading "/" as one of its own commands (even
        // /config); a space in front keeps it the user's words.
        prompt: text.startsWith("/") ? ` ${text}` : text,
        systemPrompt,
        sessionId,
        newSessionId: engine === "claude" && !sessionId ? newUuid() : undefined,
        model: (engine === "claude" ? settings.claudeModel : settings.codexModel) || undefined,
        effort: effortFor(engine, settings.effort),
        webSearch: settings.webSearch,
        mcp: { url, token: endpointToken(), turnId: turn.turnId },
        onEvent: (event) => applyEvent(turn, event),
      });
      if (turn.stopRequested) {
        turn.run.stop();
      }
      const outcome = await turn.run.outcome;
      if (outcome.stopped && !outcome.aborted) {
        assistant.status = "stopped";
        break;
      }
      const lost =
        assistant.error?.kind === "session_lost" ||
        /no conversation found with session id/i.test(outcome.stderr);
      if (lost && sessionId && !retriedLostSession) {
        // The CLI no longer has this conversation (its history was cleared):
        // start a new one and say so, rather than failing every turn.
        retriedLostSession = true;
        conversation.sessionId = undefined;
        assistant.error = undefined;
        assistant.status = "running";
        assistant.parts = [{ kind: "notice", text: "The earlier conversation could not be restored, so this answer starts fresh." }];
        notify(true);
        continue;
      }
      if (!outcome.finished && !assistant.error) {
        const detail = outcome.stderr.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 400);
        setError(
          assistant,
          "cli",
          `${ENGINE_LABELS[engine]} stopped unexpectedly${outcome.exitCode !== null ? ` (exit ${outcome.exitCode})` : ""}${detail ? `: ${detail}` : "."}`,
        );
      }
      break;
    }
  } catch (error) {
    setError(assistant, "cli", errorMessage(error));
  } finally {
    for (const settle of [...turn.approvals.values()]) {
      settle("denied");
    }
    // Codex does not report how long a turn took; measure it here.
    if (assistant.meta && assistant.meta.durationMs === undefined && assistant.status !== "error") {
      assistant.meta.durationMs = Date.now() - now;
    }
    if (assistant.status === "running") {
      assistant.status = assistant.error ? "error" : "done";
    }
    for (const part of assistant.parts || []) {
      if (part.kind === "tool" && part.status === "running") {
        part.status = assistant.status === "done" ? "ok" : "error";
      }
    }
    activeTurns.delete(stateKey);
    turnsById.delete(turn.turnId);
    conversation.updatedAt = Date.now();
    notify(true);
    scheduleSave(stateKey);
  }
}

/** Sends the last question again, in place of the answer that failed. */
export async function retryLastMessage(stateKey: string): Promise<void> {
  const conversation = conversations.get(stateKey);
  if (!conversation || activeTurns.has(stateKey)) {
    return;
  }
  const { messages } = conversation;
  const answer = messages[messages.length - 1];
  const question = messages[messages.length - 2];
  if (answer?.role !== "assistant" || question?.role !== "user" || !question.text) {
    return;
  }
  messages.splice(messages.length - 2, 2);
  notify(true);
  await sendAgentMessage(stateKey, question.text);
}

export function stopAgentTurn(stateKey: string): void {
  const turn = activeTurns.get(stateKey);
  if (!turn) {
    return;
  }
  turn.stopRequested = true;
  for (const settle of [...turn.approvals.values()]) {
    settle("denied");
  }
  turn.run?.stop();
  notify(true);
}

export async function startNewConversation(stateKey: string): Promise<void> {
  const conversation = conversations.get(stateKey);
  if (!conversation || activeTurns.has(stateKey)) {
    return;
  }
  pendingSaves.get(stateKey)?.();
  pendingSaves.delete(stateKey);
  try {
    await archiveConversation(conversation);
  } catch (error) {
    Zotero.logError(error as Error);
  }
  conversation.messages = [];
  conversation.sessionId = undefined;
  conversation.updatedAt = Date.now();
  notify(true);
}

function assistantMarkdown(message: ChatMessage): string {
  return (message.parts || [])
    .filter((part): part is Extract<AssistantPart, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** "Save chat as note": the user's own click, so no approval is asked. */
export async function saveConversationAsNote(stateKey: string): Promise<{ ok: boolean; message: string }> {
  const conversation = conversations.get(stateKey);
  if (!conversation || !conversation.messages.some((message) => message.role === "assistant" && assistantMarkdown(message))) {
    return { ok: false, message: "There is nothing to save yet." };
  }
  const engine = ENGINE_LABELS[conversation.engine];
  const body = conversation.messages
    .map((message) =>
      message.role === "user"
        ? `**You:** ${message.text || ""}`
        : `**${engine}:**\n\n${assistantMarkdown(message) || "_(no answer)_"}`,
    )
    .join("\n\n---\n\n");
  const paper = conversation.paper;
  let parent: Zotero.Item | null = null;
  if (paper) {
    const found = (await Zotero.Items.getByLibraryAndKeyAsync(paper.libraryID, paper.key)) as Zotero.Item | false;
    parent = found && !found.deleted ? found : null;
  }
  const date = new Date().toLocaleDateString();
  const title = `Paperly Agent chat: ${paper?.title || "Library"} (${date})`;
  try {
    const note = new Zotero.Item("note");
    setLibrary(note, parent?.libraryID ?? Zotero.Libraries.userLibraryID);
    if (parent?.isRegularItem()) {
      note.parentID = parent.id;
    }
    note.setNote(markdownToNoteHtml(body, title));
    await note.saveTx();
    return {
      ok: true,
      message: parent?.isRegularItem() ? "Saved as a note on this paper." : "Saved as a note in your library.",
    };
  } catch (error) {
    return { ok: false, message: `Could not save the note: ${errorMessage(error)}` };
  }
}

/* --------------------------------------------------------------- engines */

export function getEngineStatus(engine: EngineId, refresh = false): Promise<CliStatus> {
  return getCliStatus(engine, refresh).then((status) => {
    notify();
    return status;
  });
}

const signIns = new Map<EngineId, { flow: SignInFlow | null; state: SignInState }>();

export function getSignInState(engine: EngineId): SignInState | null {
  return signIns.get(engine)?.state || null;
}

export async function beginSignIn(engine: EngineId): Promise<void> {
  const current = signIns.get(engine);
  if (current && ["starting", "waiting", "checking"].includes(current.state.phase)) {
    return;
  }
  const status = await getCliStatus(engine, true);
  if (!status.path) {
    signIns.set(engine, { flow: null, state: { engine, phase: "failed", message: `${ENGINE_LABELS[engine]} is not installed.` } });
    notify(true);
    return;
  }
  const entry: { flow: SignInFlow | null; state: SignInState } = { flow: null, state: { engine, phase: "starting" } };
  signIns.set(engine, entry);
  notify(true);
  entry.flow = await startSignIn(engine, status.path, (state) => {
    entry.state = state;
    if (state.phase === "succeeded") {
      void getEngineStatus(engine, true);
    }
    notify(true);
  });
}

export function submitSignInCode(engine: EngineId, code: string): boolean {
  return signIns.get(engine)?.flow?.submitCode(code) || false;
}

export function cancelSignIn(engine: EngineId): void {
  signIns.get(engine)?.flow?.cancel();
}

export function clearSignIn(engine: EngineId): void {
  signIns.delete(engine);
  notify(true);
}

/* ------------------------------------------------------------- lifecycle */

export function initAgent(): void {
  registerAgentEndpoint(
    (context) => createPaperToolHost(context, { requestNoteApproval, version }),
    endpointToken,
  );
}

export async function shutdownAgent(): Promise<void> {
  for (const stateKey of [...activeTurns.keys()]) {
    stopAgentTurn(stateKey);
  }
  for (const engine of [...signIns.keys()]) {
    cancelSignIn(engine);
  }
  for (const [stateKey, cancel] of [...pendingSaves.entries()]) {
    cancel();
    pendingSaves.delete(stateKey);
    await flushSave(stateKey);
  }
  unregisterAgentEndpoint();
  listeners.clear();
}
