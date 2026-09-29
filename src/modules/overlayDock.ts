// The surfaces Paperly's own chrome floats on.
//
// The note pad used to live in the reader's own document, which means the
// reader's frame clipped it: it could never reach the AI column beside the
// paper. The main window can host it, but nothing editable can live in the
// window's own document -- it is application/xhtml+xml with a <window> root and
// no <body>, and execCommand is dead there (measured: `bold` returns true and
// changes nothing, `insertHTML` returns false).
//
// So each floating thing lives in an about:blank iframe laid over the whole
// window. That document is text/html with a body, so editing behaves exactly as
// it did in the reader, and it is chrome-privileged, so there are no Xray
// wrappers between the plugin and its DOM.
//
// Covering the window would normally swallow every click meant for the paper
// or the column. It does not, because the frame is clipped to the union of
// whatever it currently occupies: `clip-path` drives hit-testing in Gecko, so a
// point outside the clip lands on whatever is underneath. Measured -- over the
// reader and over the column, both resolve to the `browser` beneath rather than
// to the frame.
//
// Why a full-window frame rather than one the size of its occupant: the pad's
// menus, the format bar and the emoji picker are all `position: fixed` and
// clamp themselves to the viewport. Sized to the pad, that viewport would be
// the pad, and a 320px emoji grid would be crushed into it. Full-window, they
// keep the room they have always had and none of those modules needs to know
// anything changed.
//
// Why one frame per occupant rather than one shared frame: a clipped-away
// region passes the click through to whatever is below, and one overlay frame
// is just another thing below. So two frames never fight -- each cuts its own
// clip, and where neither is drawn the window underneath answers as before.
// Sharing one frame would instead mean sharing one clip path and one
// MutationObserver between modules that have nothing to say to each other.

/**
 * The docks that exist, in painting order.
 *
 * "bot" sits over "note" because it is the launcher: small, deliberately
 * movable, and useless if a note panel can bury it.
 */
export type DockName = "note" | "bot";

// Above Zotero's own chrome. XUL popups are OS-level widgets and still win,
// which is what we want for context menus.
const Z_INDEX: Record<DockName, number> = {
  note: 2147483000,
  bot: 2147483001,
};

export interface OverlayDock {
  win: Window;
  name: DockName;
  frame: HTMLIFrameElement;
  doc: Document;
}

const docks = new Map<Window, Map<DockName, OverlayDock>>();

function frameId(name: DockName): string {
  return `paperly-overlay-${name}`;
}

function frameReady(frame: HTMLIFrameElement): boolean {
  // A body is the only signal that matters: until the document has one there is
  // nowhere to build anything.
  return Boolean(frame.contentDocument?.body);
}

/**
 * The named dock for a window, built on first use.
 *
 * An about:blank frame has its document almost immediately, but not reliably
 * within the same task, so this waits rather than assuming.
 */
export async function ensureOverlayDock(
  win: Window,
  name: DockName,
): Promise<OverlayDock | null> {
  const existing = docks.get(win)?.get(name);
  if (existing?.frame.isConnected && existing.frame.contentDocument) {
    return existing;
  }

  const doc = win.document;
  const host = doc.documentElement;
  if (!host) {
    return null;
  }
  doc.getElementById(frameId(name))?.remove();

  const frame = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "iframe",
  ) as HTMLIFrameElement;
  frame.id = frameId(name);
  frame.setAttribute("src", "about:blank");
  frame.style.cssText = [
    "position: fixed",
    "inset: 0",
    "width: 100%",
    "height: 100%",
    "border: 0",
    "margin: 0",
    "padding: 0",
    "background: transparent",
    `z-index: ${Z_INDEX[name]}`,
    // Nothing is on it yet, so it must catch nothing. An empty path clips
    // everything away.
    'clip-path: path("M 0 0 Z")',
  ].join(";");
  host.appendChild(frame);

  for (let attempt = 0; attempt < 60 && !frameReady(frame); attempt += 1) {
    await new Promise<void>((resolve) => {
      win.setTimeout(resolve, 16);
    });
  }
  const frameDoc = frame.contentDocument;
  if (!frameDoc?.body) {
    frame.remove();
    return null;
  }

  // The frame is a window over the paper, so its own document must not paint
  // anything of its own.
  const reset = frameDoc.createElement("style");
  reset.textContent = [
    "html, body {",
    "  margin: 0;",
    "  padding: 0;",
    "  height: 100%;",
    "  background: transparent;",
    "  overflow: hidden;",
    "}",
  ].join("\n");
  (frameDoc.head || frameDoc.documentElement)?.appendChild(reset);

  const dock: OverlayDock = { win, name, frame, doc: frameDoc };
  let perWindow = docks.get(win);
  if (!perWindow) {
    perWindow = new Map();
    docks.set(win, perWindow);
  }
  perWindow.set(name, dock);
  return dock;
}

export function getOverlayDock(
  win: Window,
  name: DockName,
): OverlayDock | null {
  const dock = docks.get(win)?.get(name);
  return dock?.frame.isConnected ? dock : null;
}

/**
 * What a clip is cut from. `DOMRect` satisfies it, and so does a rect the bot
 * has inflated to cover a wobble that is still settling.
 */
export interface ClipBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Limits what the frame covers to the boxes given, in window coordinates.
 *
 * One subpath per box; the nonzero fill rule makes overlapping boxes a union
 * rather than holes. An empty list clips the frame away entirely, which is how
 * it stays out of the way while its occupant is closed.
 */
export function setDockClip(dock: OverlayDock, boxes: ClipBox[]): void {
  const path = boxes.length
    ? `path("${boxes
        .map((box) => {
          const x = Math.floor(box.left);
          const y = Math.floor(box.top);
          const width = Math.ceil(box.width);
          const height = Math.ceil(box.height);
          return `M${x},${y} h${width} v${height} h${-width} Z`;
        })
        .join(" ")}")`
    : 'path("M 0 0 Z")';
  // Called on every DOM change the pad makes, typing included, so an unchanged
  // clip must cost nothing.
  if (dock.frame.style.clipPath === path) {
    return;
  }
  dock.frame.style.clipPath = path;
}

/** Lets the frame catch everything, for as long as a drag is running. */
export function openDockClip(dock: OverlayDock): void {
  dock.frame.style.clipPath = "";
}

export function destroyOverlayDock(win: Window, name: DockName): void {
  const perWindow = docks.get(win);
  const dock = perWindow?.get(name);
  perWindow?.delete(name);
  if (perWindow && perWindow.size === 0) {
    docks.delete(win);
  }
  try {
    dock?.frame.remove();
  } catch {
    // A window already torn down takes the frame with it.
  }
}

/** Every window's dock of that name, for a module tearing its own down. */
export function destroyOverlayDocks(name: DockName): void {
  for (const win of Array.from(docks.keys())) {
    destroyOverlayDock(win, name);
  }
}
