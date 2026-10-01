# Building, installing, and testing

## Layout

| Path | Role |
| --- | --- |
| `Paperly/zotero-client` | Zotero source build — the runtime. Do not edit. |
| `Paperly/Zotero-WebAI` | This plugin. All development happens here. |
| `Paperly/research-ai-reader` | Unused duplicate Zotero clone. Ignore. |

## One-time setup

The Zotero runtime must be built once:

```bash
cd ~/Documents/code/Paperly/zotero-client
./app/scripts/check_requirements   # needs git-lfs, wget; MAR/AWS failures are fine
npm install
./app/scripts/build_and_run        # builds and launches
```

`check_requirements` reports failures for MAR tools, AWS CLI, and the deploy
host. Those are packaging and distribution requirements only and do not affect
local development.

Plugin dependencies:

```bash
cd ~/Documents/code/Paperly/Zotero-WebAI
npm install
```

## The dev loop

Testing happens in an **isolated dev profile**, never the one you use daily. A
crashing build must not disturb real work.

```bash
cd ~/Documents/code/Paperly/Zotero-WebAI
./scripts/dev-reload.sh            # build + install into the dev profile
./scripts/dev-reload.sh --launch   # ...and start the dev instance
```

Dev profile: `~/Library/Application Support/Zotero/Profiles/paperly-dev`
Dev data dir: `~/Zotero-paperly-dev` (a separate, empty library)

Override with `PAPERLY_DEV_PROFILE`, `PAPERLY_DEV_DATA`, `ZOTERO_SRC`.

On a brand-new dev profile the first launch registers the plugin as disabled and
the enable step is skipped, because `extensions.json` does not exist yet. Launch
once, then run the script again.

To build without installing:

```bash
NODE_ENV=production npm run build   # also runs tsc --noEmit
npx tsc --noEmit                    # typecheck alone
```

## Measuring crashes

Do **not** count files in `~/Library/Logs/DiagnosticReports`. macOS rotates
them, so the count can go *down* and any delta is meaningless.

Watch the process instead:

```bash
pgrep -f "profile.*paperly-dev"          # alive?
grep -c "Exiting due to channel error" <log>
grep -c "startup' for plugin zotero-webai" <log>   # 0 means it never loaded
```

Always confirm `startup` is 1. A run where the plugin never loaded proves
nothing, and that mistake was made more than once.

## Two things that will bite you

**1. Version compatibility.** `addon/manifest.json` originally declared
`strict_max_version: "9.*"`. The local Zotero reports `11.0.SOURCE`, so Zotero
marked the plugin `appDisabled` and refused to load it, with no obvious error.
This fork bumps it to `11.*`.

**2. Side-loaded plugins are disabled by default.** Copying an XPI into
`<profile>/extensions/` registers it with `userDisabled: true`. `dev-reload.sh`
patches `extensions.json` to force-enable it. Doing this by hand requires Zotero
to be **closed**, or the file is overwritten on exit.

Check plugin state at any time:

```bash
python3 -c "
import json
p='$HOME/Library/Application Support/Zotero/Profiles/paperly-dev/extensions.json'
for a in json.load(open(p))['addons']:
    if 'webai' in (a.get('id') or ''):
        print({k: a.get(k) for k in ['id','version','active','userDisabled','appDisabled']})
"
```

`active: true`, `userDisabled: false`, `appDisabled: false` means it loaded.

## Manual test plan

There is no automated test suite, so these are manual.

### Smoke test

1. Run `./scripts/dev-reload.sh`.
2. The tab-bar button is always present — it toggles the AI column, which works
   in the library view as well as in a reader tab. View → Paperly AI Panel and
   the × in the column header do the same thing, and all three stay in sync.
3. Click the Paperly AI button in the tab-bar toolbar — right of the tab
   strip, left of the sync button.
4. The panel opens beside the PDF — not in the item pane. Zotero's item-pane
   sidenav must show only Zotero's own icons: no Paperly AI entry, and
   scrolling the item pane must never reach a WebAI section.
5. The provider selector is in the panel header, next to the
   theme toggle — there must be exactly one such control.
6. Open it: chat providers and look-up pages appear under separate headings, and
   the dot is amber for any provider you are not signed in to.
7. Pick Cambridge Dictionary. The composer and transcript disappear and
   a single look-up box replaces them. Type a word, press Enter, and the frame
   navigates to that entry.
8. Pick Claude. The login page must render a working form rather than spinning —
   that is the Turnstile user-agent fix.

### Provider dropdown

| # | Step | Pass |
| --- | --- | --- |
| 1 | Click the provider button | Menu lists all five providers, active one highlighted |
| 2 | Click outside the menu | Menu closes, provider unchanged |
| 3 | Reopen, press Escape | Menu closes, provider unchanged |
| 4 | Pick a provider you have never signed into | Panel switches **and** a login window opens |
| 5 | Pick a provider you are already signed into | Panel switches, **no** login window |

Step 5 depends on `hasStoredSession`, which only checks for an unexpired
`Secure`/`HttpOnly` cookie. A stale cookie suppresses the login window; use the
toolbar "Login Window" button in that case.

### Per-provider test

The panel renders now, so this is runnable. For each of ChatGPT, Claude, Gemini,
DeepSeek and Z.ai:

| # | Step | Pass |
| --- | --- | --- |
| 1 | Select the provider | Page renders, not blank |
| 2 | Sign in | Login completes in-panel |
| 3 | Restart Zotero | Still signed in |
| 4 | Send a prompt from the Zotero chat box | Text reaches the web composer |
| 5 | — | Prompt actually submits |
| 6 | — | Reply is captured into the Results panel |

Steps 4-6 are the remaining risk: injection, submission and capture are generic
heuristics with no per-provider selectors. Claude uses a ProseMirror composer and
Gemini a shadow-DOM `rich-textarea`, so each step can fail independently.
**Record which step fails for which provider** — that decides whether a
per-provider capability layer is needed.

If a panel is blank, check in this order: is the pane wide enough (the load is
deferred until the host has width), then whether `remote` is still `"false"` on
the browser element.

### The web view carries nothing but the page

| # | Step | Pass |
| --- | --- | --- |
| 1 | Switch provider a few times | No "Loaded …" line appears anywhere |
| 2 | Look under the toolbar in the web view | No thinking-effort selector, no token meter, no status text |
| 3 | Click Conversation | All three are back |
| 4 | Send a prompt whose answer is not captured automatically | The record says to read the answer in the web view — it must not mention a Capture button |

### Provider state survives a switch

| # | Step | Pass |
| --- | --- | --- |
| 1 | Google Search, run a query, scroll down | Results on screen |
| 2 | AI Web, type something into Claude's composer without sending | Composer holds the text |
| 3 | Back to Google Search | Same results, same scroll position — no reload |
| 4 | Back to AI Web | The unsent text is still there |
| 5 | Click Reload | *This* one reloads, and only this one |
| 6 | Collapse the column to nothing, switch provider, widen it again | The page loads — the size gate was re-armed, not skipped |
| 7 | Close the column and reopen it | Everything reloads; frames only live as long as the workspace |

Step 6 is the regression that the `loaded` flag exists for. Step 7 is expected,
not a bug: closing the column unmounts the workspace.

### Acting on an existing highlight

| # | Step | Pass |
| --- | --- | --- |
| 1 | Highlight a passage, then click it | Zotero's annotation popup opens — this is upstream behaviour, not a bug |
| 2 | Hold Alt and drag across the highlight | Text selects and the selection popup returns |
| 3 | Right-click the highlight | Copy Text, Translate, Dictionary, Google appear below Zotero's own items |
| 4 | Click Copy Text, paste somewhere | The highlight's text, not its comment |
| 5 | Click Google | The column opens on results for that text |
| 6 | Right-click an image annotation | None of the four appear — an image has no text |
| 7 | Right-click a highlight in the annotations sidebar | Same four items |

### Links inside the page

Zotero's `browserWindowShim.js` answers a `target="_blank"` click with a hidden
browser it never loads, so this used to be a silent no-op.

| # | Step | Pass |
| --- | --- | --- |
| 1 | Google Search, run a query, switch to AI Mode | Answer renders with citation chips |
| 2 | Open a citation card and click a source link | The source opens **in the column** |
| 3 | — | The **‹** chevron above the page, top left, goes from dimmed to enabled |
| 4 | Hover Open External | Tooltip shows the source URL, not the provider's home page |
| 5 | Click **‹** | The AI Mode answer returns, **‹** dims and **›** enables |
| 6 | Click **›** | The source page returns |
| 7 | Click an ordinary result link (no new tab) | It opens in the column and **‹** enables again |

Step 7 is the other half: an ordinary link never reaches
`nsIBrowserDOMWindow`, so Back has to come from session history rather than
from anything the plugin diverted.

If step 2 still does nothing, the log names the path. Every new-window request
logs its entry point, `aWhere` and whether the opener resolved:

```
grep "New-window request" ~/paperly-dev.log
```

No line at all means the click never reached `nsIBrowserDOMWindow`, so the
in-page interceptor is the one that failed — check that the frame script loaded
by looking for `Could not install the Web AI link interceptor`.

Zotero's own browsers must be unaffected: run a translator save from a web page
and open a provider login window. Both go through the same
`nsIBrowserDOMWindow`, and the patch is supposed to delegate anything whose
opener is not `.ai-assistant-web-browser`.

### Look-up in the selection popup, from a cold start

The one that matters is step 1: this used to work only after the WebAI column
had been opened once in that session, because React threw before the popup was
filled in and the reader swallowed it.

| # | Step | Pass |
| --- | --- | --- |
| 1 | Restart Zotero, open a PDF, and **without touching the WebAI button** select a few words | The colour popup carries a row with **Translate**, **Dictionary** and **Google**, and the floating Explain / Ask toolbar appears above the selection |
| 2 | With the column still closed, press **Dictionary** | The column opens **on Cambridge**, showing that word. Not the AI provider: the request used to be dispatched 45ms before the column was listening, and was lost |
| 3 | Press **Translate**, then **Google** | Each switches to the service it names, with the same word |
| 4 | Select a different word and press Dictionary again | Cambridge again, on the new word |
| 5 | Now open the WebAI column and select again | The same row, unchanged |
| 6 | Turn the floating toolbar off in settings and select again | The popup gains "Paperly AI" with Explain and Ask under the look-up row; no floating toolbar |
| 7 | Check the debug output for `selection toolbar failed to render` | Nothing. If it is there, the toolbar threw and the look-up row survived it — which is the point of the ordering, but the throw still wants fixing |

### The note pad in the reader

| # | Step | Pass |
| --- | --- | --- |
| 1 | Open a PDF and look at the left of the toolbar | A seedling icon sits immediately right of the headphones, same size and hover as its neighbours, and not mistakable for Reading Mode two buttons along |
| 2 | Click it | A card opens over the page, top right, below the toolbar |
| 3 | Compare its background with the paper | Identical. On Sepia both are `#F4ECD8` and the text is `#5B4636` |
| 4 | Reading settings → switch theme (Sepia ↔ Snow ↔ Dark) with the pad open | The pad follows immediately; no reopen needed |
| 5 | Type a few lines, including Vietnamese with diacritics | Every character renders in the chosen font — no mixed-font words |
| 6 | Switch the font menu through Inter, IBM Plex Sans, Noto Sans | The text visibly changes shape each time. If all three look the same, the bundled woff2 did not load |
| 7 | Wait a second; read the footer | "Saved to this paper's notes" |
| 8 | Close the reader tab, reopen the paper, open the pad | The text is back |
| 9 | Look at the paper in the library | A child note called "Paperly Notes" holds the same text |
| 10 | Drag the header; drag the corner grip | The card moves and resizes, and cannot be pushed off screen or under the toolbar |
| 11 | Close the pad, open it on a different paper | Empty, or that paper's own notes — never the previous paper's |
| 12 | Reopen the first paper's pad | Same size and position as you left it |

### The emoji picker

| # | Step | Pass |
| --- | --- | --- |
| 1 | Open the pad and look at its header | A smiley button sits left of the font menu |
| 2 | Put the caret in the middle of a line, then click it | A picker opens under the button, in the paper's colours, with the search field already focused |
| 3 | Type `cuoi` | 😀 😃 😄 first — Vietnamese without diacritics, matched against the Vietnamese names |
| 4 | Type `sách` | 📕 📖 📗 first, not 🤓 — a name beats a tag |
| 5 | Type `rocket`, press → then Enter | 🧑‍🚀 lands **at the caret**, not at the end of the note, and the picker closes |
| 6 | Wait a second | The footer says saved; the emoji is in the note in Zotero |
| 7 | Open it again | A "Recent" row at the top holds what you just used |
| 8 | Click the hand button, choose a tone, browse to People | 👋 and friends are in that tone. Emoji built from two people stay default — there is no single tone for them |
| 9 | Click the tabs along the bottom, left to right, then click back up the row | The list jumps every time, in both directions, and exactly one heading is pinned at the top — the one whose rows are on screen |
| 10 | Press Escape, or click the page | The picker closes and the caret is still in the note |
| 11 | Type `h` or a digit while the picker is open | It goes in the search box. The hand tool does not turn on and the highlight colour does not change |
| 12 | Switch the reader theme with the picker open | The picker follows the pad |

### The pad's background

| # | Step | Pass |
| --- | --- | --- |
| 1 | Press the palette button in the header | A grid three rows tall: one column per family — pink, grey, blue, purple, green — darkest at the top. A "Follow the paper" row above it with a tick and a chip showing the paper's own colour |
| 1b | Look at the size of it | The whole popover is about 196x144 and each tile 33x22. It has to stay short: fifteen colours laid out a family per row would be taller than the pad |
| 1c | Pick a purple, then a green | The pad takes each one, and the status line names it |
| 2 | Pick Dusty Pink | The pad, its header and its footer turn pink, the text stays comfortably readable, and the footer says "Background: Dusty Pink" for a moment |
| 3 | Open the emoji picker, the blocks menu and a table | All three follow the pad's colour, not the paper's |
| 4 | Close the pad and open it again | Still pink. Open the palette: that swatch has a ring round it |
| 5 | Change the reader's own theme (Appearance → sepia, dark) | The pad stays pink. It is no longer following the paper, and it says so by not moving |
| 6 | Pick "Follow the paper" | Back to the paper's colours at once, and it tracks the reader theme again |
| 7 | Press the palette button twice | It opens, then shuts |
| 8 | Press the palette, then press a swatch, with a real mouse | The pad takes the colour. Do this one by hand every time: it is the exact path a window-level press watch broke once, and a scripted click cannot see it — the menu opens, and picking from it does nothing. The trap is in `NOTE.md` |
| 9 | Do the same for the emoji picker and the "/" menu | Both pick. They fail and recover together with the palette |

### Blocks and tables

| # | Step | Pass |
| --- | --- | --- |
| 1 | In an empty line type `# ` then some words | It becomes a Heading 1 and the `# ` is gone |
| 2 | Try `## `, `### `, `#### `, `- `, `1. `, `[] ` and `---` the same way | Heading 2-4, a bullet, a number, a to-do with an empty box, a divider |
| 3 | Type `/` on an empty line | The menu opens under the caret, in the paper's colours, "Basic blocks" at the top and ten rows |
| 3b | Put the caret mid-line and press the **+ v** button beside "Notes" | The same menu, hanging under the button. Pick a heading: it applies to the line the caret was on, and typing carries on in it. Press the button again and it shuts |
| 4 | Type `head` | Only the four headings are left. ↑/↓ move the highlight, Enter inserts, Escape closes and leaves the `/` behind |
| 5 | Pick **To-do list**, type something, press Enter | The next line starts with its own empty box |
| 6 | Click the box | It ticks, the text greys out and goes through. Click again to untick |
| 7 | Press Enter twice at the end of a list | The list ends and you are back in ordinary text -- no stray bullet, no stray box |
| 8 | Put the caret at the very start of a heading and press Backspace | It turns back into ordinary text instead of being swallowed by the line above |
| 9 | Type `/table` and press Enter | A 3x3 table with a header row, caret in the first cell |
| 10 | Type, press Tab, type | Tab moves to the next cell; Shift-Tab goes back; Tab in the last cell adds a row |
| 11 | Hover the table | A bar appears over every column, one beside every row, a **+** centred on the right edge and another centred under the bottom edge |
| 11b | Move the pointer slowly off the table towards one of those handles | They stay. Losing them on the way out was what made the **+** unclickable; a mouse jumped straight to the target never showed it |
| 11c | Click the **+** on the right, then the one underneath | A column, then a row. The table still fits inside the pad |
| 11d | Move the pointer well away from the table | Now they go |
| 12 | Drag the line between two columns | The two columns resize against each other. The table never grows past the pad |
| 13 | Drag a column bar sideways | A line shows where it will land; let go and the column moves, taking its width with it |
| 14 | Drag a row bar up or down | The same for rows |
| 15 | Click a bar without dragging | A small menu: insert before, insert after, delete |
| 16 | Press Cmd-Z after any of 9-15 except a resize | One step back. Resizing is not undoable, deliberately: see the Traps |
| 17 | Select everything, press Backspace, then type | Typing still works and shortcuts still fire -- the pad puts a block back |
| 18 | Wait a second, then open the note in Zotero | Headings, lists, divider and table are all there as real markup, with the column widths |
| 19 | Reopen the pad | Everything comes back the way it was left |

### Formatting selected text

Everything here was run automatically on both engines on 2026-09-27; the rows
marked **eye** are the ones only a person can judge.

| # | Step | Pass |
| --- | --- | --- |
| 1 | Select a few words with the mouse | A toolbar appears just above them, inside the pad, in the paper's colours: a row saying which block you are in, then the marks |
| 2 | Select with Shift-arrow instead | The same. Nothing appears while you are still dragging |
| 3 | Press **B**, then **I**, **U**, **S**, **</>** | The word goes bold, italic, underlined, struck through, monospace. Each button lights up while the caret is inside what it made |
| 4 | Press the same button again | It comes off |
| 5 | Press Cmd-B, Cmd-I, Cmd-U, Cmd-E, Cmd-Shift-S | The same five, from the keyboard |
| 6 | Press Cmd-Z after any of them | One step back; Cmd-Shift-Z forward again |
| 7 | Press the pen, pick a colour | The words are highlighted. Reopen the palette: that colour has a ring round it |
| 8 | Select part of the highlight and pick the crossed-out swatch | Only that part loses the colour; the rest keeps it |
| 9 | Press the chain, type an address, press Enter | The words become a link. Cmd-K reopens the field with the address already in it; Escape leaves the field and puts the caret back in the note |
| 10 | Press the chain again, then **✕** | The link comes off, the words stay |
| 11 | Press **Tx** over a mixture of marks | All of it goes back to plain text, links included |
| 12 | Select inside a heading | The first row says "Heading 2"; **B** is greyed out there, because the pad already draws headings bold |
| 13 | Press the first row | The Basic blocks menu opens with a ✓ on the type you are in. Pick "Bulleted list": the heading becomes a real bullet, not a heading with a list inside it |
| 14 | Select inside a table cell | The block row is not offered — only the marks |
| 15 | Type anything | The toolbar goes away |
| 16 | Wait a second, then open the note in Zotero | Bold, italic, underline, strikethrough, code, the link and the highlight are all there, in Zotero's own formatting, editable there |
| 17 | Edit it in Zotero, come back, reopen the pad | What Zotero wrote comes back into the pad with its formatting |
| 18 | **eye** — put the pad against a dark reader theme and a custom background | The toolbar takes the same colours; the link and the code chip stay readable against both |
| 19 | **eye** — paste some rich text from a web page | It arrives as plain text. That is deliberate and unchanged; the toolbar is how formatting is added |

### The note pad does not fight the reader

This is the section to re-run after any change to the pad, because every item is
something that was broken by an earlier design.

| # | Step | Pass |
| --- | --- | --- |
| 1 | Highlight something, then click into the pad and type `h` | The letter appears. The hand tool does **not** turn on |
| 2 | Type digits `1`–`8` in the pad | They appear. The highlight colour does **not** change |
| 3 | Select a highlight, then press Backspace in the pad | A character is deleted from the note. **The annotation survives** |
| 4 | Select text in the pad and press Cmd/Ctrl+A, then Cmd/Ctrl+C, then paste elsewhere | The note text, not an annotation |
| 5 | Press the arrow keys in the pad | The caret moves. Focus does not jump to a toolbar button |
| 6 | Press Tab in the pad | Focus leaves the note. This is expected — the reader owns Tab and cannot be overridden |
| 7 | Paste rich text (from a web page) into the pad | It arrives as plain text |
| 8 | Press Escape | The pad closes |
| 9 | Right-click the page with the pad open | The context menu appears **above** the pad |
| 10 | Open Find (Cmd/Ctrl+F) | The find bar is not covered by the pad |
| 11 | Open two papers in two tabs, open a pad in each, type in both | Each paper keeps its own text |
| 12 | Type continuously for ten seconds without pausing, then quit Zotero | Reopen: everything is there. The 2.5 s ceiling, not just the idle debounce, is what makes this pass |

### A note edited in two places

| # | Step | Pass |
| --- | --- | --- |
| 1 | With the pad open, edit the same "Paperly Notes" note in Zotero's own note editor | The pad picks up the change |
| 2 | Add a bullet list in Zotero's editor, then look at the pad | The text is flattened and the footer says the formatting was simplified |
| 3 | Do not type in the pad; check the note in Zotero | The list is still there — the pad only writes when someone types in it |
| 4 | Rename the note's first line in Zotero's editor, then reopen the pad | Still the same note; the pointer, not the title, is what binds it |

### The panel's name

| # | Step | Pass |
| --- | --- | --- |
| 1 | Open the column | The header reads **Paperly AI**; hovering the × says "Close Paperly AI" |
| 2 | Hover the tab-bar button, then the reader toolbar button | Both say Paperly AI |
| 3 | Select text in the PDF, right-click | "Explain with Paperly AI" and "Ask Paperly AI..." |
| 4 | Open the View menu | "Paperly AI Panel" |
| 5 | Open Settings | The pane is listed as Paperly AI and its heading matches |
| 6 | Zotero → Add-ons | The plugin is listed as Paperly AI |
| 7 | Conversation → export Markdown | The file is `Paperly-AI-<scope>-<stamp>.md` and its first line is `# Paperly AI Conversation Export` |
| 8 | Capture an answer into notes | Still appends to the existing **Zotero WebAI Notes** — the note keeps its name on purpose |
| 9 | Settings → your existing settings | All present: the rename touched no pref key |

### Theme

Do this with Zotero itself in dark mode; that is the case the old code got
wrong.

| # | Step | Pass |
| --- | --- | --- |
| 1 | Open the column, sign in to a provider, note the page you are on | — |
| 2 | Press the theme button once | The **whole** column flips: header, toolbar, status line, and the provider's page inside the frame. Not just the header |
| 3 | Look at the page you were on | Same page, same scroll, still signed in — a theme change must not reload the frame |
| 4 | Press once more | Back to dark, in one press. No third state that looks the same as another |
| 5 | Hover the button | It names where a press goes ("Switch to light mode"), not where you are |
| 6 | Switch provider, then flip the theme, then switch back | Both pages follow the theme |
| 7 | Reload the frame while in light | The page comes back light — the override survives the reload |
| 8 | Settings → Theme mode → Follow system | The header resolves it; pressing the button then switches away from whatever the system gave |

### The pad floats over both panes

Start here: **typing is the one thing not verified by machine.**

| # | Step | Pass |
| --- | --- | --- |
| 1 | Open the pad and type a sentence | Every character lands, the caret behaves, Backspace and Enter work |
| 2 | Select some of it, press Cmd-B | It goes bold; the format bar appears over the selection |
| 3 | Type `/` at the start of a line | The block menu opens and is clickable, at full size — not squeezed into the pad |
| 4 | Open the emoji picker and the colour menu | Both open at full size and are clickable |
| 5 | With a menu open, click the reader's own toolbar | The menu closes. By hand only: `sendNativeMouseEvent` reaches Zotero's chrome and the pad, and a click aimed inside the reader's `<browser>` was delivered to neither document — so this row has never been machine-checked |
| 5b | With a menu open, click the rendered page | The menu stays open. Known and deliberate: the page is a frame inside the reader's `<browser>`, so no document above it hears the press. Escape closes the pad and takes the menu with it, and so does a press on the pad |
| 6 | Click on the paper anywhere the pad is not | The click reaches the paper: text selects, annotations work |
| 7 | Click in the AI column anywhere the pad is not | The column responds normally |
| 8 | Drag the pad onto the AI column | It goes, and stays on top of the column |
| 9 | Type into it while it is over the column | Still works |
| 9b | Drag it fast, faster than it can keep up | It keeps following. If the pointer gets ahead and the pad stops dead, the clip is being re-cut mid-drag — `surface.dragging` is what stops that |
| 10 | Click the column just beside the pad | The column responds — the pad only catches its own box |
| 11 | Switch to another paper's tab | The pad stays put and keeps showing the first paper; the footer still names that paper |
| 12 | Press the second paper's Notes button | The pad re-pins: same place and size, the second paper's note, and the first paper's text is saved |
| 13 | Press that same button again | It closes |
| 14 | Switch to the library tab | The pad behaves the same — it belongs to a paper, not a tab |
| 15 | Close the tab the pad is pinned to | The pad closes and the note is saved |
| 16 | Reopen, drag to an edge, close, reopen | Comes back where it was left |
| 17 | Resize the Zotero window smaller | The pad stays inside it |
| 18 | Close the pad, then use Zotero normally for a minute | Nothing anywhere is unclickable |
| 19 | Change the pad's font and background | Both still apply |
| 20 | Type, then check the note in Zotero's own note editor | The text is there |

### The pad opens, moves and lands

| # | Step | Pass |
| --- | --- | --- |
| 1 | Open the pad from the toolbar button | It grows out of the button rather than appearing whole; the header reads **Paper Notes** |
| 2 | Hover the header | Cursor is an open hand |
| 3 | Press and hold the header | Cursor becomes a closed hand and the pad lifts — a deeper shadow, very slightly larger |
| 4 | Drag it around fast | It keeps up with the pointer with no lag or stutter, and never leaves the paper pane |
| 5 | Drag it to within a finger's width of any edge | It takes hold of the edge and a ring pulses once |
| 6 | Let go | It settles with a small bounce and stays exactly where it was dropped — no jump back |
| 7 | Close and open again | It comes back at the dropped position |
| 8 | Drag the corner grip | Resizing still works and is unaffected |
| 9 | Close it | It shrinks away rather than vanishing |
| 10 | Press the button twice quickly while it is closing | It comes back open; it must not be left half-closed or stuck |
| 11 | macOS → Settings → Accessibility → Display → Reduce motion, then repeat 1–9 | Everything lands in the same places, instantly, with no animation |
| 12 | Type into the pad, then drag it | The text and the caret survive the move |

### The reader toolbar survives a wide column

| # | Step | Pass |
| --- | --- | --- |
| 1 | Open a PDF, open the column, drag the splitter left slowly | Around a paper width of 900px the reader's buttons step down a size and the page total "/ 37" drops; the current page stays |
| 2 | Keep dragging | Nothing in the reader's toolbar ever sits on top of anything else, and no button is cut off at the right edge |
| 3 | Keep dragging to the end | The drag stops with roughly 620px of paper left and will not go further |
| 4 | Drag back right | Past ~900px of paper the buttons return to full size and "/ 37" comes back |
| 5 | Every reader button | All still there and clickable at the narrow size: sidebar, zoom ×3, reading mode, read aloud, back, page up/down, the six annotation tools, the colour dropdown, Aa, search, split view |
| 6 | Type a page number in the narrow input | Still accepts up to 4 digits and jumps to that page |
| 7 | Open an EPUB, repeat | Same behaviour; the floor adjusts to that toolbar's own controls |
| 8 | Close the column, make the Zotero window ~800px wide | The reader's page total is covered by its own buttons **only if this build predates the fix** — with the fix the toolbar switches to the narrow metrics on its own |
| 9 | Zotero's own main toolbar (library view, narrow window) | Unchanged — the narrow metrics are scoped to the reader document |

### The two panes divide on the same line

The point of this one is a straight edge. Put a ruler, a window edge, or a
screenshot guide across the top of the window.

| # | Step | Pass |
| --- | --- | --- |
| 1 | Open a PDF, open the column | The rule under the reader toolbar and the rule under the Paperly AI bar are **one continuous line** across the splitter |
| 2 | Look at the bar | One line of text: **Paperly AI**. No second line under it |
| 3 | Press Conversation | The first rule does not move; the scope card appears **below** it as its own band |
| 4 | Press Google Search | The band goes; the rule stays where it was |
| 5 | Drag the splitter narrow | The name ellipsises rather than pushing the dropdown or the buttons off the bar |
| 6 | Settings → Workspace layout → Compact | The bar is still 41px and still aligned |
| 7 | Flip the theme | Both rules keep the same colour relationship; neither band loses its edge |

### Header chrome

| # | Step | Pass |
| --- | --- | --- |
| 1 | Look at the header | No `Stacked` / `Compact` chip next to the theme button |
| 2 | Settings → Workspace layout → Compact | The layout still changes — only the chip went |
| 3 | Open the column on Google Search or AI Web | No Current Scope card; the page starts right under the header |
| 4 | Press Conversation | The card appears, naming the current item and its loaded text |
| 5 | Press Google Search | The card goes again |
| 6 | With no item selected, press Conversation | The card appears and reads "No item selected" |

### The plugin's icon

| # | Step | Pass |
| --- | --- | --- |
| 1 | Look at the button in the tab bar, on a retina screen | The mark is crisp, not soft. If it is soft, the button is being served `icon-20.png` instead of `icon-48.png` |
| 2 | Look at it beside Zotero's own toolbar icons | A navy tile. At this size the emblem's detail is gone -- that is the known trade for carrying the whole logo; see `assets/icon/README.md` |
| 3 | Open Settings and find the Paperly AI pane | Its icon is the same mark, from `icon-20.png` |
| 3b | Compare the tab-bar button with the chevron and sync icons beside it | It sits a little larger than them and lines up on the same centre. If it looks small, the padding in `styles.css` has crept back to 4px |
| 4 | Open the plugin manager | The whole emblem: crown, circuit ring, **A.I.** eyes, INTELLIGENCE ribbon. Nothing clipped at any edge -- if the crown's top ball is cut, the zoom has crept past 1.10 |
| 5 | Switch Zotero between light and dark | The icon holds on both -- the emblem's field is navy either way, by design |
| 6 | Look at the floating bot | Her face on a rose plate, her ears and ahoge over the rim, from `bot-anya.png`. The emblem here means the bot is being served an `icon-*.png`; a dark square behind her means a stale strip with its field still baked in |

## The AI column is never duplicated

| # | Step | Pass |
| --- | --- | --- |
| 1 | Open the AI panel, then View ▸ Paperly AI Panel twice more | Exactly one panel. Two panels sharing the row is the bug this checks |
| 2 | With the panel open, install a plugin update or disable and re-enable the plugin, without restarting | Still exactly one panel, and the splitter beside it is a single handle |
| 3 | Drag the splitter | One handle moves. Two handles stacked means a stale splitter survived a reload |
| 4 | Close the panel, reopen it, ten times | Still one of each. `sweepColumnNodes` is what guarantees this; see `PAPERLY-FORK.md`, "Two panels fighting over the row" |

The count is what matters, and ids do not prove it -- duplicated nodes share the
id, so `getElementById` reports one either way. Count with
`document.querySelectorAll('#zotero-webai-pane').length`.

## Reading status

`src/modules/readingStatus.ts` draws it, `src/services/readingStatusStore.ts`
keeps it; `docs/READING-STATUS.md` says why it is built this way.

| # | Step | Pass |
| --- | --- | --- |
| 1 | Open the library and look at the **left** of the item list, before Title | A narrow column headed with a tick, one empty box per regular item. **No column at all means it registered and was hidden** -- see READING-STATUS.md, `defaultIn` |
| 1b | Look at the Title column beside it | It still has the item type icon and, on an item with attachments, an expand arrow. Either of those appearing in the tick or star column instead means the primary-column fix has been lost -- see READING-STATUS.md |
| 1c | Expand an item with attachments | It expands, and the child rows are indented under **Title**, not under the tick |
| 2 | Expand a paper and look at its notes, PDF and snapshot | Each child row has **no box and no star at all** -- not an empty one. An empty box on a child means `renderCell` is reading `""` as "unread" again |
| 2b | Look at the two column headers | They read **Reading status** and **Starred** in full, not a tick and a star, and neither is truncated |
| 3 | Click a box | It fills blue with a white tick, and **the row must not become selected**. A row that selects means the cell lost its `clickable` class |
| 4 | Click it again | Back to an empty box |
| 5 | Click the box on a row that is *already* selected | The status toggles and the selection is unchanged -- no rows added or removed from the selection |
| 6 | Click the column header | It sorts. Unread first ascending |
| 7 | Select a paper, open the item pane, find Reading status | Three buttons; the current one is filled |
| 8 | Press Reading there | The item-list box shows a filled square, not a tick -- that is the middle state |
| 9 | Right-click one paper ▸ Reading status ▸ Read | The box ticks |
| 10 | Select three papers, right-click ▸ Reading status ▸ Read | All three tick |
| 11 | Restart Zotero | Every status is still there |
| 12 | Set a paper to Read, then delete it permanently (Bin ▸ Delete) | Its row leaves `paperlyReadingStatus`. Check with `sqlite3 <datadir>/zotero.sqlite "SELECT * FROM paperlyReadingStatus"` **with Zotero closed** -- the database is locked while it runs |
| 13 | Click a box, then immediately check the item's Date Modified | Unchanged. The redraw uses a `refresh` notification, not `modify`; a changed date means it is telling the sync engine about an edit that never happened |

Row 3 is the one to distrust a pass on. The click arrives as `click`, while the
row's selection is suppressed by a capture-phase handler on `mousedown` and
`mouseup` -- two different mechanisms, and a cell can easily get one without the
other. See READING-STATUS.md.

## Starred papers

`src/modules/starredPapers.ts`; `docs/STARRED.md` says why the star is a tag
while reading status is a table.

| # | Step | Pass |
| --- | --- | --- |
| 1 | Look at the item list | A narrow column headed with a star, one hollow star per regular item |
| 2 | Click a hollow star | It fills amber, and **the row must not become selected** |
| 3 | Look at the item's title in the same row | A `★` now shows beside it. That is Zotero drawing the tag itself, not a second copy of this column |
| 4 | Look at the collection tree | A saved search **Starred Papers** has appeared |
| 5 | Click that folder | The paper is in it |
| 6 | Star a second paper | It joins the folder. **No second folder is created** |
| 7 | Un-star everything | The folder stays, and is empty. It is a search, not a bin |
| 8 | Delete the folder, then star a paper again | The folder comes back. Matching is by name, so this is expected |
| 9 | Rename the folder, then star another paper | No new folder appears -- the rename means the name no longer matches, so if a second one *does* appear that is the bug |
| 10 | Check the paper's Date Modified after starring | It **is** bumped. A tag is a real edit and sync must hear about it -- this is the opposite of reading status, where it must not move |
| 11 | Open the tag selector | `★` is listed like any other tag, with no colour assigned |
| 12 | Right-click `★` in the tag selector ▸ Assign Colour | It works, and the number key then toggles it. Nothing in the plugin should break; it does not care whether a colour exists |
| 13 | Click the star column header | It sorts, starred first |
| 14 | Restart Zotero | Stars and folder are still there. Unlike reading status, these also survive a sync to another machine |

Row 6 is the one to distrust a pass on: the folder is created from the click
handler, so a race there would make one folder per star.

## The floating bot

Everything here is `src/modules/floatingBot.ts`; `docs/BOT.md` says why it is
built the way it is.

| # | Step | Pass |
| --- | --- | --- |
| 1 | Start Zotero and look at the bottom-right corner | Her face floats there inside a bubble, with a catchlight on its upper left, a rose bloom and a shadow under it. The page must show **through** the glass around her |
| 2 | Watch it for a few seconds | It bobs and squashes slightly at each end of its travel, the bloom breathes, the catchlight drifts, and two faint rose rings turn around it in opposite directions |
| 2b | Keep watching for about six seconds | She blinks twice, unevenly spaced -- about 3.0s then 2.4s apart. Each blink is one held half-shut frame, one shut, one half again. A blink that reads as a flicker means the strip is misaligned: `background-size` must be exactly three times the drawn width |
| 3 | Click it | The Paperly AI panel opens |
| 4 | Click it again | The panel closes. The halo and the rim go back from steel blue to rose, and the on-air dot at her lower right goes out |
| 5 | Hover it | A bubble appears on the side with more room, reading **Paperly AI** and how to use it |
| 6 | Click something 200px away from it | Zotero gets the click. The bot only catches what is inside its own 140px box -- if the window has gone dead, the dock's clip is not being cut |
| 7 | Drag it to the middle of the window and let go | It follows the pointer, and stays where it was dropped. It must **not** open the panel: a press that travels is a drag, not a click |
| 7b | Drag it fast, in a circle, and watch what is *not* the bubble | The bubble falls behind the pointer, stretches along the way it is going and squashes across it; the rings and the bloom are dragged further still and arrive later. Nothing may fall behind by more than about 18px -- more than that means `LAG_MAX` is not being applied and the clip will cut the wobble |
| 7c | Throw it hard at the middle and let go | It overshoots and swings back about four times over ~0.7s, then settles. No straight edge may appear at any point of the wobble; that is `MOTION_BLEED` failing |
| 8 | Drag it to within 36px of an edge | It snaps flush. The bubble still sits 22px clear of the edge, because that much of the box is the paint budget |
| 9 | Restart Zotero | It comes back where it was left |
| 10 | Shrink the window until the corner passes the bot | It is pushed back inside, never left off screen |
| 11 | Open a reader and put the note pad over the bot | The bot stays on top of the pad, and the pad still drags, types and takes a colour |
| 11b | Turn on Reduce Motion in System Settings and restart | The bob, the rings, the bloom, the catchlight drift and the shadow all stop. She still blinks -- that is deliberate, see `BOT.md` |
| 11c | Hover it, then click it, watching the edge of the bloom | The glow and the click ripple fade off round on every side. **A straight grey edge anywhere means something is painting past `BOX / 2` and being guillotined by the clip** -- the arithmetic that must hold is in `BOT.md`, *The box never changes size* |
| 12 | View ▸ Paperly AI Bot | It goes. The menu entry stays, unchecked |
| 13 | View ▸ Paperly AI Bot again | It comes back, in the same place |
| 14 | Right-click it | No native context menu, and no bubble text beyond the name |
| 15 | Hover it | A bubble reading **Paperly AI** and nothing else. Any "Click to open" text means an old build |
| 16 | Hover it and look at the top right of its box | A small **×** fades in, clear of her face. It must be invisible when not hovered, and gone while dragging |
| 17 | Press the × and drag | It must **not** carry the bot. A press there is a close, not a grab |
| 18 | Click the × | The bot goes. View ▸ Paperly AI Bot is now unticked |
| 19 | Click the Paperly AI icon at the top right of the window | The bot comes back, and the AI panel toggles as it always did |
| 20 | Click that icon again | The panel toggles. The bot is untouched -- restoring is a no-op once it is there |

Row 6 is the one to distrust a pass on. `clip-path` drives hit-testing, so a
frame that is not being clipped looks identical and swallows the whole window.
Measured in the running app: the bot's centre resolves to
`iframe#paperly-overlay-bot`, 200px to its left resolves to Zotero's item
table.


### Regression check

DeepSeek, Z.ai and ChatGPT must keep working. The session-restore change and the
tab-bar button rehost both touch shared paths.

Switch reader → library → reader a few times. The tab strip must never shift or
re-lay out, and the button must hide and show without moving the tabs. If the
tabs jump, the button is back inside `#tab-bar-container`.

## Debugging

Zotero launches with `-jsconsole`; errors appear there. The launcher also writes
debug output to stdout. To search a captured run:

```bash
grep -i webai <output-file> | head -30
grep "JavaScript error" <output-file> | grep -i webai
```

A failed page load is silent — there is no load-failure detection. A blank panel
means the page did not load, not that the plugin crashed.
