# Reading status

Three states -- **unread**, **reading**, **read** -- on every regular item, shown
as a tick in the item list, a picker in the item pane and a submenu on
right-click.

| Question | File |
| --- | --- |
| *Where is it stored?* | `src/services/readingStatusStore.ts` |
| *Where is it drawn?* | `src/modules/readingStatus.ts` |
| *Does it still work?* | `TESTING.md`, "Reading status" |
| *And the star?* | `STARRED.md` -- a tag, for the opposite reasons |

---

## Why a table of our own, and what it costs

The status lives in `paperlyReadingStatus`, a table this plugin creates inside
Zotero's own SQLite at startup and owns entirely.

Zotero will not touch it. Its integrity check reads `sqlite_master` but only
drops names from an explicit allowlist of three tables it used to ship --
`transactionSets`, `transactions`, `transactionLog` (schema.js ~2090). It never
enumerates unknown tables. So **nothing here needs a change to the client's own
`userdata.sql`**, which is what keeps the fork mergeable with upstream Zotero.

What the table buys, over the obvious alternative of a tag:

- three states, where a tag can only express presence and absence
- nothing appears in the tag selector

What it costs, and these are real:

- **It does not sync.** The status is local to this machine's database. Read a
  paper on the laptop and the desktop will not know.
- **Saved searches cannot see it.** `searchConditions.js` builds its conditions
  into a private object with no registration hook, so no plugin can add one.
  This is why the star is a *coloured tag* and not a second column in this
  table: the starred folder is a saved search, and a saved search can only see
  Zotero's own data.
- **The web port cannot read it.** `paperly-web` gets nothing for free here; it
  would need its own storage. Not done -- see `PORTING.md`.

`unread` is never written. Absence of a row *is* unread, so clearing a status is
a `DELETE` and the table only ever holds papers the user has actually touched.

## The cache is a requirement, not an optimisation

`ItemTree` calls a column's `dataProvider` **synchronously** while it builds a
row (`itemTree.jsx`, `_getRowData`), and every `Zotero.DB` read is async. So the
whole table is loaded into a `Map` at startup and the database is only ever
written to afterwards, never read from.

Which means a write is: update the cache, redraw the row, *then* write to disk.
If the write fails the cache is rolled back and the row redrawn again -- a tick
that says "read" over a database that says otherwise is worse than a click that
did not take.

## Redraw with `refresh`, never `modify`

```js
Zotero.Notifier.trigger("refresh", "item", itemIDs)
```

`ItemTree` answers `refresh` by clearing exactly those rows from its display
cache and redrawing them (`itemTree.jsx`, `action == 'refresh'` ->
`invalidateRowCache`). `modify` would instead mean *the item changed*, which
bumps `dateModified` and hands the sync engine an edit that never happened.

## Deleting a paper has to delete its row

Our table is outside Zotero's schema, so no foreign key cleans up after it. A
notifier on `delete`/`item` does it instead. Without that, rows accumulate for
ever, and an `itemID` that Zotero later reuses would inherit a stale tick.

## Three things about the column that cost a build each to find

All three were found by probing the running application, because none of them
fail loudly.

### 1. `width` is a string

`ItemTreeColumnManager` validates it as a string and **rejects a number
outright** -- the column simply never registers. The JSDoc says
`@param {string} [option.width]` and means it.

    width: "38",    // not 38

### 2. Without `defaultIn` the column registers and is then hidden

`ItemTree` computes `hasDefaultIn = columns.some(column => 'defaultIn' in
column)` across **all** columns (`itemTree.jsx` ~2591). Zotero's own columns all
carry `defaultIn`, so that is always true, and a custom column without one falls
straight to `hidden = true`. The feature ships invisible and the user never
knows it is there.

`defaultIn` is documented as "will be deprecated", and is still the only lever
for initial visibility, and is still honoured. The values are `collectionTreeRow`
types: `["library", "collection", "search"]` -- where papers live, and not feeds
(they have their own unread) or the trash.

### 4. A column in front of Title takes Title's furniture with it

Both Paperly columns sit before Title, which needed a change in `zotero-client`
(`b86c3f988`) before it was safe.

Four things hung off whichever visible column had the lowest ordinal: the item
type icon, the `.cell-text` wrapper, the expand arrow and the depth indent. That
is the same column as Title only while Title is leftmost. Put anything in front
of it and the document icon and the twisty land in a 38px checkbox cell while
Title loses all four -- items can no longer be expanded.

It is a latent bug rather than one these columns created: dragging any existing
column in front of Title does the same today. Both halves now follow the
**primary** column instead -- `ItemTree._renderItem` picks `firstColumn` by
`primary`, and `VirtualizedTable._addIndentAndTwisty` targets
`.cell.first-column`, each keeping the old rule as a fallback.

The ordinals themselves are negative (`-20`, `-19`). Ordinals are sorted and
then renormalised to 0..n, so the value only has to be lower than Title's --
which is 0 once the user has touched any column, since that is what
`treePrefs.json` holds. Negative keeps them lower without needing to know how
many columns Zotero ships.

### 3. The click has to be `click`, and the class has to be `clickable`

These are two separate halves and mixing them up gives a cell that either
selects the row or does nothing.

`cell clickable` is what stops the row being selected: `VirtualizedTable` has a
**capture-phase** listener on the row for `mousedown` and `mouseup` that calls
`stopPropagation()` for anything inside a `.cell.clickable`
(`virtualized-table.jsx`, `_captureMouseUpDown`).

Because that `stopPropagation()` happens in the capture phase on an *ancestor*,
`mousedown` and `mouseup` **never reach the cell at all** -- a `mouseup`
listener here is simply never called. The first version used one and the tick
did nothing while the row correctly stayed unselected, which is a confusing way
to fail.

`click` is a separate event that the capture listener does not touch, so it
arrives normally. This is exactly how Zotero builds its own button cells
(`virtualized-table.jsx`, `renderButtonCell`: the cell gets `clickable`, the
handler listens for `click`).

## Only papers carry a mark

`dataProvider` returns `""` for anything that is not a regular item, and
`renderCell` has to read that as *nothing to show* rather than as a state.

The first version wrote `data || "unread"`, so expanding a paper gave every
child -- its notes, its PDF, its snapshot -- a tickbox of its own. A tick there
would have meant nothing: there is no reading status to record against an
attachment. Both columns now return a bare `<span class="cell">` when the data
is empty, which holds the column's alignment without inviting a click.

## The headers are words, not glyphs

A tick and a star say what the column looks like, not what it is. `label` is
`"Reading status"` and `"Starred"`, which sets the widths: 152 and 76.

`staticWidth` keeps them from growing with the window. `fixedWidth` is
deliberately *absent* -- with a text header it is reasonable to want the space
back, so the columns stay draggable.

## A click never sets `reading`

Straight to read and straight back. Cycling three states under one click means
the user has to look at what they got each time. The middle state is
deliberate, so it is set deliberately -- from the item pane or the context menu.

## Traps

**`dataProvider` and `renderCell` run inside ItemTree's render path**, once per
visible row. An exception from either does not break a cell, it breaks the item
list. Both are wrapped, and must stay wrapped.

**The store refuses to put the UI up if it did not load.** A column reading from
an empty cache would show every paper as unread and invite ticks into a store
that cannot keep them. `registerReadingStatus()` returns early;
`hooks.ts` only calls it when `initReadingStatusStore()` resolved true.

**Do not report "registered" as one line.** The three managers each validate
their own options and refuse a bad one on their own, so a single optimistic log
line hid a column that had been rejected for the `width` bug above. Each surface
reports its own result.

**`uncaught exception: undefined` after `itemTree.render()` is not ours.**
Measured: with `registerReadingStatus()` disabled it still appears exactly once
per launch. Do not go looking for it in this code.
