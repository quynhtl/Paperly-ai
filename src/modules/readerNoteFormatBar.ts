// The toolbar that comes up over a selection.
//
// Same shape as the other three popups in the pad: fixed to the reader
// document, never takes focus, closes on a press outside itself. It differs in
// one way, and the difference is the whole design: it is shown and hidden
// constantly, so it is BUILT once per document and then updated. Rebuilding it
// on every selection change would make the buttons flash under the pointer.
//
// It has three faces in one box -- the marks, the link field, the highlight
// palette -- rather than three popups, because a popup hanging off a popup
// would have to close in the right order and would cover the text twice over.
import {
  NoteBlockId,
  buildIcon,
  noteBlockById,
  type IconPath,
} from "../ui/noteBlocks";
import { NOTE_HIGHLIGHTS } from "../ui/noteColors";
import {
  NO_HIGHLIGHT,
  type MarkState,
  type NoteMarkId,
} from "./readerNoteEditing";
import {
  closeBlockMenu,
  isBlockMenuOpen,
  openBlockMenu,
} from "./readerNoteBlockMenu";
import { isChineseLocale } from "../utils/locale";

const ROOT_ID = "paperly-note-format";
const STYLE_ID = "paperly-note-format-style";
// Over the pad, under every reader popup -- the same band as the other three.
const Z_INDEX = 26;
// How far above the selection the bar sits, and the gap it keeps from an edge.
const OFFSET = 8;
const EDGE = 8;

function text(en: string, zh: string): string {
  return isChineseLocale() ? zh : en;
}

/** What the bar is showing: the marks, the link field, or the palette. */
type Face = "marks" | "link" | "highlight";

export type FormatAction =
  | { kind: "block"; id: NoteBlockId }
  | { kind: "mark"; id: NoteMarkId }
  | { kind: "highlight"; color: string }
  | { kind: "link"; href: string }
  | { kind: "unlink" }
  | { kind: "clear" };

export interface FormatBarSnapshot {
  /**
   * The block type the selection is in, or null where switching type is not
   * offered -- inside a table cell, where a heading would be thrown away when
   * the cell is stored.
   */
  block: NoteBlockId | null;
  marks: MarkState;
}

export interface FormatBarOptions {
  doc: Document;
  /** The pad, whose theme custom properties the bar copies. */
  themeSource: HTMLElement;
  /** The selection, in client coordinates. */
  anchor: DOMRect;
  /** The editor's box. The bar goes above the selection only if it fits here. */
  bounds: DOMRect;
  snapshot: FormatBarSnapshot;
  onAction: (action: FormatAction) => void;
  /**
   * Puts the caret back in the note. Called when the link field is dismissed
   * with nothing following it; an action puts the caret back on its own.
   */
  onRestore: () => void;
}

interface BarState {
  doc: Document;
  root: HTMLElement;
  blockRow: HTMLButtonElement;
  blockIcon: HTMLElement;
  blockName: HTMLElement;
  marksRow: HTMLElement;
  linkRow: HTMLElement;
  linkField: HTMLInputElement;
  highlightRow: HTMLElement;
  /** The mark buttons by id, plus "link" and "highlight". */
  buttons: Map<string, HTMLElement>;
  /** The band of colour under the highlight button. */
  chip: HTMLElement;
  face: Face;
  options: FormatBarOptions;
  teardown: (() => void)[];
}

const bars = new Map<Document, BarState>();

export function isFormatBarOpen(doc: Document): boolean {
  return bars.has(doc);
}

/** True while the link field holds the caret, so the selection must be kept. */
export function isFormatBarEditing(doc: Document): boolean {
  return bars.get(doc)?.face === "link";
}

// ------------------------------------------------------------------ icons ---

const CHEVRON_PATHS: IconPath[] = [{ d: "M3.4 5.2L7 8.8L10.6 5.2", stroke: true }];

// A marker pen, for the highlight button.
const PEN_PATHS: IconPath[] = [
  { d: "M4.2 10.4L9.6 5a1.7 1.7 0 0 1 2.4 2.4l-5.4 5.4H4.2Z", stroke: true },
  { d: "M3 15.2H15", stroke: true },
];

// Two links of a chain, for the link button.
const LINK_PATHS: IconPath[] = [
  { d: "M7.6 10.4a2.6 2.6 0 0 0 3.8 0.3l2-2a2.6 2.6 0 0 0-3.7-3.7l-1 1", stroke: true },
  { d: "M10.4 7.6a2.6 2.6 0 0 0-3.8-0.3l-2 2a2.6 2.6 0 0 0 3.7 3.7l1-1", stroke: true },
];

const TICK_PATHS: IconPath[] = [{ d: "M3.4 7.4L6.2 10.2L11.6 4.4", stroke: true }];

// ----------------------------------------------------------------- styles ---

function styleSheet(): string {
  return `
#${ROOT_ID} {
  position: fixed;
  z-index: ${Z_INDEX};
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-sizing: border-box;
  padding: 4px;
  border-radius: 9px;
  background: var(--paperly-note-bg, #ffffff);
  color: var(--paperly-note-fg, #000000);
  border: 1px solid color-mix(in srgb, var(--paperly-note-fg) 20%, var(--paperly-note-bg));
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.12);
  /* The pad's font is the note's, not the toolbar's: a B in a serif at 12px
     is unreadable, and these letters ARE the labels. */
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
#${ROOT_ID}[data-scheme="dark"] {
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4);
}
#${ROOT_ID} .paperly-format-block {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  text-align: start;
  font: inherit;
  font-size: 12.5px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
#${ROOT_ID} .paperly-format-block:hover,
#${ROOT_ID} .paperly-format-block[aria-expanded="true"] {
  background: color-mix(in srgb, var(--paperly-note-fg) 10%, var(--paperly-note-bg));
}
#${ROOT_ID} .paperly-format-block-name {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${ROOT_ID} .paperly-format-block-icon,
#${ROOT_ID} .paperly-format-chevron {
  flex: 0 0 auto;
  display: flex;
  opacity: 0.7;
}

#${ROOT_ID} .paperly-format-row {
  display: flex;
  align-items: center;
  gap: 1px;
}
/* Written out per class rather than as one #id [hidden] rule: an attribute
   selector and a class selector weigh the same, so the generic rule lost to
   the display above it and every face was laid out at once. */
#${ROOT_ID} .paperly-format-row[hidden],
#${ROOT_ID} .paperly-format-block[hidden] { display: none; }
#${ROOT_ID} .paperly-format-button {
  flex: 0 0 auto;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 0 4px;
  border: 0;
  border-radius: 6px;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  color: inherit;
  background: transparent;
  cursor: pointer;
  opacity: 0.75;
}
#${ROOT_ID} .paperly-format-button:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--paperly-note-fg) 10%, var(--paperly-note-bg));
}
#${ROOT_ID} .paperly-format-button:disabled {
  opacity: 0.26;
  cursor: default;
  background: transparent;
}
#${ROOT_ID} .paperly-format-button[aria-pressed="true"],
#${ROOT_ID} .paperly-format-button[aria-expanded="true"] {
  opacity: 1;
  background: color-mix(in srgb, var(--paperly-note-fg) 16%, var(--paperly-note-bg));
}
/* The letters are the icons, so each one carries its own meaning. */
#${ROOT_ID} .paperly-format-button[data-mark="bold"] { font-weight: 800; }
#${ROOT_ID} .paperly-format-button[data-mark="italic"] { font-style: italic; font-family: Georgia, serif; }
#${ROOT_ID} .paperly-format-button[data-mark="underline"] { text-decoration: underline; }
#${ROOT_ID} .paperly-format-button[data-mark="strike"] { text-decoration: line-through; }
#${ROOT_ID} .paperly-format-button[data-mark="code"] { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
#${ROOT_ID} .paperly-format-clear { font-size: 12.5px; }
#${ROOT_ID} .paperly-format-clear sub { font-size: 0.72em; }

#${ROOT_ID} .paperly-format-highlight { flex-direction: column; gap: 1px; padding-bottom: 2px; }
#${ROOT_ID} .paperly-format-chip {
  width: 15px;
  height: 3px;
  border-radius: 2px;
  background: currentColor;
  opacity: 0.5;
}
#${ROOT_ID} .paperly-format-chip[data-on="true"] { opacity: 1; }

#${ROOT_ID} .paperly-format-separator {
  flex: 0 0 auto;
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: color-mix(in srgb, var(--paperly-note-fg) 20%, var(--paperly-note-bg));
}

#${ROOT_ID} .paperly-format-field {
  flex: 1 1 auto;
  min-width: 150px;
  height: 24px;
  padding: 0 7px;
  border-radius: 6px;
  font: inherit;
  font-size: 12.5px;
  color: inherit;
  background: color-mix(in srgb, var(--paperly-note-fg) 8%, var(--paperly-note-bg));
  border: 1px solid color-mix(in srgb, var(--paperly-note-fg) 18%, var(--paperly-note-bg));
  outline: none;
}
#${ROOT_ID} .paperly-format-field::placeholder { color: inherit; opacity: 0.42; }

#${ROOT_ID} .paperly-format-swatch {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  padding: 0;
  margin: 2px 1px;
  border: 1px solid rgba(0, 0, 0, 0.14);
  border-radius: 5px;
  cursor: pointer;
}
#${ROOT_ID} .paperly-format-swatch:hover {
  border-color: color-mix(in srgb, var(--paperly-note-fg) 55%, transparent);
}
#${ROOT_ID} .paperly-format-swatch[aria-checked="true"] {
  box-shadow:
    0 0 0 1.5px var(--paperly-note-bg, #fff),
    0 0 0 3px color-mix(in srgb, var(--paperly-note-fg) 75%, var(--paperly-note-bg));
}
/* "No colour" is a swatch with a line through it rather than a word, so the
   row stays one row at any pad width. */
#${ROOT_ID} .paperly-format-swatch[data-none="true"] {
  background:
    linear-gradient(to top right, transparent calc(50% - 1px), currentColor calc(50% - 1px), currentColor calc(50% + 1px), transparent calc(50% + 1px));
}
`;
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

function applyThemeVars(root: HTMLElement, source: HTMLElement): void {
  for (const name of ["--paperly-note-bg", "--paperly-note-fg"]) {
    const value = source.style.getPropertyValue(name);
    if (value) {
      root.style.setProperty(name, value);
    }
  }
  const scheme = source.getAttribute("data-scheme");
  if (scheme) {
    root.setAttribute("data-scheme", scheme);
  }
}

export function syncFormatBarTheme(
  doc: Document,
  themeSource: HTMLElement,
): void {
  const state = bars.get(doc);
  if (state) {
    applyThemeVars(state.root, themeSource);
  }
}

// ------------------------------------------------------------------ build ---

const MARK_LABELS: { id: NoteMarkId; glyph: string; en: string; zh: string }[] = [
  { id: "bold", glyph: "B", en: "Bold", zh: "加粗" },
  { id: "italic", glyph: "I", en: "Italic", zh: "斜体" },
  { id: "underline", glyph: "U", en: "Underline", zh: "下划线" },
  { id: "strike", glyph: "S", en: "Strikethrough", zh: "删除线" },
  { id: "code", glyph: "</>", en: "Code", zh: "行内代码" },
];

function button(doc: Document, title: string): HTMLButtonElement {
  const node = doc.createElement("button");
  node.type = "button";
  node.className = "paperly-format-button";
  node.title = title;
  node.setAttribute("aria-label", title);
  return node;
}

function setFace(state: BarState, face: Face): void {
  state.face = face;
  state.marksRow.hidden = face !== "marks";
  state.linkRow.hidden = face !== "link";
  state.highlightRow.hidden = face !== "highlight";
  state.buttons.get("highlight")?.setAttribute(
    "aria-expanded",
    face === "highlight" ? "true" : "false",
  );
  state.buttons.get("link")?.setAttribute(
    "aria-expanded",
    face === "link" ? "true" : "false",
  );
  applySnapshot(state);
  if (face === "link") {
    state.linkField.focus({ preventScroll: true });
    state.linkField.select();
  }
  place(state);
}

/** Leaves whichever field was open and hands the caret back to the note. */
function leaveField(state: BarState): void {
  if (state.face === "marks") {
    return;
  }
  setFace(state, "marks");
  state.options.onRestore();
}

function build(options: FormatBarOptions): BarState {
  const doc = options.doc;
  ensureStyles(doc);

  const root = doc.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", text("Formatting", "文字格式"));

  const blockRow = doc.createElement("button");
  blockRow.type = "button";
  blockRow.className = "paperly-format-block";
  blockRow.setAttribute("aria-expanded", "false");
  const blockIcon = doc.createElement("span");
  blockIcon.className = "paperly-format-block-icon";
  const blockName = doc.createElement("span");
  blockName.className = "paperly-format-block-name";
  const chevron = doc.createElement("span");
  chevron.className = "paperly-format-chevron";
  chevron.appendChild(buildIcon(doc, 14, CHEVRON_PATHS));
  blockRow.append(blockIcon, blockName, chevron);

  const marksRow = doc.createElement("div");
  marksRow.className = "paperly-format-row";

  const buttons = new Map<string, HTMLElement>();

  const highlight = button(doc, text("Highlight", "高亮"));
  highlight.classList.add("paperly-format-highlight");
  highlight.setAttribute("aria-expanded", "false");
  highlight.appendChild(buildIcon(doc, 18, PEN_PATHS));
  const chip = doc.createElement("span");
  chip.className = "paperly-format-chip";
  highlight.appendChild(chip);
  buttons.set("highlight", highlight);
  marksRow.appendChild(highlight);

  const separator = doc.createElement("span");
  separator.className = "paperly-format-separator";
  marksRow.appendChild(separator);

  for (const mark of MARK_LABELS) {
    const node = button(doc, text(mark.en, mark.zh));
    node.dataset.mark = mark.id;
    node.textContent = mark.glyph;
    buttons.set(mark.id, node);
    marksRow.appendChild(node);
  }

  const link = button(doc, text("Link", "链接"));
  link.setAttribute("aria-expanded", "false");
  link.appendChild(buildIcon(doc, 18, LINK_PATHS));
  buttons.set("link", link);
  marksRow.appendChild(link);

  const clear = button(doc, text("Clear formatting", "清除格式"));
  clear.classList.add("paperly-format-clear");
  const clearT = doc.createElement("span");
  clearT.textContent = "T";
  const clearX = doc.createElement("sub");
  clearX.textContent = "x";
  clear.append(clearT, clearX);
  buttons.set("clear", clear);
  marksRow.appendChild(clear);

  const linkRow = doc.createElement("div");
  linkRow.className = "paperly-format-row";
  linkRow.hidden = true;
  const linkField = doc.createElement("input");
  linkField.type = "text";
  linkField.className = "paperly-format-field";
  linkField.placeholder = text("Paste a link…", "粘贴链接……");
  linkField.setAttribute("aria-label", linkField.placeholder);
  const linkApply = button(doc, text("Apply", "确定"));
  linkApply.appendChild(buildIcon(doc, 14, TICK_PATHS));
  const linkRemove = button(doc, text("Remove link", "移除链接"));
  linkRemove.textContent = "✕";
  linkRow.append(linkField, linkApply, linkRemove);

  const highlightRow = doc.createElement("div");
  highlightRow.className = "paperly-format-row";
  highlightRow.hidden = true;

  root.append(blockRow, marksRow, linkRow, highlightRow);
  doc.body?.appendChild(root);

  const state: BarState = {
    doc,
    root,
    blockRow,
    blockIcon,
    blockName,
    marksRow,
    linkRow,
    linkField,
    highlightRow,
    buttons,
    chip,
    face: "marks",
    options,
    teardown: [],
  };

  const none = doc.createElement("button");
  none.type = "button";
  none.className = "paperly-format-swatch";
  none.dataset.none = "true";
  none.title = text("No highlight", "取消高亮");
  none.setAttribute("aria-label", none.title);
  none.setAttribute("role", "radio");
  none.addEventListener("click", () => {
    setFace(state, "marks");
    state.options.onAction({ kind: "highlight", color: NO_HIGHLIGHT });
  });
  highlightRow.appendChild(none);
  for (const swatch of NOTE_HIGHLIGHTS) {
    const node = doc.createElement("button");
    node.type = "button";
    node.className = "paperly-format-swatch";
    node.style.background = swatch.hex;
    node.title = text(swatch.en, swatch.zh);
    node.setAttribute("aria-label", node.title);
    node.setAttribute("role", "radio");
    node.dataset.color = swatch.hex;
    node.addEventListener("click", () => {
      setFace(state, "marks");
      state.options.onAction({ kind: "highlight", color: swatch.hex });
    });
    highlightRow.appendChild(node);
  }

  blockRow.addEventListener("click", () => {
    if (isBlockMenuOpen(doc)) {
      closeBlockMenu(doc);
      return;
    }
    blockRow.setAttribute("aria-expanded", "true");
    openBlockMenu({
      doc,
      anchor: blockRow.getBoundingClientRect(),
      themeSource: state.options.themeSource,
      trigger: blockRow,
      current: state.options.snapshot.block || undefined,
      onPick: (id) => state.options.onAction({ kind: "block", id }),
      onClose: () => blockRow.setAttribute("aria-expanded", "false"),
    });
  });

  for (const mark of MARK_LABELS) {
    buttons.get(mark.id)?.addEventListener("click", () => {
      state.options.onAction({ kind: "mark", id: mark.id });
    });
  }
  clear.addEventListener("click", () => {
    state.options.onAction({ kind: "clear" });
  });
  highlight.addEventListener("click", () => {
    setFace(state, state.face === "highlight" ? "marks" : "highlight");
  });
  link.addEventListener("click", () => {
    if (state.face === "link") {
      leaveField(state);
      return;
    }
    state.linkField.value = state.options.snapshot.marks.link || "";
    setFace(state, "link");
  });
  const applyLink = (): void => {
    const href = state.linkField.value.trim();
    setFace(state, "marks");
    state.options.onAction(href ? { kind: "link", href } : { kind: "unlink" });
  };
  linkApply.addEventListener("click", applyLink);
  linkRemove.addEventListener("click", () => {
    setFace(state, "marks");
    state.options.onAction({ kind: "unlink" });
  });
  linkField.addEventListener("keydown", (event) => {
    const key = event as KeyboardEvent;
    if (key.key === "Enter") {
      event.preventDefault();
      applyLink();
      return;
    }
    if (key.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      leaveField(state);
    }
  });

  // Nothing here may take the caret out of the note -- except the link field,
  // which is the one thing that has to have it.
  const onPointerDown = (event: Event): void => {
    if (event.target !== linkField) {
      event.preventDefault();
    }
  };
  root.addEventListener("pointerdown", onPointerDown);
  state.teardown.push(() =>
    root.removeEventListener("pointerdown", onPointerDown),
  );

  const onOutside = (event: Event): void => {
    const target = event.target as Node | null;
    // The blocks menu is opened BY this bar, so a press in it is not outside.
    if ((target && root.contains(target)) || isBlockMenuOpen(doc)) {
      return;
    }
    closeFormatBar(doc);
  };
  doc.addEventListener("pointerdown", onOutside, true);
  state.teardown.push(() =>
    doc.removeEventListener("pointerdown", onOutside, true),
  );

  return state;
}

// ------------------------------------------------------------------ place ---

function place(state: BarState): void {
  const view = state.doc.defaultView;
  if (!view) {
    return;
  }
  const { anchor, bounds } = state.options;
  const width = state.root.offsetWidth || 240;
  const height = state.root.offsetHeight || 64;
  // Centred on the selection, but kept over the note. The pad is narrow, and a
  // bar centred on a word near its left edge would hang out over the paper
  // instead of belonging to the thing it is editing.
  const centred = anchor.left + anchor.width / 2 - width / 2;
  const inside = Math.min(
    Math.max(centred, bounds.left - 2),
    Math.max(bounds.left - 2, bounds.right - width + 2),
  );
  const left = Math.min(
    Math.max(EDGE, Math.round(inside)),
    Math.max(EDGE, view.innerWidth - width - EDGE),
  );
  // Above the selection, which is where a toolbar belongs: it does not cover
  // the next line, which is the one being read. It only goes below when there
  // is no room for it inside the note's own box.
  let top = anchor.top - height - OFFSET;
  if (top < bounds.top || top < EDGE) {
    top = anchor.bottom + OFFSET;
  }
  top = Math.min(top, view.innerHeight - height - EDGE);
  state.root.style.left = `${left}px`;
  state.root.style.top = `${Math.max(EDGE, Math.round(top))}px`;
}

function applySnapshot(state: BarState): void {
  const { block, marks } = state.options.snapshot;
  const def = block ? noteBlockById(block) : null;
  if (def) {
    state.blockIcon.replaceChildren(buildIcon(state.doc, 18, def.icon));
    state.blockName.textContent = text(def.en, def.zh);
  }
  state.blockRow.hidden = state.face !== "marks" || !def;

  for (const mark of MARK_LABELS) {
    state.buttons
      .get(mark.id)
      ?.setAttribute("aria-pressed", marks[mark.id] ? "true" : "false");
  }
  // Bold is greyed out in a heading rather than left to do nothing there. The
  // pad draws headings at weight 650, so the browser already counts them as
  // bold and its bold command UN-bolds instead: measured, it wrote a
  // font-weight:normal span, which showed part of the heading in plain text
  // until the next save quietly dropped it again.
  (state.buttons.get("bold") as HTMLButtonElement).disabled = /^h[1-4]$/.test(
    `${block ?? ""}`,
  );
  state.buttons
    .get("link")
    ?.setAttribute("aria-pressed", marks.link ? "true" : "false");
  const highlight = state.buttons.get("highlight");
  highlight?.setAttribute("aria-pressed", marks.highlight ? "true" : "false");
  state.chip.style.background = marks.highlight || "";
  state.chip.dataset.on = marks.highlight ? "true" : "false";

  // The browser hands back `rgba(255, 212, 0, 0.5)` for a stored `#ffd40080`,
  // so a swatch is compared to the painted colour only after this one throwaway
  // span has parsed both the same way.
  const probe = state.doc.createElement("span");
  for (const swatch of Array.from(
    state.highlightRow.querySelectorAll(".paperly-format-swatch"),
  ) as HTMLElement[]) {
    const wanted = swatch.dataset.color;
    let on = !marks.highlight;
    if (wanted && marks.highlight) {
      probe.style.backgroundColor = wanted;
      on = probe.style.backgroundColor === marks.highlight;
    } else if (wanted) {
      on = false;
    }
    swatch.setAttribute("aria-checked", on ? "true" : "false");
  }
}

/** Shows the bar, building it the first time and updating it after that. */
export function showFormatBar(options: FormatBarOptions): void {
  let state = bars.get(options.doc);
  if (!state) {
    state = build(options);
    bars.set(options.doc, state);
  }
  state.options = options;
  applyThemeVars(state.root, options.themeSource);
  applySnapshot(state);
  place(state);
}

export function closeFormatBar(doc: Document): void {
  const state = bars.get(doc);
  if (!state) {
    return;
  }
  bars.delete(doc);
  closeBlockMenu(doc);
  for (const off of state.teardown) {
    try {
      off();
    } catch {
      // Teardown must not throw on the way out.
    }
  }
  state.root.remove();
}

/** Opens the link field, for the keyboard shortcut. False if there is no bar. */
export function editFormatBarLink(doc: Document): boolean {
  const state = bars.get(doc);
  if (!state) {
    return false;
  }
  state.linkField.value = state.options.snapshot.marks.link || "";
  setFace(state, "link");
  return true;
}

export function destroyFormatBars(): void {
  for (const doc of [...bars.keys()]) {
    closeFormatBar(doc);
  }
}
