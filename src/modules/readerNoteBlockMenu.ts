// The "/" menu: the list of blocks you can insert, the way Notion does it.
//
// Unlike the emoji picker, this one never takes focus. It does not need to: the
// caret stays in the editor, which is a contenteditable and therefore something
// the reader's isTextBox() recognises, so typing goes on reaching the note and
// the arrow keys are not stolen. The menu is driven entirely by what the panel
// forwards to it.
import {
  NOTE_BLOCKS,
  NoteBlockDef,
  NoteBlockId,
  buildIcon,
} from "../ui/noteBlocks";
import { isChineseLocale } from "../utils/locale";

const ROOT_ID = "paperly-note-blocks";
const STYLE_ID = "paperly-note-blocks-style";
// Over the pad, under every reader popup -- the same band as the emoji picker.
const Z_INDEX = 26;
const WIDTH = 268;
const MAX_HEIGHT = 292;

function text(en: string, zh: string): string {
  return isChineseLocale() ? zh : en;
}

interface MenuState {
  doc: Document;
  root: HTMLElement;
  list: HTMLElement;
  empty: HTMLElement;
  matches: NoteBlockDef[];
  active: number;
  /** The type the caret is already in, which gets the tick. */
  current: NoteBlockId | null;
  anchor: DOMRect;
  trigger: HTMLElement | null;
  onPick: (id: NoteBlockId) => void;
  onClose: () => void;
  teardown: (() => void)[];
}

const menus = new Map<Document, MenuState>();

export interface BlockMenuOptions {
  doc: Document;
  /** Where the caret is, in client coordinates. */
  anchor: DOMRect;
  /** The pad, whose theme custom properties the menu copies. */
  themeSource: HTMLElement;
  /**
   * The button that opened it, if any. Pressing that button again has to close
   * the menu, and it cannot do that while the outside-press handler has
   * already closed it in the capture phase before the click arrives.
   */
  trigger?: HTMLElement;
  /**
   * The block type the caret is in. Opened from the toolbar the menu is a
   * switcher, so it says which one is on; opened by typing "/" there is no
   * "current" worth ticking, and this is left out.
   */
  current?: NoteBlockId;
  onPick: (id: NoteBlockId) => void;
  onClose: () => void;
}

export function isBlockMenuOpen(doc: Document): boolean {
  return menus.has(doc);
}

function styleSheet(): string {
  return `
#${ROOT_ID} {
  position: fixed;
  z-index: ${Z_INDEX};
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: ${WIDTH}px;
  max-height: ${MAX_HEIGHT}px;
  padding: 6px;
  border-radius: 10px;
  overflow: auto;
  scrollbar-width: thin;
  background: var(--paperly-note-bg, #ffffff);
  color: var(--paperly-note-fg, #000000);
  border: 1px solid color-mix(in srgb, var(--paperly-note-fg) 20%, var(--paperly-note-bg));
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.12);
  font-family: var(--paperly-note-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
}
#${ROOT_ID}[data-scheme="dark"] {
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4);
}
#${ROOT_ID} .paperly-blocks-label {
  padding: 6px 8px 4px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.5;
}
#${ROOT_ID} .paperly-blocks-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  text-align: start;
  font: inherit;
  font-size: 13px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
#${ROOT_ID} .paperly-blocks-row[data-active="true"] {
  background: color-mix(in srgb, var(--paperly-note-fg) 12%, var(--paperly-note-bg));
}
#${ROOT_ID} .paperly-blocks-icon {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  opacity: 0.85;
  background: color-mix(in srgb, var(--paperly-note-fg) 7%, var(--paperly-note-bg));
}
#${ROOT_ID} .paperly-blocks-name {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${ROOT_ID} .paperly-blocks-hint {
  flex: 0 0 auto;
  font-size: 11px;
  opacity: 0.4;
}
#${ROOT_ID} .paperly-blocks-tick {
  flex: 0 0 auto;
  font-size: 12px;
  opacity: 0.75;
}
#${ROOT_ID} .paperly-blocks-empty {
  padding: 14px 10px;
  text-align: center;
  font-size: 12px;
  opacity: 0.55;
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
  for (const name of [
    "--paperly-note-bg",
    "--paperly-note-fg",
    "--paperly-note-font",
  ]) {
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

export function syncBlockMenuTheme(
  doc: Document,
  themeSource: HTMLElement,
): void {
  const state = menus.get(doc);
  if (state) {
    applyThemeVars(state.root, themeSource);
  }
}

/** Filters on the label and the keywords, which include unaccented Vietnamese. */
function search(query: string): NoteBlockDef[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return NOTE_BLOCKS;
  }
  const scored: { block: NoteBlockDef; score: number }[] = [];
  NOTE_BLOCKS.forEach((block) => {
    const label = text(block.en, block.zh).toLowerCase();
    const fields = [label, block.en.toLowerCase(), ...block.keywords];
    let best = -1;
    for (const field of fields) {
      const at = field.indexOf(needle);
      if (at < 0) {
        continue;
      }
      const score = at === 0 ? 0 : 1;
      best = best < 0 ? score : Math.min(best, score);
    }
    if (best >= 0) {
      scored.push({ block, score: best });
    }
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.map((hit) => hit.block);
}

function place(state: MenuState): void {
  const view = state.doc.defaultView;
  if (!view) {
    return;
  }
  const width = state.root.offsetWidth || WIDTH;
  const height = state.root.offsetHeight || MAX_HEIGHT;
  const left = Math.min(
    Math.max(8, state.anchor.left),
    Math.max(8, view.innerWidth - width - 8),
  );
  let top = state.anchor.bottom + 6;
  if (top + height > view.innerHeight - 8) {
    top = Math.max(8, state.anchor.top - height - 6);
  }
  state.root.style.left = `${Math.round(left)}px`;
  state.root.style.top = `${Math.round(top)}px`;
}

function setActive(state: MenuState, index: number): void {
  const rows = Array.from(
    state.list.querySelectorAll(".paperly-blocks-row"),
  ) as HTMLElement[];
  rows[state.active]?.removeAttribute("data-active");
  state.active = Math.max(0, Math.min(rows.length - 1, index));
  const row = rows[state.active];
  if (!row) {
    return;
  }
  row.setAttribute("data-active", "true");
  // Scrolled by hand rather than with scrollIntoView, which would also scroll
  // every clipping ancestor between here and the reader's root.
  const top = row.offsetTop;
  if (top < state.root.scrollTop) {
    state.root.scrollTop = Math.max(0, top - 24);
  } else if (top + row.offsetHeight > state.root.scrollTop + state.root.clientHeight) {
    state.root.scrollTop = top + row.offsetHeight - state.root.clientHeight + 6;
  }
}

function renderRows(state: MenuState): void {
  const doc = state.doc;
  state.list.replaceChildren();
  state.matches.forEach((block, index) => {
    const row = doc.createElement("button");
    row.type = "button";
    row.className = "paperly-blocks-row";
    row.dataset.block = block.id;
    const icon = doc.createElement("span");
    icon.className = "paperly-blocks-icon";
    icon.appendChild(buildIcon(doc, 18, block.icon));
    const name = doc.createElement("span");
    name.className = "paperly-blocks-name";
    name.textContent = text(block.en, block.zh);
    row.append(icon, name);
    if (block.hint) {
      const hint = doc.createElement("span");
      hint.className = "paperly-blocks-hint";
      hint.textContent = block.hint;
      row.appendChild(hint);
    }
    if (state.current === block.id) {
      row.setAttribute("aria-checked", "true");
      const tick = doc.createElement("span");
      tick.className = "paperly-blocks-tick";
      tick.textContent = "\u2713";
      row.appendChild(tick);
    }
    row.addEventListener("mousemove", () => setActive(state, index));
    state.list.appendChild(row);
  });
  state.empty.hidden = state.matches.length > 0;
  state.active = -1;
  setActive(state, 0);
}

/**
 * Narrows the menu to what has been typed after the slash.
 *
 * Returns false when nothing matches any more, which is the caller's cue to
 * put the menu away -- someone typing "/usr/local" is not picking a block.
 */
export function updateBlockMenu(doc: Document, query: string): boolean {
  const state = menus.get(doc);
  if (!state) {
    return false;
  }
  state.matches = search(query);
  renderRows(state);
  place(state);
  return state.matches.length > 0;
}

/** Moves the caret's anchor, so the menu follows the line it belongs to. */
export function moveBlockMenu(doc: Document, anchor: DOMRect): void {
  const state = menus.get(doc);
  if (state) {
    state.anchor = anchor;
    place(state);
  }
}

/** Returns true when the key belonged to the menu. */
export function blockMenuKeyDown(doc: Document, event: KeyboardEvent): boolean {
  const state = menus.get(doc);
  if (!state) {
    return false;
  }
  const key = event.key;
  if (key === "Escape") {
    closeBlockMenu(doc);
    return true;
  }
  if (key === "ArrowDown") {
    setActive(state, state.active + 1);
    return true;
  }
  if (key === "ArrowUp") {
    setActive(state, state.active - 1);
    return true;
  }
  if (key === "Enter" || key === "Tab") {
    const block = state.matches[state.active];
    if (!block) {
      closeBlockMenu(doc);
      return true;
    }
    const pick = state.onPick;
    closeBlockMenu(doc);
    pick(block.id);
    return true;
  }
  return false;
}

export function closeBlockMenu(doc: Document): void {
  const state = menus.get(doc);
  if (!state) {
    return;
  }
  menus.delete(doc);
  for (const off of state.teardown) {
    try {
      off();
    } catch {
      // Teardown must not throw on the way out.
    }
  }
  state.root.remove();
  state.onClose();
}

export function openBlockMenu(options: BlockMenuOptions): void {
  const { doc, anchor, themeSource, trigger, current, onPick, onClose } =
    options;
  closeBlockMenu(doc);
  ensureStyles(doc);

  const root = doc.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("role", "listbox");
  root.setAttribute("aria-label", text("Basic blocks", "基础模块"));
  applyThemeVars(root, themeSource);

  const label = doc.createElement("div");
  label.className = "paperly-blocks-label";
  label.textContent = text("Basic blocks", "基础模块");
  const list = doc.createElement("div");
  const empty = doc.createElement("div");
  empty.className = "paperly-blocks-empty";
  empty.textContent = text("No block matches", "没有匹配的模块");
  empty.hidden = true;
  root.append(label, list, empty);
  doc.body?.appendChild(root);

  const state: MenuState = {
    doc,
    root,
    list,
    empty,
    matches: NOTE_BLOCKS,
    active: -1,
    current: current || null,
    anchor,
    trigger: trigger || null,
    onPick,
    onClose,
    teardown: [],
  };
  menus.set(doc, state);
  renderRows(state);
  place(state);

  // Nothing in here may take the caret out of the editor, so every press inside
  // the menu is cancelled. mousedown as well as pointerdown: cancelling
  // pointerdown does not stop the browser collapsing the selection, and a
  // collapsed selection takes the toolbar away mid-press -- see the note on the
  // same pair in readerNoteFormatBar.
  const onPointerDown = (event: Event): void => {
    event.preventDefault();
  };
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("mousedown", onPointerDown);
  state.teardown.push(() => {
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("mousedown", onPointerDown);
  });

  const onClick = (event: Event): void => {
    const row = (event.target as Element | null)?.closest(
      ".paperly-blocks-row",
    ) as HTMLElement | null;
    const id = row?.dataset.block as NoteBlockId | undefined;
    if (!id) {
      return;
    }
    const pick = state.onPick;
    closeBlockMenu(doc);
    pick(id);
  };
  root.addEventListener("click", onClick);
  state.teardown.push(() => root.removeEventListener("click", onClick));

  const onOutside = (event: Event): void => {
    const target = event.target as Node | null;
    if (
      target &&
      (root.contains(target) || state.trigger?.contains(target))
    ) {
      return;
    }
    closeBlockMenu(doc);
  };
  doc.addEventListener("pointerdown", onOutside, true);
  state.teardown.push(() =>
    doc.removeEventListener("pointerdown", onOutside, true),
  );
}

export function destroyBlockMenus(): void {
  for (const doc of [...menus.keys()]) {
    closeBlockMenu(doc);
  }
}
