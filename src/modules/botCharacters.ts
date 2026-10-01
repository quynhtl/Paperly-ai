// Who the floating bot is.
//
// Two lists. The built-in characters live in assets/bot/characters.json, which
// is also what assets/bot/build-portraits.sh renders their faces from, so
// adding one is an entry there and one run of that script -- see
// assets/bot/README.md. The user's own characters, added with the (+) in the
// picker or in Settings, are an array in a pref, and their faces are files in
// the profile (botCharacterEditor writes them).
//
// The chosen-character pref is empty until the user has picked someone, and
// that emptiness is what tells the bot to offer the picker on its first
// appearance. Anya stands in until then.
import registry from "../../assets/bot/characters.json";
import { config } from "../../package.json";
import { clearPref, getPref, setPref } from "../utils/prefs";

export interface BotCharacter {
  id: string;
  name: string;
  /**
   * The face file: a name under addon/content/icons/ for a built-in character,
   * an absolute path in the profile for one of the user's own.
   */
  file: string;
  /** 3 for a blink strip (open, half, shut), 1 for a still face. */
  frames: number;
  /**
   * "cutout": the character on transparency, standing in front of the plate.
   * "framed": a picture with its own background, filling the disc.
   */
  kind: "cutout" | "framed";
  /** A cut-out whose head may come up out of the disc; see botArt. */
  popout?: boolean;
  /** [r, g, b] for the plate, the bloom, the rings and the ripple. None keeps Anya's rose. */
  tint?: number[];
  /** One of the user's own, and so removable. */
  custom?: boolean;
}

const CHARACTER_PREF = "floatingBotCharacter";
const CUSTOM_PREF = "floatingBotCustomCharacters";
/** The profile directory the user's own faces are written to. */
export const CUSTOM_DIR_NAME = "paperly-bot";

export const BOT_CHARACTERS = registry.characters as BotCharacter[];

const DEFAULT_CHARACTER =
  BOT_CHARACTERS.find((c) => c.id === registry.default) ?? BOT_CHARACTERS[0];

export function customCharactersDir(): string {
  return PathUtils.join(PathUtils.profileDir, CUSTOM_DIR_NAME);
}

/** The user's own characters, as saved. Anything malformed is skipped, not fatal. */
export function customBotCharacters(): BotCharacter[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(getPref(CUSTOM_PREF) || "[]"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter(
      (c): c is BotCharacter =>
        Boolean(c) &&
        typeof c.id === "string" &&
        typeof c.name === "string" &&
        typeof c.file === "string" &&
        (c.kind === "cutout" || c.kind === "framed"),
    )
    .map((c) => ({ ...c, frames: 1, custom: true }));
}

/** Every character there is to choose from: the built-in ones, then the user's. */
export function allBotCharacters(): BotCharacter[] {
  return [...BOT_CHARACTERS, ...customBotCharacters()];
}

export function botCharacterUrl(character: BotCharacter): string {
  if (character.custom) {
    return PathUtils.toFileURI(character.file);
  }
  return `chrome://${config.addonRef}/content/icons/${character.file}`;
}

export function hasChosenBotCharacter(): boolean {
  return Boolean(getPref(CHARACTER_PREF));
}

export function currentBotCharacter(): BotCharacter {
  const id = String(getPref(CHARACTER_PREF) ?? "");
  return allBotCharacters().find((c) => c.id === id) ?? DEFAULT_CHARACTER;
}

export function defaultBotCharacter(): BotCharacter {
  return DEFAULT_CHARACTER;
}

/** Remembers the choice; showing it is the bot's job. */
export function saveBotCharacter(id: string): void {
  if (allBotCharacters().some((c) => c.id === id)) {
    setPref(CHARACTER_PREF, id);
  }
}

function writeCustomCharacters(characters: BotCharacter[]): void {
  const stored = characters.map(({ id, name, file, kind, popout, tint }) => ({
    id,
    name,
    file,
    kind,
    popout,
    tint,
  }));
  if (stored.length) {
    setPref(CUSTOM_PREF, JSON.stringify(stored));
  } else {
    clearPref(CUSTOM_PREF);
  }
}

/** Adds one of the user's own; its face file must already be written. */
export function addCustomBotCharacter(character: BotCharacter): void {
  writeCustomCharacters([...customBotCharacters(), { ...character, custom: true }]);
}

/**
 * Forgets one of the user's own and deletes its face. If it was the chosen
 * one, the choice goes back to the default -- the caller shows that.
 */
export async function removeCustomBotCharacter(id: string): Promise<void> {
  const all = customBotCharacters();
  const gone = all.find((c) => c.id === id);
  if (!gone) {
    return;
  }
  writeCustomCharacters(all.filter((c) => c.id !== id));
  if (String(getPref(CHARACTER_PREF) ?? "") === id) {
    setPref(CHARACTER_PREF, DEFAULT_CHARACTER.id);
  }
  try {
    await IOUtils.remove(gone.file, { ignoreAbsent: true });
  } catch (error) {
    ztoolkit.log("Could not delete a bot face:", error);
  }
}
