// Reading status, where the user meets it: a tick in the item list, a picker in
// the item pane, and a submenu on right-click.
//
// All three are registered once for the whole application, not per window --
// ItemTreeManager, ItemPaneManager and MenuManager each keep their own registry
// and hand the registration to every window that opens. So this is set up in
// onStartup and torn down in onShutdown, and knows nothing about windows.
//
// The one thing to be careful of here: `dataProvider` and `renderCell` run
// inside ItemTree's own render path, once per visible row. An exception thrown
// from either does not break a cell, it breaks the item list. Both are wrapped.
import { config } from "../../package.json";
import {
  getReadingStatus,
  isReadingStatusReady,
  setReadingStatusMany,
  type ReadingStatus,
} from "../services/readingStatusStore";

const COLUMN_KEY = "paperlyReadingStatus";
const PANE_ID = "paperly-reading-status";
const MENU_ID = "paperly-reading-status-menu";

let columnKey: string | false = false;
let paneID: string | false = false;
let menuRegistered = false;

/** Sort order: what the user wants at the top of the list is what is unread. */
const SORT_ORDER: Record<ReadingStatus, number> = {
  unread: 0,
  reading: 1,
  read: 2,
};

const LABELS: Record<ReadingStatus, string> = {
  unread: "Unread",
  reading: "Reading",
  read: "Read",
};

/**
 * What a click on the tick does.
 *
 * Straight to read and straight back, never stopping at `reading` -- cycling
 * three states under one click means the user has to look at what they got. The
 * middle state is deliberate, so it is set deliberately, from the item pane or
 * the context menu.
 */
function toggled(status: ReadingStatus): ReadingStatus {
  return status === "read" ? "unread" : "read";
}

// ------------------------------------------------------------------ column --

/**
 * The tick itself.
 *
 * Two halves, and they must not be mixed up:
 *
 * `cell clickable` is what stops the row being selected. VirtualizedTable has a
 * capture-phase listener on the row for mousedown and mouseup that calls
 * stopPropagation for anything inside a `.cell.clickable`
 * (virtualized-table.jsx `_captureMouseUpDown`).
 *
 * The action then has to hang off `click`, because capture-phase
 * stopPropagation on the row stops mousedown and mouseup before they ever
 * reach this cell -- a mouseup listener here is simply never called. `click` is
 * a separate event that the capture listener does not touch, so it arrives
 * normally. This is exactly how Zotero builds its own button cells
 * (virtualized-table.jsx `renderButtonCell`).
 */
function renderCell(
  index: number,
  data: string,
  column: { className?: string },
  isFirstColumn: boolean,
  doc: Document,
): HTMLElement {
  const cell = doc.createElement("span");
  try {
    // An attachment, a note or a snapshot is not a paper, and `dataProvider`
    // says so by returning "". Leave the cell empty rather than falling through
    // to "unread": every child row of an expanded item would otherwise grow a
    // tickbox of its own, and ticking one would mean nothing.
    if (!data) {
      cell.className = `cell ${column.className ?? ""}`;
      return cell;
    }
    const status = data as ReadingStatus;
    cell.className = `cell clickable ${column.className ?? ""}`;
    cell.classList.add("paperly-read-cell");
    cell.dataset.paperlyStatus = status;
    cell.setAttribute("role", "checkbox");
    cell.setAttribute(
      "aria-checked",
      status === "read" ? "true" : status === "reading" ? "mixed" : "false",
    );
    cell.setAttribute("aria-label", LABELS[status] ?? LABELS.unread);
    cell.title = LABELS[status] ?? LABELS.unread;

    const box = doc.createElement("span");
    box.className = "paperly-read-box";
    cell.appendChild(box);

    cell.addEventListener("click", (event: Event) => {
      event.stopPropagation();
      const itemID = itemIDForRow(doc, index);
      if (itemID === null) {
        return;
      }
      void setReadingStatusMany([itemID], toggled(getReadingStatus(itemID)));
    });
  } catch (error) {
    ztoolkit.log("Reading status cell render failed:", error);
  }
  return cell;
}

/**
 * The item behind a rendered row.
 *
 * renderCell is handed a row index and a document but not the item, so the tree
 * has to be asked. Going through the window's ZoteroPane rather than holding a
 * reference to the tree keeps this correct when there is more than one window.
 */
function itemIDForRow(doc: Document, index: number): number | null {
  try {
    const pane = (doc.defaultView as (Window & { ZoteroPane?: any }) | null)
      ?.ZoteroPane;
    const row = pane?.itemsView?.getRow?.(index);
    const id = row?.ref?.id;
    return typeof id === "number" ? id : null;
  } catch (error) {
    ztoolkit.log("Reading status row lookup failed:", error);
    return null;
  }
}

function registerColumn(): void {
  try {
    columnKey = Zotero.ItemTreeManager.registerColumn({
      dataKey: COLUMN_KEY,
      label: "Reading status",
      pluginID: config.addonID,
      enabledTreeIDs: ["main"],
      // Without this the column registers and is then hidden, so the feature
      // ships invisible. ItemTree computes `hasDefaultIn` across *all* columns
      // (itemTree.jsx ~2591) and Zotero's own columns all carry `defaultIn`, so
      // any custom column lacking it falls to `hidden = true`. Deprecated in
      // the docs, still the only lever for initial visibility, still honoured.
      // The values are collectionTreeRow types: where papers live, and not
      // feeds (they have their own unread) or the trash.
      // Before Title. Ordinals are sorted and then renormalised to 0..n
      // (virtualized-table), so the value only has to be lower than Title's --
      // which is 0 once the user has ever touched a column, because that is
      // what gets written to treePrefs.json. Negative keeps it lower without
      // having to know how many columns Zotero ships.
      //
      // This is only safe because ItemTree now hangs the item icon, the text
      // wrapper, the expand arrow and the depth indent off the *primary*
      // column rather than the leftmost one. Before that change a column in
      // front of Title collected all four and Title lost them.
      ordinal: -20,
      defaultIn: ["library", "collection", "search"],
      // Wide enough for the header text. staticWidth keeps it from growing with
      // the window; fixedWidth is deliberately absent, so it can still be
      // dragged narrower by anyone who would rather have the room.
      width: "152",
      staticWidth: true,
      noPadding: true,
      dataProvider: (item: Zotero.Item) => {
        try {
          // Attachments and notes are not papers; leaving them blank keeps the
          // column from inviting a tick on a row that cannot mean one.
          if (!item?.isRegularItem?.()) {
            return "";
          }
          return getReadingStatus(item.id);
        } catch (error) {
          ztoolkit.log("Reading status dataProvider failed:", error);
          return "";
        }
      },
      renderCell,
      zoteroPersist: ["width", "hidden", "sortDirection"],
    } as any);
  } catch (error) {
    ztoolkit.log("Reading status column registration failed:", error);
    columnKey = false;
  }
}

// -------------------------------------------------------------- item pane --

function buildPicker(
  doc: Document,
  body: HTMLElement,
  item: Zotero.Item | null,
): void {
  body.textContent = "";
  if (!item?.isRegularItem?.()) {
    return;
  }
  const current = getReadingStatus(item.id);
  const group = doc.createElement("div");
  group.className = "paperly-read-picker";

  for (const status of ["unread", "reading", "read"] as ReadingStatus[]) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "paperly-read-choice";
    button.dataset.paperlyStatus = status;
    button.textContent = LABELS[status];
    button.setAttribute("aria-pressed", String(status === current));
    button.addEventListener("click", () => {
      void setReadingStatusMany([item.id], status).then(() => {
        buildPicker(doc, body, item);
      });
    });
    group.appendChild(button);
  }
  body.appendChild(group);
}

function registerSection(): void {
  try {
    paneID = Zotero.ItemPaneManager.registerSection({
      paneID: PANE_ID,
      pluginID: config.addonID,
      header: {
        l10nID: "paperly-reading-status-header",
        icon: `chrome://${config.addonRef}/content/icons/icon-20.png`,
      },
      sidenav: {
        l10nID: "paperly-reading-status-sidenav",
        icon: `chrome://${config.addonRef}/content/icons/icon-20.png`,
      },
      onItemChange: ({ item, setEnabled }: any) => {
        setEnabled(Boolean(item?.isRegularItem?.()));
      },
      onRender: ({ doc, body, item }: any) => {
        try {
          buildPicker(doc, body, item);
        } catch (error) {
          ztoolkit.log("Reading status section render failed:", error);
        }
      },
    } as any);
  } catch (error) {
    ztoolkit.log("Reading status section registration failed:", error);
    paneID = false;
  }
}

// ------------------------------------------------------------ context menu --

function selectedRegularItemIDs(): number[] {
  try {
    const win = Zotero.getMainWindow() as (Window & { ZoteroPane?: any }) | null;
    const items = win?.ZoteroPane?.getSelectedItems?.() ?? [];
    return items
      .filter((item: Zotero.Item) => item?.isRegularItem?.())
      .map((item: Zotero.Item) => item.id);
  } catch (error) {
    ztoolkit.log("Reading status selection lookup failed:", error);
    return [];
  }
}

function registerMenu(): void {
  try {
    Zotero.MenuManager.registerMenu({
      menuID: MENU_ID,
      pluginID: config.addonID,
      target: "main/library/item",
      menus: [
        {
          menuType: "submenu",
          l10nID: "paperly-reading-status-menu",
          menus: (["unread", "reading", "read"] as ReadingStatus[]).map(
            (status) => ({
              menuType: "menuitem",
              l10nID: `paperly-reading-status-${status}`,
              onCommand: () => {
                const ids = selectedRegularItemIDs();
                if (ids.length) {
                  void setReadingStatusMany(ids, status);
                }
              },
            }),
          ),
        },
      ],
    } as any);
    menuRegistered = true;
  } catch (error) {
    ztoolkit.log("Reading status menu registration failed:", error);
    menuRegistered = false;
  }
}

// ----------------------------------------------------------------- install --

/**
 * Puts the three surfaces up.
 *
 * Refuses to register anything if the store did not load. A column reading from
 * an empty cache would show every paper as unread and invite ticks that cannot
 * be kept.
 */
export function registerReadingStatus(): void {
  if (!isReadingStatusReady()) {
    ztoolkit.log("Reading status UI skipped: store not ready");
    return;
  }
  registerColumn();
  registerSection();
  registerMenu();
  // Reported individually: the managers validate their options and refuse a
  // bad one on their own, so "registered" as a single line once hid a column
  // that had been rejected for passing a number where a string was wanted.
  ztoolkit.log(
    `Reading status surfaces: column=${columnKey ? "ok" : "FAILED"}` +
      ` section=${paneID ? "ok" : "FAILED"}` +
      ` menu=${menuRegistered ? "ok" : "FAILED"}`,
  );
}

export function unregisterReadingStatus(): void {
  if (columnKey) {
    try {
      Zotero.ItemTreeManager.unregisterColumn(columnKey);
    } catch {
      // Shutdown may already have torn the registry down.
    }
    columnKey = false;
  }
  if (paneID) {
    try {
      Zotero.ItemPaneManager.unregisterSection(paneID);
    } catch {
      // As above.
    }
    paneID = false;
  }
  if (menuRegistered) {
    try {
      Zotero.MenuManager.unregisterMenu(MENU_ID);
    } catch {
      // As above.
    }
    menuRegistered = false;
  }
}
