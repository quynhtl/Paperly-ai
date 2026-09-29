import React from "react";
import { bindReactDomGlobals } from "../utils/reactGlobals";
import { EventBus } from "../utils/eventBus";
import { Sidebar } from "../ui/components/Sidebar";
import { getPref, setPref } from "../utils/prefs";
import {
  resolveSidebarLocation,
  type SidebarLocation,
} from "../ui/sidebarSection";
import { getReaderToolbarMinWidth } from "./readerPrivate";

type ReactRoot = import("react-dom/client").Root;

interface ColumnState {
  mainWindow: Window;
  splitter: Element;
  column: HTMLElement;
  mount: HTMLElement;
  reactRoot: ReactRoot | null;
  bootstrapping: Promise<void> | null;
  location: SidebarLocation;
  tabObserverID: string | null;
}

const COLUMN_ID = "zotero-webai-pane";
const SPLITTER_ID = "zotero-webai-splitter-pane";
const MOUNT_ID = "zotero-webai-pane-mount";
const WIDTH_PREF = "columnWidth";
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;

const states = new WeakMap<Window, ColumnState>();
const columnChangeListeners = new Set<(win: Window) => void>();

// The tab-bar button is a toggle for this column, so it has to follow the state.
// A listener keeps the dependency one-directional: readerIntegration imports
// this module, never the other way round.
export function subscribeWebAIColumnChange(
  listener: (win: Window) => void,
): () => void {
  columnChangeListeners.add(listener);
  return () => {
    columnChangeListeners.delete(listener);
  };
}

function notifyColumnChange(win: Window): void {
  for (const listener of columnChangeListeners) {
    try {
      listener(win);
    } catch {
      // A listener must never block the toggle.
    }
  }
}
let reactDomClientPromise: Promise<typeof import("react-dom/client")> | null =
  null;

function readStoredWidth(): number {
  const raw = Number(getPref(WIDTH_PREF));
  return Number.isFinite(raw) && raw >= MIN_WIDTH ? raw : DEFAULT_WIDTH;
}

// The column is a sibling of #tabs-deck, not a child of it. Everything inside
// the deck -- the collections tree, the item pane, every reader -- belongs to
// one tab and is hidden when another tab is selected. Sitting outside the deck
// is what makes this column visible in both library and reader tabs.
function findDeckRow(doc: Document): Element | null {
  return doc.getElementById("tabs-deck")?.parentElement ?? null;
}

// Leave at least this much of the paper on screen; everything wider is the
// user's call. Pointer capture is what makes the drag survive crossing the
// embedded <browser>, which would otherwise swallow the move events.
const MIN_PAPER_WIDTH = 200;

// Enough that the reader's toolbar is not sitting exactly on its limit, where
// a different locale or item type would tip it over.
const TOOLBAR_SLACK = 8;

/**
 * The narrowest the paper may get.
 *
 * With a reader open this is whatever its toolbar needs, read live: squeezed
 * past that the toolbar's sections paint over each other, and no drag should
 * be able to reach that. The number falls on its own as the paper narrows,
 * because the narrow-reader styles in readerIntegration trade metrics for
 * room -- measured, 793px becomes 620px, so the floor is well under anything
 * worth reading beside. The library view has no toolbar to ask and keeps the
 * old floor.
 */
function paperFloor(win: Window): number {
  const toolbar = getReaderToolbarMinWidth(win);
  return toolbar === null ? MIN_PAPER_WIDTH : toolbar + TOOLBAR_SLACK;
}

// The handle sits between the two, so the paper gets the row minus the column
// minus this. Left out, the paper lands a handle's width under its floor.
// Zero before createColumn has appended it, which only makes the first clamp
// looser than the drag's.
function splitterWidth(win: Window): number {
  const splitter = win.document.getElementById(SPLITTER_ID) as HTMLElement | null;
  return splitter?.offsetWidth ?? 0;
}

function clampColumnWidth(win: Window, width: number): number {
  const ceiling = Math.max(
    MIN_WIDTH,
    win.innerWidth - paperFloor(win) - splitterWidth(win),
  );
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), ceiling));
}

function attachColumnResize(
  win: Window,
  handle: HTMLElement,
  column: HTMLElement,
): void {
  handle.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = column.getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      // Dragging left widens the column.
      const desired = startWidth + (startX - moveEvent.clientX);
      column.style.width = `${clampColumnWidth(win, desired)}px`;
    };

    const onUp = () => {
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        // The capture is already gone if the window lost focus mid-drag.
      }
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
}

/**
 * Takes out anything a previous life left in the window.
 *
 * `states` is module-level, so a plugin reload begins with an empty map while
 * the window's DOM still holds the column built by the load before it. Nothing
 * else would ever remove those nodes -- removeWebAIColumn works *through*
 * `states` and so cannot see them -- and the next open would append a second
 * column and splitter beside the first. Both then render, sharing the row, and
 * the two of them squeeze each other: the two-panels-fighting bug.
 *
 * By id rather than through `states`, because the whole point is that the
 * module no longer knows these nodes exist. querySelectorAll and not
 * getElementById: ids are supposed to be unique, and the bug is precisely that
 * they stopped being.
 */
function sweepColumnNodes(doc: Document): void {
  for (const id of [COLUMN_ID, SPLITTER_ID]) {
    const nodes = Array.from(doc.querySelectorAll(`#${id}`)) as Element[];
    for (const node of nodes) {
      node.remove();
    }
  }
}

/** Lets go of a state whose DOM has gone, so its observer and root do not leak. */
function discardState(state: ColumnState): void {
  if (state.tabObserverID) {
    try {
      Zotero.Notifier.unregisterObserver(state.tabObserverID);
    } catch {
      // Already gone.
    }
    state.tabObserverID = null;
  }
  try {
    state.reactRoot?.unmount();
  } catch {
    // React roots can throw once their container has been taken away.
  }
  state.reactRoot = null;
}

function createColumn(win: Window): ColumnState | null {
  const doc = win.document;
  const row = findDeckRow(doc);
  if (!row) {
    return null;
  }
  sweepColumnNodes(doc);

  const makeXUL = (tag: string) =>
    (doc as Document & { createXULElement?: (t: string) => Element })
      .createXULElement?.(tag) ?? doc.createElement(tag);

  const column = makeXUL("box") as HTMLElement;
  column.id = COLUMN_ID;
  column.setAttribute("orient", "vertical");
  // Inline min-width 0 keeps this column out of Zotero's own width budget:
  // updateLayoutConstraints() sums only Zotero's panes into
  // --width-of-fixed-components, which drives #main-window's min-width. The
  // real floor is applied by the drag handler instead.
  column.style.minWidth = "0";
  // Clamp against the current window: the stored width may come from a wider
  // one, and restoring it verbatim would push the paper off screen.
  column.style.width = `${clampColumnWidth(win, readStoredWidth())}px`;

  // A plain handle rather than Zotero's <splitter>. The XUL splitter derives
  // how far it may travel from the CSS constraints of the boxes on either side,
  // and something in that chain stopped it well short of the window edge.
  // Driving the width directly leaves exactly one limit: the one chosen here.
  const splitter = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLElement;
  splitter.id = SPLITTER_ID;
  splitter.setAttribute("role", "separator");
  splitter.setAttribute("aria-orientation", "vertical");
  attachColumnResize(win, splitter, column);

  const mount = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLElement;
  mount.id = MOUNT_ID;
  mount.className = "ai-assistant-pane-mount";
  column.appendChild(mount);

  row.appendChild(splitter);
  row.appendChild(column);

  return {
    mainWindow: win,
    splitter,
    column,
    mount,
    reactRoot: null,
    bootstrapping: null,
    location: resolveColumnLocation(win),
    tabObserverID: null,
  };
}

// The column outlives every tab, so its location has to follow the selected one.
// Sidebar gates reader actions on `isSidebarLocationSelected(selectedType,
// location)`, so a column frozen at "library" would silently drop every
// Explain/Ask sent from a PDF and show the wrong scope.
function resolveColumnLocation(win: Window): SidebarLocation {
  const tabs = (win as Window & { Zotero_Tabs?: { selectedType?: string } })
    .Zotero_Tabs;
  return resolveSidebarLocation(`${tabs?.selectedType || ""}`) || "library";
}

function renderColumn(state: ColumnState): void {
  if (!state.reactRoot) {
    return;
  }
  state.reactRoot.render(
    React.createElement(Sidebar, {
      eventBus: EventBus.getInstance(),
      hostWindow: state.mainWindow,
      location: state.location,
      onClose: () => closeWebAIColumn(state.mainWindow),
    }),
  );
}

// React keeps the same element type in the same position, so re-rendering with a
// new location updates props rather than remounting -- the embedded <browser>
// and whatever is signed in inside it survive the tab switch. That is the whole
// reason this column exists instead of a panel inside the reader tab.
function watchTabSelection(state: ColumnState): void {
  if (state.tabObserverID) {
    return;
  }
  state.tabObserverID = Zotero.Notifier.registerObserver(
    {
      notify: (event: string, type: string) => {
        if (event !== "select" || type !== "tab" || state.mainWindow.closed) {
          return;
        }
        const next = resolveColumnLocation(state.mainWindow);
        if (next === state.location) {
          return;
        }
        state.location = next;
        renderColumn(state);
      },
    },
    ["tab"],
    "zotero-webai-column",
  ) as unknown as string;
}

function getReactDomClient(win: Window) {
  if (!reactDomClientPromise) {
    bindReactDomGlobals(win);
    reactDomClientPromise = import("react-dom/client");
  }
  return reactDomClientPromise;
}

async function bootstrap(state: ColumnState): Promise<void> {
  if (state.reactRoot) {
    return;
  }
  if (state.bootstrapping) {
    return state.bootstrapping;
  }
  state.bootstrapping = (async () => {
    const { createRoot } = await getReactDomClient(state.mainWindow);
    state.reactRoot = createRoot(state.mount);
    state.location = resolveColumnLocation(state.mainWindow);
    renderColumn(state);
    watchTabSelection(state);
  })()
    .catch((error) => {
      state.reactRoot?.unmount();
      state.reactRoot = null;
      throw error;
    })
    .finally(() => {
      state.bootstrapping = null;
    });
  return state.bootstrapping;
}

export function isWebAIColumnOpen(win: Window): boolean {
  const state = states.get(win);
  return Boolean(state && !state.column.hidden);
}

export async function openWebAIColumn(win: Window): Promise<boolean> {
  let state = states.get(win);
  if (!state || !state.column.isConnected) {
    // A state whose column has left the DOM still holds a tab observer and a
    // React root. Replacing it without saying so leaks both.
    if (state) {
      discardState(state);
      states.delete(win);
    }
    const created = createColumn(win);
    if (!created) {
      return false;
    }
    state = created;
    states.set(win, state);
  }
  state.column.hidden = false;
  (state.splitter as HTMLElement).hidden = false;
  // Marks the window so the stylesheet can relax Zotero's #tabs-deck floor
  // only while this column is sharing the row.
  win.document.documentElement?.setAttribute("zotero-webai-column", "open");
  notifyColumnChange(win);
  await bootstrap(state);
  return true;
}

export function closeWebAIColumn(win: Window): void {
  const state = states.get(win);
  if (!state) {
    return;
  }
  rememberWidth(state);
  state.column.hidden = true;
  (state.splitter as HTMLElement).hidden = true;
  win.document.documentElement?.removeAttribute("zotero-webai-column");
  notifyColumnChange(win);
}

export async function toggleWebAIColumn(win: Window): Promise<void> {
  if (isWebAIColumnOpen(win)) {
    closeWebAIColumn(win);
    return;
  }
  await openWebAIColumn(win);
}

function rememberWidth(state: ColumnState): void {
  const width = Math.round(state.column.getBoundingClientRect().width);
  if (width >= MIN_WIDTH) {
    setPref(WIDTH_PREF, width);
  }
}

const MENU_ITEM_ID = "zotero-webai-column-menuitem";

// Entry point lives in the View menu rather than the tab bar: the tab-bar button
// only renders while a reader is open, and this column is meant to be reachable
// from the library too.
export function registerWebAIColumnMenu(win: Window): void {
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
  item.setAttribute("label", "Paperly AI Panel");
  item.addEventListener("command", () => {
    void toggleWebAIColumn(win);
  });
  popup.addEventListener("popupshowing", () => {
    item.setAttribute("checked", isWebAIColumnOpen(win) ? "true" : "false");
  });
  popup.appendChild(item);
}

export function removeWebAIColumn(win: Window): void {
  win.document.getElementById(MENU_ITEM_ID)?.remove();
  const state = states.get(win);
  if (!state) {
    // No state does not mean no column: after a plugin reload the map is empty
    // and the previous load's nodes are still in the window. Returning here is
    // what left them behind for the next open to duplicate.
    sweepColumnNodes(win.document);
    win.document.documentElement?.removeAttribute("zotero-webai-column");
    return;
  }
  try {
    rememberWidth(state);
  } catch {
    // Width is a convenience; never block teardown on it.
  }
  if (state.tabObserverID) {
    try {
      Zotero.Notifier.unregisterObserver(state.tabObserverID);
    } catch {
      // Already gone during shutdown.
    }
    state.tabObserverID = null;
  }
  try {
    state.reactRoot?.unmount();
  } catch {
    // React roots can throw if the document is already going away.
  }
  win.document.documentElement?.removeAttribute("zotero-webai-column");
  state.splitter.remove();
  state.column.remove();
  states.delete(win);
}
