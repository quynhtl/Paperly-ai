// Where a paper's reading status lives.
//
// A table of our own inside Zotero's SQLite, created at startup and owned
// entirely by this plugin. Zotero will not touch it: its integrity check drops
// tables from an explicit allowlist of three names it used to ship
// (transactionSets, transactions, transactionLog) and never enumerates unknown
// ones, so nothing here needs a change to the client's own schema -- which is
// what keeps the fork mergeable with upstream.
//
// What that buys, and what it costs:
//   + three states rather than the two a tag can express
//   + nothing appears in the tag selector
//   - it does NOT sync. The status is local to this machine's database.
//   - saved searches cannot see it, because search conditions are hardcoded in
//     searchConditions.js with no way to register more. The star is a coloured
//     tag for exactly that reason; see docs/READING-STATUS.md.
//
// `unread` is never stored. Absence of a row IS unread, so clearing a status is
// a DELETE and the table only ever holds papers the user has actually touched.

export type ReadingStatus = "unread" | "reading" | "read";

export const READING_STATUSES: readonly ReadingStatus[] = [
  "unread",
  "reading",
  "read",
];

const TABLE = "paperlyReadingStatus";

/**
 * The cache is not an optimisation, it is a requirement.
 *
 * ItemTree calls a column's `dataProvider` synchronously while it builds a row
 * (itemTree.jsx `_getRowData`), and every Zotero.DB read is async. So the whole
 * table is held in memory -- one small row per touched paper -- and the
 * database is only ever written to, never read from, after startup.
 */
const cache = new Map<number, ReadingStatus>();
let ready = false;
let notifierID: string | null = null;

function isStatus(value: unknown): value is ReadingStatus {
  return (
    value === "unread" || value === "reading" || value === "read"
  );
}

/**
 * Reads one paper's status. Synchronous, and safe to call before the store has
 * finished loading -- it answers `unread`, which is what an unknown paper is.
 */
export function getReadingStatus(itemID: number): ReadingStatus {
  if (!ready) {
    return "unread";
  }
  return cache.get(itemID) ?? "unread";
}

export function isReadingStatusReady(): boolean {
  return ready;
}

/**
 * Writes one paper's status.
 *
 * The cache is updated first and the row redrawn from it, so the tick responds
 * to the click immediately; the database write trails behind. A failed write is
 * logged and the cache rolled back, because a tick that says "read" over a
 * database that says otherwise is worse than a click that did not take.
 */
export async function setReadingStatus(
  itemID: number,
  status: ReadingStatus,
): Promise<void> {
  await setReadingStatusMany([itemID], status);
}

export async function setReadingStatusMany(
  itemIDs: number[],
  status: ReadingStatus,
): Promise<void> {
  if (!ready || itemIDs.length === 0) {
    return;
  }
  const previous = new Map<number, ReadingStatus | undefined>();
  for (const itemID of itemIDs) {
    previous.set(itemID, cache.get(itemID));
    if (status === "unread") {
      cache.delete(itemID);
    } else {
      cache.set(itemID, status);
    }
  }
  refreshRows(itemIDs);

  try {
    const now = new Date().toISOString();
    await Zotero.DB.executeTransaction(async () => {
      for (const itemID of itemIDs) {
        if (status === "unread") {
          await Zotero.DB.queryAsync(
            `DELETE FROM ${TABLE} WHERE itemID=?`,
            [itemID],
          );
        } else {
          await Zotero.DB.queryAsync(
            `REPLACE INTO ${TABLE} (itemID, status, updatedAt) VALUES (?,?,?)`,
            [itemID, status, now],
          );
        }
      }
    });
  } catch (error) {
    for (const [itemID, was] of previous) {
      if (was === undefined) {
        cache.delete(itemID);
      } else {
        cache.set(itemID, was);
      }
    }
    refreshRows(itemIDs);
    ztoolkit.log("Reading status write failed:", error);
  }
}

/**
 * Asks every item tree to re-read these rows.
 *
 * `refresh` and not `modify`: ItemTree answers it by clearing just those rows
 * from its display cache and redrawing them (itemTree.jsx, `action == 'refresh'`
 * -> `invalidateRowCache`). `modify` would mean the *item* changed, which would
 * bump dateModified and hand the sync engine an edit that never happened.
 */
function refreshRows(itemIDs: number[]): void {
  try {
    void Zotero.Notifier.trigger("refresh", "item", itemIDs);
  } catch (error) {
    ztoolkit.log("Reading status refresh failed:", error);
  }
}

/**
 * Builds the table if it is not there, loads it, and starts watching for
 * deletions.
 *
 * Returns false if any of that failed. The caller must then leave the column
 * unregistered: a column whose data never loads would show every paper as
 * unread and invite the user to tick papers into a store that cannot keep them.
 */
export async function initReadingStatusStore(): Promise<boolean> {
  try {
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
        itemID INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )`,
    );
    const rows = (await Zotero.DB.queryAsync(
      `SELECT itemID, status FROM ${TABLE}`,
    )) as Array<{ itemID: number; status: string }> | false;

    cache.clear();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (isStatus(row.status) && row.status !== "unread") {
          cache.set(Number(row.itemID), row.status);
        }
      }
    }
    ready = true;
    registerCleanupNotifier();
    ztoolkit.log(`Reading status store ready (${cache.size} marked)`);
    return true;
  } catch (error) {
    ready = false;
    ztoolkit.log("Reading status store init failed:", error);
    return false;
  }
}

/**
 * Drops rows for papers that no longer exist.
 *
 * Our table is outside Zotero's schema, so no foreign key cleans up after it.
 * Without this, deleting a library's worth of papers leaves their rows behind
 * for good, and an itemID Zotero later reuses would inherit a stale tick.
 */
function registerCleanupNotifier(): void {
  if (notifierID) {
    return;
  }
  try {
    notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event: string, type: string, ids: Array<string | number>) => {
          if (event !== "delete" || type !== "item") {
            return;
          }
          const gone = ids
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && cache.has(id));
          if (!gone.length) {
            return;
          }
          for (const id of gone) {
            cache.delete(id);
          }
          void Zotero.DB.queryAsync(
            `DELETE FROM ${TABLE} WHERE itemID IN (${gone
              .map(() => "?")
              .join(",")})`,
            gone,
          ).catch((error: unknown) => {
            ztoolkit.log("Reading status cleanup failed:", error);
          });
        },
      },
      ["item"],
      "paperly-reading-status",
    );
  } catch (error) {
    ztoolkit.log("Reading status notifier failed:", error);
  }
}

export function shutdownReadingStatusStore(): void {
  if (notifierID) {
    try {
      Zotero.Notifier.unregisterObserver(notifierID);
    } catch {
      // Shutdown may already have taken the notifier with it.
    }
    notifierID = null;
  }
  cache.clear();
  ready = false;
}
