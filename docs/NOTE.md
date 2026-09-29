# Customisation map

Where to change things, and what will break if you change the wrong one.

The other docs answer different questions, so start with whichever fits:

| Question | File |
| --- | --- |
| *How do I change X?* | this file |
| *Why is it built this way?* | `PAPERLY-FORK.md` |
| *Does it still work?* | `TESTING.md` |
| *How do I add an AI provider?* | `ADDING-A-PROVIDER.md` |
| *How does the floating bot work?* | `BOT.md` |

Symbol names are used instead of line numbers throughout, because line numbers
go stale within a commit or two. `grep -n "<symbol>" src/...` finds them.

---

## Who owns what on screen

Everything the user sees belongs to one of five places. Knowing which one is
usually the whole problem.

| On screen | Owner |
| --- | --- |
| The button beside the tab strip | `src/modules/readerIntegration.ts` — `ensureReaderTabbarButton` |
| The colour popup when you select PDF text | `src/modules/readerIntegration.ts` — the `lookupRow` block |
| The DOM globals React needs before it can render | `src/utils/reactGlobals.ts` |
| A look-up asked for before the column was listening | `src/services/lookupRequest.ts` |
| The column itself: width, splitter, close button, View menu item | `src/modules/webAIColumn.ts` |
| Everything inside the column | `src/ui/components/Sidebar.tsx` → `src/ui/components/WebAIWorkspace.tsx` |
| The provider list | `src/ui/webAIServices.ts` |
| The note button in the reader toolbar, and the note pad itself | `src/modules/readerNotePanel.ts` |
| Where a paper's notes are stored | `src/services/readerNoteStore.ts` |
| The colours the note pad copies from the page | `src/ui/readerTheme.ts` |
| The palette the pad can be painted in instead | `src/ui/noteColors.ts`, `src/modules/readerNoteColorMenu.ts` |
| The three note fonts | `src/ui/readerNoteFonts.ts` |
| The emoji picker in the pad | `src/modules/readerNoteEmojiPicker.ts` |
| The emoji list and its search | `src/ui/emojiCatalog.ts`, built by `scripts/build-emoji-data.mjs` |
| What a block is, and what may be stored | `src/ui/noteBlocks.ts` |
| Turning keystrokes into blocks | `src/modules/readerNoteEditing.ts` |
| The "/" menu, and the button beside the pad's title that opens it | `src/modules/readerNoteBlockMenu.ts` |
| Tables, and their drag handles | `src/modules/readerNoteTable.ts` |
| The toolbar that appears over selected text | `src/modules/readerNoteFormatBar.ts` |
| Bold, italic, links, code and highlights | `src/modules/readerNoteEditing.ts` (the commands), `src/ui/noteBlocks.ts` (what is stored) |
| The eight highlight colours | `NOTE_HIGHLIGHTS` in `src/ui/noteColors.ts` |

`WebAIWorkspace.tsx` is ~10,000 lines and holds nearly all behaviour. That is a
known problem, not a design; see the Known issues list in `PAPERLY-FORK.md`.

---

## Recipes

### Change the translation target language

`src/ui/webAIServices.ts`, `TRANSLATION_TARGET`. One constant, currently `"vi"`.

The source language stays `sl=auto` in the `translate` entry's
`searchUrlTemplate` on purpose — a paper quoting French should not be forced
through English.

### Change which provider the panel opens on

`src/ui/webAIServices.ts`, `DEFAULT_SERVICE_ID`. Currently `"claude"`.

It is a named id, **not** `SERVICES[0]`. The array is a menu order; reordering
the menu should not move the default with it. Three places read it — the
panel's initial provider, what "AI Web" falls back to before any chat provider
has been used, and the provider a stored chat session is attributed to when its
own id is unreadable — so one edit moves all of them.

There is no per-user preference for this, and the choice is not remembered
across reopens: close the column and it returns to the default. If that ever
needs to persist, `Sidebar.tsx` owns the `service` state and
`settingsManager.ts` is where prefs live.

### Change where a look-up sends you

Same file, the `searchUrlTemplate` on the provider. `{q}` is replaced with the
URL-encoded query, `{tl}` with `TRANSLATION_TARGET`. Substitution lives in
`buildLookupURL`, which is the only place that knows about the placeholders.

### Add or remove a provider

`ADDING-A-PROVIDER.md`. Two edits in `src/ui/webAIServices.ts`; the selector
and session restore both read `SERVICES`, so neither needs touching.

### Add a button to the PDF selection popup

`src/modules/readerIntegration.ts`, the `lookupRow` block.

```ts
lookupRow.appendChild(createLookupButton(doc, "<serviceID>", "<label>", annotationText));
```

`<serviceID>` must be a `kind: "lookup"` provider that has a
`searchUrlTemplate`, or the button will open the provider's home page and drop
the selection. The row wraps, so a fourth button costs nothing.

Use a brand name as-is (Google) and translate the rest — `zh ? "翻译" : "Translate"`.

### Act on an existing highlight

`onCreateAnnotationContextMenu` in `src/modules/readerIntegration.ts`. Items are
appended to the right-click menu on a highlight, in the page or in the
annotations sidebar.

Text comes from `getAnnotationsText`, which maps `params.ids` (annotation item
keys) through `reader.annotationItemIDs` to the items and reads
`annotationText`. Image and ink annotations have none, and the handler returns
early rather than appending items that cannot work.

Do not add `persistent: true` unless the item should stay visible while
disabled — Zotero's `createItemGroup` hides disabled items without it, which is
what keeps this menu short.

**The popup with the comment box cannot be extended.** Zotero exposes
`renderTextSelectionPopup` for a live selection and nothing for an existing
annotation; the full list of plugin-facing reader events is in
`chrome/content/zotero/xpcom/reader.js`. The context menu is the only hook.

### Add, remove or reorder a toolbar button

The row under the page, `className="zotero-webai-toolbar"` in
`WebAIWorkspace.tsx`. Buttons are plain JSX in render order.

Labels are **not** inline. Add the key to the `buttons` block of the
`WebAIStrings` interface, then to both `EN_STRINGS` and `ZH_STRINGS` — the
interface makes a missed locale a type error rather than a blank button. Keep
the three lists alphabetical; that is the only reason they stay readable.

`getWebAIStrings(language)` picks the table: Chinese locales get `ZH_STRINGS`,
everything else falls back to `EN_STRINGS`. There is no per-key fallback — a
missing key is a type error, not a blank button at runtime.

### Show or hide something per view

`panelView` (`"web" | "chat"`) lives in `WebAIWorkspace`. Anything inside that
component reads it directly.

The shell around it — the header, the footer with the thinking-effort selector
and the token meter — lives in `Sidebar`, which mirrors the value through the
`onPanelViewChange` prop. If something in the shell needs to follow the view,
that mirror is already there; do not lift `panelView` out of the workspace,
which is where every setter is.

The status line renders only when `status` is non-empty or the view is `chat`.
Setting `status` is how anything gets a sentence on screen in the web view;
there is no other surface for it.

### Change when a provider's page reloads

It does not, except on Reload, a look-up request and New Conversation. Each
provider keeps its own live `<browser>` in `framesRef` (`FrameEntry`), and
switching only toggles `style.display`.

To make something reload, navigate it: `loadFrameElement(frameRef.current, url)`.
To make something *stop* reloading, check whether it is calling that.

Do not add `service` to a dependency list that ends up removing frames, and do
not move frame teardown back into the frame effect — it runs on every provider
switch. Teardown lives in the `[]`-deps effect right below it.

There is no cap on how many frames are kept, and each is a content process. If
one is ever needed, `FrameEntry` is where a last-used stamp would go.

### Change the Back / Forward strip

`HistoryButton` (the chevron), `styles.frameNav` (the strip) and
`styles.frameShell` (the border and rounding shared with the page).

To put something else up there — a URL field, a Reload — add it to the
`zotero-webai-frame-nav` div. It is an ordinary flex row.

**Do not** make the buttons appear and disappear instead of dimming. That was
tried; a control that appears shifts every button beside it, and an absent
control is harder to find than a greyed-out one.

The enabled state comes from `watchFrameNavigation`. The two directions read
**different** fields and this is not an oversight:

| Direction | Field read | Why |
| --- | --- | --- |
| Back | `canGoBackIgnoringUserInteraction` | plain `canGoBack` also demands user interaction on the entry, which a look-up result the panel loaded itself does not have |
| Forward | `canGoForward` | already exactly what `goForward()` gates on |

`stepThroughHistory` passes `false` to both so the action matches the state the
button was enabled for. If you change one side, change the other.

### Change the note pad

`src/modules/readerNotePanel.ts` owns everything you see: the toolbar button,
the card, dragging, resizing and the status line. It is plain DOM on purpose —
no React inside the reader. See the Traps below for why.

**Where it lives.** Not in the reader any more. `overlayDock.ts` puts an
`about:blank` iframe over the whole main window and the pad is built in *that*
document, so it can be dragged over the paper and the AI column alike. Read
that file's header before changing anything about the dock; it records what was
measured and why nothing simpler works.

The pad's dock is the one named `"note"`. The floating bot has its own, named
`"bot"`, in its own frame — a clipped-away region passes clicks through to
whatever is below, and another overlay frame is just another thing below, so
the two never fight. See `floatingBot.ts`.

| Thing | Where |
| --- | --- |
| The iframe over the window | `overlayDock.ts` — `ensureOverlayDock(win, "note")` |
| What the iframe catches | `overlayDock.ts` — `setDockClip` / `openDockClip` |
| Which boxes go into the clip | `readerNotePanel.ts` — `syncClip`, `OVERLAY_IDS` |
| One pad per window | `surfaces`, keyed by the chrome window |
| One button per reader | `buttons`, keyed by the reader document |
| Which paper the pad writes to | `surface.reader` / `surface.readerDoc` |

The pad is **pinned**, not per tab: it keeps writing to the paper whose button
opened it while you read another. Its footer names that paper
(`pinnedPaperTitle`). Pressing another paper's button re-pins it — same place,
same size, that paper's note, pending edits flushed first.

Sizes and limits are named constants at the top (`MIN_WIDTH`, `DEFAULT_WIDTH`,
`EDGE_GAP`, `TOOLBAR_GAP`, `PANEL_Z_INDEX`). The look is one template string,
`styleSheet()`, injected once per reader document — `addon/content/styles.css`
is linked into main windows only and never reaches a reader, so a class you add
there will silently do nothing here.

The glyph is `NOTE_ICON_PATHS`, a seedling: pot and stem as 1.25 strokes,
leaves as fills. If you replace it, size it by **ink**, not by bounding box --
the neighbours are dense page-shaped icons, so a plant scaled to fill the 20x20
box reads much heavier than they do. `read-aloud.svg` is the one to match: 75
units of ink. The first version of this button was a notepad, which was very
nearly `reading-mode.svg` two buttons along.

The button's position is `anchorButton`. It inserts after `#read-aloud`, then
falls back to `#readingMode`, then `#zoomAuto`, then appends to `.toolbar
.start`. Never make it the first child: `focus-manager.js` enters the toolbar
with `.toolbar .start .toolbar-button`, which has to stay the sidebar toggle.

### Change what the pad lets through to the paper

The dock covers the window, so on its own it would swallow every click meant
for the paper or the column. It does not, because `clip-path` drives
hit-testing in Gecko: `syncClip` cuts the frame down to the pad plus any
overlay that is open, and a point outside that lands on whatever is underneath.

Three things keep it honest:

- `placePanel` re-cuts it, so it follows the pad wherever it is put.
- A `MutationObserver` on the dock's body re-cuts it on the next frame after
  anything changes, which is how the format bar, the "/" menu, the colours and
  the emoji picker are covered without any of them knowing the dock exists.
- A drag calls `openDockClip` **and** sets `surface.dragging`, and the frame
  catches everything until the pad lands. Both halves are needed: the drag
  writes the pad's `transform`, which is an attribute change like any other, so
  the observer above would cut the clip straight back on the next frame — and
  then a pointer that got ahead of the pad would land on the pane underneath
  and the pad would stop following it. `syncClip` returns early while
  `dragging` is set, and `commit` clears it before re-cutting. Measured with a
  pointer moving 60px a frame: 360px asked for, 360px moved.

`setDockClip` skips the write when the path has not changed, which is most of
the time — the observer fires on every keystroke.

If a new overlay is added to the pad, put its root id in `OVERLAY_IDS` or it
will be drawn and never clickable.

### Change when the pad's menus close

Four things can be open over the pad — the format bar, the "/" menu, the
colours and the emoji picker — and `closePadOverlays` is the single way they
are all put away. Three watches call it, and each hears a different set of
presses, because a press is only ever delivered to one document:

| Pressed on | Heard by |
| --- | --- |
| The pad, or anything open over it | Each overlay's own `pointerdown` on the dock document |
| Zotero's chrome — tabs, item tree, toolbars | `onAway`, on `win.document`, guarded by `insideDock` |
| The reader's chrome — its toolbar, its sidebar | `onPaperPress`, on the reader document, kept alive by the button registry |
| The rendered page, or a provider's page | Nobody |

The last row is not an oversight. The page renders in a frame inside the
reader's `<browser>`, and the provider's page is in another process, so a press
on either reaches none of the three documents above. That was true before the
pad moved into the dock as well — the pad used to live in the reader document,
which never saw those presses either. Focus was tried as a way across and is
not one: measured, clicking the page moves focus in some places and not others,
and a watch that fires half the time is worse than no watch. What does put a
menu away is Escape, a press anywhere on the pad, and a press on either chrome.

Of the three, only the first two have been checked by machine. A synthetic
native click aimed inside the reader's `<browser>` was delivered to neither the
chrome document nor the reader's own — measured, with a listener on each — so
the reader row is a by-hand check, and `TESTING.md` says so.

If a new watch is added here, guard it with `insideDock` first. Read the trap
below before assuming a document only hears its own presses.

### Change how the pad opens, moves and lands

All of it is in `readerNotePanel.ts`, and it is deliberately split between
what CSS does and what JS does.

| Moment | Where |
| --- | --- |
| Growing out of the button | `setOpenOrigin` puts the transform origin on the button, then `paperly-note-opening` runs `paperly-note-in` |
| Getting out of the way | `paperly-note-closing` runs `paperly-note-out`; `hidden` is set by a `CLOSE_MS` timer, not before |
| Being picked up | `paperly-note-dragging` — bigger shadow, `cursor: grabbing` |
| Following the pointer | The header's `trackPointer` handler writes `transform` only |
| Taking hold of an edge | `snapToEdges`, then `restartAnimation(panel, "paperly-note-snapped")` |
| Landing | `commit` clears the transform, calls `placePanel`, then `paperly-note-dropping` |

Durations live in `OPEN_MS`, `CLOSE_MS` and `SNAP_RADIUS`. The drop and snap
keyframes carry their own timings because they are one-shot flourishes rather
than state changes.

**The pad moves on `transform` and lands on `left`/`top`.** Dragging by
`left`/`top` relayouts the pad on every `pointermove`; a transform never
touches layout. Nothing may transition `transform`: the drag writes it once
per move, and `commit` clears it in the same task it writes `left`/`top`, so a
transition there would slide the pad back to where the drag started. The
settle is an animation, and it only touches `scale`.

Because the drag leaves a `scale` on the pad, its rect is no longer its
geometry — which is why `trackPointer` takes an optional `commit` and the
header uses it. The resize grip has no transform, so it still lets the default
rect-based commit run.

Snapping is applied **after** clamping, so it can only ever pull the pad
somewhere a drag was already allowed to reach.

`prefers-reduced-motion: reduce` turns every one of these off in one block at
the end of the motion CSS. Nothing in JS checks it — the classes still go on
and come off, they just do not animate.

### Add a block type to the "/" menu

One entry in `NOTE_BLOCKS` (`src/ui/noteBlocks.ts`) gives the menu its row: the
label, the icon, the words it is searched by and the shortcut shown on the
right. The same list is what the button beside the pad's title opens, so a new
entry appears in both. Then teach `applyBlock` in `src/modules/readerNoteEditing.ts` what to do
with it, and -- only if it is a new tag -- add that tag to `BLOCK_TAGS` in
`noteBlocks.ts` so the sanitizer stops dropping it.

Check the tag against Zotero's note editor first:
`zotero-client/note-editor/src/core/schema/nodes.js` is the whole list of what
Zotero can parse back. A note is HTML, not Markdown, so anything can be
*stored* -- but anything outside that schema is dropped the first time someone
edits the note in Zotero, which is a silent way to lose someone's work.

### Change how the pad behaves as you type

`src/modules/readerNoteEditing.ts`. `INPUT_RULES` is the Markdown-style
shortcuts (`# `, `- `, `1. `, `[] `, `---`); `handleEditorKeyDown` is Enter,
Backspace and Tab; `normalizeStructure` is what keeps the top level of the
editor a flat row of blocks no matter what the browser does when Enter is
pressed.

Every one of those changes the document through `execCommand`. That is
deprecated and it is also the only way to edit a contenteditable without
throwing the browser's undo stack away. Two rules come with it, both in the
Traps: nothing may call it from inside an `input` event, and a block command
needs a block to work on.

### Change what you can do to selected text

`src/modules/readerNoteFormatBar.ts` is the toolbar that comes up over a
selection: its CSS, its three faces (the marks, the link field, the highlight
palette) and where it is placed. It is built ONCE per reader document and then
updated — rebuilding it on every selection change made the buttons flash under
the pointer. `showFormatBar` does both jobs.

Adding a mark takes three edits and they must all happen, or the mark is stored
and then thrown away — or worse, shown and then thrown away:

1. `NoteMarkId`, `MARK_COMMANDS` and `MARK_SELECTORS` in
   `src/modules/readerNoteEditing.ts`. The selector is what the toolbar reads to
   decide whether the button is on; see the Traps for why it does not ask
   `queryCommandState`.
2. `MARK_TAGS` in `src/ui/noteBlocks.ts`, mapping every tag the browser might
   write to the ONE tag the note is stored as.
3. `MARK_LABELS` in the format bar, which is the button.

Check the tag against `zotero-client/note-editor/src/core/schema/marks.js`
first — the same rule as blocks. `strong`, `em`, `u`, `s`, `code`, `sub`, `sup`,
`a[href]` and a `<span>` carrying `color` or `background-color` are what Zotero
can parse back; anything else is dropped the first time the note is opened
there.

The pad deliberately does **not** offer a text colour. Its ink is derived from
whichever background was chosen (`inkFor` in `src/ui/noteColors.ts`), so a fixed
colour fights that; and clearing one cannot be done without breaking the
nesting — see the Traps.

### Change the table

`src/modules/readerNoteTable.ts` owns the whole block: what a new table looks
like, the handles, and the CSS (`tableStyles`, which the pad appends to its own
stylesheet). Structural changes -- insert, delete, move -- all go through
`replaceTable`, which swaps the table for a changed copy of itself with
`insertHTML` so that each one is a single step on the undo stack. Resizing is
the exception and says why in the code.

Column widths are stored as `data-colwidth`, because that is what
prosemirror-tables reads. Measured: a table written here opens in Zotero's own
note editor with its widths intact.

Every handle is drawn OUTSIDE the table — the column bars above it, the row
bars beside it, the two `+` past its right and bottom edges — so the pointer
always has a strip of plain editor to cross to reach one. `withinReach` is what
keeps them alive for that trip; read the Trap below before changing where a
handle sits or how far `HOVER_SLACK` reaches.

### Change the emoji picker

`src/modules/readerNoteEmojiPicker.ts` owns the popover: its CSS, the category
tabs in `TABS`, the skin tone swatches, and the keyboard. It is a sibling of the
pad in the reader document, never a child -- the pad clips its own overflow, so
a popover inside it would be cut off at the edge.

One rule holds the whole thing up: **the search field keeps focus the entire
time the picker is open**. An `input[type=text]` is one of the two things the
reader's `isTextBox()` recognises, so typing does not reach the annotation
shortcuts and the arrow keys are not stolen. The grid's selection is a
highlighted cell, not real focus, and every `pointerdown` inside the picker is
cancelled so clicking a cell cannot move focus either. If you add a control
that needs focus, it has to be an `input[type=text]` or the keyboard breaks in
ways that look like reader bugs.

Each category is a `.paperly-emoji-section` wrapping its heading and its rows.
That wrapper is load-bearing, not tidiness -- see the Traps.

Inserting is `insertAtCaret` in `readerNotePanel.ts`. It restores the Range
saved when the button was pressed, then uses `execCommand("insertText")`, which
keeps the undo stack and fires `input` -- so the save and the placeholder state
are handled by the listener that is already there.

### Refresh the emoji list

```bash
node scripts/build-emoji-data.mjs      # needs a network connection
```

It rewrites `addon/content/emoji.txt` from
[emojibase-data](https://github.com/milesj/emojibase) (CLDR, MIT), which is
where the English and Vietnamese names come from. The file is read once, the
first time someone opens the picker, rather than bundled: most sessions never
open it.

Ranking lives in `searchEmoji`. Two rules, both earned: a match in a **name**
beats a match in a tag, and ties go to catalogue position, which is Unicode's
own order. See the Traps for why the second one is not cosmetic.

### Change where a paper's notes are stored

`src/services/readerNoteStore.ts`. `PAPER_NOTE_TITLE` is the note's heading and
its fallback identity; `pointerSettingKey` builds the SyncedSettings key that
holds the note's key.

The body is a Zotero child note on the paper, so it syncs, shows up in the
library and outlives the plugin. Do **not** move the body into the pointer
setting: a 403 on a settings upload makes the client delete the local value
(`sync/syncEngine.js`), which is survivable for a pointer and not for someone's
notes.

`IDLE_MS` and `MAX_WAIT_MS` are the debounce. The ceiling is armed once per
burst and deliberately not reset on each keystroke — that is what bounds how
much can be lost by someone typing without pausing.

The pad is plain text. `textToNoteHTML` and `noteHTMLToText` are the two ends of
that; widen `PLAIN_TAGS` if you teach it more markup, or the pad will start
claiming it simplified a note it understood perfectly well.

### Change the note pad's colours or fonts

Colours come from one of two places. By default the pad follows the paper, and
that derivation is `src/ui/readerTheme.ts`. If someone picks a colour from the
palette instead, `src/ui/noteColors.ts` holds it, and `applyTheme` in the panel
chooses between them on the `readerNoteBackground` preference (`paper`, or a
hex).

To add a colour, add it to `NOTE_BACKGROUNDS`. Nothing else is needed: the ink
is not chosen by hand but derived, the swatch taken down to a fifth of its
brightness so it keeps the hue instead of dropping black on top of it. Measured
across the fifteen that ship: 7.6:1 to 11.7:1 against their own background,
where the reader's own sepia theme is 7.5:1. `inkFor` falls back to near-white
if a swatch is ever dark enough that its own ink would disappear into it.

`NOTE_BACKGROUNDS` is a list of FAMILIES, each one darkest first — but the
palette draws it **transposed**, a family per column and a shade per row, so it
stays three rows tall however many families there are. Laid out the way the
data reads, five families made a popover taller than the pad it hangs off.
A family with fewer shades than the others simply leaves that cell out.

Following the paper: `resolveReaderPaperTheme` recomputes the
reader's theme from the same inputs Zotero uses — the light/dark media query of
the *reader's* window, `reader.lightTheme` / `reader.darkTheme`, and
`readerCustomThemes` — and only cross-checks the background against the DOM.
Do not switch it to reading the DOM alone: for a PDF the view publishes
`--background-color` and nothing else, so sepia's cream would be right and its
brown text would be invented. Everything else in the pad is derived with
`color-mix` from those two values, which is why a custom theme works with no
extra code.

Fonts: `src/ui/readerNoteFonts.ts`, `NOTE_FONTS`. To add one, drop a woff2 in
`addon/content/fonts/`, add an entry, and ship its licence beside it. Subsets
are declared Vietnamese-first and Latin-last on purpose: the two overlap on the
combining marks and the last matching face wins.

The fonts are inlined as `data:` URIs, not linked. This is not a style choice —
see the Traps.

### Change what happens when a link wants a new tab

There are **two** mechanisms and they cover different cases. Changing the wrong
one looks like the change did nothing.

| Trigger | Handled by |
| --- | --- |
| Clicking an `<a target="_blank">` | `interceptFrameLinks` in `WebAIWorkspace.tsx` — a frame script, runs in the content process |
| `window.open(url)` from the page's own script | `src/modules/webAINewWindow.ts` — wraps the window's `nsIBrowserDOMWindow` |

Both end in the same place: the URL loads in the column. To send links to the
system browser instead, change `divertIntoFrame` (which already does exactly
that for non-`http(s)` schemes) and the `top.location.href` assignment in the
frame script.

If a link does nothing at all, the wrapper logs every request it sees:

```
grep "New-window request" ~/paperly-dev.log
```

No line means the click never reached `nsIBrowserDOMWindow` — look at the frame
script instead, and at `Could not install the Web AI link interceptor`.

### Change the column's width behaviour

`src/modules/webAIColumn.ts`:

| Constant | Meaning |
| --- | --- |
| `DEFAULT_WIDTH` (380) | width on first open |
| `MIN_WIDTH` (280) | the column cannot be dragged narrower |
| `MIN_PAPER_WIDTH` (200) | how little of the paper may be left; this is what caps the drag |
| `WIDTH_PREF` (`columnWidth`) | where the user's width is remembered |

The splitter is a custom handle (`attachColumnResize`), not a XUL `<splitter>`.
A XUL splitter negotiated with `#tabs-deck`'s `min-width` and the drag stopped
well short of what was asked for; the handle sets `column.style.width` directly
so the result no longer depends on guessing which constraint binds.

---

## Traps

Each of these cost real debugging time. They look like ordinary code.

**A chrome `<iframe>`'s presses keep going into the window's document.** A
same-process frame in chrome has the frame element as its chrome event
handler, so a `pointerdown` inside the dock carries on into `win.document` —
in the default group, with the pad's own button still as `event.target`, not
the frame. The window-level watch that closes the pad's menus was written on
the assumption that anything the *window* saw had happened outside the dock.
It had not: the watch fired on every press on the pad and tore the open menu
down between `pointerdown` and `click`, so no swatch, emoji or "/" entry could
be picked at all — the menu opened, and picking from it did nothing. Measured
both ways with `sendNativeMouseEvent`: the window saw the press with
`BUTTON.paperly-colors-swatch` as its target, and the stored colour went from
`paper` to `paper` where `#E5D9EF` had been asked for. `insideDock` is the
guard, and it checks the frame element *and* the target's `ownerDocument`,
because which of the two arrives depends on where the press started.

The same measurement said the reverse about content: a press inside the
reader's `<browser>` reached the window **zero** times, in the default group
and the system group alike. So that one watch was hearing exactly the presses
it should have ignored and none of the ones it was written for.

**`setPointerCapture` throws, and it is not the last line of the handler.**
`trackPointer` calls it right after the drag has been marked as started and
right before the move listener is attached, so a throw leaves the pad wearing
its "being dragged" class with nothing listening for the pointer — it sticks to
the cursor's first position and never lets go. Gecko throws for any pointer id
that is not currently active, which is every synthetic drag and any real one
where the pointer was lost between `pointerdown` and the call. It is wrapped,
and the drag works without the capture; it just stops following once the
pointer leaves the header. `releasePointerCapture` below it was already
wrapped, which is the hint that this one should have been.

**Priming the browser is once-only.** `primeBrowserRemoteness` calls
`changeRemoteness()` then `construct()`, which tears down the frame loader and
builds a new one — so calling it again drops the `loadURI()` that follows,
silently, with nothing thrown. A fresh frame is built on every provider change,
so the flag never needs clearing. Never prime a frame that is already showing a
page.

**Use `overflow: clip`, never `hidden`.** An `overflow: hidden` box is
programmatically scrollable with no scrollbar to scroll back, so `focus()` and
`scrollIntoView()` anywhere inside it will push content out of view for good.
This is what cut the panel's toolbar off at the top. Pass
`focus({ preventScroll: true })` for the same reason.

**Stylesheet `!important` beats an inline style.** Several rules in
`addon/content/styles.css` carry `!important` and will override the `style={{}}`
you just wrote. If a layout change has no effect, grep the stylesheet for the
class before touching the component again. When you add a flex child that must
fill the column, add its class to those rules too.

**Moving a `<browser>` in the DOM destroys its frame loader**, which logs the
user out of the provider. This is why the web surface is hidden with
`display: none` rather than unmounted, and why the frame host is a bare div the
mount effect fills — never put React children inside `frameHostRef`, the effect
calls `replaceChildren()`.

**`#tab-bar-container` is a React root** owned by Zotero's `tabs.js`. Anything
inserted there makes React and the DOM disagree on the next tab open. The
tab-bar button goes in `#zotero-tabs-toolbar`, the static XUL box beside it, and
needs `-moz-window-dragging: no-drag` or macOS swallows single clicks.

**A button that opens a popup has to be excused from its own outside-press
handler.** The blocks menu and the emoji picker both close on a `pointerdown`
anywhere outside, in the capture phase -- which fires before the `click` on the
button that opened them. Without telling the popup which element is its
trigger, pressing that button a second time closed the popup and then
immediately reopened it, so it could never be shut the way it was opened.
`openBlockMenu` takes a `trigger`.

**execCommand is refused from inside an input event.** While Gecko is
dispatching the `input` event of one edit, every `execCommand` is ignored --
`formatBlock`, `insertUnorderedList` and even `delete` all return without doing
anything. A Markdown shortcut noticed in the `input` event therefore cannot be
applied there; the pad applies it in the next task (`setTimeout(..., 0)` in the
panel's input listener). The symptom before that was worse than nothing: the
rule had already selected the trigger text, so the next keystroke silently
overwrote it and the block never changed.

**A block command needs a block.** Select everything, press Backspace and type:
the editor is left holding a bare text node with no block at all, and from then
on nothing that works on "the current block" works -- no shortcut, no menu, no
heading. `normalizeStructure` runs on every input and puts loose text back in a
paragraph. It also flattens the `<div>` wrappers Blink creates on Enter, which
is the same bug wearing a different hat: a list and the text after it inside one
container read as a single block.

**The plugin sandbox has no DOM constructors.** `new DOMRect(...)` throws there.
The table handles were built, positioned by a function that threw on its first
line, and drawn at (0, 0) -- and because the reader swallows exceptions from its
own document, nothing was logged. Rectangles this code computes are plain
objects.

**A layer over the editor is not in the editor.** The table handles sit in a
sibling of the contenteditable, never inside it, because a node inside it is
part of the note and would be saved. The cost is that moving the pointer from
the table onto a handle *leaves* the editor -- so clearing the handles on
`pointerleave` took them away at the exact moment anyone reached for one. Only
a real pointer shows this; every synthetic test passed. `onLeave` checks
`relatedTarget`.

**A cell's stored width is the whole cell.** `data-colwidth` is a border-box
width, so the cells carry `box-sizing: border-box`. Without it every column
rendered 15px wider than it was told to be -- padding plus border -- and a
three-column table ran off the side of the pad.

**`#️⃣` is not a comment.** The emoji catalogue uses `#` for comments, and the
keycap number sign is an emoji whose line starts with that character. A parser
that skips `startsWith("#")` silently loses exactly one emoji out of 1906 -- it
was found by counting, not by noticing. The comment marker is `# `, hash and a
space.

**A sticky heading is confined to its parent block, not to the scroller.**
The category headings are `position: sticky; top: 0`. Appended straight into the
scrolling list they all shared one containing block, so every heading scrolled
past stayed stuck at the top and the nine piled up on each other. The second
half of that bug is worse: `offsetTop` on a stuck element reports where it is
stuck, and that is what the bottom bar read to scroll to a category -- so once
you had scrolled past a heading, its tab computed "scroll to where you already
are" and looked dead. Measured in the reader: after one pass down the tabs, all
nine headings were pinned and every further click left `scrollTop` at 7304.
Each category now sits in its own `.paperly-emoji-section`, which bounds the
heading to its own rows and gives the tab a box whose `offsetTop` never moves.

**Folding accents makes Vietnamese ambiguous on purpose.** "cười" (smile),
"cưới" (wedding) and "cưỡi" (ride) all fold to "cuoi", so a query typed without
diacritics genuinely matches a chapel and a horse as well as a smile. That is
the right trade -- people type without diacritics -- but it means the tie-break
is doing real work: without ordering by catalogue position, "cuoi" put 💒
first.

**A throwing reader-event handler stops every handler after it.**
`Zotero.Reader._dispatchEvent` walks its listener list with no `try`/`catch`, and
that list is shared with every other plugin. One exception in `onRenderToolbar`
took out a listener registered later in this same plugin, and the only symptom
was a feature that silently never ran. Wrap the body of every reader event
handler.

**An init object handed to a content-window constructor reads back empty.**
`new readerWindow.MutationObserver(cb)` with a plain chrome-side
`{ childList: true }` throws *"One of 'childList', 'attributes',
'characterData' must not be false"* — the object crosses a compartment boundary
and its properties are not visible on the other side. Use the chrome
constructor, or `Cu.cloneInto` the init. The same boundary is why
`new readerWindow.FontFace(...)` and a `blob:` URL minted in the reader window
both fail with *"Permission denied to access object"*.

**A webfont cannot be loaded into the reader from `chrome://`.** `@font-face`
with a `chrome://` `src` fails inside the reader with *"NetworkError: A network
error occurred"*, while the same URL works in a main window and while
`<img src="chrome://…">` works in the reader. Fonts go through a principal check
that images do not. The bytes are read once in chrome, where the URL is legal,
and inlined as a `data:` URI.

**`<textarea>` is not a text box to the reader.** `isTextBox()`
(`reader/src/common/lib/utilities.js`) accepts `input[type=text]` and
`[contenteditable="true"]` and nothing else, and the reader's keyboard and focus
managers listen in **capture phase on the reader window**, so a descendant
cannot get in front of them. In a textarea inside a reader, `h` toggles the hand
tool, a digit repaints the highlight colour, `Cmd-A` is swallowed and the arrow
keys move focus to another toolbar button. The note pad is a contenteditable for
this reason alone.

**Not matching the reader's focus whitelist is a feature.** The pad deliberately
carries none of `.annotation, .annotation-popup, .selection-popup, .label-popup,
.appearance-popup, .context-menu`, so focusing it makes the reader deselect
annotations. That is what stops `Backspace` from deleting the highlight the user
had selected and `Cmd-C` from copying the annotation instead of the note text.
Add one of those classes to the pad and both bugs come back.

**Blink strips `<code>` out of `insertHTML`, always.** Measured in Chromium:
`insertHTML` with `<code>x</code>` inserts `x`, with or without attributes on
the tag, while `<b>x</b>` beside it comes through intact. What both engines DO
write is `<span style="font-family: monospace">`, from `fontName` under
`styleWithCSS` — which is also one of the things Zotero's `code` mark parses.
So that is what the pad asks for, and the whitelist in `ui/noteBlocks` turns the
span back into `<code>` on the way to storage. Do not "simplify" that back to an
`insertHTML`; it works on the desktop and silently does nothing on the web.

**`queryCommandState` answers from the COMPUTED style, not from the note.** It
reports bold for every heading, because the pad draws headings at weight 650,
and underline for every link, because the browser underlines links itself. The
toolbar therefore reads `MARK_SELECTORS` off the DOM instead. The same
computation is inside the browser's own bold command, which is why **bold is
greyed out inside a heading**: asking for it there UN-bolds, writing a
`font-weight: normal` span that showed part of the heading in plain text until
the next save quietly dropped it.

**A colour command needs `styleWithCSS` on; every other mark needs it off.**
With it off, bold is `<b>` — the tag the whitelist keeps. Also with it off,
Gecko runs a colour value through HTML's *legacy* colour parsing, which reads
`#ffd40080` as `#ff4080`: Zotero's yellow highlight comes out pink. `setHighlight`
turns it on for the one call and straight back off. `pinCommandStyle` sets the
document's own default, which is what the browser's Cmd-B relies on.

**Taking a highlight off nests a see-through span inside the coloured one.**
`transparent` is in the colour whitelist for exactly that reason. Drop that span
as "not a real colour" and the words go back to yellow — measured on Gecko;
Blink splits the outer span instead and gets the same result either way.

**A list asked for inside a heading is made INSIDE the heading.** Both engines:
Gecko gives `<ul><li><h2>…</h2></li></ul>`, Blink gives `<h2><ul>…</ul></h2>`,
and the whitelist then flattens the second one back to a plain heading — so the
list someone asked for is gone the next time the note is opened. `clearHeading`
runs first for that reason.

**A handle outside the table cannot be reached if leaving the table takes it
away.** All of them are outside it, so the pointer crosses plain editor on the
way. Clearing the handles the moment it was no longer over the table did
exactly that: measured with a real mouse, two pixels of travel was enough to
lose the lot, so the `+` buttons could not be clicked at all — and they were
7px square on top of that, which is not a target either. `withinReach` now
keeps them while the pointer is within `HOVER_SLACK` of the union of the table
and its own handles, so moving a handle further out widens the zone by itself.
Every synthetic test passed throughout: `mouse.move(x, y)` jumps straight to
the target and never lands in the strip. This is the second bug in this file
that only a real pointer could find; the first is the one above it.

**React DOM reads `window` off the global scope, and a plugin sandbox has
none.** `getCurrentEventPriority` inside react-dom does a bare `window.event`,
so the first React render in a fresh session throws `ReferenceError: window is
not defined` — nothing to do with the node being rendered into. Binding used to
happen only where the sidebar and the column mount React, which meant the
reader's selection popup threw on every cold start, and because a DOM event
listener **swallows** what is thrown in it, the `append()` further down never
ran: Translate, Dictionary and Google were simply absent from the popup until
the WebAI column had been opened once, with nothing in the console to say why.
`bindReactDomGlobals` in `src/utils/reactGlobals.ts` is the one place that binds
them now. Call it before any `createRoot`.

**Opening the column and then telling it something is a race, and you lose
it.** `openWebAIColumn` awaits `bootstrap`, which calls React's `root.render` --
and `render` SCHEDULES, it does not mount. Measured: the column resolves and
the event goes out at +13ms, the Sidebar's effect subscribes at +57ms. So the
first look-up after the column had been closed reached nobody and the column
simply opened on whatever provider it was last on: pressing Dictionary landed
on the AI provider. Anything the column has to be told right after being opened
goes through `src/services/lookupRequest.ts` as well as the bus -- dispatched
for when it is already listening, left in the store for when it is not, and
cleared by whoever handles it so it is never replayed. Do not "fix" this with a
setTimeout; 45ms on this machine is not 45ms on another.

**Append to a reader popup BEFORE doing anything that can throw.**
`custom-sections.js` dispatches the event from inside a `useEffect` and only
accepts an `append()` made synchronously during it — and the listener swallows
exceptions, so anything that throws first takes the whole section with it
silently. Build the section, append it, then do the risky work in a `try`.

**`__aiAssistantEventBus` is one singleton across every main window**
(`EventBus.getInstance()`). Anything that must stay within one window — a frame
event, a per-column state change — is dispatched on the element, not the bus.

---

## Changed on 2026-09-27

| Commit | Change |
| --- | --- |
| *(this change)* | A note pad for the open paper, in the reader toolbar beside Read Aloud |
| *(this change)* | A seedling icon for its button, distinct from Reading Mode |
| *(this change)* | An emoji picker in the pad's header, searchable in English and Vietnamese |
| `490af41` | Blocks and tables: a "/" menu, Markdown-style shortcuts, a draggable table |
| `f82a1d5` | The same blocks menu from a button beside the pad's title |
| `cbce5f7` | A palette the pad can be painted in instead of following the paper |
| *(this change)* | A toolbar over selected text: block type, bold, italic, underline, strikethrough, code, link, highlight, clear |
| *(this change)* | Table handles that survive the trip to reach them, and `+` buttons big enough to hit |
| *(this change)* | Translate / Dictionary / Google in the selection popup without opening the WebAI column first |
| *(this change)* | Those three open the service they name, even on the first press of a session |

Four new files: `src/modules/readerNotePanel.ts` (button and pad),
`src/services/readerNoteStore.ts` (one child note per paper, debounced),
`src/ui/readerTheme.ts` (the paper's colours), `src/ui/readerNoteFonts.ts`
(Inter, IBM Plex Sans, Noto Sans, inlined). Everything that had to be measured
rather than reasoned about is in the Traps above.

## Changed on 2026-09-25

| Commit | Change |
| --- | --- |
| `09f28a4` | Divert new-window requests whose opener is the WebAI frame |
| `bf3e871` | Remove the "Selection only" toggle and its preference — both were dead |
| `081f9a8` | Intercept the click in the page; Back from session history |
| `bf4b1ac` | Enable Back on the condition `goBack()` actually acts on |
| `0bc9b26` | Two-way chevron pair instead of a single labelled Back |
| `6550527` | Move the pair above the page, where a browser puts it |

The reasoning behind each is in the commit message and in `PAPERLY-FORK.md`;
this table is only here so you can find the commit.
