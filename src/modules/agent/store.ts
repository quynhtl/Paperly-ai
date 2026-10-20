// Where Paperly Agent keeps each paper's conversation: one JSON file per
// paper and engine under <profile>/paperly-agent/conversations/.
//
// The CLI remembers the conversation itself (its session, resumed with
// --resume), but only for the model; this is what the chat view shows again
// after a restart or a tab switch.

import type { ChatMessage, Conversation, EngineId, PaperRef } from "./types";
import { agentDirectory } from "./util";

const MESSAGE_LIMIT = 400;

export function conversationKey(paper: PaperRef | null): string {
  return paper ? `${paper.libraryID}_${paper.key}` : "library";
}

function conversationPath(engine: EngineId, key: string): string {
  return agentDirectory("conversations", engine, `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function emptyConversation(engine: EngineId, paper: PaperRef | null): Conversation {
  return {
    version: 1,
    key: conversationKey(paper),
    engine,
    ...(paper ? { paper } : {}),
    messages: [],
    updatedAt: Date.now(),
  };
}

function isMessage(value: unknown): value is ChatMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as ChatMessage).id === "string" &&
      ((value as ChatMessage).role === "user" || (value as ChatMessage).role === "assistant"),
  );
}

export async function loadConversation(
  engine: EngineId,
  paper: PaperRef | null,
): Promise<Conversation> {
  const fallback = emptyConversation(engine, paper);
  try {
    const stored = (await IOUtils.readJSON(conversationPath(engine, fallback.key))) as Partial<Conversation>;
    if (!stored || stored.version !== 1 || !Array.isArray(stored.messages)) {
      return fallback;
    }
    const messages = stored.messages.filter(isMessage).map((message) =>
      // A turn that was running when Paperly quit did not finish.
      message.status === "running" ? { ...message, status: "stopped" as const } : message,
    );
    return {
      ...fallback,
      sessionId: typeof stored.sessionId === "string" ? stored.sessionId : undefined,
      paper: paper || stored.paper,
      messages,
      updatedAt: typeof stored.updatedAt === "number" ? stored.updatedAt : Date.now(),
    };
  } catch {
    return fallback;
  }
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  const path = conversationPath(conversation.engine, conversation.key);
  await IOUtils.makeDirectory(PathUtils.parent(path)!, { createAncestors: true, ignoreExisting: true });
  const trimmed: Conversation = {
    ...conversation,
    messages: conversation.messages.slice(-MESSAGE_LIMIT),
  };
  await IOUtils.writeJSON(path, trimmed, { tmpPath: `${path}.tmp` });
}

/** Keeps the old conversation beside the new, empty one rather than deleting it. */
export async function archiveConversation(conversation: Conversation): Promise<void> {
  if (!conversation.messages.length) {
    return;
  }
  const path = conversationPath(conversation.engine, conversation.key);
  const stamp = new Date(conversation.updatedAt || Date.now()).toISOString().replace(/[:.]/g, "-");
  const archive = agentDirectory(
    "conversations",
    conversation.engine,
    "archive",
    `${conversation.key.replace(/[^A-Za-z0-9_-]/g, "_")}-${stamp}.json`,
  );
  await IOUtils.makeDirectory(PathUtils.parent(archive)!, { createAncestors: true, ignoreExisting: true });
  try {
    await IOUtils.writeJSON(archive, conversation, { tmpPath: `${archive}.tmp` });
  } finally {
    await IOUtils.remove(path, { ignoreAbsent: true });
  }
}
