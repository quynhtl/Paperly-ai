// A note pad for the paper you are reading, opened from the reader toolbar.
//
// It lives inside the reader's own document rather than in the Zotero window,
// for two reasons. Binding: one reader document is one paper, so the panel can
// never attach to the wrong item, which is the failure mode every "which tab is
// active?" design in this plugin has hit. Looks: the paper's colours are right
// there, so the pad can sit on the page as if it belonged to it.
//
// The price is that the reader owns the keyboard. `KeyboardManager` and
// `FocusManager` both listen for keydown in CAPTURE phase on the reader
// iframe's window, so nothing inside the document can get in front of them.
// Their escape hatch is `isTextBox()`, which accepts `input[type=text]` and
// `[contenteditable="true"]` -- and NOT `<textarea>`
// (reader/src/common/lib/utilities.js). A textarea here would let `h` toggle
// the hand tool and a digit repaint the highlight colour while someone types.
// Hence contenteditable.
//
// Two more consequences of that are load-bearing and deliberate:
//   * The panel does NOT carry any of `.annotation, .annotation-popup,
//     .selection-popup, .label-popup, .appearance-popup, .context-menu`.
//     Because it does not, focusing it makes the reader deselect annotations
//     (focus-manager.js `_handleFocus`) -- which is exactly what keeps
//     Backspace from deleting a highlight and Cmd-C from copying an annotation
//     instead of the note text. The reader's guards become the panel's.
//   * Tab is not the note's to take: FocusManager preventDefaults it
//     unconditionally and moves focus to the next toolbar group. Inside a
//     table the pad puts the caret back and moves it to the next cell itself.
import {
  flushPaperNoteSaves,
  getNoteFontPref,
  getNoteBackgroundPref,
  getNoteGeometryPref,
  hasPendingPaperNoteSave,
  loadPaperNote,
  queuePaperNoteSave,
  resolvePaperNoteTarget,
  setNoteBackgroundPref,
  setNoteFontPref,
  setNoteGeometryPref,
  subscribePaperNoteChanges,
  type PaperNoteTarget,
} from "../services/readerNoteStore";
import {
  PAPER_BACKGROUND,
  inkFor,
  isPaperBackground,
  normalizeBackground,
  schemeFor,
  swatchNamed,
} from "../ui/noteColors";
import {
  closeColorMenu,
  destroyColorMenus,
  isColorMenuOpen,
  openColorMenu,
  syncColorMenuTheme,
} from "./readerNoteColorMenu";
import {
  NOTE_FONTS,
  ensureNoteFontLoaded,
  getNoteFont,
  noteFontStack,
  type ReaderNoteFontId,
} from "../ui/readerNoteFonts";
import {
  ensureOverlayDock,
  openDockClip,
  setDockClip,
  destroyOverlayDock,
  destroyOverlayDocks,
  type OverlayDock,
} from "./overlayDock";
import {
  resolveReaderPaperTheme,
  subscribeReaderThemeSources,
  type PaperTheme,
} from "../ui/readerTheme";
import {
  buildIcon,
  isEmptyBlocks,
  type IconPath,
  type NoteBlockId,
} from "../ui/noteBlocks";
import {
  closeEmojiPicker,
  destroyEmojiPickers,
  openEmojiPicker,
  syncEmojiPickerTheme,
} from "./readerNoteEmojiPicker";
import {
  blockMenuKeyDown,
  closeBlockMenu,
  destroyBlockMenus,
  isBlockMenuOpen,
  moveBlockMenu,
  openBlockMenu,
  syncBlockMenuTheme,
  updateBlockMenu,
} from "./readerNoteBlockMenu";
import {
  applyBlock,
  applyInputRules,
  blockIdOf,
  caretText,
  clearFormatting,
  clearLink,
  currentBlock,
  currentCell,
  selectionIsAllHeadings,
  decorateTodos,
  deleteTextRange,
  markStateAt,
  normalizeStructure,
  ensureTrailingParagraph,
  handleEditorKeyDown,
  pinCommandStyle,
  setHighlight,
  setLink,
  toggleMark,
  toggleTodoAt,
  type EditContext,
  type NoteMarkId,
} from "./readerNoteEditing";
import {
  closeFormatBar,
  destroyFormatBars,
  editFormatBarLink,
  isFormatBarEditing,
  isFormatBarOpen,
  showFormatBar,
  syncFormatBarTheme,
  type FormatAction,
} from "./readerNoteFormatBar";
import {
  applyColumnWidths,
  installTableUI,
  moveBetweenCells,
  tableStyles,
} from "./readerNoteTable";
import { isChineseLocale } from "../utils/locale";

const BUTTON_ID = "paperly-reader-note-button";
const PANEL_ID = "paperly-reader-note-panel";
const STYLE_ID = "paperly-reader-note-style";

// Above the sidebar (10) and its resizers (20), below the toolbar (30) and
// every reader popup, so a context menu or the find bar is never covered.
const PANEL_Z_INDEX = 25;

const MIN_WIDTH = 260;
const MIN_HEIGHT = 200;
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 440;
const EDGE_GAP = 16;
// The reader toolbar is 41px tall; keep the pad clear of it.
const TOOLBAR_GAP = 52;
// How near an edge the pad has to come before it is pulled onto it. Big enough
// to feel like the edge wants it, small enough that a deliberate 20px offset
// still survives.
const SNAP_RADIUS = 16;
// Opening is the gesture worth watching; closing just has to get out of the way.
const OPEN_MS = 220;
const CLOSE_MS = 140;

interface ReaderLike {
  itemID?: number;
  _iframeWindow?: Window;
}

interface Surface {
  /** The chrome window the pad floats over. */
  mainWindow: Window;
  dock: OverlayDock;
  /** The dock's document, where every part of the pad is built. */
  doc: Document;
  /**
   * The paper the pad is pinned to. It does not follow the selected tab: the
   * point of the pad is to keep writing about one paper while reading another.
   */
  reader: ReaderLike;
  /** That paper's reader document, so its tab closing can close the pad. */
  readerDoc: Document | null;
  /** Its name, for the footer. Read once when pinned rather than per status. */
  paperTitle: string;
  panel: HTMLElement | null;
  editor: HTMLElement | null;
  /** Sits over the editor and holds the table handles. */
  overlay: HTMLElement | null;
  status: HTMLElement | null;
  target: PaperNoteTarget | null;
  noteID: number | null;
  /** Set while the editor is being filled, so that does not count as typing. */
  loading: boolean;
  /**
   * Where the caret was when the emoji picker took focus. The picker's search
   * field has to be focusable, so the selection has to be put back by hand.
   */
  savedRange: Range | null;
  simplified: boolean;
  /** The block the open "/" menu was summoned from, and where its slash is. */
  slashBlock: HTMLElement | null;
  slashOffset: number;
  /**
   * Set for as long as the closing animation runs. The panel is still
   * `hidden = false` then, so without this a second click on the button would
   * read it as open and try to close it again.
   */
  closing: number | null;
  /**
   * Set while the pad is being carried. The clip is opened to the whole window
   * for the duration and nothing may cut it back: a pointer that runs ahead of
   * the pad would land on the pane underneath, and the pad would stop
   * following it.
   */
  dragging: boolean;
  teardown: (() => void)[];
}

/** One pad per chrome window. */
const surfaces = new Map<Window, Surface>();

/**
 * One toolbar button per open reader, and one pad between them. A button reads
 * as pressed only when the pad is open and pinned to that button's paper.
 */
interface ButtonEntry {
  reader: ReaderLike;
  button: HTMLElement;
  anchorObserver: MutationObserver | null;
  /** Detaches this document's half of the outside-press watch. */
  unwatch: () => void;
}
const buttons = new Map<Document, ButtonEntry>();

function text(en: string, zh: string): string {
  return isChineseLocale() ? zh : en;
}

function surfaceFor(
  win: Window,
  dock: OverlayDock,
  reader: ReaderLike,
  readerDoc: Document | null,
): Surface {
  const existing = surfaces.get(win);
  if (existing) {
    return existing;
  }
  const surface: Surface = {
    mainWindow: win,
    dock,
    doc: dock.doc,
    reader,
    readerDoc,
    paperTitle: "",
    panel: null,
    editor: null,
    overlay: null,
    status: null,
    target: null,
    noteID: null,
    loading: false,
    savedRange: null,
    simplified: false,
    slashBlock: null,
    slashOffset: 0,
    closing: null,
    dragging: false,
    teardown: [],
  };
  surfaces.set(win, surface);

  // The window's half of the watch that puts the pad's menus away: Zotero's
  // own chrome, which is this document. The guard is not a nicety -- see
  // insideDock.
  const onAway = (event: Event): void => {
    if (insideDock(surface, event.target)) {
      return;
    }
    closePadOverlays(surface);
  };
  win.document.addEventListener("pointerdown", onAway, true);
  surface.teardown.push(() =>
    win.document.removeEventListener("pointerdown", onAway, true),
  );

  // The overlays -- format bar, "/" menu, colours, emoji -- are separate
  // roots that appear, move and resize on their own as they filter. Rather
  // than have four modules report their boxes, the clip is re-derived on the
  // next frame after anything in the dock changes. setDockClip skips the
  // write when the path is the same, which most of these will be.
  const view = dock.doc.defaultView as
    | (Window & { MutationObserver?: typeof MutationObserver })
    | null;
  if (view?.MutationObserver && dock.doc.body) {
    let queued = 0;
    const observer = new view.MutationObserver(() => {
      if (queued) {
        return;
      }
      queued = view.requestAnimationFrame(() => {
        queued = 0;
        if (isLive(surface)) {
          syncClip(surface);
        }
      });
    });
    observer.observe(dock.doc.body, {
      attributeFilter: ["style", "hidden", "class"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    surface.teardown.push(() => {
      if (queued) {
        view.cancelAnimationFrame(queued);
      }
      observer.disconnect();
    });
  }

  const onUnload = (): void => {
    void flushPaperNoteSaves();
    destroyReaderNoteSurface(win);
  };
  win.addEventListener("unload", onUnload, { once: true });
  surface.teardown.push(() => win.removeEventListener("unload", onUnload));

  return surface;
}

/** False once the window's pad has been torn down or replaced. */
function isLive(surface: Surface): boolean {
  return surfaces.get(surface.mainWindow) === surface;
}

/** The pad is open when it is on screen and not on its way out. */
function isPadOpen(surface: Surface | null | undefined): boolean {
  return Boolean(
    surface?.panel && !surface.panel.hidden && surface.closing === null,
  );
}

function refreshButtons(): void {
  for (const entry of buttons.values()) {
    let pressed = false;
    for (const surface of surfaces.values()) {
      if (isPadOpen(surface) && surface.reader === entry.reader) {
        pressed = true;
        break;
      }
    }
    entry.button.classList.toggle("active", pressed);
    entry.button.setAttribute("aria-pressed", pressed ? "true" : "false");
  }
}

/**
 * Whether a press landed inside the pad's own frame.
 *
 * A chrome iframe's chrome event handler is the frame element, so a press
 * inside the dock carries on into the window's document -- with the pad's own
 * button still as its target, not the frame. Anything watching the window for
 * presses "outside" the pad therefore has to say what outside means. Measured
 * the hard way: an unguarded watcher fired on every press on the pad and tore
 * the open menu down before its click could run, so no swatch, emoji or "/"
 * entry could be picked at all.
 */
function insideDock(surface: Surface, target: EventTarget | null): boolean {
  if (!target) {
    return false;
  }
  if (target === surface.dock.frame || target === surface.doc) {
    return true;
  }
  return (target as Node).ownerDocument === surface.doc;
}

/** Puts away everything the pad has open, and takes the room back. */
function closePadOverlays(surface: Surface): void {
  closeEmojiPicker(surface.doc);
  closeBlockMenu(surface.doc);
  closeColorMenu(surface.doc);
  closeFormatBar(surface.doc);
  syncClip(surface);
}

/**
 * Limits the dock to what the pad actually occupies, so every pixel outside it
 * belongs to the paper and the column again.
 *
 * The overlays are separate roots in the same document rather than children of
 * the pad, so each one is measured on its own.
 */
const OVERLAY_IDS = [
  "paperly-note-format",
  "paperly-note-blocks",
  "paperly-note-colors",
  "paperly-note-emoji",
];

function syncClip(surface: Surface): void {
  // The drag owns the clip until it lands. Writing the pad's transform is an
  // attribute change like any other, so without this the observer below would
  // cut the clip back to the pad on every single pointermove.
  if (surface.dragging) {
    return;
  }
  if (!isPadOpen(surface) && surface.closing === null) {
    setDockClip(surface.dock, []);
    return;
  }
  const boxes: DOMRect[] = [];
  const panel = surface.panel;
  if (panel && !panel.hidden) {
    boxes.push(panel.getBoundingClientRect());
  }
  for (const id of OVERLAY_IDS) {
    const overlay = surface.doc.getElementById(id) as HTMLElement | null;
    if (overlay && !overlay.hidden && overlay.isConnected) {
      const box = overlay.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) {
        boxes.push(box);
      }
    }
  }
  setDockClip(surface.dock, boxes);
}

// ------------------------------------------------------------------ styles --

function styleSheet(): string {
  return `
#${PANEL_ID} {
  position: fixed;
  z-index: ${PANEL_Z_INDEX};
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-width: ${MIN_WIDTH}px;
  min-height: ${MIN_HEIGHT}px;
  border-radius: 10px;
  /* clip, never hidden: an overflow:hidden box is still programmatically
     scrollable and focus() would push the header out of view for good. */
  overflow: clip;
  background: var(--paperly-note-bg, #ffffff);
  color: var(--paperly-note-fg, #000000);
  border: 1px solid color-mix(in srgb, var(--paperly-note-fg) 20%, var(--paperly-note-bg));
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16), 0 2px 8px rgba(0, 0, 0, 0.10);
  font-family: var(--paperly-note-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
}
#${PANEL_ID}[data-scheme="dark"] {
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.35);
}
#${PANEL_ID}[hidden] { display: none; }

/* ---------------------------------------------------------------- motion --
   The pad moves on transform and lands on left/top. Dragging by left/top
   relayouts the whole pad on every pointermove; a transform is handed to the
   compositor and never touches layout. Nothing transitions the transform,
   because the drag sets it once per move and the drop clears it in the same
   task it writes left/top -- a transition there would slide the pad back to
   where it started. The settle is an animation instead, and it only touches
   scale. */
#${PANEL_ID} {
  transition: box-shadow 140ms ease;
}
#${PANEL_ID}.paperly-note-dragging {
  /* The shadow of something picked up, and a hair larger so it reads as
     lifted off the page rather than sliding along it. */
  box-shadow: 0 22px 48px rgba(0, 0, 0, 0.26), 0 4px 14px rgba(0, 0, 0, 0.16);
}
#${PANEL_ID}[data-scheme="dark"].paperly-note-dragging {
  box-shadow: 0 22px 48px rgba(0, 0, 0, 0.62), 0 4px 14px rgba(0, 0, 0, 0.42);
}
#${PANEL_ID} .paperly-note-header { cursor: grab; }
#${PANEL_ID}.paperly-note-dragging .paperly-note-header { cursor: grabbing; }

@keyframes paperly-note-in {
  from { opacity: 0; transform: scale(0.92) translateY(6px); }
  to   { opacity: 1; transform: none; }
}
@keyframes paperly-note-out {
  from { opacity: 1; transform: none; }
  to   { opacity: 0; transform: scale(0.96) translateY(4px); }
}
/* Overshoots past 1 before settling, which is what makes a drop feel like it
   landed rather than stopped. */
@keyframes paperly-note-drop {
  0%   { transform: scale(1.015); }
  55%  { transform: scale(0.996); }
  100% { transform: none; }
}
@keyframes paperly-note-snap {
  0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--paperly-note-fg) 45%, transparent),
                     0 10px 30px rgba(0, 0, 0, 0.16); }
  100% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--paperly-note-fg) 0%, transparent),
                     0 10px 30px rgba(0, 0, 0, 0.16); }
}
#${PANEL_ID}.paperly-note-opening {
  animation: paperly-note-in ${OPEN_MS}ms cubic-bezier(0.16, 1, 0.3, 1);
}
#${PANEL_ID}.paperly-note-closing {
  animation: paperly-note-out ${CLOSE_MS}ms ease-in forwards;
}
#${PANEL_ID}.paperly-note-dropping {
  animation: paperly-note-drop 260ms cubic-bezier(0.16, 1, 0.3, 1);
}
#${PANEL_ID}.paperly-note-snapped {
  animation: paperly-note-snap 420ms ease-out;
}

/* Someone who has asked the OS for less movement gets the same pad, placed
   instantly. */
@media (prefers-reduced-motion: reduce) {
  #${PANEL_ID},
  #${PANEL_ID}.paperly-note-opening,
  #${PANEL_ID}.paperly-note-closing,
  #${PANEL_ID}.paperly-note-dropping,
  #${PANEL_ID}.paperly-note-snapped {
    animation: none;
    transition: none;
  }
}

#${PANEL_ID} .paperly-note-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 7px 12px;
  cursor: move;
  user-select: none;
  background: color-mix(in srgb, var(--paperly-note-fg) 6%, var(--paperly-note-bg));
  border-bottom: 1px solid color-mix(in srgb, var(--paperly-note-fg) 12%, var(--paperly-note-bg));
}
#${PANEL_ID} .paperly-note-title {
  /* Not flex-grow: the blocks button sits right beside the word, and it is
     what pushes everything else to the other end of the header. */
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.75;
}
#${PANEL_ID} .paperly-note-font {
  flex: 0 0 auto;
  font: inherit;
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 5px;
  color: inherit;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--paperly-note-fg) 22%, var(--paperly-note-bg));
  cursor: pointer;
}
#${PANEL_ID} .paperly-note-blocks-button {
  margin-inline-end: auto;
}
#${PANEL_ID} .paperly-note-blocks-button,
#${PANEL_ID} .paperly-note-color-button,
#${PANEL_ID} .paperly-note-emoji-button {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  opacity: 0.6;
}
#${PANEL_ID} .paperly-note-blocks-button:hover,
#${PANEL_ID} .paperly-note-blocks-button[aria-expanded="true"],
#${PANEL_ID} .paperly-note-color-button:hover,
#${PANEL_ID} .paperly-note-color-button[aria-expanded="true"],
#${PANEL_ID} .paperly-note-emoji-button:hover,
#${PANEL_ID} .paperly-note-emoji-button[aria-expanded="true"] {
  opacity: 1;
  background: color-mix(in srgb, var(--paperly-note-fg) 12%, var(--paperly-note-bg));
}
#${PANEL_ID} .paperly-note-color-button {
  width: auto;
  padding: 0 3px;
  gap: 1px;
}

#${PANEL_ID} .paperly-note-close {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  opacity: 0.65;
}
#${PANEL_ID} .paperly-note-close:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--paperly-note-fg) 12%, var(--paperly-note-bg));
}

#${PANEL_ID} .paperly-note-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}
#${PANEL_ID} .paperly-note-editor {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding: 12px 14px;
  overflow: auto;
  outline: none;
  font-size: 14px;
  line-height: 1.62;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  caret-color: var(--paperly-note-fg, #000000);
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--paperly-note-fg) 28%, var(--paperly-note-bg)) transparent;
}
/* On the first block, not on the editor: with blocks there is always a
   paragraph in the way, and generated content inside it sits where the text
   would have been. */
#${PANEL_ID} .paperly-note-editor[data-empty="true"] > :first-child::before {
  content: attr(data-placeholder);
  opacity: 0.38;
  pointer-events: none;
}

/* Blocks. Sizes are relative so they follow the pad's own font size. */
#${PANEL_ID} .paperly-note-editor > :first-child { margin-top: 0; }
#${PANEL_ID} .paperly-note-editor > :last-child { margin-bottom: 0; }
/* A div is what Blink makes when you press Enter; it has to look like the
   paragraph Gecko makes. Both are stored as <p>. */
#${PANEL_ID} .paperly-note-editor p,
#${PANEL_ID} .paperly-note-editor > div { margin: 0 0 2px; }
#${PANEL_ID} .paperly-note-editor h1,
#${PANEL_ID} .paperly-note-editor h2,
#${PANEL_ID} .paperly-note-editor h3,
#${PANEL_ID} .paperly-note-editor h4 {
  margin: 12px 0 2px;
  line-height: 1.3;
  font-weight: 650;
}
#${PANEL_ID} .paperly-note-editor h1 { font-size: 1.45em; }
#${PANEL_ID} .paperly-note-editor h2 { font-size: 1.25em; }
#${PANEL_ID} .paperly-note-editor h3 { font-size: 1.1em; }
#${PANEL_ID} .paperly-note-editor h4 { font-size: 1em; opacity: 0.85; }
#${PANEL_ID} .paperly-note-editor ul,
#${PANEL_ID} .paperly-note-editor ol {
  margin: 2px 0;
  padding-inline-start: 1.4em;
}
#${PANEL_ID} .paperly-note-editor li { margin: 1px 0; }
/* A to-do is a list item whose first character is the box, so the list marker
   comes off and the text moves back into its place. */
#${PANEL_ID} .paperly-note-editor li[data-todo] {
  list-style: none;
  margin-inline-start: -1.15em;
}
#${PANEL_ID} .paperly-note-editor li[data-todo="done"] {
  opacity: 0.6;
  text-decoration: line-through;
}
/* Marks. A link takes the pad's own ink rather than a blue of its own: the
   ink is derived from whatever background was chosen, and a fixed colour would
   lose against half the palette. */
#${PANEL_ID} .paperly-note-editor a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  opacity: 0.85;
}
/* The code mark is STORED as <code>, but while it is being typed both engines
   have written a monospace span instead -- see toggleCode -- so it has to look
   the same in either shape. */
#${PANEL_ID} .paperly-note-editor code,
#${PANEL_ID} .paperly-note-editor span[style*="monospace"] {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
  padding: 0.08em 0.3em;
  border-radius: 4px;
  background: color-mix(in srgb, var(--paperly-note-fg) 11%, var(--paperly-note-bg));
}
#${PANEL_ID} .paperly-note-editor hr {
  height: 0;
  margin: 11px 2px;
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--paperly-note-fg) 24%, var(--paperly-note-bg));
}

#${PANEL_ID} .paperly-note-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px 5px 12px;
  font-size: 11px;
  border-top: 1px solid color-mix(in srgb, var(--paperly-note-fg) 12%, var(--paperly-note-bg));
  background: color-mix(in srgb, var(--paperly-note-fg) 4%, var(--paperly-note-bg));
}
#${PANEL_ID} .paperly-note-status {
  flex: 1 1 auto;
  min-width: 0;
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${PANEL_ID} .paperly-note-grip {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  opacity: 0.45;
  background:
    linear-gradient(135deg, transparent 0 46%, currentColor 46% 54%, transparent 54% 100%) no-repeat,
    linear-gradient(135deg, transparent 0 70%, currentColor 70% 78%, transparent 78% 100%) no-repeat;
  background-size: 100% 100%;
}
${tableStyles(PANEL_ID)}`;
}

function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = styleSheet();
  (doc.head || doc.documentElement)?.appendChild(style);
}

// ------------------------------------------------------------------ button --

// The block-menu icons, the toolbar button and the pad's own small buttons all
// come out of buildIcon in ui/noteBlocks.

const NOTE_ICON_PATHS: IconPath[] = [
  {
    d: "M4.8 12.7H15.2L13.83 16.88C13.4 18.35 13.2 18.5 12.7 18.5H7.3C6.8 18.5 6.6 18.35 6.18 16.88Z",
    stroke: true,
  },
  { d: "M10 12.7V8.2", stroke: true },
  { d: "M9.85 10.9C8.72 7.55 6.72 6.26 3.2 6.6C4.33 9.95 6.33 11.24 9.85 10.9Z" },
  { d: "M10.15 8C13.73 8.2 15.72 6.82 16.8 3.4C13.22 3.2 11.23 4.58 10.15 8Z" },
];

const EMOJI_ICON_PATHS: IconPath[] = [
  {
    d: "M7 1a6 6 0 1 0 0 12A6 6 0 0 0 7 1Zm0 1.25a4.75 4.75 0 1 1 0 9.5 4.75 4.75 0 0 1 0-9.5Z",
    evenOdd: true,
  },
  {
    d: "M5.2 5.4a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Zm3.6 0a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Z",
  },
  { d: "M4.8 8.4c.45.85 1.25 1.35 2.2 1.35s1.75-.5 2.2-1.35", stroke: true },
];

// A plus and a chevron, side by side: add something, and here is the list of
// what. Stacked they were unreadable at 14px, which is the size this is drawn
// at -- rendered and looked at before choosing.
const BLOCKS_ICON_PATHS: IconPath[] = [
  { d: "M1.6 6H6.4", stroke: true },
  { d: "M4 3.6V8.4", stroke: true },
  { d: "M8.6 5.2L11 7.7L13.4 5.2", stroke: true },
];

// Two overlapping circles: the "pick a colour" mark. NOT a chip of the current
// colour -- rendered side by side, a chip always matches the pad it sits on and
// reads as an empty ring. Which colour is chosen is shown in the palette, where
// there is something to compare it against.
const PALETTE_ICON_PATHS: IconPath[] = [
  { d: "M2.3 5.4a3.1 3.1 0 1 0 6.2 0a3.1 3.1 0 1 0-6.2 0Z", stroke: true },
  { d: "M5.7 8.4a3.1 3.1 0 1 0 6.2 0a3.1 3.1 0 1 0-6.2 0Z", stroke: true },
];

const CHEVRON_ICON_PATHS: IconPath[] = [
  { d: "M2.4 3.8L5 6.4L7.6 3.8", stroke: true },
];

const CLOSE_ICON_PATHS: IconPath[] = [
  { d: "M3.3 2.4 7 6.1l3.7-3.7.9.9L7.9 7l3.7 3.7-.9.9L7 7.9l-3.7 3.7-.9-.9L6.1 7 2.4 3.3z" },
];

// The reader's sanctioned plugin slot is a custom-sections div at the START of
// the toolbar's `.end` group -- next to Appearance, at the opposite end from
// Read Aloud. Sitting beside the headphones means inserting into `.start`
// directly. That group is React-managed, so the position is re-checked on every
// mutation rather than assumed; #numPages really is added there after mount.
function anchorButton(doc: Document, button: HTMLElement): boolean {
  const start = doc.querySelector(".toolbar .start");
  if (!start) {
    return false;
  }
  const after =
    doc.getElementById("read-aloud") ||
    doc.getElementById("readingMode") ||
    doc.getElementById("zoomAuto");
  if (after && after.parentElement === start) {
    if (after.nextElementSibling !== button) {
      after.after(button);
    }
    return true;
  }
  // Never first: focus-manager.js enters the toolbar with
  // `.toolbar .start .toolbar-button`, which has to stay the sidebar toggle.
  if (button.parentElement !== start) {
    start.appendChild(button);
  }
  return true;
}

// The init object has to live in the same compartment as the observer. A plain
// chrome-side `{ childList: true }` handed to the reader window's
// MutationObserver reads back as all-false across the boundary and observe()
// throws "One of 'childList', 'attributes', 'characterData' must not be false".
// So: prefer the chrome constructor, which can watch a content node with a
// chrome-side init, and clone the init when only the content one is available.
function watchToolbarOrder(doc: Document): MutationObserver | null {
  const start = doc.querySelector(".toolbar .start");
  if (!start) {
    return null;
  }
  const react = (): void => {
    const current = doc.getElementById(BUTTON_ID) as HTMLElement | null;
    if (current) {
      anchorButton(doc, current);
    }
  };
  const scope = globalThis as unknown as {
    MutationObserver?: typeof MutationObserver;
  };
  try {
    if (typeof scope.MutationObserver === "function") {
      const observer = new scope.MutationObserver(react);
      observer.observe(start, { childList: true });
      return observer;
    }
    const view = doc.defaultView as unknown as {
      MutationObserver?: typeof MutationObserver;
    } | null;
    if (typeof view?.MutationObserver !== "function") {
      return null;
    }
    const observer = new view.MutationObserver(react);
    const init = (
      Components as unknown as {
        utils: { cloneInto: (value: unknown, scope: unknown) => unknown };
      }
    ).utils.cloneInto({ childList: true }, doc.defaultView);
    observer.observe(start, init as MutationObserverInit);
    return observer;
  } catch (error) {
    // Without the observer the button simply stays where it was first put.
    ztoolkit.log("readerNotePanel: could not watch the toolbar order:", error);
    return null;
  }
}

/** Put the note button in the reader toolbar. Idempotent. */
export function ensureReaderNoteButton(
  doc: Document,
  reader: ReaderLike,
  append?: (...nodes: unknown[]) => void,
): void {
  let entry = buttons.get(doc);
  let button = doc.getElementById(BUTTON_ID) as HTMLElement | null;
  if (!button) {
    button = doc.createElement("button");
    button.id = BUTTON_ID;
    button.className = "toolbar-button";
    (button as HTMLButtonElement).type = "button";
    // Mandatory: the reader builds arrow-key navigation from the live set of
    // [tabindex="-1"] inside the toolbar's tabstop group.
    button.tabIndex = -1;
    button.title = text("Paper Notes", "论文笔记");
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", "false");
    button.appendChild(buildIcon(doc, 20, NOTE_ICON_PATHS));
    button.addEventListener("click", () => {
      void toggleNotePanel(doc, reader);
    });
  }

  if (!anchorButton(doc, button)) {
    if (append) {
      // No .start to insert into: fall back to the slot the event handed us
      // rather than leaving the user with no entry point at all.
      append(button);
    } else {
      // Nowhere to put it. Forget it so the next render tries again instead of
      // accumulating detached buttons.
      forgetReaderButton(doc);
      return;
    }
  }

  if (entry) {
    entry.reader = reader;
    entry.button = button;
  } else {
    // The reader's half of the watch: its toolbar and its sidebar, which the
    // chrome window never hears about. A press inside the reader's <browser>
    // reaches the window in neither event group -- measured: seen zero times
    // there, default group and system group alike.
    //
    // A press on the page itself reaches neither document: the view is a
    // nested iframe inside that <browser>, so it is a third document again.
    // That was true before the pad moved into the dock as well. Focus was
    // tried as a way across and is not one -- measured: clicking the page
    // moves it in some places and not others, and a watch that fires half the
    // time is worse than none. What does close a menu is Escape, a press
    // anywhere on the pad, and a press on either chrome.
    const onPaperPress = (): void => {
      for (const surface of surfaces.values()) {
        closePadOverlays(surface);
      }
    };
    doc.addEventListener("pointerdown", onPaperPress, true);
    entry = {
      reader,
      button,
      anchorObserver: watchToolbarOrder(doc),
      unwatch: () => doc.removeEventListener("pointerdown", onPaperPress, true),
    };
    buttons.set(doc, entry);
    // The reader document goes away with its tab, and pagehide is the last
    // moment anything here can run.
    doc.defaultView?.addEventListener(
      "pagehide",
      () => {
        void flushPaperNoteSaves();
        forgetReaderButton(doc);
      },
      { once: true },
    );
  }
  refreshButtons();
}

/**
 * Drops a reader's button, and closes the pad if that reader was the one it was
 * pinned to -- the paper it is writing about has gone.
 */
function forgetReaderButton(doc: Document): void {
  const entry = buttons.get(doc);
  buttons.delete(doc);
  entry?.anchorObserver?.disconnect();
  entry?.unwatch();
  for (const surface of surfaces.values()) {
    if (surface.readerDoc === doc) {
      surface.readerDoc = null;
      closeNotePanel(surface.mainWindow);
    }
  }
  refreshButtons();
}

// ------------------------------------------------------------------- panel --

function editContext(surface: Surface): EditContext | null {
  return surface.editor ? { doc: surface.doc, editor: surface.editor } : null;
}

function readEditorHTML(surface: Surface): string {
  return `${surface.editor?.innerHTML ?? ""}`;
}

/**
 * Fills the editor from stored block HTML.
 *
 * Parsed with the reader window's own DOMParser and imported node by node
 * rather than assigned to innerHTML: chrome code writing into the reader's
 * resource:// document is the one place in this plugin where the convenient
 * DOM shortcuts have repeatedly not worked.
 */
function writeEditorHTML(surface: Surface, html: string): void {
  const editor = surface.editor;
  const view = surface.doc.defaultView as
    | (Window & { DOMParser?: typeof DOMParser })
    | null;
  if (!editor) {
    return;
  }
  surface.loading = true;
  try {
    const source = html || "<p><br></p>";
    const parsed = view?.DOMParser
      ? new view.DOMParser().parseFromString(source, "text/html")
      : null;
    if (parsed?.body) {
      editor.replaceChildren(
        ...(Array.from(parsed.body.childNodes) as Node[]).map((node) =>
          surface.doc.importNode(node, true),
        ),
      );
    } else {
      editor.textContent = parsedText(source);
    }
    const ctx = editContext(surface);
    if (ctx) {
      ensureTrailingParagraph(ctx);
    }
    decorateTodos(editor);
    applyColumnWidths(editor);
  } finally {
    surface.loading = false;
  }
  markEmpty(surface);
}

/** Last resort when there is no parser: the text, with the tags stripped. */
function parsedText(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function markEmpty(surface: Surface): void {
  if (!surface.editor) {
    return;
  }
  const empty = isEmptyBlocks(readEditorHTML(surface));
  surface.editor.setAttribute("data-empty", empty ? "true" : "false");
}

function scheduleSave(surface: Surface): void {
  if (surface.loading || !surface.target) {
    return;
  }
  setStatus(surface, text("Saving…", "保存中……"));
  queuePaperNoteSave(surface.target, readEditorHTML(surface), (error) => {
    if (!isLive(surface)) {
      return;
    }
    setStatus(
      surface,
      error ? text("Could not save", "保存失败") : idleStatus(surface),
    );
  });
}

// ------------------------------------------------------------ "/" menu -----

/** Where to hang the block menu: the caret, or the line it is on. */
function caretRect(surface: Surface): DOMRect | null {
  const ctx = editContext(surface);
  const selection = surface.doc.getSelection?.();
  if (!ctx || !selection || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!ctx.editor.contains(range.commonAncestorContainer)) {
    return null;
  }
  const rect = range.getBoundingClientRect();
  if (rect.height) {
    return rect;
  }
  // Measured in the reader: a collapsed caret on an empty line has no rect at
  // all -- zero width, zero height, no client rects -- so the block it sits in
  // is what the menu hangs off instead.
  return currentBlock(ctx)?.getBoundingClientRect() || null;
}

function dismissSlashMenu(surface: Surface): void {
  surface.slashBlock = null;
  closeBlockMenu(surface.doc);
}

function pickBlock(
  surface: Surface,
  id: NoteBlockId,
  slash: { block: HTMLElement; offset: number } | null,
): void {
  const ctx = editContext(surface);
  if (!ctx) {
    return;
  }
  surface.slashBlock = null;
  // Picked from the header button, the caret is wherever it was left.
  if (!slash) {
    focusEditorAtCaret(surface);
  }
  const block = slash?.block && slash.block.isConnected ? slash.block : null;
  const offset = slash?.offset ?? 0;
  if (block) {
    // Take the "/what-you-typed" out before the block replaces it.
    const before = caretText(ctx)?.before.length ?? offset;
    deleteTextRange(ctx, block, offset, before);
  }
  applyBlock(ctx, id);
  afterEdit(surface);
}

/**
 * Opens the menu on "/", keeps it in step with what follows, and puts it away
 * when what follows stops looking like a block name.
 */
function updateSlashMenu(surface: Surface, event: InputEvent): void {
  const ctx = editContext(surface);
  const here = ctx ? caretText(ctx) : null;
  if (!ctx || !here) {
    dismissSlashMenu(surface);
    return;
  }
  if (!isBlockMenuOpen(surface.doc)) {
    // Only a slash that starts a word: "and/or" is not a command. The typed
    // character is read back off the block rather than from event.data, which
    // execCommand does not always fill in.
    const before = here.before;
    const previous = before.charAt(before.length - 2);
    if (
      !`${event.inputType || ""}`.startsWith("insert") ||
      !before.endsWith("/") ||
      (previous && !/\s/.test(previous))
    ) {
      return;
    }
    const anchor = caretRect(surface);
    if (!anchor || !surface.panel) {
      return;
    }
    surface.slashBlock = here.block;
    surface.slashOffset = before.length - 1;
    // Captured rather than read back on the way out: closing the menu clears
    // the panel's own record of it before the pick is delivered.
    const slash = { block: here.block, offset: before.length - 1 };
    openBlockMenu({
      doc: surface.doc,
      anchor,
      themeSource: surface.panel,
      onPick: (id) => pickBlock(surface, id, slash),
      onClose: () => {
        surface.slashBlock = null;
      },
    });
    return;
  }
  if (
    here.block !== surface.slashBlock ||
    here.before.length <= surface.slashOffset ||
    here.before.charAt(surface.slashOffset) !== "/"
  ) {
    dismissSlashMenu(surface);
    return;
  }
  const query = here.before.slice(surface.slashOffset + 1);
  if (!updateBlockMenu(surface.doc, query)) {
    dismissSlashMenu(surface);
    return;
  }
  const anchor = caretRect(surface);
  if (anchor) {
    moveBlockMenu(surface.doc, anchor);
  }
}

function setStatus(surface: Surface, message: string): void {
  if (surface.status) {
    surface.status.textContent = message;
  }
}

function idleStatus(surface: Surface): string {
  if (surface.simplified) {
    return text(
      "Formatting simplified — open the note in Zotero to keep it",
      "格式已简化 —— 如需保留请在 Zotero 中打开该笔记",
    );
  }
  const paper = surface.paperTitle;
  if (paper) {
    return text(`Saved to ${paper}`, `已保存到《${paper}》`);
  }
  return text("Saved to this paper's notes", "已保存到本文献的笔记");
}

/**
 * Reads the pinned paper's name into the surface.
 *
 * The pad stays where it is when you move to another tab, so the footer is the
 * only thing saying which paper you are writing about. Cached rather than
 * looked up per status line, which is written on every save.
 */
function refreshPaperTitle(surface: Surface): void {
  try {
    const itemID = surface.target?.itemID ?? surface.reader.itemID;
    if (typeof itemID !== "number") {
      surface.paperTitle = "";
      return;
    }
    const item = Zotero.Items.get(itemID) as
      | { getDisplayTitle?: () => string }
      | undefined;
    const title = `${item?.getDisplayTitle?.() || ""}`.trim();
    surface.paperTitle = title.length > 48 ? `${title.slice(0, 47)}…` : title;
  } catch {
    // An item mid-delete has no title. The generic line still reads correctly.
    surface.paperTitle = "";
  }
}

/** The paper's own colours, whatever the pad is currently painted in. */
function paperTheme(surface: Surface): PaperTheme {
  return resolveReaderPaperTheme(surface.reader);
}

/**
 * Paints the pad: the paper's colours, or a colour of its own.
 *
 * A chosen background brings its own ink with it (see ui/noteColors), so the
 * pad stays readable without anyone picking a text colour to go with it.
 */
function applyTheme(surface: Surface): void {
  if (!surface.panel) {
    return;
  }
  const chosen = normalizeBackground(getNoteBackgroundPref());
  const theme: PaperTheme = isPaperBackground(chosen)
    ? paperTheme(surface)
    : {
        background: chosen,
        foreground: inkFor(chosen),
        scheme: schemeFor(chosen),
      };
  surface.panel.style.setProperty("--paperly-note-bg", theme.background);
  surface.panel.style.setProperty("--paperly-note-fg", theme.foreground);
  surface.panel.dataset.scheme = theme.scheme;
  syncEmojiPickerTheme(surface.doc, surface.panel);
  syncBlockMenuTheme(surface.doc, surface.panel);
  syncColorMenuTheme(surface.doc, surface.panel);
  syncFormatBarTheme(surface.doc, surface.panel);
}

async function applyFont(surface: Surface, id: ReaderNoteFontId): Promise<void> {
  surface.panel?.style.setProperty("--paperly-note-font", noteFontStack(id));
  await ensureNoteFontLoaded(surface.doc, id);
}

function clampGeometry(
  surface: Surface,
  box: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const view = surface.doc.defaultView;
  const viewWidth = view?.innerWidth || 1200;
  const viewHeight = view?.innerHeight || 800;
  const width = Math.min(
    Math.max(box.width, MIN_WIDTH),
    Math.max(MIN_WIDTH, viewWidth - EDGE_GAP * 2),
  );
  const height = Math.min(
    Math.max(box.height, MIN_HEIGHT),
    Math.max(MIN_HEIGHT, viewHeight - TOOLBAR_GAP - EDGE_GAP),
  );
  const x = Math.min(
    Math.max(box.x, EDGE_GAP),
    Math.max(EDGE_GAP, viewWidth - width - EDGE_GAP),
  );
  const y = Math.min(
    Math.max(box.y, TOOLBAR_GAP),
    Math.max(TOOLBAR_GAP, viewHeight - height - EDGE_GAP),
  );
  return { x, y, width, height };
}

function placePanel(
  surface: Surface,
  box: { x: number; y: number; width: number; height: number },
  persist: boolean,
): void {
  if (!surface.panel) {
    return;
  }
  const clamped = clampGeometry(surface, box);
  surface.panel.style.left = `${Math.round(clamped.x)}px`;
  surface.panel.style.top = `${Math.round(clamped.y)}px`;
  surface.panel.style.width = `${Math.round(clamped.width)}px`;
  surface.panel.style.height = `${Math.round(clamped.height)}px`;
  if (persist) {
    setNoteGeometryPref({
      x: Math.round(clamped.x),
      y: Math.round(clamped.y),
      width: Math.round(clamped.width),
      height: Math.round(clamped.height),
    });
  }
  syncClip(surface);
}

function initialGeometry(surface: Surface): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const stored = getNoteGeometryPref();
  const view = surface.doc.defaultView;
  const viewWidth = view?.innerWidth || 1200;
  const width = Number(stored?.width) || DEFAULT_WIDTH;
  const height = Number(stored?.height) || DEFAULT_HEIGHT;
  return {
    width,
    height,
    x: Number.isFinite(Number(stored?.x))
      ? Number(stored?.x)
      : viewWidth - width - EDGE_GAP,
    y: Number.isFinite(Number(stored?.y)) ? Number(stored?.y) : TOOLBAR_GAP,
  };
}

/**
 * Pulls a box onto a viewport edge once it comes within SNAP_RADIUS of one.
 *
 * Only the edges the pad is already clamped to, so snapping can never put it
 * anywhere a drag could not.
 */
function snapToEdges(
  surface: Surface,
  box: { x: number; y: number; width: number; height: number },
): { x: number; y: number; snapped: boolean } {
  const view = surface.doc.defaultView;
  const viewWidth = view?.innerWidth || 1200;
  const viewHeight = view?.innerHeight || 800;
  const edges = {
    left: EDGE_GAP,
    right: viewWidth - box.width - EDGE_GAP,
    top: TOOLBAR_GAP,
    bottom: viewHeight - box.height - EDGE_GAP,
  };
  let { x, y } = box;
  let snapped = false;
  if (Math.abs(x - edges.left) <= SNAP_RADIUS) {
    x = edges.left;
    snapped = true;
  } else if (Math.abs(x - edges.right) <= SNAP_RADIUS) {
    x = edges.right;
    snapped = true;
  }
  if (Math.abs(y - edges.top) <= SNAP_RADIUS) {
    y = edges.top;
    snapped = true;
  } else if (Math.abs(y - edges.bottom) <= SNAP_RADIUS) {
    y = edges.bottom;
    snapped = true;
  }
  return { x, y, snapped };
}

/**
 * Re-runs a one-shot animation class that may already be on the element.
 * Removing and adding it in the same task does nothing on its own -- the style
 * system never sees the gap -- so a layout read is forced in between.
 */
function restartAnimation(element: HTMLElement, className: string): void {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

/**
 * The pinned paper's toolbar button, in the dock's coordinates.
 *
 * The button is in the reader's document and the pad is in the dock's, so the
 * two are measured against different origins. Screen coordinates are the one
 * thing both windows agree on.
 */
function pinnedButtonBox(
  surface: Surface,
): { left: number; top: number; width: number; height: number } | null {
  const entry = surface.readerDoc ? buttons.get(surface.readerDoc) : null;
  if (!entry?.button.isConnected) {
    return null;
  }
  type Screened = Window & { mozInnerScreenX?: number; mozInnerScreenY?: number };
  const readerWin = entry.button.ownerDocument?.defaultView as Screened | null;
  const dockWin = surface.doc.defaultView as Screened | null;
  if (!readerWin || !dockWin) {
    return null;
  }
  const box = entry.button.getBoundingClientRect();
  return {
    left: box.left + (readerWin.mozInnerScreenX ?? 0) - (dockWin.mozInnerScreenX ?? 0),
    top: box.top + (readerWin.mozInnerScreenY ?? 0) - (dockWin.mozInnerScreenY ?? 0),
    width: box.width,
    height: box.height,
  };
}

/**
 * Grows the pad out of the button that opened it, by putting the transform's
 * origin where that button is. Clamped, because a button well outside the pad
 * would throw the origin far enough that the growth reads as a slide in from
 * off screen rather than an opening.
 */
function setOpenOrigin(surface: Surface): void {
  const panel = surface.panel;
  if (!panel) {
    return;
  }
  const buttonBox = pinnedButtonBox(surface);
  const panelBox = panel.getBoundingClientRect();
  if (!buttonBox || !panelBox.width || !panelBox.height) {
    panel.style.transformOrigin = "center";
    return;
  }
  const within = (value: number) => Math.min(Math.max(value, -20), 120);
  const x = ((buttonBox.left + buttonBox.width / 2 - panelBox.left) / panelBox.width) * 100;
  const y = ((buttonBox.top + buttonBox.height / 2 - panelBox.top) / panelBox.height) * 100;
  panel.style.transformOrigin = `${within(x).toFixed(1)}% ${within(y).toFixed(1)}%`;
}

function trackPointer(
  surface: Surface,
  handle: HTMLElement,
  onStart: (event: PointerEvent) => {
    move: (event: PointerEvent) => void;
    /**
     * Where the handle knows the final box better than the DOM does. The drag
     * leaves a scale on the pad, so its rect is no longer its geometry.
     */
    commit?: () => void;
  },
): void {
  handle.addEventListener("pointerdown", (event) => {
    const pointerEvent = event as PointerEvent;
    if (pointerEvent.button !== 0) {
      return;
    }
    const target = pointerEvent.target as Element | null;
    if (target?.closest("select, button")) {
      return;
    }
    const handlers = onStart(pointerEvent);
    try {
      handle.setPointerCapture(pointerEvent.pointerId);
    } catch {
      // A capture that cannot be taken is not worth the drag: without this the
      // throw lands between the handle being marked as held and its move
      // listener being attached, so the pad sticks to the cursor's first
      // position and never lets go. The drag still works, it just stops
      // following the pointer once it leaves the header.
    }
    const move = (moveEvent: Event): void => {
      handlers.move(moveEvent as PointerEvent);
    };
    const end = (): void => {
      handle.removeEventListener("pointermove", move);
      try {
        handle.releasePointerCapture(pointerEvent.pointerId);
      } catch {
        // The capture is already gone if the pointer left the window.
      }
      if (handlers.commit) {
        handlers.commit();
        return;
      }
      const rect = surface.panel?.getBoundingClientRect();
      if (rect) {
        placePanel(
          surface,
          {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          },
          true,
        );
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end, { once: true });
    handle.addEventListener("pointercancel", end, { once: true });
    pointerEvent.preventDefault();
  });
}

/** Remembers the caret so the picker can hand it back. */
function rememberCaret(surface: Surface): void {
  const editor = surface.editor;
  const selection = surface.doc.getSelection?.();
  if (!editor || !selection || selection.rangeCount === 0) {
    return;
  }
  const range = selection.getRangeAt(0);
  if (editor.contains(range.commonAncestorContainer)) {
    surface.savedRange = range.cloneRange();
  }
}

/**
 * Focuses the editor with the caret back where it was.
 *
 * Anything opened from the header -- the emoji picker, the blocks menu -- is
 * reached by pressing a button, and the caret has to be put back by hand
 * afterwards. Falling back to the end of the note is better than inserting at
 * whatever the browser happens to think the selection is.
 */
function focusEditorAtCaret(surface: Surface): void {
  const doc = surface.doc;
  const editor = surface.editor;
  if (!editor) {
    return;
  }
  editor.focus({ preventScroll: true });
  const selection = doc.getSelection?.();
  if (!selection) {
    return;
  }
  const usable =
    surface.savedRange &&
    editor.contains(surface.savedRange.commonAncestorContainer)
      ? surface.savedRange
      : null;
  if (usable) {
    selection.removeAllRanges();
    selection.addRange(usable);
    return;
  }
  if (
    selection.rangeCount === 0 ||
    !editor.contains(selection.getRangeAt(0).commonAncestorContainer)
  ) {
    const range = doc.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function insertAtCaret(surface: Surface, value: string): void {
  if (!surface.editor) {
    return;
  }
  focusEditorAtCaret(surface);
  // execCommand keeps the undo stack and fires `input`, so the save and the
  // placeholder state are handled by the listener that is already there.
  surface.doc.execCommand("insertText", false, value);
  rememberCaret(surface);
}

// --------------------------------------------------- the selection toolbar --

/** Everything that has to happen once the note has been changed. */
function afterEdit(surface: Surface): void {
  const editor = surface.editor;
  if (!editor) {
    return;
  }
  decorateTodos(editor);
  applyColumnWidths(editor);
  rememberCaret(surface);
  markEmpty(surface);
  scheduleSave(surface);
  if (isFormatBarOpen(surface.doc)) {
    // An edit moves the text the bar is pointing at and changes what is
    // switched on in it. Typing collapses the selection, so this is also what
    // takes the bar away again.
    refreshFormatBar(surface);
  }
}

/** The selection's box, or null when there is nothing to format. */
function selectionBox(surface: Surface): DOMRect | null {
  const ctx = editContext(surface);
  const selection = surface.doc.getSelection?.();
  if (!ctx || !selection || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (range.collapsed || !ctx.editor.contains(range.commonAncestorContainer)) {
    return null;
  }
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) {
    return null;
  }
  // Scrolled out of the note: the bar would be left floating over the paper,
  // pointing at a line nobody can see.
  const bounds = ctx.editor.getBoundingClientRect();
  return rect.bottom < bounds.top || rect.top > bounds.bottom ? null : rect;
}

function runFormatAction(surface: Surface, action: FormatAction): void {
  const ctx = editContext(surface);
  if (!ctx) {
    return;
  }
  if (action.kind === "block") {
    // pickBlock puts the caret back and saves on its own.
    pickBlock(surface, action.id, null);
    refreshFormatBar(surface);
    return;
  }
  focusEditorAtCaret(surface);
  switch (action.kind) {
    case "mark":
      toggleMark(ctx, action.id);
      break;
    case "highlight":
      setHighlight(ctx, action.color);
      break;
    case "link":
      setLink(ctx, action.href);
      break;
    case "unlink":
      clearLink(ctx);
      break;
    case "clear":
      clearFormatting(ctx);
      break;
  }
  afterEdit(surface);
  refreshFormatBar(surface);
}

/**
 * Puts the toolbar where the selection is, or takes it away.
 *
 * Safe to call as often as the selection changes: the bar is built once per
 * document and updated after that, so this does not rebuild anything.
 */
function refreshFormatBar(surface: Surface): void {
  const doc = surface.doc;
  const ctx = editContext(surface);
  if (!ctx || !surface.panel || surface.panel.hidden) {
    closeFormatBar(doc);
    return;
  }
  const anchor = selectionBox(surface);
  if (!anchor) {
    // The link field holds the caret on purpose. Losing the selection while
    // someone is typing an address is not a reason to take the field away.
    if (!isFormatBarEditing(doc)) {
      closeFormatBar(doc);
    }
    return;
  }
  // What the bar acts on, kept for the moment the link field takes the caret.
  rememberCaret(surface);
  showFormatBar({
    doc,
    themeSource: surface.panel,
    anchor,
    bounds: ctx.editor.getBoundingClientRect(),
    snapshot: {
      // A heading inside a table cell is flattened when the cell is stored,
      // so the switcher is not offered there.
      block: currentCell(ctx) ? null : blockIdOf(ctx),
      marks: markStateAt(ctx),
      allHeadings: selectionIsAllHeadings(ctx),
    },
    onAction: (action) => runFormatAction(surface, action),
    onRestore: () => focusEditorAtCaret(surface),
  });
}

function buildPanel(surface: Surface): HTMLElement {
  const doc = surface.doc;
  ensureStyles(doc);

  const panel = doc.createElement("div");
  panel.id = PANEL_ID;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", text("Paper Notes", "论文笔记"));

  const header = doc.createElement("div");
  header.className = "paperly-note-header";

  const title = doc.createElement("span");
  title.className = "paperly-note-title";
  title.textContent = text("Paper Notes", "论文笔记");
  header.appendChild(title);

  // The way in for anyone who does not know about "/": the same menu, from a
  // button beside the title.
  const blocksButton = doc.createElement("button");
  blocksButton.className = "paperly-note-blocks-button";
  (blocksButton as HTMLButtonElement).type = "button";
  blocksButton.title = text("Basic blocks", "基础模块");
  blocksButton.setAttribute("aria-label", blocksButton.title);
  blocksButton.setAttribute("aria-expanded", "false");
  blocksButton.appendChild(buildIcon(doc, 14, BLOCKS_ICON_PATHS));
  // Cancel the pointerdown so the caret stays where it is; the click still
  // fires, and the pick puts the selection back before it inserts anyway.
  blocksButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    rememberCaret(surface);
  });
  blocksButton.addEventListener("click", () => {
    if (isBlockMenuOpen(doc)) {
      closeBlockMenu(doc);
      return;
    }
    if (!surface.panel) {
      return;
    }
    surface.slashBlock = null;
    blocksButton.setAttribute("aria-expanded", "true");
    openBlockMenu({
      doc,
      anchor: blocksButton.getBoundingClientRect(),
      themeSource: surface.panel,
      trigger: blocksButton,
      onPick: (id) => pickBlock(surface, id, null),
      onClose: () => {
        surface.slashBlock = null;
        blocksButton.setAttribute("aria-expanded", "false");
      },
    });
  });
  header.appendChild(blocksButton);

  const emojiButton = doc.createElement("button");
  emojiButton.className = "paperly-note-emoji-button";
  (emojiButton as HTMLButtonElement).type = "button";
  emojiButton.title = text("Emoji", "表情");
  emojiButton.setAttribute("aria-label", emojiButton.title);
  emojiButton.setAttribute("aria-expanded", "false");
  emojiButton.appendChild(buildIcon(doc, 14, EMOJI_ICON_PATHS));
  // Cancel the pointerdown so the caret stays where it is; the click still
  // fires and the picker puts the selection back before inserting anyway.
  emojiButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    rememberCaret(surface);
  });
  emojiButton.addEventListener("click", () => {
    void openEmojiPicker({
      doc,
      anchor: emojiButton,
      themeSource: panel,
      onPick: (emoji) => insertAtCaret(surface, emoji),
    });
  });
  header.appendChild(emojiButton);

  // Beside the font, because both are about how the pad looks rather than what
  // is in it. The chip shows the colour the pad is wearing right now.
  const colorButton = doc.createElement("button");
  colorButton.className = "paperly-note-color-button";
  (colorButton as HTMLButtonElement).type = "button";
  colorButton.title = text("Note background", "笔记底色");
  colorButton.setAttribute("aria-label", colorButton.title);
  colorButton.setAttribute("aria-expanded", "false");
  colorButton.append(
    buildIcon(doc, 14, PALETTE_ICON_PATHS),
    buildIcon(doc, 10, CHEVRON_ICON_PATHS),
  );
  colorButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    rememberCaret(surface);
  });
  colorButton.addEventListener("click", () => {
    if (isColorMenuOpen(doc)) {
      closeColorMenu(doc);
      return;
    }
    if (!surface.panel) {
      return;
    }
    colorButton.setAttribute("aria-expanded", "true");
    openColorMenu({
      doc,
      anchor: colorButton,
      themeSource: surface.panel,
      current: getNoteBackgroundPref(),
      paperColor: paperTheme(surface).background,
      onPick: (value) => {
        setNoteBackgroundPref(
          value === PAPER_BACKGROUND ? PAPER_BACKGROUND : value,
        );
        applyTheme(surface);
        const swatch = swatchNamed(value);
        setStatus(
          surface,
          swatch
            ? text(
                `Background: ${swatch.en}`,
                `底色：${swatch.zh}`,
              )
            : text("Background follows the paper", "底色跟随页面"),
        );
        surface.doc.defaultView?.setTimeout(() => {
          if (isLive(surface)) {
            setStatus(surface, idleStatus(surface));
          }
        }, 1600);
      },
      onClose: () => colorButton.setAttribute("aria-expanded", "false"),
    });
  });
  header.appendChild(colorButton);

  const fontSelect = doc.createElement("select");
  fontSelect.className = "paperly-note-font";
  fontSelect.title = text("Note font", "笔记字体");
  for (const font of NOTE_FONTS) {
    const option = doc.createElement("option");
    option.value = font.id;
    option.textContent = font.label;
    fontSelect.appendChild(option);
  }
  fontSelect.value = getNoteFont(getNoteFontPref()).id;
  fontSelect.addEventListener("change", () => {
    const id = getNoteFont(fontSelect.value).id;
    setNoteFontPref(id);
    void applyFont(surface, id);
  });
  header.appendChild(fontSelect);

  const close = doc.createElement("button");
  close.className = "paperly-note-close";
  (close as HTMLButtonElement).type = "button";
  close.title = text("Close", "关闭");
  close.setAttribute("aria-label", close.title);
  close.appendChild(buildIcon(doc, 14, CLOSE_ICON_PATHS));
  close.addEventListener("click", () => closeNotePanel(surface.mainWindow));
  header.appendChild(close);

  const editor = doc.createElement("div");
  editor.className = "paperly-note-editor";
  editor.setAttribute("contenteditable", "true");
  // Vietnamese and English in one note with only an English dictionary means
  // red squiggles under most of the text; the noise is worse than the help.
  editor.setAttribute("spellcheck", "false");
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-multiline", "true");
  editor.setAttribute(
    "data-placeholder",
    text("Main ideas from this paper…", "这篇论文的要点……"),
  );
  editor.setAttribute("data-empty", "true");

  const footer = doc.createElement("div");
  footer.className = "paperly-note-footer";
  const status = doc.createElement("span");
  status.className = "paperly-note-status";
  const grip = doc.createElement("span");
  grip.className = "paperly-note-grip";
  grip.title = text("Resize", "调整大小");
  footer.append(status, grip);

  // The handles for a table sit in a layer OVER the editor, never inside it:
  // a node inside a contenteditable is part of the note, and would be saved.
  const body = doc.createElement("div");
  body.className = "paperly-note-body";
  const overlay = doc.createElement("div");
  overlay.className = "paperly-note-overlay";
  body.append(editor, overlay);

  panel.append(header, body, footer);
  doc.body?.appendChild(panel);

  surface.panel = panel;
  surface.editor = editor;
  surface.overlay = overlay;
  surface.status = status;

  // --- typing -------------------------------------------------------------
  const ctx: EditContext = { doc, editor };
  pinCommandStyle(ctx);

  // Gecko REFUSES execCommand while it is dispatching the input event of
  // another edit -- measured: formatBlock, insertUnorderedList and delete all
  // returned without doing anything, and the only visible effect was the next
  // keystroke overwriting the range the rule had selected. So a shortcut is
  // noticed in the input event and applied in the next task.
  let rulesQueued = false;
  const runInputRules = (): void => {
    rulesQueued = false;
    if (!isLive(surface) || !applyInputRules(ctx)) {
      return;
    }
    dismissSlashMenu(surface);
    afterEdit(surface);
  };

  editor.addEventListener("input", (event) => {
    // Structure first: a block has to exist before anything can act on it.
    normalizeStructure(ctx);
    updateSlashMenu(surface, event as InputEvent);
    afterEdit(surface);
    if (!rulesQueued) {
      rulesQueued = true;
      const view = doc.defaultView;
      if (view?.setTimeout) {
        view.setTimeout(runInputRules, 0);
      } else {
        rulesQueued = false;
      }
    }
  });

  editor.addEventListener("paste", (event) => {
    const clipboard = (event as ClipboardEvent).clipboardData;
    const plain = clipboard?.getData("text/plain");
    if (plain == null) {
      return;
    }
    event.preventDefault();
    // execCommand keeps the caret and the undo stack; a manual range insert
    // loses both. A paste of several lines becomes several blocks.
    const lines = plain.replace(/\r\n?/g, "\n").split("\n");
    lines.forEach((line, index) => {
      if (index) {
        doc.execCommand("insertParagraph");
      }
      if (line) {
        doc.execCommand("insertText", false, line);
      }
    });
  });

  editor.addEventListener("drop", (event) => {
    const plain = (event as DragEvent).dataTransfer?.getData("text/plain");
    if (plain == null) {
      return;
    }
    event.preventDefault();
    doc.execCommand("insertText", false, plain);
  });

  // Shown when the pointer comes UP, not on every selectionchange: during a
  // drag the selection changes on every pixel, and a toolbar following that
  // would jump about under the pointer. While a drag is in progress
  // selectionchange may only put the bar away, never move it.
  let selecting = false;

  editor.addEventListener("pointerdown", (event) => {
    const pointer = event as PointerEvent;
    selecting = true;
    if (
      toggleTodoAt(
        ctx,
        pointer.clientX,
        pointer.clientY,
        pointer.target as Element | null,
      )
    ) {
      event.preventDefault();
      decorateTodos(editor);
      scheduleSave(surface);
    }
  });

  const onSelectionChange = (): void => {
    if (!isLive(surface)) {
      return;
    }
    if (!selecting) {
      refreshFormatBar(surface);
      return;
    }
    if (!selectionBox(surface) && !isFormatBarEditing(doc)) {
      closeFormatBar(doc);
    }
  };
  doc.addEventListener("selectionchange", onSelectionChange);
  surface.teardown.push(() =>
    doc.removeEventListener("selectionchange", onSelectionChange),
  );

  // On the document, not the editor: a drag that starts in the note often ends
  // outside it, and the button still has to come back up somewhere.
  const onPointerUp = (): void => {
    if (!selecting) {
      return;
    }
    selecting = false;
    refreshFormatBar(surface);
  };
  doc.addEventListener("pointerup", onPointerUp);
  // A cancelled pointer never comes up, and a drag flag left switched on would
  // stop the bar ever appearing again -- including for Shift-arrow.
  doc.addEventListener("pointercancel", onPointerUp);
  surface.teardown.push(() => {
    doc.removeEventListener("pointerup", onPointerUp);
    doc.removeEventListener("pointercancel", onPointerUp);
  });

  editor.addEventListener("scroll", () => {
    if (isFormatBarOpen(doc)) {
      refreshFormatBar(surface);
    }
  });

  editor.addEventListener("blur", () => {
    // The link field is allowed to take the caret. Anything else -- the emoji
    // picker, the paper itself -- means the note is no longer being edited.
    if (!isFormatBarEditing(doc)) {
      closeFormatBar(doc);
    }
  });

  editor.addEventListener("keydown", (event) => {
    const key = event as KeyboardEvent;
    if (isBlockMenuOpen(doc) && blockMenuKeyDown(doc, key)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (key.key === "Tab") {
      const cell = currentCell(ctx);
      if (cell) {
        // FocusManager has already had this key in capture on the window and
        // moved focus to a toolbar group. Taking it back is synchronous, so
        // nothing is painted in between.
        event.preventDefault();
        event.stopPropagation();
        if (moveBetweenCells(ctx, cell, !key.shiftKey)) {
          scheduleSave(surface);
        }
        return;
      }
      if (currentBlock(ctx)?.tagName === "LI") {
        event.preventDefault();
        event.stopPropagation();
        editor.focus({ preventScroll: true });
        doc.execCommand(key.shiftKey ? "outdent" : "indent");
        scheduleSave(surface);
      }
      return;
    }
    // The marks the browser has no shortcut of its own for. Cmd-B, Cmd-I and
    // Cmd-U are Gecko's and Blink's already, and reach the note untouched now
    // that the pad stores what they produce. Checked against the reader's
    // KeyboardManager and Zotero's own keyset: none of these three is taken.
    if ((key.metaKey || key.ctrlKey) && !key.altKey) {
      const letter = key.key.toLowerCase();
      const mark: NoteMarkId | null =
        letter === "e" ? "code" : letter === "s" && key.shiftKey ? "strike" : null;
      if (mark) {
        event.preventDefault();
        event.stopPropagation();
        toggleMark(ctx, mark);
        afterEdit(surface);
        refreshFormatBar(surface);
        return;
      }
      if (letter === "k" && editFormatBarLink(doc)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (handleEditorKeyDown(ctx, key)) {
      event.preventDefault();
      decorateTodos(editor);
      scheduleSave(surface);
    }
  });

  panel.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Escape") {
      return;
    }
    // One Escape puts the block menu away, then the toolbar, then the pad.
    if (isBlockMenuOpen(doc)) {
      return;
    }
    if (isFormatBarOpen(doc)) {
      closeFormatBar(doc);
      return;
    }
    closeNotePanel(surface.mainWindow);
  });

  surface.teardown.push(
    installTableUI({
      doc,
      editor,
      overlay,
      onChange: () => scheduleSave(surface),
    }),
  );

  // --- geometry -----------------------------------------------------------
  placePanel(surface, initialGeometry(surface), false);
  trackPointer(surface, header, (down) => {
    // Taken once: the pad does not change size while it is being carried, and
    // this is also the untransformed origin every offset below is measured
    // from.
    const rect = panel.getBoundingClientRect();
    const grabX = down.clientX - rect.left;
    const grabY = down.clientY - rect.top;
    let box = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
    let wasSnapped = false;
    panel.classList.remove("paperly-note-dropping");
    panel.classList.add("paperly-note-dragging");
    // The pointer is held down on the pad, so nothing else can be clicked
    // anyway: let the dock catch everything until it lands, rather than
    // recutting the clip on every move.
    openDockClip(surface.dock);
    surface.dragging = true;
    return {
      move: (move) => {
        // Clamped first, so snapping can only ever pull it somewhere the drag
        // was already allowed to go.
        const wanted = clampGeometry(surface, {
          x: move.clientX - grabX,
          y: move.clientY - grabY,
          width: rect.width,
          height: rect.height,
        });
        const pulled = snapToEdges(surface, wanted);
        if (pulled.snapped && !wasSnapped) {
          restartAnimation(panel, "paperly-note-snapped");
        }
        wasSnapped = pulled.snapped;
        box = { ...wanted, x: pulled.x, y: pulled.y };
        panel.style.transform = [
          `translate3d(${Math.round(box.x - rect.left)}px,`,
          `${Math.round(box.y - rect.top)}px, 0)`,
          "scale(1.015)",
        ].join(" ");
      },
      commit: () => {
        surface.dragging = false;
        panel.classList.remove("paperly-note-dragging");
        syncClip(surface);
        // Cleared in the same task that writes left/top, so no frame is ever
        // painted with the pad back at the position it started from.
        panel.style.transform = "";
        placePanel(surface, box, true);
        restartAnimation(panel, "paperly-note-dropping");
      },
    };
  });
  trackPointer(surface, grip, (down) => {
    const rect = panel.getBoundingClientRect();
    return {
      move: (move) => {
        placePanel(
          surface,
          {
            x: rect.left,
            y: rect.top,
            width: rect.width + (move.clientX - down.clientX),
            height: rect.height + (move.clientY - down.clientY),
          },
          false,
        );
      },
    };
  });

  const view = doc.defaultView;
  const onResize = (): void => {
    const rect = panel.getBoundingClientRect();
    placePanel(
      surface,
      { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      false,
    );
    if (isFormatBarOpen(doc)) {
      refreshFormatBar(surface);
    }
  };
  view?.addEventListener("resize", onResize);
  surface.teardown.push(() => view?.removeEventListener("resize", onResize));

  // --- theme and font -----------------------------------------------------
  applyTheme(surface);
  surface.teardown.push(subscribeReaderThemeSources(() => applyTheme(surface)));
  const media = (
    surface.reader._iframeWindow as
      | (Window & { matchMedia?: (q: string) => MediaQueryList })
      | undefined
  )?.matchMedia?.("(prefers-color-scheme: dark)");
  if (media?.addEventListener) {
    const onScheme = (): void => applyTheme(surface);
    media.addEventListener("change", onScheme);
    surface.teardown.push(() => media.removeEventListener("change", onScheme));
  }
  void applyFont(surface, getNoteFont(getNoteFontPref()).id);

  // --- notes edited elsewhere --------------------------------------------
  surface.teardown.push(
    subscribePaperNoteChanges((ids) => {
      if (
        !surface.noteID ||
        !ids.includes(surface.noteID) ||
        !surface.target ||
        hasPendingPaperNoteSave(surface.target)
      ) {
        return;
      }
      void reload(surface);
    }),
  );

  return panel;
}

async function reload(surface: Surface): Promise<void> {
  if (!surface.target) {
    return;
  }
  const loaded = await loadPaperNote(surface.target);
  if (!isLive(surface) || !surface.editor) {
    return;
  }
  surface.noteID = loaded.noteID;
  surface.simplified = loaded.simplified;
  writeEditorHTML(surface, loaded.html);
  setStatus(surface, loaded.html ? idleStatus(surface) : "");
}

/**
 * `doc` is the reader that asked, not where the pad lives. Pressing a paper's
 * button when the pad is already open on that paper closes it; pressing another
 * paper's button re-pins the pad to that paper instead.
 */
export async function toggleNotePanel(
  doc: Document,
  reader: ReaderLike,
): Promise<void> {
  const win = Zotero.getMainWindow?.() as Window | null;
  const surface = win ? surfaces.get(win) : null;
  // A pad still playing its closing animation is on its way out, so a second
  // press means bring it back, not close it again.
  if (win && isPadOpen(surface) && surface?.readerDoc === doc) {
    closeNotePanel(win);
    return;
  }
  await openNotePanel(doc, reader);
}

export async function openNotePanel(
  doc: Document,
  reader: ReaderLike,
): Promise<void> {
  const win = Zotero.getMainWindow?.() as Window | null;
  if (!win) {
    return;
  }
  const dock = await ensureOverlayDock(win, "note");
  if (!dock) {
    return;
  }
  const surface = surfaceFor(win, dock, reader, doc);
  // Re-pinning: the pad keeps its place on screen and its size, and takes on
  // the other paper's note. Anything half-written goes out first.
  const repinned = surface.readerDoc !== doc || surface.reader !== reader;
  if (repinned) {
    await flushPaperNoteSaves();
    surface.reader = reader;
    surface.readerDoc = doc;
    surface.target = null;
    surface.noteID = null;
    surface.paperTitle = "";
  }
  if (!surface.panel) {
    buildPanel(surface);
  }
  if (!surface.panel) {
    return;
  }
  const panel = surface.panel;
  // Cancelled rather than waited out: pressing the button again during the
  // close should feel like catching the pad, not queueing behind it.
  if (surface.closing !== null) {
    win.clearTimeout(surface.closing);
    surface.closing = null;
  }
  panel.classList.remove("paperly-note-closing");
  panel.hidden = false;
  // After hidden, because a display:none box has no rect to measure.
  setOpenOrigin(surface);
  restartAnimation(panel, "paperly-note-opening");
  applyTheme(surface);
  refreshButtons();
  syncClip(surface);

  if (!surface.target) {
    surface.target = resolvePaperNoteTarget(reader.itemID);
  }
  refreshPaperTitle(surface);
  if (!surface.target) {
    surface.editor?.setAttribute("contenteditable", "false");
    setStatus(
      surface,
      text("No paper is open here", "此处没有打开的文献"),
    );
    return;
  }
  surface.editor?.setAttribute("contenteditable", "true");
  await reload(surface);
  // After the text is in: setting textContent would otherwise throw away the
  // caret. preventScroll because focus() scrolls every scrollable ancestor and
  // the panel clips its own overflow.
  (surface.editor as HTMLElement | null)?.focus({ preventScroll: true });
}

export function closeNotePanel(win: Window): void {
  const surface = surfaces.get(win);
  if (!surface?.panel || surface.panel.hidden) {
    return;
  }
  const panel = surface.panel;
  const doc = surface.doc;
  closeEmojiPicker(doc);
  closeBlockMenu(doc);
  closeColorMenu(doc);
  closeFormatBar(doc);
  // Whatever is still in the debounce window goes out now rather than waiting
  // for a timer whose document may be closing.
  void flushPaperNoteSaves();

  const view = doc.defaultView;
  if (surface.closing !== null) {
    view?.clearTimeout(surface.closing);
    surface.closing = null;
  }
  panel.classList.remove("paperly-note-opening", "paperly-note-dropping");
  if (!view) {
    panel.hidden = true;
    refreshButtons();
    syncClip(surface);
    return;
  }
  // `hidden` waits for the animation, because display:none would cut it off on
  // its first frame. The out keyframe holds its last frame (`forwards`), so
  // nothing flashes back into view while the timer runs.
  restartAnimation(panel, "paperly-note-closing");
  surface.closing = view.setTimeout(() => {
    surface.closing = null;
    panel.classList.remove("paperly-note-closing");
    panel.hidden = true;
    // Only now is there nothing to catch, so only now does the dock let the
    // paper and the column have every pixel back.
    syncClip(surface);
  }, CLOSE_MS);
  // The pad counts as closed from the press, not from the end of its animation.
  refreshButtons();
}

// ---------------------------------------------------------------- teardown --

export function destroyReaderNoteSurface(win: Window): void {
  const surface = surfaces.get(win);
  if (!surface) {
    return;
  }
  surfaces.delete(win);
  const doc = surface.doc;
  // The pad is about to be removed outright, so the timer waiting to hide it
  // would fire against a detached node.
  if (surface.closing !== null) {
    win.clearTimeout(surface.closing);
    surface.closing = null;
  }
  closeEmojiPicker(doc);
  closeBlockMenu(doc);
  closeColorMenu(doc);
  closeFormatBar(doc);
  for (const off of surface.teardown) {
    try {
      off();
    } catch {
      // Teardown must not throw on the way out.
    }
  }
  surface.teardown = [];
  try {
    surface.panel?.remove();
    doc.getElementById(STYLE_ID)?.remove();
  } catch {
    // The document may already be gone.
  }
  surface.panel = null;
  surface.editor = null;
  surface.overlay = null;
  surface.status = null;
  // The dock is the pad's whole home, so it goes with it rather than being
  // left over the window catching nothing.
  destroyOverlayDock(win, "note");
  refreshButtons();
}

export function destroyAllReaderNoteSurfaces(): void {
  destroyEmojiPickers();
  destroyBlockMenus();
  destroyColorMenus();
  destroyFormatBars();
  for (const win of [...surfaces.keys()]) {
    destroyReaderNoteSurface(win);
  }
  for (const entry of buttons.values()) {
    entry.anchorObserver?.disconnect();
    try {
      entry.button.remove();
    } catch {
      // Its document may already be gone.
    }
  }
  buttons.clear();
  destroyOverlayDocks("note");
}
