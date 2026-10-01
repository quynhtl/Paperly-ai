// The floating bot's section of Settings > Paperly AI: whether it is shown, and
// who it is.
//
// Everything here applies the moment it is clicked -- there is nothing for the
// pane's Save button to do -- and follows the prefs, so a face picked from the
// bot's own picker or the View menu while Settings is open shows up here too.
import { config } from "../../package.json";
import { artStyleSheet, buildCharacterArt } from "./botArt";
import { BOT_CHARACTERS, botCharacterUrl, currentBotCharacter } from "./botCharacters";
import {
  isFloatingBotEnabled,
  setBotCharacter,
  setFloatingBotEnabled,
} from "./floatingBot";

const CONTAINER_ID = "zotero-ai-assistant-pref-bot";
const SHOW_ID = "zotero-ai-assistant-pref-bot-show";
const STYLE_ID = "zotero-ai-assistant-pref-bot-style";
/** A face in the grid, in CSS px: big enough that the 3D shows. */
const TILE_ART = 64;

const prefName = (key: string) => `${config.prefsPrefix}.${key}`;

function styleSheet(): string {
  return `
${artStyleSheet()}
#${CONTAINER_ID} {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: 8px;
}
.paperly-bot-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 6px 8px;
  border: 1px solid transparent;
  border-radius: 10px;
  --paperly-art-size: ${TILE_ART}px;
  cursor: default;
  user-select: none;
}
.paperly-bot-tile:hover {
  background: var(--fill-quinary, rgba(127, 127, 127, 0.08));
}
.paperly-bot-tile[aria-checked="true"] {
  border-color: var(--accent-blue, #4072e5);
  background: color-mix(in srgb, var(--accent-blue, #4072e5) 12%, transparent);
}
.paperly-bot-tile:focus-visible {
  outline: 2px solid var(--accent-blue, #4072e5);
  outline-offset: 1px;
}
.paperly-bot-tile-name {
  font-size: 12px;
  line-height: 1.25;
  text-align: center;
}
`;
}

/** Ticks the chosen face, and the "show" box, to match the prefs. */
function sync(doc: Document): void {
  const current = currentBotCharacter().id;
  for (const tile of Array.from(
    doc.querySelectorAll(`#${CONTAINER_ID} .paperly-bot-tile`),
  ) as HTMLElement[]) {
    const chosen = tile.dataset.character === current;
    tile.setAttribute("aria-checked", String(chosen));
    tile.tabIndex = chosen ? 0 : -1;
  }
  const show = doc.getElementById(SHOW_ID) as (HTMLElement & { checked?: boolean }) | null;
  if (show) {
    show.checked = isFloatingBotEnabled();
  }
}

function buildTiles(doc: Document, container: HTMLElement): void {
  container.textContent = "";
  container.setAttribute("role", "radiogroup");
  for (const character of BOT_CHARACTERS) {
    // A div and not a button: Settings styles every button to Zotero's own
    // fixed height, which squashed the tiles flat and let their faces spill
    // into the next section.
    const tile = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    tile.className = "paperly-bot-tile";
    tile.dataset.character = character.id;
    tile.setAttribute("role", "radio");
    tile.setAttribute("aria-label", character.name);
    const name = doc.createElementNS("http://www.w3.org/1999/xhtml", "span") as HTMLElement;
    name.className = "paperly-bot-tile-name";
    name.textContent = character.name;
    tile.append(buildCharacterArt(doc, character, botCharacterUrl(character)), name);
    tile.addEventListener("click", () => setBotCharacter(character.id));
    tile.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        setBotCharacter(character.id);
      }
    });
    container.appendChild(tile);
  }
  // Arrows walk the faces and pick as they go, like any radio group.
  container.addEventListener("keydown", (event: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (!step) {
      return;
    }
    event.preventDefault();
    const index = BOT_CHARACTERS.findIndex((c) => c.id === currentBotCharacter().id);
    const next = BOT_CHARACTERS[(index + step + BOT_CHARACTERS.length) % BOT_CHARACTERS.length];
    setBotCharacter(next.id);
    (container.querySelector(`[data-character="${next.id}"]`) as HTMLElement | null)?.focus();
  });
}

export function registerBotSettings(win: Window): void {
  const doc = win.document;
  const container = doc.getElementById(CONTAINER_ID) as HTMLElement | null;
  if (!container) {
    return;
  }
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.id = STYLE_ID;
    style.textContent = styleSheet();
    (doc.head ?? doc.documentElement)?.appendChild(style);
  }
  buildTiles(doc, container);

  const show = doc.getElementById(SHOW_ID);
  show?.addEventListener("command", () => {
    const enabled = Boolean((show as HTMLElement & { checked?: boolean }).checked);
    for (const main of Zotero.getMainWindows()) {
      void setFloatingBotEnabled(main, enabled);
    }
  });

  sync(doc);
  const observers = ["floatingBotCharacter", "floatingBot"].map((key) =>
    Zotero.Prefs.registerObserver(prefName(key), () => sync(doc), true),
  );
  win.addEventListener(
    "unload",
    () => observers.forEach((symbol) => Zotero.Prefs.unregisterObserver(symbol)),
    { once: true },
  );
}
