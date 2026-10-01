// What a character looks like: the plate it stands on and its face over it.
//
// The floating bot draws these two layers with more around them -- the glass,
// the rim, the gloss, the rings -- and everywhere else a character is shown
// small (the picker, Settings, the editor) draws just these two. Both come from
// here, so a face looks the same at 44px as it does at 96.
//
// Every face file is a frame FRAME wide around a DISC-wide disc. A framed
// portrait fills the disc and leaves the rest of the frame empty. A cut-out is
// the whole frame, and is masked here: inside the disc everywhere, and above the
// disc's middle it may also leave the disc -- the head comes up out of the
// plate and over the rim, which is most of what makes it look 3D.
import type { BotCharacter } from "./botCharacters";

/** The disc a face is fitted to, in CSS px at the bot's own size. */
export const DISC = 96;
/** The frame around it that a head may come out into. */
export const FRAME = 112;

/** Anya's rose, the plate of any character without a tint of its own. */
const ROSE = [246, 176, 204];
const ROSE_DEEP = [196, 112, 156];

/** The plate's two colours: the character's, and a deeper one for its far side. */
export function plateColours(character: BotCharacter): { tint: number[]; deep: number[] } {
  if (!character.tint) {
    return { tint: ROSE, deep: ROSE_DEEP };
  }
  return {
    tint: character.tint,
    deep: character.tint.map((c) => Math.round(c * 0.72)),
  };
}

// Lengths in the masks are fractions of the frame, so one definition serves
// every size. In a `closest-side` circle 100% is half the frame; in a linear
// gradient it is the whole frame.
const inCircle = (px: number) => `${((px / (FRAME / 2)) * 100).toFixed(2)}%`;
const down = (px: number) => `${((px / FRAME) * 100).toFixed(2)}%`;

/**
 * Inside the disc, and no further -- 0.4px inside it, so the rim's lit edge is
 * never painted over at the bottom, where the face sits in front of nothing.
 */
const DISC_MASK = `radial-gradient(circle closest-side, #000 ${inCircle(46.4)}, transparent ${inCircle(47)})`;

/**
 * The disc, plus everything above its middle. The cut across the middle is
 * soft (52 -> 60px down the frame) so hair that leaves the disc at the side
 * thins out rather than stopping on a ruled line; the top 3px fade in for the
 * same reason, for a tip that reaches the frame's edge.
 */
const POPOUT_MASK = `${DISC_MASK}, linear-gradient(to bottom, transparent 0, #000 ${down(3)}, #000 ${down(52)}, transparent ${down(60)})`;

export function faceMask(character: BotCharacter): string {
  return character.popout ? POPOUT_MASK : DISC_MASK;
}

/**
 * The plate: a sphere in the character's colour, lit from the top left, with
 * the shadow of its own far side along the bottom. `--paperly-plate` and
 * `--paperly-plate-deep` are its colours, as "r, g, b".
 */
export const PLATE_BACKGROUND = `
    radial-gradient(circle at 30% 24%, rgba(255, 255, 255, 0.55) 0%, rgba(255, 255, 255, 0) 36%),
    radial-gradient(circle at 50% 42%,
      rgb(var(--paperly-plate)) 0%,
      rgb(var(--paperly-plate)) 40%,
      rgb(var(--paperly-plate-deep)) 100%)`;

/** A cut-out stands a little off the plate: it is lit along the top and throws a shadow down. */
export const CUTOUT_FILTER =
  "drop-shadow(0 -0.7px 0 rgba(255, 255, 255, 0.45)) drop-shadow(0 2.5px 2px rgba(20, 10, 40, 0.45))";

/** The small rendition's stylesheet, for any document that shows one. */
export function artStyleSheet(): string {
  const plateInset = `${(((FRAME - DISC) / 2 / FRAME) * 100).toFixed(3)}%`;
  return `
.paperly-art {
  position: relative;
  display: inline-block;
  flex: none;
  width: var(--paperly-art-size, 44px);
  height: var(--paperly-art-size, 44px);
  vertical-align: middle;
}
.paperly-art-plate {
  position: absolute;
  inset: ${plateInset};
  border-radius: 50%;
  background: ${PLATE_BACKGROUND};
  box-shadow:
    inset 0 -4px 7px rgba(30, 16, 50, 0.32),
    0 1px 3px rgba(20, 14, 40, 0.35);
}
.paperly-art-face {
  position: absolute;
  inset: 0;
  background-repeat: no-repeat;
  background-position: 0 0;
  background-size: calc(100% * var(--paperly-art-frames, 1)) 100%;
}
.paperly-art[data-kind="cutout"] .paperly-art-face {
  filter: drop-shadow(0 1px 1px rgba(20, 10, 40, 0.45));
}
`;
}

/** A character at the size of its element: the plate, and the face over it. */
export function buildCharacterArt(
  doc: Document,
  character: BotCharacter,
  url: string,
): HTMLElement {
  const art = doc.createElement("span");
  art.className = "paperly-art";
  art.dataset.kind = character.kind;
  const { tint, deep } = plateColours(character);
  art.style.setProperty("--paperly-plate", tint.join(", "));
  art.style.setProperty("--paperly-plate-deep", deep.join(", "));
  art.style.setProperty("--paperly-art-frames", String(character.frames));

  const plate = doc.createElement("span");
  plate.className = "paperly-art-plate";
  const face = doc.createElement("span");
  face.className = "paperly-art-face";
  face.style.backgroundImage = `url("${url}")`;
  if (character.kind === "cutout") {
    face.style.setProperty("mask-image", faceMask(character));
  }
  art.append(plate, face);
  return art;
}
