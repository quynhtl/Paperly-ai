# The star, and the folder it fills

A star column in the item list, and a self-updating **Starred Papers** folder
that appears the first time anything is starred.

| Question | File |
| --- | --- |
| *Where is it drawn and stored?* | `src/modules/starredPapers.ts` |
| *Why is reading status built differently?* | `READING-STATUS.md` |
| *Does it still work?* | `TESTING.md`, "Starred papers" |

---

## The star is a tag, and that is the whole design

The star is the tag `★` on the item. Nothing else is stored anywhere.

This is the opposite choice from reading status, which lives in a private table,
and the contrast is the point:

| | Reading status | Star |
| --- | --- | --- |
| Stored as | our own SQLite table | the tag `★` |
| Syncs | **no** | **yes**, through Zotero's own tag sync |
| A saved search can see it | **no** | **yes** |
| Number of states | three | two |
| Shows in the tag selector | no | yes |

The starred folder is the reason. Saved-search conditions are hardcoded in
`searchConditions.js` with no registration hook, so **no plugin can teach a
saved search to read its own data**. A folder of starred papers is therefore
only possible if the star is something Zotero already understands. A tag is.

The cost is the mirror image: two states rather than three, and the tag is
visible and editable by the user like any other. Both are acceptable for a
star, and neither would be for reading status.

## It is drawn beside the title too, for free

`★` is U+2605, which falls inside the `☀-➿` range that
`Utilities.Internal.containsEmoji` matches, so Zotero draws it next to the title
on its own (`itemTreeRow.js` -> `getItemsListTags`) without being asked.

That is kept deliberately. It means a starred paper still reads as starred when
this column is hidden, in search results, and in the item pane's tag list.

## No colour is assigned, on purpose

The plan for this phase said to call `Zotero.Tags.setColor(libraryID, "★",
colour, 0)`, which would have earned the star the number key `1` for free, the
same way Zotero's own coloured tags work.

It is not done, because **tag colours are user data and they sync**. The user
may already have a coloured tag on that position, and assigning one silently
would reorder shortcuts they chose.

A user who wants the shortcut can do it in one step themselves: right-click `★`
in the tag selector and assign a colour. Nothing in this module depends on
whether they have.

## The folder is made on the first star, not at startup

A saved search that appears in the collection tree before anything is starred is
a folder the user did not ask for. `ensureStarredSearch` runs after a successful
*star* (never an un-star), in the library that star was in, so the folder
arrives exactly when it first has something to hold.

It is matched by name, so renaming it means a second one is never offered.
Deleting it means the next star makes it again -- which is the behaviour to want
if it was deleted by accident, and the behaviour to know about if it was
deleted on purpose.

`Starred Papers` is stored data, not UI, so it is not localisable. Rename it
freely.

## No redraw is asked for, unlike reading status

`item.saveTx()` fires a `modify` notification and ItemTree already answers that
by re-reading and re-sorting the row. Reading status has to raise a `refresh` by
hand precisely because nothing about the *item* changes there.

The flip side, and it is correct rather than a bug: **starring bumps
`dateModified`**, because adding a tag genuinely is an edit to the item and the
sync engine needs to know. Reading status must never do this; the star must.

## Two typings that are behind the client

`zotero-types` describes these wrongly, and both casts in the source say so with
the file and line rather than shrugging:

- `Zotero.Searches.getByLibrary` exists (`searches.js:53`) and is missing from
  the typings.
- `Search.libraryID` is typed read-only because the base `DataObject` defines it
  with a getter only (`dataObject.js:81`). `Zotero.Search` **redefines it with a
  setter** (`search.js:68-71`), and Zotero's own `zoteroPane.js:2078` assigns to
  it.

## Traps

**The column registration has the same three silent failure modes** as reading
status -- `width` must be a string, `defaultIn` must be present or the column
ships hidden, and the handler must be `click` on a `.cell.clickable`. They are
written up once, in `READING-STATUS.md`. Read that before editing the
registration here.

**`hasTag` throws if the item's tags were never loaded.** Rows the tree is
drawing have them, because it loads tags to draw coloured-tag swatches, but a
throw inside `dataProvider` takes the whole item list down rather than one cell.
It is caught and read as "not starred".

**`dataProvider` returns `"1"`/`"0"`, not a boolean.** That value is what the
tree sorts on and what `renderCell` is handed back as `data`.
