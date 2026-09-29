// Where a paper's reading notes live.
//
// The body is a real Zotero child note on the paper, titled "Paperly Notes".
// That makes it sync, show up in the library, survive the plugin being removed
// and be full-text searchable. A pointer to it -- just the note's key -- goes in
// SyncedSettings so the panel can find the same note on every machine even if
// the user renames its first line.
//
// The body deliberately does NOT live in SyncedSettings: when the server
// rejects a settings upload with 403, the client re-downloads and deletes any
// local key the server does not have (sync/syncEngine.js). That is fine for a
// pointer that can be rebuilt by title, and unacceptable for the only copy of
// what someone typed. It does not live in a preference either: prefs.js is
// flushed lazily and is not transactional, so a crash loses recent keystrokes.
import {
  escapeHTML,
  isEmptyBlocks,
  sanitizeNoteBlocks,
} from "../ui/noteBlocks";
import { getPref, setPref } from "../utils/prefs";

// The plugin sandbox does not reliably have timers of its own, and a debounce
// that never fires would lose every keystroke silently. Same fallback shape as
// resolveTimeoutHost in services/mcpClient.ts.
const hostGlobals = (():
  | {
      setTimeout: (callback: () => void, ms: number) => number;
      clearTimeout: (id: number) => void;
    }
  | never => {
  const scope = globalThis as unknown as {
    setTimeout?: (callback: () => void, ms: number) => number;
    clearTimeout?: (id: number) => void;
  };
  if (
    typeof scope.setTimeout === "function" &&
    typeof scope.clearTimeout === "function"
  ) {
    return {
      setTimeout: (callback, ms) => scope.setTimeout!(callback, ms),
      clearTimeout: (id) => scope.clearTimeout!(id),
    };
  }
  const win = () =>
    Zotero.getMainWindow?.() as
      | {
          setTimeout?: (callback: () => void, ms: number) => number;
          clearTimeout?: (id: number) => void;
        }
      | undefined;
  return {
    setTimeout: (callback, ms) => {
      const host = win();
      if (typeof host?.setTimeout === "function") {
        return host.setTimeout(callback, ms);
      }
      // No timer anywhere: save immediately rather than never.
      callback();
      return 0;
    },
    clearTimeout: (id) => {
      win()?.clearTimeout?.(id);
    },
  };
})();

export const PAPER_NOTE_TITLE = "Paperly Notes";

const ZoteroSynced = Zotero as unknown as {
  SyncedSettings?: {
    get: (libraryID: number, setting: string) => unknown;
    set: (libraryID: number, setting: string, value: unknown) => Promise<unknown>;
    clear: (libraryID: number, setting: string) => Promise<unknown>;
  };
  Notes?: { AUTO_SYNC_DELAY?: number };
};

export interface PaperNoteTarget {
  /** The item the note belongs to: the paper, or a parentless attachment. */
  itemID: number;
  itemKey: string;
  libraryID: number;
  /**
   * True when the reader is open on an attachment with no parent. Zotero only
   * allows child notes under a regular item, so in that case the text goes in
   * the attachment's own embedded note instead of a child of it.
   */
  embedded: boolean;
}

export interface LoadedPaperNote {
  /** Editor-ready block HTML, already through the pad's whitelist. */
  html: string;
  /**
   * The stored note held markup this panel cannot represent (an image, a
   * citation, bold text) and it was flattened for display. Saving would drop
   * it, so the panel says so instead of quietly losing someone's formatting.
   */
  simplified: boolean;
  noteID: number | null;
}

// ---------------------------------------------------------------- identity --

/** The paper behind an open reader, or null if it cannot be resolved. */
export function resolvePaperNoteTarget(
  attachmentID: number | undefined,
): PaperNoteTarget | null {
  if (!attachmentID) {
    return null;
  }
  try {
    const attachment = Zotero.Items.get(attachmentID);
    if (!attachment) {
      return null;
    }
    const parent = attachment.parentItem;
    const item = parent || attachment;
    return {
      itemID: item.id,
      itemKey: item.key,
      libraryID: item.libraryID,
      embedded: !parent,
    };
  } catch {
    return null;
  }
}

export function targetKey(target: PaperNoteTarget): string {
  return `${target.libraryID}/${target.itemKey}`;
}

// Mirrors the key shape Zotero uses for its own per-item synced settings
// (`lastReadAloudPosition_u_<key>`), and like Zotero it always stores on the
// user library even for a group item.
function pointerSettingKey(target: PaperNoteTarget): string | null {
  try {
    const library = Zotero.Libraries.get(target.libraryID);
    if (!library) {
      return null;
    }
    const scope =
      library.libraryType === "user"
        ? "u"
        : library.libraryType === "group"
          ? `g${(library as unknown as { groupID?: number }).groupID ?? ""}`
          : null;
    return scope ? `paperlyNote_${scope}_${target.itemKey}` : null;
  } catch {
    return null;
  }
}

function readPointer(target: PaperNoteTarget): string | null {
  const key = pointerSettingKey(target);
  if (!key) {
    return null;
  }
  try {
    const value = ZoteroSynced.SyncedSettings?.get(
      Zotero.Libraries.userLibraryID,
      key,
    ) as { noteKey?: unknown } | null;
    const noteKey = `${value?.noteKey ?? ""}`;
    return noteKey || null;
  } catch {
    return null;
  }
}

async function writePointer(
  target: PaperNoteTarget,
  noteKey: string,
): Promise<void> {
  const key = pointerSettingKey(target);
  if (!key) {
    return;
  }
  try {
    await ZoteroSynced.SyncedSettings?.set(Zotero.Libraries.userLibraryID, key, {
      v: 1,
      noteKey,
    });
  } catch (error) {
    // The pointer is an optimisation: title matching still finds the note.
    ztoolkit.log("readerNoteStore: could not store the note pointer:", error);
  }
}

// ------------------------------------------------------------------ blocks --

/**
 * The pad's blocks as a Zotero note.
 *
 * The <h1> is the note's identity: Zotero derives a note's title from its first
 * line, and findNoteItem() falls back to that title when the pointer is gone.
 */
export function blocksToNoteHTML(html: string): string {
  const body = parseNoteBody(html);
  const blocks = body ? sanitizeNoteBlocks(body, false).html : "";
  // Zotero wraps this in <div class="zotero-note znv1"> itself on save.
  return `<h1>${escapeHTML(PAPER_NOTE_TITLE)}</h1>${blocks}`;
}

// Parsing needs a document, and the plugin sandbox is not one. Any window will
// do; the result is only read, never attached.
function parseNoteBody(html: string): HTMLElement | null {
  try {
    const win = Zotero.getMainWindow?.() as
      | (Window & { DOMParser?: typeof DOMParser })
      | null;
    if (!win?.DOMParser) {
      return null;
    }
    return new win.DOMParser().parseFromString(html, "text/html").body;
  } catch {
    return null;
  }
}

/** A stored note as blocks the editor can hold. */
export function noteHTMLToBlocks(html: string): {
  html: string;
  simplified: boolean;
} {
  if (!html) {
    return { html: "", simplified: false };
  }
  const body = parseNoteBody(html);
  if (!body) {
    return { html: "", simplified: false };
  }
  // Drop the heading this panel writes, but only when it is still ours: if the
  // note now starts with something else, that is someone's own first line.
  const first = body.firstElementChild;
  if (
    first?.tagName === "H1" &&
    first.textContent?.trim() === PAPER_NOTE_TITLE
  ) {
    first.remove();
  }
  const { html: blocks, dropped } = sanitizeNoteBlocks(body, true);
  return { html: blocks, simplified: dropped };
}

// ------------------------------------------------------------------ items ---

type MutableNote = Zotero.Item & {
  libraryID: number;
  parentKey: string;
};

async function findNoteItem(
  target: PaperNoteTarget,
): Promise<Zotero.Item | null> {
  if (target.embedded) {
    return Zotero.Items.get(target.itemID) || null;
  }
  const pointed = readPointer(target);
  if (pointed) {
    try {
      const note = (await Zotero.Items.getByLibraryAndKeyAsync(
        target.libraryID,
        pointed,
      )) as Zotero.Item | false;
      if (note && !note.deleted) {
        return note;
      }
    } catch {
      // Fall through to the title scan.
    }
  }
  // The pointer can be missing (note made on another machine) or dangling
  // (note trashed). The title is a weaker identity -- it is just the note's
  // first line -- so it is the fallback, not the primary.
  try {
    const paper = Zotero.Items.get(target.itemID);
    for (const id of paper?.getNotes?.(false) || []) {
      const note = Zotero.Items.get(id);
      if (note?.isNote?.() && note.getNoteTitle?.() === PAPER_NOTE_TITLE) {
        void writePointer(target, note.key);
        return note;
      }
    }
  } catch {
    // Nothing to adopt.
  }
  return null;
}

async function createNoteItem(
  target: PaperNoteTarget,
  html: string,
): Promise<Zotero.Item> {
  const paper = Zotero.Items.get(target.itemID);
  const note = new Zotero.Item("note");
  const mutable = note as unknown as MutableNote;
  mutable.libraryID = target.libraryID;
  mutable.parentKey = paper.key;
  note.setNote(blocksToNoteHTML(html));
  await note.saveTx(saveOptions());
  await writePointer(target, note.key);
  return note;
}

function saveOptions(): Record<string, unknown> {
  return {
    notifierData: {
      // Notes get a longer auto-sync delay than the 3s default precisely
      // because they are saved while someone types.
      autoSyncDelay: ZoteroSynced.Notes?.AUTO_SYNC_DELAY ?? 15,
      paperlyNoteSave: true,
    },
  };
}

export async function loadPaperNote(
  target: PaperNoteTarget,
): Promise<LoadedPaperNote> {
  const note = await findNoteItem(target);
  if (!note) {
    return { html: "", simplified: false, noteID: null };
  }
  try {
    await note.loadDataType?.("note");
  } catch {
    // getNote() below will throw instead, and that is caught.
  }
  try {
    const parsed = noteHTMLToBlocks(`${note.getNote?.() || ""}`);
    return { ...parsed, noteID: note.id };
  } catch {
    return { html: "", simplified: false, noteID: note.id };
  }
}

// ------------------------------------------------------------------ saving --

// Idle debounce with a hard ceiling. Zotero's own note editor uses a plain
// trailing debounce and carries a standing TODO about it: without a maximum
// wait, someone who types without pausing has nothing on disk for as long as
// they keep going.
const IDLE_MS = 600;
const MAX_WAIT_MS = 2500;

interface PendingSave {
  target: PaperNoteTarget;
  html: string;
  idleTimer: number | null;
  ceilingTimer: number | null;
  /** Told how the write went, so the panel can stop saying "Saving…". */
  onSettled?: (error?: unknown) => void;
}

const pending = new Map<string, PendingSave>();
// One promise chain per note, so two commits for the same paper can never
// interleave a read-modify-write.
const chains = new Map<string, Promise<void>>();
const inFlight = new Set<Promise<void>>();

async function commit(entry: PendingSave): Promise<void> {
  const html = entry.html;
  const note = await findNoteItem(entry.target);
  if (!note) {
    if (isEmptyBlocks(html)) {
      // Never create a note for an empty panel.
      return;
    }
    await createNoteItem(entry.target, html);
    return;
  }
  try {
    await note.loadDataType?.("note");
  } catch {
    // setNote below still works; only the unchanged-check needs the old value.
  }
  // setNote returns false when the text is identical, which keeps a re-render
  // or a focus change from writing to the database.
  if (!note.setNote(blocksToNoteHTML(html))) {
    return;
  }
  await note.saveTx(saveOptions());
}

function clearTimers(entry: PendingSave): void {
  if (entry.idleTimer) {
    hostGlobals.clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  if (entry.ceilingTimer) {
    hostGlobals.clearTimeout(entry.ceilingTimer);
    entry.ceilingTimer = null;
  }
}

function run(key: string): void {
  const entry = pending.get(key);
  if (!entry) {
    return;
  }
  clearTimers(entry);
  pending.delete(key);
  const next = (chains.get(key) || Promise.resolve())
    .then(() => commit(entry))
    .then(() => entry.onSettled?.())
    .catch((error) => {
      ztoolkit.log("readerNoteStore: save failed:", error);
      try {
        entry.onSettled?.(error);
      } catch {
        // A failing status update must not mask the save error.
      }
    });
  chains.set(key, next);
  inFlight.add(next);
  void next.finally(() => {
    inFlight.delete(next);
    if (chains.get(key) === next) {
      chains.delete(key);
    }
  });
}

/** Record what the panel currently holds. Writes settle a moment later. */
export function queuePaperNoteSave(
  target: PaperNoteTarget,
  html: string,
  onSettled?: (error?: unknown) => void,
): void {
  const key = targetKey(target);
  const existing = pending.get(key);
  if (existing) {
    existing.html = html;
    existing.onSettled = onSettled;
    if (existing.idleTimer) {
      hostGlobals.clearTimeout(existing.idleTimer);
    }
    existing.idleTimer = hostGlobals.setTimeout(() => run(key), IDLE_MS);
    return;
  }
  pending.set(key, {
    target,
    html,
    onSettled,
    idleTimer: hostGlobals.setTimeout(() => run(key), IDLE_MS),
    // The ceiling is armed once per burst, not reset on every keystroke:
    // that is what makes it a ceiling.
    ceilingTimer: hostGlobals.setTimeout(() => run(key), MAX_WAIT_MS),
  });
}

/** Write everything outstanding and wait for it. Call before anything closes. */
export async function flushPaperNoteSaves(): Promise<void> {
  for (const key of [...pending.keys()]) {
    run(key);
  }
  await Promise.allSettled([...inFlight]);
}

/** True while this paper has unwritten keystrokes. */
export function hasPendingPaperNoteSave(target: PaperNoteTarget): boolean {
  return pending.has(targetKey(target));
}

// ---------------------------------------------------- external note edits ---

type NoteChangeListener = (noteIDs: number[]) => void;

const changeListeners = new Set<NoteChangeListener>();
let changeNotifierID: string | null = null;

/**
 * Fires when a note item changes anywhere OTHER than through this module --
 * Zotero's own note editor, a second reader window, a sync. Saves made here
 * carry a marker in notifierData and are filtered out, the same guard Zotero's
 * note editor uses against itself.
 */
export function subscribePaperNoteChanges(
  listener: NoteChangeListener,
): () => void {
  if (changeListeners.size === 0) {
    try {
      changeNotifierID = Zotero.Notifier.registerObserver(
        {
          notify: (
            event: string,
            type: string,
            ids: (string | number)[],
            extraData: Record<string, { paperlyNoteSave?: boolean }>,
          ) => {
            if (event !== "modify" || type !== "item") {
              return;
            }
            const foreign = ids
              .map((id) => Number(id))
              .filter((id) => !extraData?.[id]?.paperlyNoteSave);
            if (foreign.length) {
              for (const cb of [...changeListeners]) {
                try {
                  cb(foreign);
                } catch {
                  // One bad listener must not stop the others.
                }
              }
            }
          },
        },
        ["item"],
        "paperly-reader-note",
      );
    } catch {
      changeNotifierID = null;
    }
  }
  changeListeners.add(listener);
  return () => {
    if (!changeListeners.delete(listener)) {
      return;
    }
    if (changeListeners.size === 0 && changeNotifierID) {
      try {
        Zotero.Notifier.unregisterObserver(changeNotifierID);
      } catch {
        // Already gone.
      }
      changeNotifierID = null;
    }
  };
}

// ------------------------------------------------------------------- prefs --

const FONT_PREF = "readerNoteFont";
const BACKGROUND_PREF = "readerNoteBackground";
const GEOMETRY_PREF = "readerNoteGeometry";

export function getNoteFontPref(): string {
  return `${getPref(FONT_PREF) ?? ""}`;
}

/** The pad's background: a hex from the palette, or follow-the-paper. */
export function getNoteBackgroundPref(): string {
  return `${getPref(BACKGROUND_PREF) ?? ""}`;
}

export function setNoteBackgroundPref(value: string): void {
  setPref(BACKGROUND_PREF, value);
}

export function setNoteFontPref(id: string): void {
  setPref(FONT_PREF, id);
}

export interface NoteGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getNoteGeometryPref(): Partial<NoteGeometry> | null {
  try {
    const raw = `${getPref(GEOMETRY_PREF) ?? ""}`;
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<NoteGeometry>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function setNoteGeometryPref(geometry: NoteGeometry): void {
  try {
    setPref(GEOMETRY_PREF, JSON.stringify(geometry));
  } catch {
    // Geometry is a convenience; losing it is not worth surfacing.
  }
}
