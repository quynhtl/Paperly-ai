// Who the floating bot is.
//
// The list lives in assets/bot/characters.json, which is also what
// assets/bot/build-portraits.sh renders the faces from, so adding a character is
// one entry there and one run of that script -- see assets/bot/README.md.
//
// The pref is empty until the user has picked someone, and that emptiness is
// what tells the bot to offer the picker on its first appearance. Anya stands in
// until then.
import registry from "../../assets/bot/characters.json";
import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";

export interface BotCharacter {
  id: string;
  name: string;
  /** Under addon/content/icons/. */
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
}

const CHARACTER_PREF = "floatingBotCharacter";

export const BOT_CHARACTERS = registry.characters as BotCharacter[];

const DEFAULT_CHARACTER =
  BOT_CHARACTERS.find((c) => c.id === registry.default) ?? BOT_CHARACTERS[0];

export function botCharacterUrl(character: BotCharacter): string {
  return `chrome://${config.addonRef}/content/icons/${character.file}`;
}

export function hasChosenBotCharacter(): boolean {
  return Boolean(getPref(CHARACTER_PREF));
}

export function currentBotCharacter(): BotCharacter {
  const id = String(getPref(CHARACTER_PREF) ?? "");
  return BOT_CHARACTERS.find((c) => c.id === id) ?? DEFAULT_CHARACTER;
}

/** Remembers the choice; showing it is the bot's job. */
export function saveBotCharacter(id: string): void {
  if (BOT_CHARACTERS.some((c) => c.id === id)) {
    setPref(CHARACTER_PREF, id);
  }
}
