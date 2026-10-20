// Small runtime helpers for Paperly Agent: timers, ids, the agent's folder.

/** setTimeout through the main window; the plugin's own scope has none. */
export function later(callback: () => void, ms: number): () => void {
  const win = Zotero.getMainWindow?.() as unknown as (Window & typeof globalThis) | null;
  if (win) {
    const handle = win.setTimeout(callback, ms);
    return () => win.clearTimeout(handle);
  }
  let cancelled = false;
  void Zotero.Promise.delay(ms).then(() => {
    if (!cancelled) {
      callback();
    }
  });
  return () => {
    cancelled = true;
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    later(resolve, ms);
  });
}

/** Hex from a cryptographic source: tokens and turn ids are secrets. */
export function randomHex(bytes = 16): string {
  const win = Zotero.getMainWindow?.() as unknown as (Window & typeof globalThis) | null;
  const values = new Uint8Array(bytes);
  if (win?.crypto?.getRandomValues) {
    win.crypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
  }
  let hex = "";
  while (hex.length < bytes * 2) {
    hex += Services.uuid.generateUUID().toString().replace(/[{}-]/g, "");
  }
  return hex.slice(0, bytes * 2);
}

export function newUuid(): string {
  return Services.uuid.generateUUID().toString().replace(/[{}]/g, "");
}

/** <profile>/paperly-agent: conversations, the empty work folder, per-turn config. */
export function agentDirectory(...parts: string[]): string {
  return PathUtils.join(PathUtils.profileDir, "paperly-agent", ...parts);
}

/** A new item's library, before its first save (typed read-only, settable until then). */
export function setLibrary(item: Zotero.Item, libraryID: number): void {
  (item as unknown as { libraryID: number }).libraryID = libraryID;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
