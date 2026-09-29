// The palette behind the note pad's colour button.
//
// Built the same way as the blocks menu: fixed to the reader document, never
// takes focus, closes on a press outside itself, and knows which button opened
// it so that button can close it again.
import {
  NOTE_BACKGROUNDS,
  PAPER_BACKGROUND,
  normalizeBackground,
} from "../ui/noteColors";
import { isChineseLocale } from "../utils/locale";

const ROOT_ID = "paperly-note-colors";
const STYLE_ID = "paperly-note-colors-style";
// Over the pad, under every reader popup -- the same band as the other two.
const Z_INDEX = 26;
const WIDTH = 196;

function text(en: string, zh: string): string {
  return isChineseLocale() ? zh : en;
}

interface MenuState {
  doc: Document;
  root: HTMLElement;
  trigger: HTMLElement | null;
  onClose: () => void;
  teardown: (() => void)[];
}

const menus = new Map<Document, MenuState>();

export interface ColorMenuOptions {
  doc: Document;
  /** The button the palette hangs from. */
  anchor: HTMLElement;
  /** The pad, whose theme custom properties the palette copies. */
  themeSource: HTMLElement;
  /** The stored choice: a hex, or PAPER_BACKGROUND. */
  current: string;
  /** The paper's own colour, shown on the follow-the-paper row. */
  paperColor: string;
  onPick: (value: string) => void;
  onClose: () => void;
}

export function isColorMenuOpen(doc: Document): boolean {
  return menus.has(doc);
}

function styleSheet(): string {
  return `
#${ROOT_ID} {
  position: fixed;
  z-index: ${Z_INDEX};
  box-sizing: border-box;
  width: ${WIDTH}px;
  padding: 6px;
  border-radius: 10px;
  background: var(--paperly-note-bg, #ffffff);
  color: var(--paperly-note-fg, #000000);
  border: 1px solid color-mix(in srgb, var(--paperly-note-fg) 20%, var(--paperly-note-bg));
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.12);
  font-family: var(--paperly-note-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
}
#${ROOT_ID}[data-scheme="dark"] {
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4);
}
#${ROOT_ID} .paperly-colors-label {
  padding: 5px 7px 4px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.5;
}
#${ROOT_ID} .paperly-colors-paper {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 7px;
  border: 0;
  border-radius: 6px;
  text-align: start;
  font: inherit;
  font-size: 12.5px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
#${ROOT_ID} .paperly-colors-paper:hover {
  background: color-mix(in srgb, var(--paperly-note-fg) 10%, var(--paperly-note-bg));
}
#${ROOT_ID} .paperly-colors-name { flex: 1 1 auto; min-width: 0; }
#${ROOT_ID} .paperly-colors-tick { flex: 0 0 auto; opacity: 0; font-size: 12px; }
#${ROOT_ID} [aria-checked="true"] .paperly-colors-tick { opacity: 0.8; }
#${ROOT_ID} .paperly-colors-rows {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 4px 3px 2px;
}
#${ROOT_ID} .paperly-colors-row {
  display: flex;
  gap: 3px;
}
/* A tile, not a bar. One family per COLUMN and one shade per row keeps the
   whole palette three rows tall however many families there are -- laid out
   the other way round, five families made a popover taller than the pad. */
#${ROOT_ID} .paperly-colors-swatch {
  flex: 1 1 0;
  height: 22px;
  padding: 0;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 5px;
  cursor: pointer;
}
#${ROOT_ID} .paperly-colors-swatch:hover {
  border-color: color-mix(in srgb, var(--paperly-note-fg) 45%, transparent);
}
/* The ring is drawn outside the swatch so the colour itself stays whole. */
#${ROOT_ID} .paperly-colors-swatch[aria-checked="true"] {
  box-shadow:
    0 0 0 1.5px var(--paperly-note-bg, #fff),
    0 0 0 3px color-mix(in srgb, var(--paperly-note-fg) 75%, var(--paperly-note-bg));
}
#${ROOT_ID} .paperly-colors-chip {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  border-radius: 4px;
  border: 1px solid rgba(0, 0, 0, 0.14);
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

export function syncColorMenuTheme(
  doc: Document,
  themeSource: HTMLElement,
): void {
  const state = menus.get(doc);
  if (state) {
    applyThemeVars(state.root, themeSource);
  }
}

export function closeColorMenu(doc: Document): void {
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

function place(state: MenuState, anchor: HTMLElement): void {
  const view = state.doc.defaultView;
  if (!view) {
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const width = state.root.offsetWidth || WIDTH;
  const height = state.root.offsetHeight || 200;
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

export function openColorMenu(options: ColorMenuOptions): void {
  const { doc, anchor, themeSource, current, paperColor, onPick, onClose } =
    options;
  closeColorMenu(doc);
  ensureStyles(doc);

  const chosen = normalizeBackground(current);
  const root = doc.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", text("Note background", "笔记底色"));
  applyThemeVars(root, themeSource);

  const label = doc.createElement("div");
  label.className = "paperly-colors-label";
  label.textContent = text("Note background", "笔记底色");

  const paperRow = doc.createElement("button");
  paperRow.type = "button";
  paperRow.className = "paperly-colors-paper";
  paperRow.setAttribute("role", "radio");
  paperRow.setAttribute(
    "aria-checked",
    chosen === PAPER_BACKGROUND ? "true" : "false",
  );
  const chip = doc.createElement("span");
  chip.className = "paperly-colors-chip";
  chip.style.background = paperColor;
  const paperName = doc.createElement("span");
  paperName.className = "paperly-colors-name";
  paperName.textContent = text("Follow the paper", "跟随页面");
  const tick = doc.createElement("span");
  tick.className = "paperly-colors-tick";
  tick.textContent = "✓";
  paperRow.append(chip, paperName, tick);
  paperRow.addEventListener("click", () => {
    closeColorMenu(doc);
    onPick(PAPER_BACKGROUND);
  });

  // Transposed: a column per family, a row per shade. NOTE_BACKGROUNDS is
  // written the other way round because that is how the families read.
  const rows = doc.createElement("div");
  rows.className = "paperly-colors-rows";
  const shades = Math.max(...NOTE_BACKGROUNDS.map((family) => family.length));
  for (let shade = 0; shade < shades; shade += 1) {
    const row = doc.createElement("div");
    row.className = "paperly-colors-row";
    for (const family of NOTE_BACKGROUNDS) {
      const swatch = family[shade];
      if (!swatch) {
        continue;
      }
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "paperly-colors-swatch";
      button.style.background = swatch.hex;
      button.title = text(swatch.en, swatch.zh);
      button.setAttribute("aria-label", button.title);
      button.setAttribute("role", "radio");
      button.setAttribute(
        "aria-checked",
        chosen === swatch.hex.toLowerCase() ? "true" : "false",
      );
      button.dataset.color = swatch.hex;
      button.addEventListener("click", () => {
        closeColorMenu(doc);
        onPick(swatch.hex);
      });
      row.appendChild(button);
    }
    rows.appendChild(row);
  }

  root.append(label, paperRow, rows);
  doc.body?.appendChild(root);

  const state: MenuState = {
    doc,
    root,
    trigger: anchor,
    onClose,
    teardown: [],
  };
  menus.set(doc, state);
  place(state, anchor);

  // Nothing in here may take the caret out of the editor, so every pointerdown
  // inside the palette is cancelled. The click still fires.
  const onPointerDown = (event: Event): void => {
    event.preventDefault();
  };
  root.addEventListener("pointerdown", onPointerDown);
  state.teardown.push(() =>
    root.removeEventListener("pointerdown", onPointerDown),
  );

  const onOutside = (event: Event): void => {
    const target = event.target as Node | null;
    // The button that opened it is not "outside": it has to be able to close
    // it, and this handler runs before its click does.
    if (target && (root.contains(target) || state.trigger?.contains(target))) {
      return;
    }
    closeColorMenu(doc);
  };
  doc.addEventListener("pointerdown", onOutside, true);
  state.teardown.push(() =>
    doc.removeEventListener("pointerdown", onOutside, true),
  );

  const onKeyDown = (event: Event): void => {
    if ((event as KeyboardEvent).key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeColorMenu(doc);
    }
  };
  root.addEventListener("keydown", onKeyDown);
  state.teardown.push(() => root.removeEventListener("keydown", onKeyDown));

  const view = doc.defaultView;
  const onResize = (): void => place(state, anchor);
  view?.addEventListener("resize", onResize);
  state.teardown.push(() => view?.removeEventListener("resize", onResize));
}

export function destroyColorMenus(): void {
  for (const doc of [...menus.keys()]) {
    closeColorMenu(doc);
  }
}
