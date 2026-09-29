// The star, and the folder it fills.
//
// Unlike reading status, this is not stored in a table of our own: the star is
// the tag `★` on the item. That is the whole reason the two halves of the
// feature are built differently, and it buys the two things a private table
// cannot give (see docs/READING-STATUS.md for the other side of the trade):
//
//   - it syncs, through Zotero's own tag sync, to every machine and to the web
//   - a saved search can see it, which is what makes the starred folder a real,
//     self-updating folder rather than something this plugin has to maintain
//
// `★` is U+2605, which falls inside the `☀-➿` range that
// Utilities.Internal.containsEmoji tests for, so Zotero also draws it beside the
// title on its own (itemTreeRow.js -> getItemsListTags). That is deliberate and
// not worth fighting: it means a starred paper still reads as starred when this
// column is hidden, in search results, and in the item pane's tag list.
//
// The three silent ways an item-tree column can fail -- `width` as a number,
// a missing `defaultIn`, and listening for `mouseup` instead of `click` -- are
// all written up in docs/READING-STATUS.md. Each of them costs a build to find,
// so read that before changing the registration below.
import { config } from "../../package.json";

/** The tag itself. User-visible, syncs, and searchable -- so it is a real word. */
const STAR_TAG = "★";
const COLUMN_KEY = "paperlyStarred";
/**
 * Saved-search name. Stored data rather than UI, so it is not localisable and
 * the user is free to rename it; `ensureStarredSearch` matches on this name, so
 * renaming it simply means a second one is never offered.
 */
const SEARCH_NAME = "Starred Papers";

let columnKey: string | false = false;

/**
 * Whether a paper is starred.
 *
 * `hasTag` calls `_requireData('tags')`, which throws if the item's tags were
 * never loaded. Rows the tree is drawing have them -- it loads tags itself to
 * draw the coloured-tag swatches -- but a throw here would take the item list
 * down with it, so it is caught and read as "not starred".
 */
function isStarred(item: Zotero.Item): boolean {
  try {
    return Boolean(item?.hasTag?.(STAR_TAG));
  } catch {
    return false;
  }
}

/**
 * Adds or removes the tag, and saves.
 *
 * No redraw is asked for. Saving the item fires a `modify` notification, and
 * ItemTree already answers that by re-reading and re-sorting the row -- which
 * is the difference from reading status, where nothing about the *item* changes
 * and a `refresh` has to be raised by hand.
 */
async function toggleStar(item: Zotero.Item): Promise<void> {
  try {
    const starring = !isStarred(item);
    if (starring) {
      item.addTag(STAR_TAG);
    } else {
      item.removeTag(STAR_TAG);
    }
    await item.saveTx();
    if (starring) {
      await ensureStarredSearch(item.libraryID);
    }
  } catch (error) {
    ztoolkit.log("Star toggle failed:", error);
  }
}

/**
 * Makes the starred folder, once, the first time a paper is starred.
 *
 * Not at startup: a saved search that appears in the collection tree before the
 * user has starred anything is a folder they did not ask for. Created on the
 * first star, in the library that star was in, it arrives exactly when it first
 * has something to hold.
 */
async function ensureStarredSearch(libraryID: number): Promise<void> {
  try {
    // Both casts are the bundled zotero-types being behind the client, not a
    // guess: Searches.getByLibrary is searches.js:53, and Search redefines
    // libraryID *with a setter* at search.js:68-71 -- the base DataObject has
    // only a getter, which is what the typings describe. Zotero's own
    // zoteroPane.js:2078 assigns it the same way.
    const searches = (
      Zotero.Searches as unknown as {
        getByLibrary: (id: number) => Array<{ name?: string }>;
      }
    ).getByLibrary(libraryID);
    if ((searches ?? []).some((search) => search?.name === SEARCH_NAME)) {
      return;
    }
    const search = new Zotero.Search() as Zotero.Search & {
      libraryID: number;
      name: string;
    };
    search.libraryID = libraryID;
    search.name = SEARCH_NAME;
    search.addCondition("tag", "is", STAR_TAG);
    await search.saveTx();
    ztoolkit.log(`Starred folder created in library ${libraryID}`);
  } catch (error) {
    ztoolkit.log("Starred folder creation failed:", error);
  }
}

/** The item behind a rendered row; see readingStatus.ts for why it goes via ZoteroPane. */
function itemForRow(doc: Document, index: number): Zotero.Item | null {
  try {
    const pane = (doc.defaultView as (Window & { ZoteroPane?: any }) | null)
      ?.ZoteroPane;
    return pane?.itemsView?.getRow?.(index)?.ref ?? null;
  } catch (error) {
    ztoolkit.log("Star row lookup failed:", error);
    return null;
  }
}

function renderCell(
  index: number,
  data: string,
  column: { className?: string },
  isFirstColumn: boolean,
  doc: Document,
): HTMLElement {
  const cell = doc.createElement("span");
  try {
    // Empty for anything that is not a paper; see readingStatus.ts.
    if (!data) {
      cell.className = `cell ${column.className ?? ""}`;
      return cell;
    }
    const starred = data === "1";
    // `clickable` suppresses the row selection; the handler below must be
    // `click`, because the capture-phase listener that does the suppressing
    // eats mousedown and mouseup before they reach this element.
    cell.className = `cell clickable ${column.className ?? ""}`;
    cell.classList.add("paperly-star-cell");
    cell.dataset.paperlyStarred = starred ? "1" : "0";
    cell.setAttribute("role", "checkbox");
    cell.setAttribute("aria-checked", String(starred));
    cell.setAttribute("aria-label", starred ? "Starred" : "Not starred");
    cell.title = starred ? "Starred" : "Star this paper";

    const glyph = doc.createElement("span");
    glyph.className = "paperly-star-glyph";
    // Two glyphs rather than one glyph and a fill, because an outlined star
    // drawn by colouring a solid one needs a stroke the font cannot give.
    glyph.textContent = starred ? "★" : "☆";
    cell.appendChild(glyph);

    cell.addEventListener("click", (event: Event) => {
      event.stopPropagation();
      const item = itemForRow(doc, index);
      if (item) {
        void toggleStar(item);
      }
    });
  } catch (error) {
    ztoolkit.log("Star cell render failed:", error);
  }
  return cell;
}

export function registerStarredPapers(): void {
  try {
    columnKey = Zotero.ItemTreeManager.registerColumn({
      dataKey: COLUMN_KEY,
      label: "Starred",
      pluginID: config.addonID,
      enabledTreeIDs: ["main"],
      // Without this the column registers and is then hidden; see
      // docs/READING-STATUS.md. Values are collectionTreeRow types.
      // Between the tick and Title; see readingStatus.ts for why negative.
      ordinal: -19,
      defaultIn: ["library", "collection", "search"],
      // A string. A number is rejected and the column never registers.
      width: "76",
      staticWidth: true,
      noPadding: true,
      dataProvider: (item: Zotero.Item) => {
        try {
          if (!item?.isRegularItem?.()) {
            return "";
          }
          // "1"/"0" and not a boolean: the value is also what the tree sorts
          // on, and what renderCell is handed back as `data`.
          return isStarred(item) ? "1" : "0";
        } catch (error) {
          ztoolkit.log("Star dataProvider failed:", error);
          return "";
        }
      },
      renderCell,
      // Starred first, because the point of sorting by it is to gather them.
      sortReverse: true,
      zoteroPersist: ["width", "hidden", "sortDirection"],
    } as any);
  } catch (error) {
    ztoolkit.log("Star column registration failed:", error);
    columnKey = false;
  }
  ztoolkit.log(`Starred papers: column=${columnKey ? "ok" : "FAILED"}`);
}

export function unregisterStarredPapers(): void {
  if (columnKey) {
    try {
      Zotero.ItemTreeManager.unregisterColumn(columnKey);
    } catch {
      // Shutdown may already have torn the registry down.
    }
    columnKey = false;
  }
}
