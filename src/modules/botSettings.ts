// The floating bot's section of Settings > Paperly AI: whether it is shown, and
// who it is.
//
// Everything here applies the moment it is clicked -- there is nothing for the
// pane's Save button to do -- and follows the prefs, so a face picked from the
// bot's own picker or the View menu while Settings is open shows up here too.
//
// The last tile adds a character of your own (botCharacterEditor); your own
// ones carry a remove button, which the built-in ones do not.
import { config } from "../../package.json";
import { artStyleSheet, buildCharacterArt } from "./botArt";
import { addCustomCharacter } from "./botCharacterEditor";
import {
  allBotCharacters,
  botCharacterUrl,
  currentBotCharacter,
  removeCustomBotCharacter,
} from "./botCharacters";
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
  overflow-wrap: anywhere;
}
.paperly-bot-tile {
  position: relative;
}
.paperly-bot-tile-add-mark {
  display: grid;
  place-items: center;
  width: ${TILE_ART * (96 / 112)}px;
  height: ${TILE_ART * (96 / 112)}px;
  margin: ${(TILE_ART * (16 / 112)) / 2}px;
  border: 1.5px dashed var(--fill-tertiary, rgba(127, 127, 127, 0.6));
  border-radius: 50%;
  box-sizing: border-box;
  color: var(--fill-secondary, rgba(127, 127, 127, 0.9));
  font: 300 28px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
}
.paperly-bot-tile.is-add:hover .paperly-bot-tile-add-mark {
  border-color: var(--accent-blue, #4072e5);
  color: var(--accent-blue, #4072e5);
}
/* Your own characters can be removed; the button shows under the pointer. */
.paperly-bot-tile-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(24, 26, 44, 0.85);
  color: #F2ECE6;
  font: 600 13px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  opacity: 0;
  transition: opacity 120ms ease;
}
.paperly-bot-tile:hover .paperly-bot-tile-remove,
.paperly-bot-tile-remove:focus-visible {
  opacity: 1;
}
.paperly-bot-tile-remove:hover {
  background: rgba(196, 60, 60, 0.95);
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

const HTML_NS = "http://www.w3.org/1999/xhtml";

/** Asks, then forgets one of the user's own characters and deletes its face. */
async function removeCharacter(win: Window, id: string, name: string): Promise<void> {
  const sure = Services.prompt.confirm(
    win as unknown as mozIDOMWindowProxy,
    "Remove character",
    `Remove \u201C${name}\u201D from the bot's characters? Its picture is deleted.`,
  );
  if (!sure) {
    return;
  }
  await removeCustomBotCharacter(id);
  // If it was the one being worn, the bot goes back to the default -- shown
  // the same way as any other change of face.
  setBotCharacter(currentBotCharacter().id);
}

function buildTiles(win: Window, container: HTMLElement): void {
  const doc = win.document;
  container.textContent = "";
  container.setAttribute("role", "radiogroup");
  const characters = allBotCharacters();
  for (const character of characters) {
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
    if (character.custom) {
      const remove = doc.createElementNS(HTML_NS, "span") as HTMLElement;
      remove.className = "paperly-bot-tile-remove";
      remove.textContent = "\u00D7";
      remove.title = "Remove";
      remove.setAttribute("role", "button");
      remove.setAttribute("aria-label", `Remove ${character.name}`);
      remove.tabIndex = 0;
      const removeIt = (event: Event) => {
        event.stopPropagation();
        void removeCharacter(win, character.id, character.name);
      };
      remove.addEventListener("click", removeIt);
      remove.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          removeIt(event);
        }
      });
      tile.appendChild(remove);
    }
    container.appendChild(tile);
  }

  // Last: add your own.
  const add = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  add.className = "paperly-bot-tile is-add";
  add.setAttribute("role", "button");
  add.tabIndex = 0;
  add.setAttribute("aria-label", "Add your own character");
  const mark = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  mark.className = "paperly-bot-tile-add-mark";
  mark.textContent = "+";
  const label = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  label.className = "paperly-bot-tile-name";
  label.textContent = "Add your own";
  add.append(mark, label);
  const addOne = () => void addCustomCharacter(win);
  add.addEventListener("click", addOne);
  add.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      addOne();
    }
  });
  container.appendChild(add);
  // Arrows walk the faces and pick as they go, like any radio group.
  container.addEventListener("keydown", (event: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (!step) {
      return;
    }
    event.preventDefault();
    const index = characters.findIndex((c) => c.id === currentBotCharacter().id);
    const next = characters[(index + step + characters.length) % characters.length];
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
  buildTiles(win, container);

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
  // Your own characters come and go: the tiles are rebuilt for them.
  observers.push(
    Zotero.Prefs.registerObserver(
      prefName("floatingBotCustomCharacters"),
      () => {
        buildTiles(win, container);
        sync(doc);
      },
      true,
    ),
  );
  win.addEventListener(
    "unload",
    () => observers.forEach((symbol) => Zotero.Prefs.unregisterObserver(symbol)),
    { once: true },
  );
}
