// The floating Paperly AI bot: her face, alive and adrift over the whole
// window, and the shortest way into the AI panel from anywhere.
//
// It lives in its own overlay dock rather than in the window's document because
// the window's document cannot hold HTML (see overlayDock), and in its own dock
// rather than the note pad's because the two have nothing to say to each other:
// the pad recuts its clip from a MutationObserver over its whole document, so a
// bot sharing that document would make the pad recut on every hover and every
// frame of a drag.
//
// The widget's box never changes size. Everything that moves -- the idle bob,
// the hover lift, the press squash, the tilt while it is carried -- moves
// inside a fixed 96px box, so the hole cut in the dock only has to be redrawn
// when the bot is somewhere new, not while it is being animated.
import { config } from "../../package.json";
import {
  destroyOverlayDock,
  destroyOverlayDocks,
  ensureOverlayDock,
  openDockClip,
  setDockClip,
  type OverlayDock,
} from "./overlayDock";
import {
  isWebAIColumnOpen,
  subscribeWebAIColumnChange,
  toggleWebAIColumn,
} from "./webAIColumn";
import { getPref, setPref } from "../utils/prefs";

const ROOT_ID = "paperly-bot";
const MENU_ITEM_ID = "zotero-webai-bot-menuitem";
const ENABLED_PREF = "floatingBot";
const POSITION_PREF = "floatingBotPosition";

// Her face, as a strip of three frames -- open, half, shut -- laid side by
// side. One file rather than three: one decode, and no frame can go missing on
// its own. 192 is the frame's 2x, because the bot draws it at 96 CSS px and
// grows it to 1.07 under the pointer.
const FACE_SRC = `chrome://${config.addonRef}/content/icons/bot-192.png`;
const FACE_FRAMES = 3;

/**
 * The widget's box, and the bubble drawn inside it.
 *
 * The clip cut in the dock is exactly this box, and `clip-path` cuts paint as
 * well as hit-testing, so anything that paints outside it is sliced off along a
 * straight edge -- which is what the first version did: the rim glow reached
 * the box exactly, the hover swell pushed it 4.8px past, and the click ripple
 * 12.5px past, so hovering or clicking drew a hard grey rectangle over the page.
 *
 * So the 22px all round is not slack, it is budget. Measured from the centre,
 * with the worst case being the bubble's own drop shadow carried out by both
 * the hover swell and the idle squash:
 *
 *     (48 disc + 12 blur + 4 offset) x 1.06 hover x 1.016 squash = 68.9  <= 70
 *     ripple 48 x 1.42 + 2 border                                = 69.2  <= 70
 *     orbit (49.5 / 50) x 62                                     = 61.4  <= 70
 *
 * Anything added here has to be checked against 70, or it will be cut.
 */
const BOX = 140;
const ART = 96;
/** What the box carries beyond the bubble, and so the gap the bubble always keeps. */
const PAD = (BOX - ART) / 2;

/** Where it parks itself the first time, measured in from the window's corner. */
const MARGIN = 8;
/** How close to an edge a drag has to end before the bot is pulled flush to it. */
const SNAP = 36;
/** ...and how much of a gap it keeps once it has been pulled. PAD is already a gap. */
const EDGE = 0;
/**
 * How far the pointer may travel before a press stops being a click.
 *
 * Small, because the bot's whole job is to be clicked: a press that wanders two
 * or three pixels is a click with an unsteady hand, not an attempt to move it.
 */
const DRAG_SLOP = 4;

/**
 * The bubble has weight, and the air around it does not keep up.
 *
 * The box follows the pointer exactly -- it has to, because it is what the clip
 * is cut from and what the saved position means. What the eye follows is a
 * second point chasing the box on a spring, and everything visible hangs off
 * the gap between the two: the bubble falls behind on the way out and
 * overshoots on the way to rest, it stretches along its travel and squashes
 * across it, and the rings and the bloom are dragged further still, the way
 * loose air would be.
 */
const SPRING = 0.17;
const DAMPING = 0.76;
/** Stretch per px/frame of travel, and the ceiling: a bubble, not a rubber band. */
const STRETCH = 0.017;
const STRETCH_MAX = 0.19;
/** How much of the stretch comes back across the travel, conserving its area. */
const SQUASH = 0.72;
/** How much further the loose air is dragged than the bubble itself. */
const TRAIL = 1.7;
/**
 * How far the bubble may fall behind its box.
 *
 * Without a ceiling the lag is whatever the spring says, which on a fast throw
 * is most of the screen, and the clip below would have to be widened to match.
 */
const LAG_MAX = 18;
/** px/frame below which the wobble is over and the tight clip goes back on. */
const AT_REST = 0.08;
/**
 * What the clip is widened by while a wobble is still running.
 *
 * The resting box has no room for one -- see BOX, where the budget is already
 * spent to the pixel. Rather than make every idle bot carry a dead margin for a
 * wobble it is not having, the clip is inflated only while one is in flight:
 *
 *     (64 bubble+shadow x 1.19 stretch x 1.06 swell) + 18 lag = 98.7
 *     orbit 61.4 + 18 x 1.7 trail                             = 92.0
 *     both under BOX / 2 + MOTION_BLEED                       = 102
 */
const MOTION_BLEED = 32;

interface Bot {
  win: Window;
  dock: OverlayDock;
  root: HTMLElement;
  body: HTMLElement;
  tip: HTMLElement;
  /** Where the box is: what the clip is cut from, and what gets saved. */
  x: number;
  y: number;
  /** Where the bubble is, chasing the box, and how fast. */
  px: number;
  py: number;
  vx: number;
  vy: number;
  frame: number | null;
  pressed: boolean;
  hovering: boolean;
  tipTimer: number | null;
  teardown: Array<() => void>;
}

const bots = new Map<Window, Bot>();

// ------------------------------------------------------------- preferences --

export function isFloatingBotEnabled(): boolean {
  return getPref(ENABLED_PREF) !== false;
}

function readPosition(): { x: number; y: number } | null {
  const raw = String(getPref(POSITION_PREF) ?? "");
  const [x, y] = raw.split(",").map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function writePosition(bot: Bot): void {
  setPref(POSITION_PREF, `${Math.round(bot.x)},${Math.round(bot.y)}`);
}

// ---------------------------------------------------------------- geometry --

function viewport(bot: Bot): { width: number; height: number } {
  // The dock's own view, not the chrome window's: the bot is positioned inside
  // that document, so its viewport is the one the coordinates belong to.
  const view = bot.dock.doc.defaultView;
  return {
    width: view?.innerWidth ?? bot.win.innerWidth,
    height: view?.innerHeight ?? bot.win.innerHeight,
  };
}

function clamp(bot: Bot, x: number, y: number): { x: number; y: number } {
  const { width, height } = viewport(bot);
  return {
    x: Math.min(Math.max(x, 0), Math.max(0, width - BOX)),
    y: Math.min(Math.max(y, 0), Math.max(0, height - BOX)),
  };
}

/** Pulls a landing within SNAP of an edge flush against it. */
function snap(bot: Bot, x: number, y: number): { x: number; y: number } {
  const { width, height } = viewport(bot);
  let nextX = x;
  let nextY = y;
  if (x < SNAP) {
    nextX = EDGE;
  } else if (x > width - BOX - SNAP) {
    nextX = width - BOX - EDGE;
  }
  if (y < SNAP) {
    nextY = EDGE;
  } else if (y > height - BOX - SNAP) {
    nextY = height - BOX - EDGE;
  }
  return clamp(bot, nextX, nextY);
}

function place(bot: Bot, x: number, y: number): void {
  const at = clamp(bot, x, y);
  bot.x = at.x;
  bot.y = at.y;
  bot.root.style.left = `${Math.round(at.x)}px`;
  bot.root.style.top = `${Math.round(at.y)}px`;
  // A drag leaves the spring running and lets it carry the bubble over; every
  // other caller -- install, resize -- is a jump, and the bubble goes with it.
  if (bot.frame === null) {
    bot.px = at.x;
    bot.py = at.y;
  }
  syncClip(bot);
}

/**
 * Cuts the dock down to what the bot actually occupies.
 *
 * The root's own box is fixed, so this only has real work to do when the bot
 * moves. The bubble is a separate box because it hangs outside the root, and it
 * only exists while it is being shown.
 */
function syncClip(bot: Bot): void {
  const box = bot.root.getBoundingClientRect();
  const bleed = bot.frame !== null ? MOTION_BLEED : 0;
  const boxes = [
    bleed
      ? {
          left: box.left - bleed,
          top: box.top - bleed,
          width: box.width + bleed * 2,
          height: box.height + bleed * 2,
        }
      : box,
  ];
  if (bot.tip.classList.contains("is-shown")) {
    const box = bot.tip.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      boxes.push(box);
    }
  }
  setDockClip(bot.dock, boxes);
}

// ------------------------------------------------------------------ motion --

/** Whether the user has asked for stillness; then there is no spring at all. */
function wantsStill(bot: Bot): boolean {
  return Boolean(
    bot.dock.doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)")?.matches,
  );
}

/** The transform the bubble wears when nothing is in flight. */
function applyRest(bot: Bot): void {
  bot.body.style.transform = bot.pressed
    ? "scale(0.93)"
    : bot.hovering
      ? "scale(1.06)"
      : "";
}

/**
 * One frame of the chase.
 *
 * The stretch is built as rotate(to the travel) / scale / rotate(back), so the
 * long axis always lies along the way the bubble is going, whatever direction
 * that is. The swell multiplies in rather than replacing, because a bubble
 * picked up while hovering is both swollen and stretched.
 */
function paintMotion(bot: Bot): void {
  const dx = bot.px - bot.x;
  const dy = bot.py - bot.y;
  const speed = Math.hypot(bot.vx, bot.vy);
  const k = Math.min(STRETCH_MAX, speed * STRETCH);
  const swell = bot.pressed ? 0.93 : bot.hovering ? 1.06 : 1;

  const parts = [`translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`];
  if (k > 0.002) {
    const angle = (Math.atan2(bot.vy, bot.vx) * 180) / Math.PI;
    parts.push(
      `rotate(${angle.toFixed(1)}deg)`,
      `scale(${((1 + k) * swell).toFixed(3)}, ${((1 - k * SQUASH) * swell).toFixed(3)})`,
      `rotate(${(-angle).toFixed(1)}deg)`,
    );
  } else if (swell !== 1) {
    parts.push(`scale(${swell})`);
  }
  bot.body.style.transform = parts.join(" ");

  // The rings and the bloom are not attached to her, so they are dragged
  // further and arrive later -- which is the whole of the wind.
  bot.root.style.setProperty("--paperly-trail-x", `${(dx * TRAIL).toFixed(2)}px`);
  bot.root.style.setProperty("--paperly-trail-y", `${(dy * TRAIL).toFixed(2)}px`);
}

function startMotion(bot: Bot): void {
  if (bot.frame !== null || wantsStill(bot)) {
    return;
  }
  bot.root.classList.add("is-moving");
  const step = (): void => {
    bot.vx = (bot.vx + (bot.x - bot.px) * SPRING) * DAMPING;
    bot.vy = (bot.vy + (bot.y - bot.py) * SPRING) * DAMPING;
    bot.px += bot.vx;
    bot.py += bot.vy;
    // Held to LAG_MAX so the clip inflation above stays a fixed number.
    const gap = Math.hypot(bot.px - bot.x, bot.py - bot.y);
    if (gap > LAG_MAX) {
      const pull = LAG_MAX / gap;
      bot.px = bot.x + (bot.px - bot.x) * pull;
      bot.py = bot.y + (bot.py - bot.y) * pull;
    }
    paintMotion(bot);

    const still =
      Math.hypot(bot.vx, bot.vy) < AT_REST &&
      Math.hypot(bot.px - bot.x, bot.py - bot.y) < AT_REST;
    if (still && !bot.root.classList.contains("is-dragging")) {
      stopMotion(bot);
      return;
    }
    bot.frame = bot.win.requestAnimationFrame(step);
  };
  bot.frame = bot.win.requestAnimationFrame(step);
}

function stopMotion(bot: Bot): void {
  if (bot.frame !== null) {
    bot.win.cancelAnimationFrame(bot.frame);
    bot.frame = null;
  }
  bot.px = bot.x;
  bot.py = bot.y;
  bot.vx = 0;
  bot.vy = 0;
  bot.root.classList.remove("is-moving");
  bot.root.style.removeProperty("--paperly-trail-x");
  bot.root.style.removeProperty("--paperly-trail-y");
  applyRest(bot);
  // The wobble is over, so the page gets its margin back.
  syncClip(bot);
}

// ------------------------------------------------------------------ styles --

function styleSheet(faceUrl: string): string {
  return `
#${ROOT_ID} {
  position: fixed;
  left: 0;
  top: 0;
  width: ${BOX}px;
  height: ${BOX}px;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  font: 500 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
#${ROOT_ID}.is-dragging {
  cursor: grabbing;
}
/* While the spring is running it writes a transform every frame, so the easing
   that makes a hover swell pleasant would fight it into treacle. */
#${ROOT_ID}.is-moving .paperly-bot-body {
  transition: none;
}

/* The bloom the bubble sits in. Rose while she is idle, because that is her
   hair; steel blue once the panel is open, because that is the colour of the
   circuitry she is drawn with, and the two need to be told apart at a glance. */
.paperly-bot-glow {
  position: absolute;
  inset: 2px;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 46%,
      rgba(246, 176, 204, 0.30) 0%,
      rgba(238, 168, 200, 0.15) 44%,
      rgba(226, 164, 208, 0.06) 58%,
      rgba(226, 164, 208, 0) 68%);
  animation: paperly-bot-pulse 4.6s ease-in-out infinite;
  transform: translate(var(--paperly-trail-x, 0px), var(--paperly-trail-y, 0px));
  pointer-events: none;
}
#${ROOT_ID}.is-active .paperly-bot-glow {
  background:
    radial-gradient(circle at 50% 46%,
      rgba(122, 200, 230, 0.38) 0%,
      rgba(122, 200, 230, 0.17) 44%,
      rgba(122, 200, 230, 0.07) 58%,
      rgba(122, 200, 230, 0) 68%);
  animation-duration: 3.1s;
}

/* Two rings turning against each other. This is the part that says machine:
   she is a drawing of a girl, and a bubble that bobs with a face in it is a
   sticker. They sit outside the float, so they hold their line while the
   bubble rises and falls inside them, and they are kept faint -- a bubble with
   a bright HUD around it stops reading as glass. */
.paperly-bot-orbit {
  position: absolute;
  inset: ${PAD - 14}px;
  pointer-events: none;
  /* Dragged after the bubble, and further, because nothing holds them to her.
     The spin lives on the circles inside, so this transform is free. */
  transform: translate(var(--paperly-trail-x, 0px), var(--paperly-trail-y, 0px));
}
.paperly-bot-orbit svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.paperly-bot-orbit .ring-far {
  animation: paperly-bot-spin 17s linear infinite;
  transform-origin: 50% 50%;
}
.paperly-bot-orbit .ring-near {
  animation: paperly-bot-spin 11s linear infinite reverse;
  transform-origin: 50% 50%;
}
#${ROOT_ID}:hover .paperly-bot-orbit .ring-far { animation-duration: 8s; }
#${ROOT_ID}:hover .paperly-bot-orbit .ring-near { animation-duration: 5.5s; }

/* Where it hovers. The ellipse tightens as the bubble rises, which is most of
   what sells the bob as a float rather than a slide. */
.paperly-bot-shadow {
  position: absolute;
  left: 50%;
  bottom: 9px;
  width: 54px;
  height: 9px;
  border-radius: 50%;
  background: radial-gradient(ellipse at center,
    rgba(58, 48, 104, 0.34) 0%, rgba(58, 48, 104, 0) 72%);
  transform: translateX(-50%);
  animation: paperly-bot-ground 4.6s ease-in-out infinite;
  pointer-events: none;
}

/* Two layers over one: the JS-driven transforms (hover, press, carry tilt) sit
   on the body, and the idle bob has the float to itself. One element cannot
   hold both, because a running animation overrides the inline transform. */
.paperly-bot-body {
  position: absolute;
  left: 50%;
  top: 50%;
  width: ${ART}px;
  height: ${ART}px;
  margin: -${ART / 2}px 0 0 -${ART / 2}px;
  transition: transform 240ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.paperly-bot-float {
  position: relative;
  width: 100%;
  height: 100%;
  animation: paperly-bot-float 4.6s ease-in-out infinite;
}

/* The glass she floats in. The tint runs pearl at the top into violet at the
   bottom, which is what gives a flat circle its volume; the inset highlight and
   the inset underlight are the near and far walls of the sphere. It is kept
   translucent, so the page shows through the way it does through a bubble --
   which is only possible because bot-192.png is her head cut out on
   transparency, with no field of its own behind her. */
.paperly-bot-bubble {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 50%,
      rgba(255, 255, 255, 0.05) 0%,
      rgba(255, 242, 248, 0.09) 46%,
      rgba(242, 202, 228, 0.22) 72%,
      rgba(202, 180, 236, 0.34) 90%,
      rgba(164, 154, 222, 0.46) 100%);
  box-shadow:
    inset 0 7px 14px rgba(255, 255, 255, 0.40),
    inset 0 -12px 18px rgba(142, 128, 196, 0.32),
    0 4px 12px rgba(74, 64, 124, 0.30),
    0 0 12px rgba(246, 170, 200, 0.40);
  transition: box-shadow 280ms ease, background 280ms ease;
  pointer-events: none;
}
#${ROOT_ID}.is-active .paperly-bot-bubble {
  background:
    radial-gradient(circle at 50% 50%,
      rgba(255, 255, 255, 0.05) 0%,
      rgba(236, 250, 255, 0.10) 46%,
      rgba(176, 222, 246, 0.24) 72%,
      rgba(142, 188, 236, 0.36) 90%,
      rgba(112, 154, 218, 0.48) 100%);
  box-shadow:
    inset 0 7px 14px rgba(255, 255, 255, 0.42),
    inset 0 -12px 18px rgba(96, 132, 190, 0.34),
    0 4px 12px rgba(48, 74, 128, 0.32),
    0 0 12px rgba(122, 200, 230, 0.48);
}

/* Her face: three frames in one strip, stepped through rather than faded
   between, because a blink is two held frames and not a cross-fade. */
.paperly-bot-face {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background-image: url("${faceUrl}");
  background-repeat: no-repeat;
  background-size: ${ART * FACE_FRAMES}px ${ART}px;
  background-position: 0 0;
  animation: paperly-bot-blink 5.4s step-end infinite;
  pointer-events: none;
}

/* The catchlight, and the small answering glint low on the far side. This is
   the one thing that makes a tinted circle read as a sphere of glass rather
   than as a disc, so it sits over her: she is inside the bubble, not on it. It
   drifts, because a highlight nailed to one spot looks painted on. */
.paperly-bot-gloss {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background:
    radial-gradient(ellipse 25% 15% at 27% 15%,
      rgba(255, 255, 255, 0.66) 0%, rgba(255, 255, 255, 0) 74%),
    radial-gradient(ellipse 9% 6% at 73% 80%,
      rgba(255, 255, 255, 0.46) 0%, rgba(255, 255, 255, 0) 76%);
  animation: paperly-bot-sheen 7.6s ease-in-out infinite;
  pointer-events: none;
}

/* The glass edge, and the one thing on it that answers the panel's state. */
.paperly-bot-rim {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  box-shadow:
    inset 0 0 0 1.5px rgba(255, 255, 255, 0.55),
    inset 0 0 10px rgba(255, 255, 255, 0.30);
  transition: box-shadow 280ms ease;
  pointer-events: none;
}
#${ROOT_ID}.is-active .paperly-bot-rim {
  box-shadow:
    inset 0 0 0 1.5px rgba(206, 238, 252, 0.80),
    inset 0 0 12px rgba(168, 220, 244, 0.42);
}

/* On-air light. It exists only while the panel is open, so it is a reading and
   not an ornament. It straddles the rim at 45 degrees: on a ${ART}px bubble
   that point is 82px along both axes, so a 9px light starts at 77. */
.paperly-bot-dot {
  position: absolute;
  left: 77px;
  top: 77px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #7BD0EC;
  box-shadow: 0 0 0 2px rgba(10, 14, 30, 0.9), 0 0 8px rgba(123, 208, 236, 0.9);
  opacity: 0;
  transform: scale(0.4);
  transition: opacity 200ms ease, transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
  pointer-events: none;
}
#${ROOT_ID}.is-active .paperly-bot-dot {
  opacity: 1;
  transform: scale(1);
  animation: paperly-bot-blip 2.2s ease-in-out infinite;
}

/* The ripple a click leaves behind: started by adding the class, ended by the
   animation, so nothing has to time it. It starts at the bubble's own size and
   stops inside the box -- see BOX for why that ceiling is not optional. */
.paperly-bot-pulse {
  position: absolute;
  inset: ${PAD}px;
  border-radius: 50%;
  border: 2px solid rgba(248, 186, 212, 0.85);
  opacity: 0;
  pointer-events: none;
}
#${ROOT_ID}.is-active .paperly-bot-pulse {
  border-color: rgba(138, 206, 236, 0.85);
}
.paperly-bot-pulse.is-ringing {
  animation: paperly-bot-ring 660ms ease-out;
}

/* The bubble's label. It hangs outside the root, so it carries its own hole in
   the dock; see syncClip. */
.paperly-bot-tip {
  position: absolute;
  top: 50%;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 7px 11px;
  border-radius: 11px;
  background: rgba(20, 24, 44, 0.96);
  color: #F4EDE6;
  white-space: nowrap;
  box-shadow: 0 6px 18px rgba(8, 10, 24, 0.42);
  opacity: 0;
  visibility: hidden;
  transform: translateY(-50%) scale(0.9);
  transform-origin: center right;
  transition: opacity 160ms ease, transform 160ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.paperly-bot-tip.is-right {
  left: calc(100% - ${PAD}px);
  transform-origin: center left;
}
.paperly-bot-tip:not(.is-right) {
  right: calc(100% - ${PAD}px);
}
.paperly-bot-tip.is-shown {
  opacity: 1;
  visibility: visible;
  transform: translateY(-50%) scale(1);
}
.paperly-bot-tip b {
  font-weight: 600;
  font-size: 12.5px;
}

/* Dismiss. Placed by arithmetic rather than by eye: a 20px button inset 21px
   from the top-right of the ${BOX}px box centres at (109, 31), which is 55px
   from the centre -- 7px clear of the ${ART}px bubble's rim, and well inside
   the 70px the clip allows. Anything moved outward from here has to be checked
   against that budget; see BOX. */
.paperly-bot-close {
  position: absolute;
  top: 21px;
  right: 21px;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgba(24, 26, 44, 0.88);
  color: #F2ECE6;
  font: 600 14px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  cursor: default;
  opacity: 0;
  /* Off until it is wanted: a permanently visible button on a 140px box is
     clutter, and while it is invisible it must not eat the drag either. */
  pointer-events: none;
  transform: scale(0.8);
  transition: opacity 140ms ease, transform 140ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
#${ROOT_ID}:hover .paperly-bot-close {
  opacity: 1;
  pointer-events: auto;
  transform: scale(1);
}
.paperly-bot-close:hover {
  background: rgba(196, 60, 60, 0.95);
}
/* Never during a carry: the pointer is down and the gesture is the drag. */
#${ROOT_ID}.is-dragging .paperly-bot-close {
  opacity: 0;
  pointer-events: none;
}

/* Twice a cycle, at 38% and 93%, so the gaps between blinks are 3.0s and 2.4s
   rather than one even beat -- an even beat is the thing that reads as a
   machine ticking rather than as someone blinking. Each blink is 43ms of
   half-shut, 76ms shut, 43ms half again. */
@keyframes paperly-bot-blink {
  0%      { background-position: 0 0; }
  38.0%   { background-position: -${ART}px 0; }
  38.8%   { background-position: -${ART * 2}px 0; }
  40.2%   { background-position: -${ART}px 0; }
  41.0%   { background-position: 0 0; }
  93.0%   { background-position: -${ART}px 0; }
  93.8%   { background-position: -${ART * 2}px 0; }
  95.2%   { background-position: -${ART}px 0; }
  96.0%   { background-position: 0 0; }
}
/* Rising, with the squash a bubble takes at the top and bottom of its travel.
   The scale is held to 1.016 because it multiplies with the hover swell, and
   the product is what has to stay inside the box. */
@keyframes paperly-bot-float {
  0%, 100% { transform: translateY(0) scale(1, 1); }
  26%      { transform: translateY(-3.5px) scale(0.984, 1.016); }
  52%      { transform: translateY(-6px) scale(1, 1); }
  78%      { transform: translateY(-3px) scale(1.016, 0.984); }
}
@keyframes paperly-bot-sheen {
  0%, 100% { transform: translate(0, 0); opacity: 0.92; }
  50%      { transform: translate(2px, -2px); opacity: 1; }
}
/* Opacity only. The bloom's transform belongs to the wind, and a running
   animation would win every frame. */
@keyframes paperly-bot-pulse {
  0%, 100% { opacity: 0.58; }
  50%      { opacity: 0.96; }
}
@keyframes paperly-bot-ground {
  0%, 100% { transform: translateX(-50%) scaleX(1); opacity: 1; }
  50%      { transform: translateX(-50%) scaleX(0.82); opacity: 0.54; }
}
@keyframes paperly-bot-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
@keyframes paperly-bot-blip {
  0%, 100% { box-shadow: 0 0 0 2px rgba(10, 14, 30, 0.9), 0 0 8px rgba(123, 208, 236, 0.9); }
  50%      { box-shadow: 0 0 0 2px rgba(10, 14, 30, 0.9), 0 0 14px rgba(123, 208, 236, 1); }
}
@keyframes paperly-bot-ring {
  from { opacity: 0.85; transform: scale(0.80); }
  to   { opacity: 0;    transform: scale(1.42); }
}

/* Asked to sit still, she sits still -- the bob, the rings, the bloom, the
   sheen and the ground shadow all stop. The blink stays: it moves nothing, it
   lasts 76ms, and a bot that has stopped blinking reads as switched off rather
   than as calm. */
@media (prefers-reduced-motion: reduce) {
  .paperly-bot-glow,
  .paperly-bot-shadow,
  .paperly-bot-float,
  .paperly-bot-gloss,
  .paperly-bot-orbit .ring-far,
  .paperly-bot-orbit .ring-near,
  .paperly-bot-dot,
  .paperly-bot-pulse.is-ringing {
    animation: none;
  }
}
`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The two rings that turn around her. */
function buildOrbit(doc: Document): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.className = "paperly-bot-orbit";
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  // Dashes rather than a border: a CSS dashed border sets its own dash length
  // from the stroke width and comes out uneven on a circle this small.
  for (const [cls, r, width, dash, colour] of [
    ["ring-far", 49, 0.8, "1.6 6.0", "rgba(226, 150, 190, 0.45)"],
    ["ring-near", 45, 1.2, "7 8 2 8", "rgba(214, 128, 176, 0.62)"],
  ] as Array<[string, number, number, string, string]>) {
    const circle = doc.createElementNS(SVG_NS, "circle");
    circle.setAttribute("class", cls);
    circle.setAttribute("cx", "50");
    circle.setAttribute("cy", "50");
    circle.setAttribute("r", String(r));
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", colour);
    circle.setAttribute("stroke-width", String(width));
    circle.setAttribute("stroke-dasharray", dash);
    circle.setAttribute("stroke-linecap", "round");
    svg.appendChild(circle);
  }
  wrap.appendChild(svg);
  return wrap;
}

function buildBot(dock: OverlayDock, win: Window, host: HTMLElement): Bot {
  const doc = dock.doc;
  doc.getElementById(ROOT_ID)?.remove();

  const style = doc.createElement("style");
  style.id = `${ROOT_ID}-style`;
  style.textContent = styleSheet(FACE_SRC);
  (doc.head || doc.documentElement)?.appendChild(style);

  const root = doc.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("role", "button");

  const glow = doc.createElement("div");
  glow.className = "paperly-bot-glow";

  const shadow = doc.createElement("div");
  shadow.className = "paperly-bot-shadow";

  const body = doc.createElement("div");
  body.className = "paperly-bot-body";
  const float = doc.createElement("div");
  float.className = "paperly-bot-float";
  // Glass behind her, catchlight in front: she is inside the bubble, not on it.
  const bubble = doc.createElement("div");
  bubble.className = "paperly-bot-bubble";
  const face = doc.createElement("div");
  face.className = "paperly-bot-face";
  const gloss = doc.createElement("div");
  gloss.className = "paperly-bot-gloss";
  const rim = doc.createElement("div");
  rim.className = "paperly-bot-rim";
  const dot = doc.createElement("div");
  dot.className = "paperly-bot-dot";
  float.append(bubble, face, gloss, rim, dot);
  body.appendChild(float);

  const pulse = doc.createElement("div");
  pulse.className = "paperly-bot-pulse";

  const tip = doc.createElement("div");
  tip.className = "paperly-bot-tip";

  // Outside `body`, so the spring's stretch and lag do not make it a moving
  // target, and last in the stack so nothing paints over it.
  const close = doc.createElement("button");
  close.className = "paperly-bot-close";
  close.type = "button";
  close.textContent = "\u00D7";
  close.title = "Hide the bot";
  close.setAttribute("aria-label", "Hide the Paperly AI bot");
  // The root starts a drag on pointerdown, so that has to be stopped here or
  // pressing the button would carry the bot off instead of closing it.
  close.addEventListener("pointerdown", (event: Event) => {
    event.stopPropagation();
  });
  close.addEventListener("click", (event: Event) => {
    event.stopPropagation();
    void setFloatingBotEnabled(win, false);
  });

  root.append(glow, buildOrbit(doc), shadow, body, pulse, tip, close);
  host.appendChild(root);

  return {
    win,
    dock,
    root,
    body,
    tip,
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    frame: null,
    pressed: false,
    hovering: false,
    tipTimer: null,
    teardown: [
      () => {
        root.remove();
        style.remove();
      },
    ],
  };
}

/**
 * The name, and nothing else.
 *
 * It used to spell out "Click to open / Drag to move", which is a label
 * explaining a control that is already a round face you click. Once it has been
 * read once it is noise on every hover after, and it is what made the bubble
 * wide enough to cover the page beside the bot.
 */
function setTip(bot: Bot): void {
  bot.tip.textContent = "";
  const b = bot.dock.doc.createElement("b");
  b.textContent = "Paperly AI";
  bot.tip.append(b);
}

function showTip(bot: Bot): void {
  if (bot.tipTimer !== null) {
    bot.win.clearTimeout(bot.tipTimer);
    bot.tipTimer = null;
  }
  // On whichever side has the room. Measured against the window rather than the
  // bot's own half, so a bot parked mid-screen in a narrow window still gets a
  // bubble that fits.
  const { width } = viewport(bot);
  bot.tip.classList.toggle("is-right", bot.x + BOX / 2 < width / 2);
  bot.tip.classList.add("is-shown");
  syncClip(bot);
}

function hideTip(bot: Bot): void {
  if (!bot.tip.classList.contains("is-shown")) {
    return;
  }
  bot.tip.classList.remove("is-shown");
  // The clip has to outlast the fade, or the bubble is cut away mid-transition.
  bot.tipTimer = bot.win.setTimeout(() => {
    bot.tipTimer = null;
    syncClip(bot);
  }, 200);
}

function setActive(bot: Bot, active: boolean): void {
  bot.root.classList.toggle("is-active", active);
  bot.root.setAttribute(
    "aria-label",
    active ? "Close the Paperly AI panel" : "Open the Paperly AI panel",
  );
}

function pulse(bot: Bot): void {
  const el = bot.root.querySelector(".paperly-bot-pulse") as HTMLElement | null;
  if (!el) {
    return;
  }
  el.classList.remove("is-ringing");
  // Read back, so the class going on again starts a new run rather than
  // continuing the old one.
  void el.offsetWidth;
  el.classList.add("is-ringing");
}

/**
 * Press, carry and release.
 *
 * One handler for both gestures because they start identically: it is only once
 * the pointer has travelled DRAG_SLOP that a press is known not to be a click.
 */
function attachPointer(bot: Bot): void {
  const root = bot.root;

  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const grabX = startX - bot.x;
    const grabY = startY - bot.y;
    let dragging = false;

    try {
      root.setPointerCapture(event.pointerId);
    } catch {
      // Without capture the bot stops following once the pointer leaves its
      // box, which over a <browser> is immediately. Better to know that the
      // drag will be short than to abandon the gesture.
    }
    bot.pressed = true;
    applyRest(bot);

    const onMove = (moveEvent: PointerEvent): void => {
      if (!dragging) {
        if (
          Math.abs(moveEvent.clientX - startX) < DRAG_SLOP &&
          Math.abs(moveEvent.clientY - startY) < DRAG_SLOP
        ) {
          return;
        }
        dragging = true;
        root.classList.add("is-dragging");
        hideTip(bot);
        // The pointer is held down on the bot, so nothing else can be clicked
        // anyway: let the dock catch everything until it lands, rather than
        // recutting the clip on every move.
        openDockClip(bot.dock);
        startMotion(bot);
      }
      // Only the box is moved here. What the bubble does about it -- fall
      // behind, stretch along the way it is going, drag the rings after it --
      // is the spring's business, one frame at a time.
      bot.x = moveEvent.clientX - grabX;
      bot.y = moveEvent.clientY - grabY;
      root.style.left = `${Math.round(bot.x)}px`;
      root.style.top = `${Math.round(bot.y)}px`;
    };

    const onUp = (upEvent: PointerEvent): void => {
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onUp);
      try {
        root.releasePointerCapture(upEvent.pointerId);
      } catch {
        // The capture is already gone if the pointer left the window.
      }
      bot.pressed = false;
      if (!dragging) {
        applyRest(bot);
        pulse(bot);
        void toggleWebAIColumn(bot.win);
        return;
      }
      root.classList.remove("is-dragging");
      const landed = snap(bot, bot.x, bot.y);
      // The spring is still running, so the snap is something the bubble
      // travels to and overshoots, not something it teleports through.
      place(bot, landed.x, landed.y);
      writePosition(bot);
    };

    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onUp);
  };

  const onEnter = (): void => {
    if (root.classList.contains("is-dragging")) {
      return;
    }
    bot.hovering = true;
    if (bot.frame === null) {
      applyRest(bot);
    }
    showTip(bot);
  };
  const onLeave = (): void => {
    if (root.classList.contains("is-dragging")) {
      return;
    }
    bot.hovering = false;
    if (bot.frame === null) {
      applyRest(bot);
    }
    hideTip(bot);
  };
  // There is no chrome context menu worth showing on a widget this size. It
  // used to answer "how do I put this away" with a pointer to the View menu;
  // the close button does that now, so there is nothing left to say.
  const onContext = (event: Event): void => {
    event.preventDefault();
  };

  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointerenter", onEnter);
  root.addEventListener("pointerleave", onLeave);
  root.addEventListener("contextmenu", onContext);
  bot.teardown.push(() => {
    root.removeEventListener("pointerdown", onDown);
    root.removeEventListener("pointerenter", onEnter);
    root.removeEventListener("pointerleave", onLeave);
    root.removeEventListener("contextmenu", onContext);
  });
}

// ----------------------------------------------------------------- install --

export async function installFloatingBot(win: Window): Promise<void> {
  if (!isFloatingBotEnabled() || bots.has(win)) {
    return;
  }
  const dock = await ensureOverlayDock(win, "bot");
  const host = dock?.doc.body;
  if (!dock || !host) {
    return;
  }
  // The await above is a handful of frames long, in which the window may have
  // been closed or the bot switched off again.
  if (bots.has(win) || !isFloatingBotEnabled()) {
    destroyOverlayDock(win, "bot");
    return;
  }

  const bot = buildBot(dock, win, host);
  bots.set(win, bot);
  setTip(bot);
  setActive(bot, isWebAIColumnOpen(win));
  attachPointer(bot);

  const stored = readPosition();
  const { width, height } = viewport(bot);
  place(
    bot,
    stored?.x ?? width - BOX - MARGIN,
    stored?.y ?? height - BOX - MARGIN,
  );

  const onResize = (): void => {
    // Clamped, not snapped: a window that grew should not drag the bot along
    // with its edge, but a window that shrank must not leave it outside.
    place(bot, bot.x, bot.y);
  };
  win.addEventListener("resize", onResize);
  bot.teardown.push(() => win.removeEventListener("resize", onResize));

  const unsubscribe = subscribeWebAIColumnChange((changed) => {
    if (changed === win) {
      setActive(bot, isWebAIColumnOpen(win));
    }
  });
  bot.teardown.push(unsubscribe);
}

export function uninstallFloatingBot(win: Window): void {
  const bot = bots.get(win);
  if (!bot) {
    // Still worth clearing: an install that got as far as its frame and no
    // further leaves one behind.
    destroyOverlayDock(win, "bot");
    return;
  }
  bots.delete(win);
  if (bot.frame !== null) {
    try {
      win.cancelAnimationFrame(bot.frame);
    } catch {
      // The window may already be gone, and with it its frame callbacks.
    }
    bot.frame = null;
  }
  if (bot.tipTimer !== null) {
    try {
      win.clearTimeout(bot.tipTimer);
    } catch {
      // The window may already be gone, and with it its timers.
    }
  }
  for (const undo of bot.teardown) {
    try {
      undo();
    } catch {
      // Teardown runs on shutdown too, where half of this is already gone.
    }
  }
  destroyOverlayDock(win, "bot");
}

/** Turns the bot on or off for this window, and remembers which. */
export async function setFloatingBotEnabled(
  win: Window,
  enabled: boolean,
): Promise<void> {
  setPref(ENABLED_PREF, enabled);
  if (enabled) {
    await installFloatingBot(win);
  } else {
    uninstallFloatingBot(win);
  }
}

/**
 * Brings the bot back after it has been dismissed.
 *
 * Hung off the toolbar icon rather than left to the View menu, because the X is
 * a one-click way out and a menu three levels deep is not a one-click way back.
 * A no-op while the bot is already there, so the icon's own job is untouched.
 */
export async function restoreFloatingBot(win: Window): Promise<void> {
  if (isFloatingBotEnabled()) {
    return;
  }
  await setFloatingBotEnabled(win, true);
}

export function uninstallAllFloatingBots(): void {
  for (const win of Array.from(bots.keys())) {
    uninstallFloatingBot(win);
  }
  // Any dock left over from an install that never finished building its bot.
  destroyOverlayDocks("bot");
}

/**
 * The switch, and the only way back once the bot has been put away.
 *
 * It sits in the View menu beside the panel's own entry rather than on the bot,
 * because a control that only exists on the thing it hides cannot turn it back
 * on.
 */
export function registerFloatingBotMenu(win: Window): void {
  const doc = win.document;
  if (doc.getElementById(MENU_ITEM_ID)) {
    return;
  }
  const popup = doc.getElementById("menu_viewPopup");
  if (!popup) {
    return;
  }
  const makeXUL = (tag: string) =>
    (doc as Document & { createXULElement?: (t: string) => Element })
      .createXULElement?.(tag) ?? doc.createElement(tag);

  const item = makeXUL("menuitem") as HTMLElement;
  item.id = MENU_ITEM_ID;
  item.setAttribute("type", "checkbox");
  item.setAttribute("label", "Paperly AI Bot");
  item.addEventListener("command", () => {
    void setFloatingBotEnabled(win, !isFloatingBotEnabled());
  });
  popup.addEventListener("popupshowing", () => {
    item.setAttribute("checked", isFloatingBotEnabled() ? "true" : "false");
  });
  popup.appendChild(item);
}

export function removeFloatingBotMenu(win: Window): void {
  win.document.getElementById(MENU_ITEM_ID)?.remove();
}
