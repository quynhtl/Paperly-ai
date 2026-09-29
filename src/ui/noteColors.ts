// The colours the note pad can be painted in, and the arithmetic behind them.
//
// By default the pad follows the paper it is sitting on. This is the other
// option: a fixed background, chosen from a small palette, for when the paper's
// own colour is not what someone wants to write on.
//
// The ink is not picked by hand for each swatch. It is the swatch itself taken
// down to a fifth of its brightness, which keeps a trace of the hue instead of
// dropping black on top of it. Measured across the nine: 7.6:1 to 10.7:1
// against their own background, where the reader's own sepia theme is 7.5:1.
//
// Nothing here touches the DOM, so the same file serves the desktop plugin and
// the web port.

/** The value stored when the pad should follow the paper. */
export const PAPER_BACKGROUND = "paper";

/** How much of a swatch's brightness the ink keeps. */
const INK_SCALE = 0.2;

export interface NoteSwatch {
  hex: string;
  en: string;
  zh: string;
}

/** Five families of three, darkest first within each family. */
export const NOTE_BACKGROUNDS: NoteSwatch[][] = [
  [
    { hex: "#E8B4B8", en: "Dusty Pink", zh: "灰粉" },
    { hex: "#E7C1C5", en: "Soft Rose", zh: "柔玫瑰" },
    { hex: "#F1D0D3", en: "Blush", zh: "腮红粉" },
  ],
  [
    { hex: "#B8B5B2", en: "Warm Gray", zh: "暖灰" },
    { hex: "#C7C7C5", en: "Soft Gray", zh: "柔灰" },
    { hex: "#E5E4E2", en: "Light Gray", zh: "浅灰" },
  ],
  [
    { hex: "#AFC4D5", en: "Dusty Blue", zh: "灰蓝" },
    { hex: "#B9D0DF", en: "Soft Blue", zh: "柔蓝" },
    { hex: "#D5E3EC", en: "Pale Blue", zh: "淡蓝" },
  ],
  [
    { hex: "#E5D9EF", en: "Dusty Purple", zh: "灰紫" },
    { hex: "#EDE5F3", en: "Soft Purple", zh: "柔紫" },
    { hex: "#F3EEF7", en: "Pale Purple", zh: "淡紫" },
  ],
  [
    { hex: "#D7E9DA", en: "Dusty Green", zh: "灰绿" },
    { hex: "#E3EFE5", en: "Soft Green", zh: "柔绿" },
    { hex: "#EEF4EF", en: "Pale Green", zh: "淡绿" },
  ],
];

/**
 * The colours text can be highlighted in.
 *
 * Copied from HIGHLIGHT_COLORS in
 * zotero-client/note-editor/src/core/schema/colors.js. The note editor is a
 * webpack bundle, so a plugin cannot import it -- and using Zotero's own eight
 * is the point: a sentence highlighted in the pad comes up the same colour when
 * the note is opened in Zotero, and one highlighted there comes up the same
 * here. The trailing 80 is the half-opacity Zotero stores them at.
 */
export const NOTE_HIGHLIGHTS: NoteSwatch[] = [
  { hex: "#ff666680", en: "Red", zh: "红色" },
  { hex: "#f1983780", en: "Orange", zh: "橙色" },
  { hex: "#ffd40080", en: "Yellow", zh: "黄色" },
  { hex: "#5fb23680", en: "Green", zh: "绿色" },
  { hex: "#2ea8e580", en: "Blue", zh: "蓝色" },
  { hex: "#a28ae580", en: "Purple", zh: "紫色" },
  { hex: "#e56eee80", en: "Magenta", zh: "品红" },
  { hex: "#aaaaaa80", en: "Gray", zh: "灰色" },
];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** One channel of a #rgb or #rrggbb colour, 0 to 1. */
export function channel(hex: string, index: number): number {
  const body = hex.replace("#", "");
  const full =
    body.length === 3
      ? body
          .split("")
          .map((c) => c + c)
          .join("")
      : body;
  return parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;
}

// WCAG relative luminance, the same comparison the reader makes in
// getModeBasedOnColors (reader/src/common/lib/utilities.js).
export function luminance(hex: string): number {
  const linear = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return (
    0.2126 * linear(channel(hex, 0)) +
    0.7152 * linear(channel(hex, 1)) +
    0.0722 * linear(channel(hex, 2))
  );
}

/** WCAG contrast, 1 for identical colours and 21 for black on white. */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The swatch, darkened. Keeps the hue, so the pad reads as one colour. */
export function inkFor(hex: string): string {
  const scaled = [0, 1, 2]
    .map((index) =>
      Math.round(channel(hex, index) * 255 * INK_SCALE)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
  const ink = `#${scaled}`;
  // A swatch dark enough that its own ink would disappear into it gets white
  // instead. None of the nine above need this; a future one might.
  return contrastRatio(hex, ink) >= 4.5 ? ink : "#F5F5F4";
}

export function schemeFor(hex: string): "light" | "dark" {
  return luminance(hex) > luminance(inkFor(hex)) ? "light" : "dark";
}

/** A stored preference as a usable value: a hex, or follow-the-paper. */
export function normalizeBackground(value: string | null | undefined): string {
  const raw = `${value ?? ""}`.trim();
  return HEX.test(raw) ? raw.toLowerCase() : PAPER_BACKGROUND;
}

export function isPaperBackground(value: string | null | undefined): boolean {
  return normalizeBackground(value) === PAPER_BACKGROUND;
}

/** The name of a swatch, for a tooltip. Empty for a colour not in the list. */
export function swatchNamed(
  hex: string,
): NoteSwatch | null {
  const wanted = hex.toLowerCase();
  for (const row of NOTE_BACKGROUNDS) {
    for (const swatch of row) {
      if (swatch.hex.toLowerCase() === wanted) {
        return swatch;
      }
    }
  }
  return null;
}
