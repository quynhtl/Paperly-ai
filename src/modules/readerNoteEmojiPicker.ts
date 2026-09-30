// The emoji picker the note pad opens from its header.
//
// It is a sibling of the pad in the reader document, not a child of it: the
// pad clips its own overflow, so a popover inside it would be cut off at the
// edge. Being a sibling also means it can hang below a pad docked near the
// bottom of the page.
//
// The search field keeps focus the whole time the picker is open. That is what
// makes the keyboard work: an `input[type=text]` is one of the two things the
// reader's `isTextBox()` recognises, so typing does not reach the annotation
// shortcuts and the arrow keys are not stolen by its focus manager. The grid's
// selection is a highlighted cell rather than real focus.
import { config } from "../../package.json";
import {
  applySkinTone,
  loadEmojiCatalog,
  searchEmoji,
  type EmojiEntry,
} from "../ui/emojiCatalog";
import { isChineseLocale } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";

const ROOT_ID = "paperly-note-emoji";
const STYLE_ID = "paperly-note-emoji-style";
// One above the pad, so it sits over it, and still under every reader popup.
const Z_INDEX = 26;
const WIDTH = 324;
const MAX_HEIGHT = 348;
const COLUMNS = 8;
const RECENT_LIMIT = 24;
const RECENT_PREF = "readerNoteEmojiRecent";
const SKIN_PREF = "readerNoteEmojiSkin";

const CATALOG_URL = `chrome://${config.addonRef}/content/emoji.txt`;

function text(en: string, zh: string): string {
  return isChineseLocale() ? zh : en;
}

interface TabSpec {
  key: string;
  /** emojibase groups this tab collects; empty means the recent list. */
  groups: number[];
  icon: string;
  en: string;
  zh: string;
}

// Smileys and people share a tab, the way every picker with a bottom bar does
// it -- split apart they are two tabs of nearly the same thing.
const TABS: TabSpec[] = [
  { key: "recent", groups: [], icon: "🕘", en: "Recent", zh: "最近使用" },
  { key: "people", groups: [0, 1], icon: "🙂", en: "Smileys & People", zh: "表情与人物" },
  { key: "nature", groups: [3], icon: "🌿", en: "Animals & Nature", zh: "动物与自然" },
  { key: "food", groups: [4], icon: "🍎", en: "Food & Drink", zh: "食物与饮料" },
  { key: "activity", groups: [6], icon: "⚽", en: "Activities", zh: "活动" },
  { key: "travel", groups: [5], icon: "✈️", en: "Travel & Places", zh: "旅行与地点" },
  { key: "objects", groups: [7], icon: "💡", en: "Objects", zh: "物品" },
  { key: "symbols", groups: [8], icon: "🔣", en: "Symbols", zh: "符号" },
  { key: "flags", groups: [9], icon: "🏁", en: "Flags", zh: "旗帜" },
];

// Default plus the five Fitzpatrick tones, on the hand the reference picker
// uses for the same control.
const TONE_SWATCHES = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];

interface PickerState {
  doc: Document;
  root: HTMLElement;
  search: HTMLInputElement;
  body: HTMLElement;
  fullView: HTMLElement;
  searchView: HTMLElement;
  status: HTMLElement;
  skinButton: HTMLButtonElement;
  tonePop: HTMLElement | null;
  tabStrip: HTMLElement;
  entries: EmojiEntry[];
  /** The cells of whichever view is showing, in visual order. */
  cells: HTMLElement[];
  activeIndex: number;
  tone: number;
  anchor: HTMLElement;
  onPick: (emoji: string) => void;
  teardown: (() => void)[];
}

const pickers = new Map<Document, PickerState>();

// ------------------------------------------------------------------ prefs --

function readRecent(): string[] {
  try {
    const raw = `${getPref(RECENT_PREF) ?? ""}`;
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value) => typeof value === "string").slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function rememberRecent(emoji: string): void {
  try {
    const next = [emoji, ...readRecent().filter((value) => value !== emoji)];
    setPref(RECENT_PREF, JSON.stringify(next.slice(0, RECENT_LIMIT)));
  } catch {
    // A lost history is not worth surfacing.
  }
}

function readTone(): number {
  const value = Number(getPref(SKIN_PREF));
  return Number.isFinite(value) && value >= 0 && value <= 5 ? value : 0;
}

// ----------------------------------------------------------------- styles --

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
  border-radius: 10px;
  overflow: clip;
  background: var(--paperly-note-bg, #ffffff);
  color: var(--paperly-note-fg, #000000);
  border: 1px solid color-mix(in srgb, var(--paperly-note-fg) 20%, var(--paperly-note-bg));
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.12);
  font-family: var(--paperly-note-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
}
#${ROOT_ID}[data-scheme="dark"] {
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4);
}
#${ROOT_ID} .paperly-emoji-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--paperly-note-fg) 12%, var(--paperly-note-bg));
}
#${ROOT_ID} .paperly-emoji-field {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--paperly-note-fg) 7%, var(--paperly-note-bg));
  border: 1px solid color-mix(in srgb, var(--paperly-note-fg) 14%, var(--paperly-note-bg));
}
#${ROOT_ID} .paperly-emoji-field:focus-within {
  border-color: color-mix(in srgb, var(--paperly-note-fg) 38%, var(--paperly-note-bg));
}
#${ROOT_ID} .paperly-emoji-field svg { flex: 0 0 auto; opacity: 0.45; }
#${ROOT_ID} .paperly-emoji-search {
  flex: 1 1 auto;
  min-width: 0;
  font: inherit;
  font-size: 12.5px;
  padding: 0;
  border: 0;
  border-radius: 0;
  color: inherit;
  background: transparent;
  outline: none;
}
#${ROOT_ID} .paperly-emoji-search::placeholder { color: inherit; opacity: 0.42; }
#${ROOT_ID} .paperly-emoji-skin {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 7px;
  cursor: pointer;
  background: transparent;
  color: inherit;
  border: 1px solid color-mix(in srgb, var(--paperly-note-fg) 16%, var(--paperly-note-bg));
  font-size: 15px;
  line-height: 1;
}
#${ROOT_ID} .paperly-emoji-skin:hover,
#${ROOT_ID} .paperly-emoji-skin[aria-expanded="true"] {
  background: color-mix(in srgb, var(--paperly-note-fg) 10%, var(--paperly-note-bg));
}
#${ROOT_ID} .paperly-emoji-tones {
  position: absolute;
  z-index: 3;
  top: 40px;
  right: 8px;
  display: flex;
  gap: 2px;
  padding: 4px;
  border-radius: 8px;
  background: var(--paperly-note-bg, #ffffff);
  border: 1px solid color-mix(in srgb, var(--paperly-note-fg) 18%, var(--paperly-note-bg));
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.16);
}
#${ROOT_ID} .paperly-emoji-tone {
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  background: transparent;
  font-size: 15px;
  line-height: 1;
}
#${ROOT_ID} .paperly-emoji-tone:hover,
#${ROOT_ID} .paperly-emoji-tone[aria-pressed="true"] {
  background: color-mix(in srgb, var(--paperly-note-fg) 14%, var(--paperly-note-bg));
}
#${ROOT_ID} .paperly-emoji-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 0 8px 8px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--paperly-note-fg) 26%, var(--paperly-note-bg)) transparent;
}
#${ROOT_ID} .paperly-emoji-label {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 9px 2px 5px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.55;
  background: var(--paperly-note-bg, #ffffff);
}
#${ROOT_ID} .paperly-emoji-grid {
  display: grid;
  grid-template-columns: repeat(${COLUMNS}, 1fr);
}
#${ROOT_ID} .paperly-emoji-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
  background: transparent;
  color: inherit;
  font-size: 21px;
  line-height: 1;
  font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
}
#${ROOT_ID} .paperly-emoji-cell:hover,
#${ROOT_ID} .paperly-emoji-cell[data-active="true"] {
  background: color-mix(in srgb, var(--paperly-note-fg) 13%, var(--paperly-note-bg));
}
#${ROOT_ID} .paperly-emoji-status {
  padding: 26px 10px;
  text-align: center;
  font-size: 12px;
  opacity: 0.55;
}
#${ROOT_ID} .paperly-emoji-foot {
  display: flex;
  gap: 1px;
  padding: 5px 6px;
  border-top: 1px solid color-mix(in srgb, var(--paperly-note-fg) 12%, var(--paperly-note-bg));
  background: color-mix(in srgb, var(--paperly-note-fg) 4%, var(--paperly-note-bg));
}
#${ROOT_ID} .paperly-emoji-tab {
  flex: 1 1 0;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  background: transparent;
  font-size: 15px;
  line-height: 1;
  opacity: 0.62;
  font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
}
#${ROOT_ID} .paperly-emoji-tab:hover { opacity: 0.9; }
#${ROOT_ID} .paperly-emoji-tab[aria-selected="true"] {
  opacity: 1;
  background: color-mix(in srgb, var(--paperly-note-fg) 12%, var(--paperly-note-bg));
}
`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function magnifier(doc: Document): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("viewBox", "0 0 13 13");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const ring = doc.createElementNS(SVG_NS, "circle");
  ring.setAttribute("cx", "5.4");
  ring.setAttribute("cy", "5.4");
  ring.setAttribute("r", "3.9");
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", "currentColor");
  ring.setAttribute("stroke-width", "1.3");
  const handle = doc.createElementNS(SVG_NS, "path");
  handle.setAttribute("d", "M8.4 8.4 11.6 11.6");
  handle.setAttribute("stroke", "currentColor");
  handle.setAttribute("stroke-width", "1.3");
  handle.setAttribute("stroke-linecap", "round");
  svg.append(ring, handle);
  return svg;
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

// -------------------------------------------------------------- the grid ---

function makeCell(state: PickerState, entry: EmojiEntry | string): HTMLElement {
  const doc = state.doc;
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "paperly-emoji-cell";
  if (typeof entry === "string") {
    button.textContent = entry;
    button.dataset.emoji = entry;
  } else {
    const shown = applySkinTone(entry, state.tone);
    button.textContent = shown;
    button.dataset.emoji = shown;
    if (entry.label) {
      button.title = entry.label;
    }
  }
  return button;
}

/**
 * A titled block of cells, wrapped in a section of its own.
 *
 * The wrapper is what makes the heading behave. A sticky box is confined to its
 * nearest block container, so labels appended straight into the scroller would
 * all share one -- every heading scrolled past would stay stuck at the top and
 * pile up on the next. Confined to a section, each is pushed out by the one
 * below it. The section also never moves, so its `offsetTop` is the real start
 * of the category, which is what the bottom bar scrolls to; a stuck label's
 * `offsetTop` is wherever it is stuck, which is useless for that.
 */
function appendSection(
  state: PickerState,
  into: HTMLElement,
  title: string,
  items: (EmojiEntry | string)[],
  tabKey?: string,
): void {
  const doc = state.doc;
  const section = doc.createElement("div");
  section.className = "paperly-emoji-section";
  if (tabKey) {
    section.dataset.tab = tabKey;
  }
  const label = doc.createElement("div");
  label.className = "paperly-emoji-label";
  label.textContent = title;
  const grid = doc.createElement("div");
  grid.className = "paperly-emoji-grid";
  for (const item of items) {
    grid.appendChild(makeCell(state, item));
  }
  section.append(label, grid);
  into.appendChild(section);
}

function buildFullView(state: PickerState): void {
  state.fullView.replaceChildren();
  const recent = readRecent();
  if (recent.length) {
    appendSection(
      state,
      state.fullView,
      text(TABS[0].en, TABS[0].zh),
      recent,
      TABS[0].key,
    );
  }
  for (const tab of TABS.slice(1)) {
    const items = state.entries.filter((entry) =>
      tab.groups.includes(entry.group),
    );
    if (items.length) {
      appendSection(state, state.fullView, text(tab.en, tab.zh), items, tab.key);
    }
  }
}

function showFullView(state: PickerState): void {
  state.searchView.hidden = true;
  state.status.hidden = true;
  state.fullView.hidden = false;
  state.cells = Array.from(
    state.fullView.querySelectorAll(".paperly-emoji-cell"),
  );
  setActive(state, -1);
}

function showSearch(state: PickerState, query: string): void {
  const hits = searchEmoji(state.entries, query);
  state.fullView.hidden = true;
  state.searchView.replaceChildren();
  if (!hits.length) {
    state.searchView.hidden = true;
    state.status.textContent = text("No emoji found", "没有匹配的表情");
    state.status.hidden = false;
    state.cells = [];
    setActive(state, -1);
    return;
  }
  state.status.hidden = true;
  state.searchView.hidden = false;
  appendSection(state, state.searchView, text("Results", "搜索结果"), hits);
  state.cells = Array.from(
    state.searchView.querySelectorAll(".paperly-emoji-cell"),
  );
  setActive(state, 0);
}

function setActive(state: PickerState, index: number): void {
  const previous = state.cells[state.activeIndex];
  previous?.removeAttribute("data-active");
  state.activeIndex = index;
  const cell = state.cells[index];
  if (!cell) {
    return;
  }
  cell.setAttribute("data-active", "true");
  // Scroll the body by hand rather than with scrollIntoView, which would also
  // scroll every clipping ancestor between here and the reader's root.
  const body = state.body;
  const top = cell.offsetTop - body.offsetTop;
  if (top < body.scrollTop) {
    body.scrollTop = Math.max(0, top - 28);
  } else if (top + cell.offsetHeight > body.scrollTop + body.clientHeight) {
    body.scrollTop = top + cell.offsetHeight - body.clientHeight + 8;
  }
}

function moveActive(state: PickerState, delta: number): void {
  if (!state.cells.length) {
    return;
  }
  const next = Math.min(
    state.cells.length - 1,
    Math.max(0, (state.activeIndex < 0 ? 0 : state.activeIndex) + delta),
  );
  setActive(state, next);
}

function pick(state: PickerState, emoji: string): void {
  rememberRecent(emoji);
  state.onPick(emoji);
  closeEmojiPicker(state.doc);
}

// ------------------------------------------------------------ skin tones ---

function closeTonePopup(state: PickerState): void {
  state.tonePop?.remove();
  state.tonePop = null;
  state.skinButton.setAttribute("aria-expanded", "false");
}

function toggleTonePopup(state: PickerState): void {
  if (state.tonePop) {
    closeTonePopup(state);
    return;
  }
  const doc = state.doc;
  const pop = doc.createElement("div");
  pop.className = "paperly-emoji-tones";
  TONE_SWATCHES.forEach((swatch, index) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "paperly-emoji-tone";
    button.textContent = swatch;
    button.setAttribute("aria-pressed", index === state.tone ? "true" : "false");
    button.title =
      index === 0 ? text("Default", "默认") : `${text("Tone", "肤色")} ${index}`;
    button.addEventListener("click", () => {
      state.tone = index;
      setPref(SKIN_PREF, index);
      state.skinButton.textContent = TONE_SWATCHES[index];
      closeTonePopup(state);
      buildFullView(state);
      if (state.search.value.trim()) {
        showSearch(state, state.search.value);
      } else {
        showFullView(state);
      }
    });
    pop.appendChild(button);
  });
  state.root.appendChild(pop);
  state.tonePop = pop;
  state.skinButton.setAttribute("aria-expanded", "true");
}

// --------------------------------------------------------------- opening ---

function place(state: PickerState): void {
  const view = state.doc.defaultView;
  if (!view) {
    return;
  }
  const rect = state.anchor.getBoundingClientRect();
  const width = state.root.offsetWidth || WIDTH;
  const height = state.root.offsetHeight || MAX_HEIGHT;
  const left = Math.min(
    Math.max(8, rect.right - width),
    Math.max(8, view.innerWidth - width - 8),
  );
  let top = rect.bottom + 6;
  if (top + height > view.innerHeight - 8) {
    top = Math.max(8, rect.top - height - 6);
  }
  state.root.style.left = `${Math.round(left)}px`;
  state.root.style.top = `${Math.round(top)}px`;
}

export interface EmojiPickerOptions {
  doc: Document;
  /** The button the picker hangs from. */
  anchor: HTMLElement;
  /** The pad, whose theme custom properties the picker copies. */
  themeSource: HTMLElement;
  onPick: (emoji: string) => void;
}

export function isEmojiPickerOpen(doc: Document): boolean {
  return pickers.has(doc);
}

export function closeEmojiPicker(doc: Document): void {
  const state = pickers.get(doc);
  if (!state) {
    return;
  }
  pickers.delete(doc);
  for (const off of state.teardown) {
    try {
      off();
    } catch {
      // Teardown must not throw on the way out.
    }
  }
  state.root.remove();
  state.anchor.setAttribute("aria-expanded", "false");
}

/** Keeps an open picker in step with a theme change in the pad. */
export function syncEmojiPickerTheme(
  doc: Document,
  themeSource: HTMLElement,
): void {
  const state = pickers.get(doc);
  if (!state) {
    return;
  }
  applyThemeVars(state.root, themeSource);
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

export async function openEmojiPicker(
  options: EmojiPickerOptions,
): Promise<void> {
  const { doc, anchor, themeSource, onPick } = options;
  if (pickers.has(doc)) {
    closeEmojiPicker(doc);
    return;
  }
  ensureStyles(doc);

  const root = doc.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", text("Emoji", "表情"));
  applyThemeVars(root, themeSource);

  const head = doc.createElement("div");
  head.className = "paperly-emoji-head";
  const field = doc.createElement("div");
  field.className = "paperly-emoji-field";
  field.appendChild(magnifier(doc));
  const search = doc.createElement("input");
  search.type = "text";
  search.className = "paperly-emoji-search";
  search.placeholder = text("Search emoji…", "搜索表情……");
  search.setAttribute("aria-label", search.placeholder);
  field.appendChild(search);
  const skinButton = doc.createElement("button");
  skinButton.type = "button";
  skinButton.className = "paperly-emoji-skin";
  skinButton.setAttribute("aria-expanded", "false");
  skinButton.title = text("Skin tone", "肤色");
  head.append(field, skinButton);

  const body = doc.createElement("div");
  body.className = "paperly-emoji-body";
  const fullView = doc.createElement("div");
  const searchView = doc.createElement("div");
  searchView.hidden = true;
  const status = doc.createElement("div");
  status.className = "paperly-emoji-status";
  status.textContent = text("Loading emoji…", "正在载入表情……");
  body.append(status, searchView, fullView);

  const tabStrip = doc.createElement("div");
  tabStrip.className = "paperly-emoji-foot";

  root.append(head, body, tabStrip);
  doc.body?.appendChild(root);
  anchor.setAttribute("aria-expanded", "true");

  const state: PickerState = {
    doc,
    root,
    search,
    body,
    fullView,
    searchView,
    status,
    skinButton,
    tonePop: null,
    tabStrip,
    entries: [],
    cells: [],
    activeIndex: -1,
    tone: readTone(),
    anchor,
    onPick,
    teardown: [],
  };
  pickers.set(doc, state);
  skinButton.textContent = TONE_SWATCHES[state.tone];
  fullView.hidden = true;

  place(state);
  search.focus({ preventScroll: true });

  // --- wiring -------------------------------------------------------------
  // Nothing in here may take focus away from the search field, so every
  // pointerdown inside the picker is cancelled. The click still fires.
  const onPointerDown = (event: Event): void => {
    const target = event.target as Element | null;
    if (target?.closest(".paperly-emoji-field")) {
      return;
    }
    event.preventDefault();
  };
  // mousedown as well: cancelling pointerdown does not stop the browser
  // collapsing the selection -- see the note on the same pair in
  // readerNoteFormatBar.
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("mousedown", onPointerDown);
  state.teardown.push(() => {
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("mousedown", onPointerDown);
  });

  const onClick = (event: Event): void => {
    const target = event.target as Element | null;
    const cell = target?.closest(".paperly-emoji-cell") as HTMLElement | null;
    if (cell?.dataset.emoji) {
      pick(state, cell.dataset.emoji);
      return;
    }
    if (target?.closest(".paperly-emoji-skin")) {
      toggleTonePopup(state);
    }
  };
  root.addEventListener("click", onClick);
  state.teardown.push(() => root.removeEventListener("click", onClick));

  const onInput = (): void => {
    closeTonePopup(state);
    const query = search.value.trim();
    if (query) {
      showSearch(state, query);
    } else {
      showFullView(state);
    }
  };
  search.addEventListener("input", onInput);
  state.teardown.push(() => search.removeEventListener("input", onInput));

  const onKeyDown = (event: Event): void => {
    const keyEvent = event as KeyboardEvent;
    const key = keyEvent.key;
    if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeEmojiPicker(doc);
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      const cell = state.cells[state.activeIndex < 0 ? 0 : state.activeIndex];
      if (cell?.dataset.emoji) {
        pick(state, cell.dataset.emoji);
      }
      return;
    }
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: COLUMNS,
      ArrowUp: -COLUMNS,
    };
    if (key in step) {
      event.preventDefault();
      moveActive(state, step[key]);
    }
  };
  root.addEventListener("keydown", onKeyDown);
  state.teardown.push(() => root.removeEventListener("keydown", onKeyDown));

  // Clicking anywhere else, including in the page, puts it away.
  const onDocPointerDown = (event: Event): void => {
    const target = event.target as Node | null;
    if (
      target &&
      (root.contains(target) || anchor.contains(target as Node))
    ) {
      return;
    }
    closeEmojiPicker(doc);
  };
  doc.addEventListener("pointerdown", onDocPointerDown, true);
  state.teardown.push(() =>
    doc.removeEventListener("pointerdown", onDocPointerDown, true),
  );

  const view = doc.defaultView;
  const onResize = (): void => place(state);
  view?.addEventListener("resize", onResize);
  state.teardown.push(() => view?.removeEventListener("resize", onResize));

  for (const tab of TABS) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "paperly-emoji-tab";
    button.textContent = tab.icon;
    button.title = text(tab.en, tab.zh);
    button.setAttribute("aria-selected", "false");
    button.addEventListener("click", () => {
      search.value = "";
      showFullView(state);
      const section = fullView.querySelector(
        `.paperly-emoji-section[data-tab="${tab.key}"]`,
      ) as HTMLElement | null;
      body.scrollTop = section ? section.offsetTop - body.offsetTop : 0;
      for (const other of Array.from(tabStrip.children)) {
        other.setAttribute(
          "aria-selected",
          other === button ? "true" : "false",
        );
      }
    });
    tabStrip.appendChild(button);
  }

  // --- data ---------------------------------------------------------------
  const entries = await loadEmojiCatalog(CATALOG_URL, (...args) =>
    ztoolkit.log(...args),
  );
  if (pickers.get(doc) !== state) {
    return;
  }
  state.entries = entries;
  if (!entries.length) {
    status.textContent = text(
      "The emoji list could not be read",
      "无法读取表情列表",
    );
    return;
  }
  buildFullView(state);
  showFullView(state);
  place(state);
}

export function destroyEmojiPickers(): void {
  for (const doc of [...pickers.keys()]) {
    closeEmojiPicker(doc);
  }
}
