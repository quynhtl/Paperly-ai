# Paperly fork of Zotero WebAI

Status 2026-09-27. Branch `feat/paperly-claude-gemini`.

This file is the *why*: what was tried, what broke, and what must not be put
back. For *where do I change this*, read `NOTE.md`. For *does it still work*,
`TESTING.md`. For *how do I add a provider*, `ADDING-A-PROVIDER.md`. For the
floating bot, `BOT.md`.

## Goal

A Zotero research workspace with three panes: library, paper, and an AI panel
where the user signs in to each provider directly. No API keys.

## Making the web panel work on Zotero 11 — SOLVED

The panel renders. Getting there meant fixing four stacked bugs, each of which
hid the next, so they must be understood together.

### 1. Upstream never loaded the page at all

`createWebFrame` called `loadFrameElement()` **before** the element was appended
to the document. A detached XUL `<browser>` has no frameLoader, so `loadURI()`
failed harmlessly and logged `Failed to load Web AI browser`. Upstream looks
stable on Zotero 11 only because it never loads anything — the panel is inert,
not working. Verified on a clean profile: upstream loads no provider URL.

Fix: append first, then load.

### 2. Loading a freshly created browser segfaulted Zotero

With the load actually reaching Gecko, the content process died
(`Exiting due to channel error`) and the parent segfaulted with `EXC_BAD_ACCESS`.

Setting `remote="true"` as an attribute is not enough. Every place Zotero itself
loads a third-party site into a dynamically created browser
(`chrome/content/zotero/import/mendeley/authViewer.js`,
`chrome/content/zotero/HiddenBrowser.mjs`) explicitly calls
`changeRemoteness()` and then `construct()` before the first `loadURI()`.

Fix: `primeBrowserRemoteness()` does that. The crash disappeared and all four
providers loaded.

### 3. The browser computed to width 0

Loaded, no errors — but invisible. Firefox's UA sheet
(`chrome/toolkit/content/global/xul.css`, extracted from `omni.ja`) applies:

```css
browser {
  min-height: 0;
  min-width: 0;
  contain: size;
}
```

`contain: size` means a `<browser>` has **no intrinsic size**; it depends
entirely on its containing block. The panel mounted and loaded while its Zotero
container was still collapsed, where the whole ancestor chain measured 0px wide,
so the plugin's `width: 100%` resolved to 0.

The asymmetry that made this confusing — `width: 0` but `height: 360` — is
because the plugin's own sheet raises only the vertical floor
(`min-height: 360px` in `addon/content/styles.css`) while leaving
`min-width: 0`.

Fix: a `ResizeObserver` on the host defers the load until the host actually has
width, which is also the moment the user opens the pane.

Note: `contain: layout paint` on `.ai-assistant-pane` is **not** involved.
Layout and paint containment never change an element's size — only `contain:
size` does. Do not waste time removing it.

### 4. A remote browser loads and sizes correctly but never paints

Correctly sized (611×360), page loaded, no errors, nothing hidden — still blank.

Zotero hit the identical wall for its own item-pane browser and documented it in
`chrome/content/zotero/elements/abstractBox.js`:

> `fx128: about:blank no longer displays content when loaded remotely`

They fell back to `remote="false"`.

Fix: load in-process. `createWebFrame` sets `remote="false"` and
`primeBrowserRemoteness` calls `changeRemoteness({ remoteType: null })` then
`construct()`. The page renders.

### Why this took so long

`remote="false"` was tried early and dismissed — but at that point
`construct()` was missing *and* the width was still 0, so the experiment could
only fail. A correct hypothesis was rejected because two other bugs masked it.
When several faults stack, a single negative result does not clear a suspect.

## How the embedding is meant to work

`createWebFrame` (`src/ui/components/WebAIWorkspace.tsx`) creates a XUL element:

```ts
const browser = maybeXULDoc.createXULElement?.("browser");
browser.setAttribute("type", "content");
browser.setAttribute("remote", "false");
```

then `primeBrowserRemoteness()` and `loadURI(uri, { triggeringPrincipal })`.
That is a *top-level* load, not a subframe, so `X-Frame-Options` and CSP
`frame-ancestors` do not apply — which is why Claude and Gemini can be embedded
at all. Login persists for free, since the browser uses Zotero's profile cookie
jar.

## Prompt injection and answer capture

There is **no per-provider selector table**. Injection, submission and capture
are generic scored heuristics over `textarea`, `[contenteditable]`,
`[role=textbox]` and anything button-like, with a shadow-DOM-piercing query.
Submission escalates through native click, native paste, native Enter, DOM
Enter, candidate button clicks, coordinate clicks, Ctrl/Meta-Enter, and
`form.submit()`. Answer capture polls (no MutationObserver): 120 attempts at 1500 ms
needing 3 stable reads.

Adding a provider needs no new selectors, but there is also no clean
per-provider hook. Now that the frame renders, this path is reachable but still
untested per provider — see TESTING.md.

A second path, `insertPromptWithFrameScript`, builds a frame script by
stringifying helpers with `fn.toString()`. **Any new helper used during
injection must be added to that list**, or it will not exist in the content
process.

## What this fork changed

| Change | File | Why |
| --- | --- | --- |
| `strict_max_version` `9.*` → `11.*` | `addon/manifest.json` | Local Zotero is 11.0; the plugin was otherwise rejected as incompatible. |
| Added `claude` and `gemini` to the id union and `SERVICES` | `WebAIWorkspace.tsx` | The two requested providers. |
| Replaced a hardcoded id check with `isKnownServiceID` | `WebAIWorkspace.tsx` | Session restore hardcoded `"zai" \|\| "chatgpt"` and silently reset anything else to `deepseek`, which would have dropped every Claude/Gemini session. Now validates against `SERVICES`. |
| Deleted `ModelSelector.tsx` | `Sidebar.tsx` | Dead UI: no `onSelect` prop, local state only, so clicking it did nothing. It also held a stale provider list on a different id scheme. |
| Provider row → dropdown | `WebAIWorkspace.tsx` | Five flat buttons did not fit the toolbar. |
| Registry extracted to `ui/webAIServices.ts` | new file | The Sidebar header needs it; importing a 10k-line component for a list of URLs is not reasonable. |
| One selector, in the shell header | `Sidebar.tsx`, `ModelSelector.tsx` | There were two provider controls and one of them was a stub that did nothing. |
| `kind: "chat" \| "lookup"` | `webAIServices.ts` | Dictionary and search pages have no prompt/answer cycle; the chat surface is hidden for them. |
| `applyPlainUserAgent()` | `WebAIWorkspace.tsx` | Claude's login spun forever behind Cloudflare Turnstile. |
| Added `hasStoredSession` | `WebAIWorkspace.tsx` | Opens the login window when a provider has no usable cookie. |
| Tab-bar button moved to `#zotero-tabs-toolbar` | `readerIntegration.ts` | The old target was a React root, and the button doubled the title bar's height. |
| A floating bot over the whole window | `floatingBot.ts`, `overlayDock.ts` | One click into the AI panel from anywhere, and the emblem where it can be seen. See `BOT.md`. |
| `new CustomEvent` → `createHostCustomEvent` | `utils/windowLifecycle.ts` | Fixes a thrown `ReferenceError`. |
| Load after append, `remote="false"`, `primeBrowserRemoteness()`, `ResizeObserver` gate | `WebAIWorkspace.tsx` | The four fixes that make the panel render on Zotero 11. |
| An emoji picker in the note pad | `readerNoteEmojiPicker.ts`, `emojiCatalog.ts`, `scripts/build-emoji-data.mjs` | Asked for, with a reference to Notion's picker. Searchable in English and Vietnamese because that is who writes the notes. |
| A note pad for the open paper | `readerNotePanel.ts`, `readerNoteStore.ts`, `readerTheme.ts`, `readerNoteFonts.ts` | Notes on a paper belonged in the reader, not in a separate window. See below for the four things that had to be measured. |
| `scripts/dev-reload.sh` | — | Build and install into an **isolated dev profile**. |
| `Zotero WebAI` → `Paperly AI` in every string a user reads | `package.json` config, both locales, `Sidebar.tsx`, `readerIntegration.ts`, `preferencesPane.ts`, `webAIColumn.ts`, `mcpClient.ts`, `WebAIWorkspace.tsx` | Asked for. Identifiers kept the old spelling — see below. |
| The workspace takes `theme` and `isDark` from the shell | `Sidebar.tsx`, `WebAIWorkspace.tsx` | It resolved its own theme **with no mode**, so every surface below the header followed the OS and ignored the toggle. |
| `applyFrameColorScheme()` | `WebAIWorkspace.tsx` | A dark panel still held a white page. |
| The theme counter stopped being a React `key` | `Sidebar.tsx` | Changing a key unmounts the subtree: every theme change destroyed the `<browser>` and the signed-in page with it. |
| Two-state theme toggle | `ThemeToggle.tsx` | `auto → light → dark` with the host already dark meant one press in three did nothing visible. |
| The workspace-layout chip is gone | `Sidebar.tsx` | A read-only label for a preference, sitting in a row of controls. |
| Current Scope only in Conversation | `Sidebar.tsx` | It describes what a prompt would be about, and the web view has no prompt. |
| The header top bar is 41px, the name on one line | `Sidebar.tsx`, `styles.css` | Zotero's toolbar height. The two-line header was 55px, so the rule under the panel started 14px below the rule under the paper. |
| Narrow-reader metrics for Zotero's own toolbar | `readerIntegration.ts` | Its 793px of controls have no responsive rule and overlap when squeezed. Tightened, they need 614px. |
| The column clamps against that requirement | `webAIColumn.ts`, `readerPrivate.ts` | `MIN_PAPER_WIDTH` was 200px, which let a drag reach a width where the toolbar is broken. |

### One provider selector, in the shell header

There used to be two. `ModelSelector` sat in the shell header and looked
authoritative, but it was a stub: its own hardcoded `BUILTIN_SERVICES` list used
a different id scheme (`deepseek-web` vs `deepseek`), omitted Claude and Gemini,
carried a `"Custom Web AI"` entry wired to nothing, and its `handleSelect` only
set local state — there was no `onSelect` prop, so clicking it changed a label
and nothing else. The working control was a second dropdown down in the
workspace toolbar.

Now `Sidebar` owns the selected provider and passes it to both `ModelSelector`
and `WebAIWorkspace`; the toolbar dropdown is gone. `WebAIWorkspace` no longer
holds the state, so it reacts to the change in an effect rather than in a click
handler — the effect skips its first run so that merely opening the panel never
pops a login window.

The menu groups chat providers and look-up pages under separate headings, and
the status dot reports `hasStoredSession` (signed in / not) instead of the old
hardcoded `"online"`. Cookie lookups run once per opening, not per render.

Selecting a chat provider with no usable cookie opens the login window and
reports it through the existing `loginWindowOpened` string. The menu closes on
selection, on pointer-down outside, and on Escape.

### Paperly AI, and what kept the old name

The panel is called **Paperly AI** everywhere a user can read it: the shell
header and its close button, the reader toolbar button and its tooltip, the
reader's right-click menu, the selection popup's Explain/Ask group, View →
Paperly AI Panel, the preferences pane, the add-on name in the Add-ons manager,
the conversation export header and its filename, the MCP `clientInfo.name`, and
the instruction text sent to the provider. Both locales.

Four things deliberately kept the old spelling, because each one identifies
stored state rather than the product:

| Kept | Where | What would break |
| --- | --- | --- |
| `zotero-webai@lineex.dev`, `extensions.zotero.zotero-webai.*`, `Zotero.ZoteroWebAI` | `package.json` config, `prefs.js` | Every stored setting is addressed by these. A rename is a factory reset. |
| `zotero-webai-*` class names and element ids | `styles.css`, everywhere | Stylesheet and DOM contract; invisible to the user. |
| `ZOTERO_WEBAI_MCP_REQUEST` / `END_…` | `WebAIWorkspace.tsx` | A wire marker agreed with the model mid-conversation. |
| `"Zotero WebAI Notes"`, `Zotero-WebAI-config.json` | `WEBAI_NOTE_TITLE`, `DEFAULT_CONFIG_SYNC_REMOTE_PATH` | The title of a note already in the library, and the name of a file already on a WebDAV server. Renaming either starts a second one beside the first. |

The title of this file still says *fork of Zotero WebAI*: that names the
upstream project it was forked from, which has not been renamed.

### The theme reaches the whole panel, and the page inside it

Three separate faults, which is why the toggle looked dead.

**1. Everything below the header ignored the mode.** `Sidebar` resolved
`getSidebarTheme(hostWindow, themeMode)`, but `WebAIWorkspace` called
`getSidebarTheme(hostWindow)` — no mode, so the `auto` branch ran and the
toolbar, status line, composer, transcript and frame host all followed the OS.
With Zotero itself dark, picking Light repainted the header and nothing else.
The theme is now resolved once, by the shell that owns the mode, and passed
down as `theme` and `isDark`.

Measured on the dev profile, with `matchMedia("(prefers-color-scheme: dark)")`
reporting **true** throughout — so nothing that reads the OS could have
produced the light column:

| | shell | toolbar | `data-theme` | page |
| --- | --- | --- | --- | --- |
| dark | `rgb(38,39,43)` | `rgb(52,55,64)` | `dark` | `dark` |
| one press | `rgb(247,247,247)` | `rgb(255,255,255)` | `light` | `light` |
| one more | `rgb(38,39,43)` | `rgb(52,55,64)` | `dark` | `dark` |

**2. `auto` and `dark` painted the same panel.** The toggle cycled
`auto → light → dark`, and on a dark host the first two steps of that cycle are
indistinguishable — one press in three visibly did nothing. It is now two
states: it reads whatever the mode resolved to and switches away from it.
Preferences still offers Follow system; the header just resolves it.

**3. The page inside stayed white.** A provider page picks its colours from
`prefers-color-scheme`, which normally comes from the OS. Gecko lets a single
browsing context override that query —
`browsingContext.prefersColorSchemeOverride`, the same switch DevTools'
colour-scheme simulation uses — so `applyFrameColorScheme()` sets it to match
the panel.

The override lives on the browsing context, and `changeRemoteness()` plus any
process swap replaces that object. So it is applied **after** the load (never
before: priming rebuilds the frame loader), again on every navigation, and
again for every open provider whenever the theme changes. `isDark` is read
through a ref in the first two, so a theme change does not re-run the mount
effect and reload the page. An `<iframe>` fallback has no browsing context and
is left alone.

### The header is a toolbar, and it is the same height as the reader's

The column and the reader tab are siblings in the same deck row, so they start
at the same y and their first horizontal rule should be the same line. It was
not: measured in screen space, the reader toolbar ran `80 -> 121` and the panel
header `80 -> 92.18 + ...`, ending **14.18px** lower. Two rules, 14px apart,
across a 5px splitter.

The reader toolbar is `height: 41px !important; box-sizing: border-box` with the
1px rule inside it -- `$height-toolbar` in `reader/src/common/stylesheets/
abstracts/_variables.scss`, and the same 41 in the main app's
`scss/abstracts/_variables.scss`. The panel header was 55.18: `10px` padding
twice, plus a title block of 34.18 (`Paperly AI` at 16.9, a 2px gap, and
`Web AI reading workspace` at 15.28), plus the rule.

The header is now two bands, each drawing its own rule, and the header itself
draws none:

| Band | Height | When |
| --- | --- | --- |
| Top bar | `41px` border-box, `padding: 0 10px` | always |
| Scope band | content, `padding: 8px 10px` | Conversation only |

So the **first** rule is at 41px in both modes, and the scope band hangs below
it rather than pushing it down. The subtitle is gone: two stacked lines do not
fit a 41px bar next to 26px controls, and the reader's toolbar carries no
branding line either. Measured after: reader toolbar `80 -> 121`, panel top bar
`80 -> 121`, offset **0** in the web view and **0** in Conversation, with the
scope band running `121 -> 192.13`.

Two CSS rules went with it:

```css
.zotero-webai-shell[data-layout="compact"] .zotero-webai-shell-header {
  gap: 6px; padding: 8px;
}
```

Both were already dead -- the component set `padding` and `gap` inline and
inline wins -- but with the header no longer setting either, they would have
come alive and knocked the bar back off the 41px grid. The scope card's
`box-shadow: 0 1px 0` went too: it was standing in for a rule the band now
draws.

### The note pad floats over the whole window

It used to live in the reader's own document, so the reader's frame clipped it:
it could be dragged anywhere on the paper and nowhere else. Getting it over the
AI column meant getting it out of that document, and that turned out to have
exactly one answer.

**The window's own document cannot hold an editor.** `zoteroPane.xhtml` is
`application/xhtml+xml` with a `<window>` root and **no `<body>`**, so a
contenteditable there has no editing host. Measured: `execCommand("bold")`
returns `true` and changes nothing, `hiliteColor` and `insertHTML` return
`false`.

**An `about:blank` iframe in that window can.** Its document is `text/html`
with a body, so editing behaves exactly as it did in the reader — measured,
`bold` gives `<b>hello world</b>` and `hiliteColor` gives
`background-color: rgba(255, 212, 0, …)`. It is chrome-privileged, so there are
no Xray wrappers between the plugin and the pad's DOM, and `@font-face` keeps
working because `readerNoteFonts` already inlines the woff2 as a `data:` URI
rather than relying on a principal.

**The frame covers the window, and `clip-path` keeps it out of the way.** A
pad-sized frame was the obvious shape and the wrong one: the format bar, the
"/" menu, the colours and the emoji picker are all `position: fixed` and clamp
themselves to the viewport, so a frame the size of the pad would crush a 320px
emoji grid into a 260px box. Full-window, they keep the room they have always
had and none of those four modules needed a line changed.

What makes that safe is that `clip-path` drives hit-testing, not just painting.
Measured with a frame over the whole window and a two-subpath clip:

| Point | No clip | Clipped |
| --- | --- | --- |
| On the pad | the frame | the frame |
| On an overlay | the frame | the frame |
| Over the paper | the frame | **the `browser` underneath** |
| Over the AI column | the frame | **the `browser` underneath** |

So `syncClip` cuts the frame to the pad plus whatever it has open, and every
other pixel belongs to Zotero again.

#### One pad, pinned to a paper

The pad was per reader document; there is now one per window. It stays on the
paper whose button opened it, so you can read one paper and keep writing about
another — the footer names the paper it is writing to. Pressing a different
paper's button re-pins it rather than opening a second pad, flushing anything
half-written first. A button reads as pressed only while the pad is open *and*
pinned to that button's paper, and a reader tab closing closes the pad if it
was the one pinned.

Two things moved with that. The outside-click that dismisses the pad's menus
was listening on the reader's document, which the pad no longer shares; the
dock listens on the window instead, where by construction every pointerdown is
outside the clip. And teardown moved from the reader's `pagehide` to the
window's `unload`, with the reader's `pagehide` now only dropping that reader's
button.

Measured after, on the dev profile:

| | |
| --- | --- |
| Pad's home | in the dock (`panelInDock: true`, `panelInReader: false`) |
| Dock | 1465px over a 1465px window, `text/html` |
| Editing | focus lands, `insertText` and `bold` both take, the note's own font loaded |
| `/` menu | opens, clip grows, clickable inside |
| Press outside | menu closes, clip shrinks back |
| Dragged onto the column | pad at 824, column at 764 — over it, and clickable there |
| Beside the pad, over the column | falls through to the column |
| Closed | clip empty, the window gets every pixel back |
| Reopened | same place, same text |

The one thing not verified by machine is a real keystroke:
`windowUtils.sendKeyEvent` is not available in this build, so the evidence
stops at the focus chain being right (window → iframe → editor) and
`execCommand` driving the same editor. Typing is the first line of the manual
test list for that reason.

### Zotero's reader toolbar does not survive a narrow reader

Drag the column wide and the reader's page counter ends up underneath the
annotation buttons. It looks like the column's fault. It is not.

**The toolbar is 793px of controls with nothing responsive about it.** No width
media query, no `ResizeObserver`, no measuring in JS -- checked across every
stylesheet and component under `reader/src/common`. Measured on a 37-page PDF:

| | `.start` | `.center` | `.end` | padding | total |
| --- | --- | --- | --- | --- | --- |
| Stock | 418.6 | 245 | 117 | 12 | **792.6** |
| Narrow | 321 | 197 | 90 | 6 | **614** |

`.toolbar` is `justify-content: space-between` over those three, and they keep
their intrinsic width whatever the bar gets. Squeeze it and the gaps close;
squeeze further and the sections are simply drawn over each other.

**The page counter goes first, at a width where nothing else has broken yet**,
because of this in `_toolbar.scss`:

```scss
#numPages { display: flex; div { position: absolute; } }
```

Its text is out of flow -- Zotero's way of stopping the page input from
shifting as the digit count changes -- so `#numPages` is 3.6px wide while
painting 34.8px of text. The tools slide over it at a reader width of about
831px. The sections themselves touch at 793px.

**It reproduces in stock Zotero.** With this plugin's column closed and only the
window resized:

| Window | Counter covered by |
| --- | --- |
| 950px | not covered, 59.4px clear |
| 850px | not covered, 9.4px clear |
| 800px | **15.6px** |

Zotero's own floor is `$min-width-tabs-deck: 570px`, well under the 793 the
toolbar needs, so it permits this. The AI column only makes it easy to reach,
because it takes width from the paper.

#### Tightening the toolbar rather than holding the column back

`toolbarFitStyleSheet()` is injected into each reader document from
`onRenderToolbar` and applies below a **900px** reader -- above the 831 where
the counter starts being covered. Every control stays; the metrics shrink:
buttons 28 -> 24px, gaps 4 -> 2px, divider margins 4 -> 2px, the page input
52 -> 40px, the toolbar's own padding 8/4 -> 4/2. The page *total* is dropped,
because out-of-flow text cannot be squeezed, only covered -- the input beside
it still shows the page you are on.

That is **178.6px** the paper no longer needs. It is scoped to the reader
document on purpose: `.toolbar` also matches Zotero's own main-window toolbar.

#### And a floor that is the real requirement

`MIN_PAPER_WIDTH` was 200px, so a drag could put the paper far inside the
broken range. It is now whatever `getReaderToolbarMinWidth()` reads off the
live toolbar, plus 8px of slack -- and the reading falls on its own once the
narrow styles take over, because the sections it measures are the ones that
shrank. The library view has no toolbar to ask and keeps the old floor.

The splitter is subtracted too. Without that the paper lands a handle's width
under its floor; measured, paper 617 against a floor of 622.

Measured through the real drag path on a 1561px window, synthetic pointer
events on the splitter:

| Column | Paper | Toolbar needs | Buttons | Counter | Clearance |
| --- | --- | --- | --- | --- | --- |
| 581 | 975 | 780.6 | 28px | shown | 91.2px |
| 681 | 875 | 608 | 24px | hidden | 130.5px |
| 881 | 675 | 608 | 24px | hidden | 30.5px |
| **934** | **622** | 608 | 24px | hidden | **4px** |

The drag stops at 934 and no further, with nothing clipped at the bar's right
edge. Before this, the column could be dragged to 1356px -- but anything past
**725px** already had the counter buried. So the width that is actually usable
went from 725 to 934.

### What the header stopped showing

**The workspace-layout chip.** `Stacked` / `Compact` was a `<span>` with no
`onClick`, reporting a preference set elsewhere, placed in a row that is
otherwise all controls — so it read as a button that did nothing. The
preference itself is untouched: Compact still changes padding, gaps and the
chat pane's floor.

**Current Scope, outside Conversation.** The card names the item a prompt would
be about and how much of its text is loaded. The web view has no prompt — the
provider's page is the whole surface there — so in Google Search and AI Web it
was three lines describing something that mode cannot use. `Sidebar` already
mirrors the workspace's `panelView`; the card is gated on it.

### Why the AI column, and not a panel inside the reader tab

The reader panel was created per reader tab. `statesByReaderWindow` keyed on the
reader's iframe window, but every state wrote into the same
`mainWindow.document` and appended its nav button to the same rail. Three open
papers meant three Paperly AI icons stacked in that rail, three panels, and
three provider pages loaded at once.

One shared panel inside the reader tab is not possible. The panel lives in the
reader's container, which is a `<tab-content>` inside `<deck id="tabs-deck">`.
Following the active paper would mean reparenting it on every tab switch, and
moving a `<browser>` in the DOM destroys its frameLoader — the provider page
reloads and whatever is signed in inside it is thrown away. `swapFrameLoaders()`
is the only escape, and it is not worth the complexity here.

The column already solves it. `#zotero-webai-pane` is a sibling of `#tabs-deck`,
so it is outside the tab model entirely: nothing moves when the selected tab
changes, and the embedded browser keeps its session.

#### Two panels fighting over the row

Reported as "why are the two AI panels squeezing each other". Both were real
columns, side by side in the same `hbox`, each taking its share of the width.

Two defects, and either alone is enough:

- `createColumn` appended a fresh `#zotero-webai-pane` and splitter **without
  checking whether one was already in the window**. Every other module here
  sweeps first -- `overlayDock.ts` and `floatingBot.ts` both open with
  `getElementById(...)?.remove()` -- and this one did not.
- `removeWebAIColumn` worked entirely *through* `states`, and returned early
  when the map had no entry for the window. No state meant the DOM was never
  touched.

`states` is module-level, so **a plugin reload starts with an empty map while
the window's DOM still holds the previous load's column**. Teardown then saw no
state and left it; the next open saw no state and built a second one beside it.

Measured, by taking the column out of the DOM behind the module's back and
reopening: two `#zotero-webai-splitter-pane`, and the deck row up from six
children to seven. With `sweepColumnNodes` in both places it stays at one and
six.

The sweep uses `querySelectorAll`, not `getElementById`. Ids are supposed to be
unique and the whole bug is that they stopped being, so the first match is not
necessarily the stale one.

A third leak came out of the same divergence: `openWebAIColumn` replaced a state
whose column had gone without unregistering its tab observer or unmounting its
React root. `discardState` now does both before the replacement.

Two things had to be fixed before it could take over:

- **Location.** The column rendered `<Sidebar location="library">`, frozen at
  mount. `Sidebar` gates reader actions on
  `isSidebarLocationSelected(selectedType, location)`, so in a reader tab it
  would have silently dropped every Explain/Ask sent from the PDF and shown the
  wrong scope. It now resolves the location from the selected tab and re-renders
  on the `select`/`tab` notifier. React keeps the same element in the same
  position, so that updates props instead of remounting and the `<browser>`
  survives.
- **Width.** The column set `width: 380px` with the default `flex-shrink: 1`, so
  a crowded row could squeeze it toward zero — indistinguishable from the page
  failing to render. It is now `flex: 0 0 auto` with a real `min-width`. Safe,
  because `#main-window`'s `min-width` is an explicit value rather than `auto`,
  so nothing inside `#browser` can raise the window's own minimum.

`readerWebAIPanel.ts` is deleted: 1241 lines of per-tab panel, rail, nav button
and reader-iframe layout mutation.

### One surface per place, and none of them inside Zotero's item pane

The plugin used to paint WebAI in four places at once. Two were visible
together in a reader tab: a panel beside the PDF and a section in the item
pane. Worse, they each put an icon in the *same* strip — the item-pane section
registered a sidenav entry, and the reader panel's rail hunted for
`#zotero-context-pane-sidenav` / `#zotero-view-item-sidenav` and appended itself
there too. Two Paperly AI icons, in a strip Zotero owns.

The item-pane section is gone. `Zotero.ItemPaneManager.registerSection` is no
longer called, and `unregisterLegacySection()` now runs on every window load so
a profile upgrading from an older build loses the entry as well. Zotero's item
pane is a scroll of sections with a sidenav that calls `scrollToPane` — there is
no "this section takes over the pane" mode, so a WebAI section could only ever
be one more thing between Abstract and Tags. It does not belong there.

The rail is now always `embedded`: it lives inside the reader, never in Zotero's
sidenav. The sidenav-hunting heuristics (`findReaderSideNav`,
`findGlobalReaderSideNav`, `collectReaderSearchRoots`, `isUsableReaderSideNav`,
`READER_SIDE_NAV_SELECTORS`) are deleted — the same class of guess-at-Zotero's-DOM
code as the tab-bar button's `findMainTabbar`.

What remains:

| Where | Surface | Opened by |
| --- | --- | --- |
| Reader tab | Panel beside the PDF | tab-bar button, reader-toolbar button |
| Library or reader | AI column | View → Paperly AI Panel |
| Library, nothing selected | Empty-state head | automatic |

The `itemPaneButtonEnabled` preference went with the section. Nothing read it
any more, but it still rendered a checkbox that silently did nothing.

### Google Search and AI Web are dropdown shortcuts

The two leftmost toolbar buttons select a provider, exactly as the header
dropdown does: **Google Search** switches to the `google` look-up provider,
**AI Web** switches back to whichever chat provider was last in use. They exist
because those two are what a reader flips between constantly, and going through
the dropdown each time is three clicks instead of one.

They replaced a **Web Search** toggle that looked dead but was not. It armed
`webSearchEnabled`, which made the next prompt scrape DuckDuckGo and inject the
results as context. Three things hid that: it was a mode toggle rather than an
action, its effect only appeared on the next send, and the record it produced
was appended with `hidden: true` so it never showed in the conversation. The
keyword sniffer `shouldAutoUseWebSearch()` did the same thing unprompted on any
message containing "latest", "recent", "news", "search" and friends.

Both are gone. `/websearch` remains as the explicit, visible way to ask for it.

### How far the handle travels

Two things had to change, and the first attempt fixed only one of them.

Zotero pins `#tabs-deck` at `min-width: 570px`
(`scss/abstracts/_variables.scss`), which caps how wide the column can get. The
plugin relaxes that to 200px while the column is showing. The relaxation is
keyed off a `zotero-webai-column="open"` attribute that `openWebAIColumn` sets
on `#main-window`, with `!important`: Zotero's rule is an id selector too, and a
`:has()` version of this did not take effect at all. Stock Zotero keeps its own
floor whenever the column is closed.

That alone was not enough — measuring the reported screenshot put the deck at
roughly 930px, nowhere near either floor, so Zotero's `<splitter>` was stopping
short for reasons of its own. The splitter is therefore gone, replaced by a
plain `<div>` that sets `column.style.width` directly from pointer deltas. The
only limit left is the one the plugin chooses: at least `MIN_WIDTH` for the
column, and at least `MIN_PAPER_WIDTH` (200px) of paper still on screen.

`setPointerCapture` is required, not decorative: without it the embedded
`<browser>` swallows `pointermove` the moment the cursor crosses it. The stored
width is clamped against the current window on open, since it may have been
saved on a wider one.

### One surface at a time

The panel used to be two halves stacked vertically: the provider page on top,
the transcript and composer below, with a drag splitter between them. In a
column around 400px wide that leaves neither half usable.

There is now a single view, chosen by the first three toolbar buttons:
**Google Search**, **AI Web**, **Conversation**. Each fills the panel.

This is a net deletion rather than a new feature. "Hide Web" already collapsed
the page to show only the transcript — the same thing the Conversation button
does — and the splitter, `webFrameHeight`, `handleSplitterPointerDown` and the
`split` workspace layout all existed only to divide two panes that no longer
coexist. All of it is gone, along with eight orphaned style records and the
`resizeWeb` / `showWeb` / `hideWeb` / `displayHidden` / `displayRestored`
strings.

Making it actually fill took undoing the sizing the split layout left behind,
in two places. `styles.readerFrameHost` pinned `height: 220px` — the old top
half — and the component's inline `flex` override did not touch `height`. And
`.zotero-webai-workspace[data-layout="stacked"] .zotero-webai-web` carried
`flex: 0 0 auto !important`, which beats an inline style outright. Both the
`stacked` and `compact` rules now say `flex: 1 1 auto; min-height: 0`, and
`readerFrameHost`, `compactFrameHost` and `loginFrameHost` are deleted: with one
surface on screen there is nothing left for them to size.

The frame host is hidden with `display: none` rather than unmounted. Tearing it
down would destroy the `<browser>` inside it and sign the user out of the
provider, which is the same constraint that put this workspace in a column
instead of a panel inside the reader tab.

History and Clear stay with the transcript, so each view carries only the
actions that apply to it.

Splitting the views broke the one thing that reported what those actions did.
The status line lived inside `.zotero-webai-composer-footer`, which only renders
in Conversation mode, so an action taken from the web view said nothing at all.
It became its own bar under the toolbar — and then, once the web view had no
actions left that report anything, it went back to belonging to Conversation.
See "The web view is only the page" below.

The composer is worth keeping behind that third button even though it is not
really a chat: `Send` types the prompt into the provider's own input. Its value
over typing there directly is Zotero context — `/pdf` pastes the paper's full
text, plus the current scope, Skills and `/zotero-mcp`. Deleting it would mean
copying papers by hand.

### Translate, Dictionary and Google in the reader's selection popup

Selecting a word in a paper and not knowing it is the common case this fork is
for, so the look-up actions live in Zotero's own selection popup, under the
colour swatches, via the sanctioned `renderTextSelectionPopup` `append`. They
carry Zotero's `toolbar-button wide-button` classes so they sit in that row
looking native, and the row wraps: three labels in a popup sized to the
selection can run out of room, and sharing a second line beats clipping one of
them. They are appended whether or not the plugin's floating selection toolbar
is enabled; that setting only controls the Explain/Ask row below them.

Clicking one opens the column, switches to that look-up provider, and lands on
the result — not the provider's home page. Two details make that work:

- The frame effect reads `selectionText` from its render closure rather than
  listing it as a dependency. It already re-runs on every provider change, which
  is the only moment that matters, and listing it would rebuild the `<browser>`
  on every selection.
- `webAILookupRequest` carries the text as well as the provider id. If the
  column was closed, its Sidebar mounted after `selectionTextUpdate` fired and
  never saw it.

Asking a second time, for a different word, needs more than that. The frame
effect only re-runs when the provider changes, and on the second click the
provider is already Google Translate — `setService` receives the very same
object from `SERVICES`, so React skips the render entirely and nothing
navigates. The Sidebar therefore raises a `lookupRequest` carrying its own id,
and the workspace acts on it in a separate effect.

The two paths must not both navigate. The frame effect records the query it
loaded in `loadedLookupRef`; the request effect compares against it and only
navigates when they differ, which is exactly the case where no new frame was
built. It can skip the size gate for the same reason: reaching that branch means
the frame is already built and on screen.

Google Translate translates into Vietnamese by default — the `TRANSLATION_TARGET`
constant in `webAIServices.ts`, substituted for `{tl}` in the template. It was
briefly derived from Zotero's interface language, which is wrong for the common
case: reading English papers in an English-language Zotero would have asked for
English to English.

The source stays `sl=auto` rather than `sl=en`. Auto-detect handles English
correctly and a paper quoting French or German does not get mistranslated.
Google Translate also remembers a target chosen in the page itself, which
overrides the constant on later visits.

### Highlighted text can no longer be selected, and that is upstream

Once a passage is highlighted, clicking it selects the **annotation**, not the
text under it, so the selection popup — and with it Translate, Dictionary and
Google — can no longer be reached for that passage. Only the annotation popup
opens, which offers a comment box and tags.

This is Zotero's own reader, not anything this fork does. The plugin touches
the reader through three registered events and nothing else; pointer handling
is `getActionAtPosition` in `reader/src/pdf/pdf-view.js`, which returns
`{ type: 'drag', annotation }` whenever the press lands on a selectable
annotation, and only falls through to `{ type: 'selectText' }` when it does
not.

The same function carries the escape hatch, a few lines above:

```js
// If holding shift, only allow text selection, to select text under annotations
if (event.altKey) {
    return { action: { type: 'selectText' }, selectAnnotations: [] };
}
```

**Alt** (Option on macOS), not Shift — the comment is stale upstream. Holding it
while dragging selects the text under a highlight and brings the selection
popup back, unchanged.

That gesture is undiscoverable, so the annotation context menu now carries the
same actions plus **Copy Text**.

`createAnnotationContextMenu` is the only surface a plugin can reach here.
Zotero exposes `renderTextSelectionPopup` for a *live selection* and nothing at
all for an existing annotation — there is no `renderAnnotationPopup` — so the
popup in the page cannot be extended. And Zotero's own items in that menu are
all about editing the annotation (colour, page label, convert, merge, delete);
nothing reads the text back out, not even a copy.

The items are appended without `persistent: true`, so `createItemGroup` drops
them when disabled rather than greying them out. They act on text, and an image
or ink annotation has none — the handler returns early there and adds nothing.

Changing the click itself would mean patching `pdf-view.js` in the
`zotero-client` fork, and it would cost the ability to select, move or delete a
highlight by clicking it. Not worth it for a reading workspace.

### One browser per provider, hidden rather than rebuilt

Switching from Google Search to Claude and back used to lose the search
results. The frame effect keyed on `service` and began with
`host.replaceChildren()`, so every switch built a new `<browser>` — and a
`<browser>` taken out of the DOM loses its frame loader, taking the page, the
scroll position and anything typed with it.

Frames now live in `framesRef`, one `FrameEntry` per provider, created on first
use and never removed while the workspace is mounted. Switching sets
`style.display` on each and moves `frameRef`. It is the same trick Zotero's own
`<deck id="tabs-deck">` uses to keep reader tabs alive, so it is proven in this
application. Only Reload, a look-up request and New Conversation navigate a
frame now.

The cost is one content process per provider the user has opened. Two or three
in practice; nine only if someone visits every entry in `SERVICES`. There is no
eviction — if that is ever needed, `FrameEntry` is where a last-used stamp would
go.

Four things this changes that are easy to get wrong:

- **Teardown moved.** The frame effect's cleanup now only disconnects the
  ResizeObserver. Destroying frames belongs to a second effect with `[]` deps,
  because the first one runs on every provider switch and would otherwise undo
  the whole point.
- **The size gate has to be re-armed.** A frame created while the column was
  too narrow is still waiting on its ResizeObserver, and switching away
  disconnects it. `FrameEntry.loaded` records whether the load actually
  *started*, so coming back re-arms the gate instead of assuming it ran. Keying
  on "is this frame new" instead would have left that frame blank for good.
- **A hidden frame can still navigate** — a redirect, a client-side route — and
  its progress listener would happily repoint Back, Forward and Open External
  at a page the user cannot see. The listener checks `frameRef.current` before
  reporting.
- **`loadedLookup` is per frame.** It was one ref shared by every provider; with
  frames kept alive, each look-up provider sits on its own page and needs its
  own record of what it last loaded.

### The web view is only the page

Three pieces of chrome were showing next to the provider's page that had
nothing to do with it.

**The status line announced every load.** "Loaded Gemini Web. Sign in, then Send
inserts prompts into the web chat." — the same sentence on every provider
switch, telling the user what the page in front of them already showed. It is
gone, with `status.loaded`, `loadedLookup` and `loadedZai`, and `status` now
starts empty. The line itself renders only when there is a message, or in
Conversation where the default text is the slash-command hint for the composer.

**The thinking-effort selector and the token meter** sat in the shell footer,
under both views. Both describe a prompt and the web view has none. They now
follow `panelView`, which the workspace reports up through
`onPanelViewChange` — the state lives in `WebAIWorkspace` and the footer in
`Sidebar`, so the shell has to be told rather than asked.

**Capture is gone.** It was the manual fallback for reading an answer out of the
provider's page, and `waitForAssistantReply` already does that automatically
after Send; the button existed for when the automatic pass missed. Removing it
made `extractLatestAssistantText` and `looksLikeSignInPage` dead, along with
four strings — and left two more strings *lying*, because they told the user to
"click Capture" when the automatic capture failed. Those now say to read the
answer in the web view, which is what is actually left to do.

The automatic path is untouched: `readLatestAssistantText`,
`waitForStableAssistantText` and `recordAssistantReply` all still serve Send.

### Remoteness is primed once, not per load

`loadFrameElement` called `primeBrowserRemoteness` on every navigation.
`changeRemoteness()` tears the frameLoader down and `construct()` builds a new
one, so on an already-loaded browser the `loadURI()` that followed was dropped —
silently, because nothing throws and the catch block never ran. Every navigation
after the first went nowhere: Reload, and Look up.

It is now guarded by a flag on the element. The mount effect creates a fresh
frame whenever the provider changes, so the flag never needs clearing.

### `target="_blank"` links, and why Zotero swallows them

Clicking a citation card in Google's AI Mode did nothing at all. Nothing threw,
nothing was logged, no page appeared.

Every new-window request from content reaches the chrome window's
`nsIBrowserDOMWindow`, which in Zotero is `browserWindowShim.js` (loaded by
`zoteroPane.xhtml`, `reader.xhtml` and `basicViewer.xhtml`). Its
`_openURIInNewTab()` is three lines:

```js
let browser = document.createXULElement('browser');
browser.hidden = true;
document.documentElement.appendChild(browser);
return browser;
```

It never loads `aURI` — it does not even take it as a parameter. The file's own
header says why that is correct for Zotero: *"our browsers will never be
visible."* Zotero's content browsers are translation and authentication scratch
browsers, so a link asking for a new tab genuinely has nowhere to go, and a
hidden one is a harmless sink.

The WebAI column is the first content browser in a Zotero window that a user
looks at, so that sink is exactly wrong for it.

The methods cannot be patched in place. Reading `window.browserDOMWindow` hands
back an XPConnect reflection of the shim object, and its interface members are
read-only — assigning to one throws `"openURI" is read-only`. The window's own
attribute *is* writable, so `webAINewWindow.ts` replaces the object with a
wrapper that forwards every member to the original and diverts only what it
should. A request is diverted when both hold:

- `aWhere` is `OPEN_NEWTAB`. Narrow on purpose. A `target="_blank"` link and
  `window.open(url)` without window features both arrive as `OPEN_NEWTAB`; a
  popup opened *with* features — the shape of an OAuth sign-in window — arrives
  as `OPEN_NEWWINDOW`, and a page that opens one is waiting to talk to it, so
  swallowing the column would be worse than the status quo. `OPEN_PRINT_BROWSER`
  likewise has to reach the shim's `PrintUtils` branch.
- the opener resolves to `.ai-assistant-web-browser`, via `openerBrowser` when
  Gecko supplies it and `openWindowInfo.parent.top.embedderElement` otherwise
  (a `rel="noopener"` link has no `openerBrowser`).

All four entry points are checked, not just `openURI`. Gecko picks between the
`openURI*` and `createContentWindow*` pairs depending on which process performs
the load, and between the plain and `*InFrame` variants depending on remoteness;
guessing one pair would leave the fix working only some of the time. The
`createContentWindow*` pair is handed a null URI when the page wants an empty
window, and then there is nothing to divert.

Everything else — every translator, every login browser — is forwarded to
Zotero's shim untouched.

`http(s)` loads into the same frame; anything else goes to `Zotero.launchURL`,
because a `mailto:` or a protocol handler does not belong in a reading column.
The diverted load must **not** call `primeBrowserRemoteness` — see the section
above.

#### The wrapper alone was not enough

Diverting at `nsIBrowserDOMWindow` is correct but was still not reaching
Google's AI Mode citation links — they kept doing nothing. Which of the four
entry points a given click reaches, and with which `aWhere`, depends on process
routing that the parent cannot observe, so each attempt to pin it down was a
guess. A first cut narrowed `aWhere` to `OPEN_NEWTAB` for exactly that reason
and narrowed the fix out of existence.

`interceptFrameLinks` in `WebAIWorkspace.tsx` stops guessing. It loads a frame
script into the WebAI browser that listens for `click` in the capture phase and
turns an anchor with a `target` into an ordinary navigation of the same frame.
Gecko is then never asked for a new window, so none of the routing matters.

Three details are load-bearing:

- `loadFrameScript(url, /* allowDelayedLoad */ true)`. Every other frame script
  in this file is a one-shot `false`. This one has to come back after every
  navigation and after the process switch a cross-origin load triggers.
- `event.composedPath()` rather than walking `parentNode`, because provider UIs
  put anchors inside shadow roots.
- `preventDefault()` but **not** `stopPropagation()`. A capture-phase
  `stopPropagation` would keep the page's own handlers from ever seeing the
  click. If the page then opens the same URL itself, the wrapper diverts it to
  the same place; a duplicate load beats a broken page.

The wrapper stays, because `window.open()` called from script has no anchor for
the interceptor to find. It logs every request it sees, with the entry point,
`aWhere` and whether the opener resolved — the only way to tell from the outside
which path a click actually took.

#### Back, and where the frame actually is

`watchFrameNavigation` puts an `nsIWebProgress` listener on the frame and keeps
`{ canGoBack, url }` in React state.

This has to come from session history rather than from a list of links the panel
diverted, because an ordinary link with no `target` never reaches
`nsIBrowserDOMWindow` at all — clicking a normal Google result is exactly that
case, and it is the one that stranded the user.

- **Back and Forward** are a chevron pair in a strip directly above the page,
  at its left edge — where a browser puts them. They started as a labelled
  "Back" in the row *under* the frame, among "Google Search", "AI Web" and
  "Conversation", and read as one more mode button: the first user to need it
  did not find it, with it on screen in front of them. Position carried more
  than the label did.

  The pair is always present and dimmed when there is nowhere to go, rather
  than appearing and disappearing. A dimmed control is easier to find than an
  absent one, and one that appears shifts every button beside it.

  The strip and the page sit inside one `zotero-webai-web-shell`, which owns
  the border and the rounding so the two read as a single surface. It clips
  with `overflow: clip`, not `hidden` — see the scrollport section below, or
  focus inside the frame would scroll the strip out of sight.

  The two directions read different fields, on purpose. Back uses
  `canGoBackIgnoringUserInteraction` (`sessionHistory.index > 0`) and calls
  `goBack(false)`; plain `canGoBack` is stricter — it also demands user
  interaction on the entry, which a look-up result the panel loaded itself does
  not have, so the button would have been dead on exactly the pages it is for.
  Forward uses `canGoForward` (`index < count - 1`), which is already exactly
  what `goForward()` gates on, so it needs no such correction.
- **Open External** follows the live URL, falling back to the look-up result and
  then to `service.url`. It used to always open `service.url`, so after a Google
  search it opened google.com rather than the results.

The listener goes on `browser.webProgress`, which is backed by
`BrowsingContext.webProgress` and therefore survives a process switch; it is
attached *after* the first `loadFrameElement`, because `primeBrowserRemoteness`
rebuilds the frame loader and with it the browsing context and the message
manager.

### The selection context bar is gone

It was a strip under the scope header that appeared whenever text was selected
in the PDF, showing a two-line preview of that text, a mode chip and a close
button.

It came apart in two steps, and the order is the interesting part.

First the chip: "Selection only / Selection + full text" reached exactly one
consumer, its own label. `selectionContextMode` was never passed to
`WebAIWorkspace`, never read by anything that assembles context or builds a
prompt, and the pref behind it round-tripped through `settingsManager` for
nobody — "Selection + full text" was never implemented at all.

What was left was a preview of text the panel already showed. For a look-up
provider the same selection is in the look-up box a few centimetres below; for a
chat provider nothing consumed it. The close button cleared `selectionText`,
which only meant the next selection would refill it.

`selectionText` itself stays — it is what lands a selection on the look-up
result instead of the provider's home page. Only its display is gone, along with
`SelectionContextBar.tsx`, its stylesheet block (including rules for the chip
removed a commit earlier) and the `webai-slide-up` keyframes it was the only
user of.

### Look-up providers

Cambridge Dictionary and Google Search are not chat. There is no prompt to
inject and no answer to stream back, so `kind: "lookup"` hides the composer, the
transcript, Clear, History and the web-search toggle, and shows a
single look-up box that navigates the frame via `searchUrlTemplate`. Text
selected in the reader is routed to that box instead of the composer.

The box follows the live reader selection — the same `selectionTextUpdate`
event the selection bar renders. It used to be filled from `incomingPrompt`,
which only fires when the user picks Explain or Ask from the selection popup, so
it kept whatever the last such action put there and ignored every plain
selection afterwards. Worse, `buildReaderActionDraft` wraps the excerpt in a
full instruction ("explain this excerpt from page N: ..."), which is a prompt,
not a search term.

PDF selections are normalized before they land in the box: soft hyphens
removed, hyphenated line breaks joined, runs of whitespace collapsed. Column
layouts produce all three, and none of them belong in a query string.

NotebookLM is registered as `chat`, but it requires picking or creating a
notebook before a composer exists — the generic `findWebChatComposer` will find
nothing on the landing page. Untested.

### Cloudflare Turnstile and the User-Agent

Claude's login spun forever. Zotero's own source explains why, in
`chrome/content/zotero/xpcom/zotero.js`: *"Turnstile won't pass with Zotero/ in
the UA string, and future requests need the same UA as the one that passed
Turnstile."*

`applyPlainUserAgent()` sets
`browsingContext.customUserAgent = Zotero.VersionHeader.getPlainFirefoxUA()`
after `construct()` and before the first `loadURI()`. It is scoped to the
browsing context rather than using `registerPlainUAHost()`, which is global and
would change the UA of Zotero's own requests — translators, sync — to the same
host. Zotero's `http-on-modify-request` observer still runs afterwards, but its
`'full'` branch looks for `Zotero/` in the string, finds nothing, and leaves
this UA alone.

It is applied to every provider, not only Claude: these are consumer web apps
with no reason to be told they are running inside Zotero, and a UA no real
browser sends is itself a fingerprint.

`hasStoredSession` counts only cookies that are `Secure` or `HttpOnly` (auth
cookies are; analytics cookies usually are not) and unexpired, and checks the
registrable base domain too, because Google keeps Gemini's auth cookies on
`google.com`. It cannot tell a live session from a revoked one, and returns
`true` when the cookie API throws — both failure modes skip the login window,
since a spurious popup is worse than a missing one. The manual "Login Window"
button remains.

### Where the tab-bar button goes

`#tab-bar-container` is off limits. `tabs.js` hands it to
`ReactDOM.createRoot`, so React reconciles every child; a foreign node in there
makes React and the DOM disagree on the next tab open, close or reorder. The
`insertBefore` startup exception this fork used to patch around was a symptom of
that, not a separate bug.

It also breaks the layout, and not in the way the screenshots suggest. The
wrapper React renders inside `#tab-bar-container` gets only `flex-grow: 1`
(`scss/components/_tabBar.scss`) and no `display`, so it is a **block** box. An
`inline-flex` button placed there forms its own anonymous line box *above* the
tab strip, pushing it down inside a row whose `min-height` is
`--tab-min-height: 36px`. On macOS `#titlebar` sets
`margin-bottom: calc(0px - var(--tab-min-height))` to overlay the native title
bar, so doubling the row's height collides with that −36px assumption. The
failure is vertical, not a horizontal squeeze.

Upstream never aimed at `#tab-bar-container` deliberately. `findMainTabbar`
tried nine selectors, **none of which exist in Zotero 11**, then fell through to
a heuristic that walked up from the first `[class*='tab']` node and accepted any
ancestor over 240px wide. Which node it hit depended on render timing.

The host is now `#zotero-tabs-toolbar` — the static XUL `<hbox>` beside the tab
bar that already holds Zotero's own tabs-menu, progress-queue and sync buttons.
Nothing owns it (`grep -rn "zotero-tabs-toolbar" chrome/ scss/` in
`zotero-client` returns four hits and zero JS), and Zotero itself puts a plain
HTML `<div class="zotero-tb-separator">` in there, so an HTML child is the
established pattern. The button is inserted before `#zotero-pq-buttons`, which
is static markup and therefore always present.

Two attributes are load-bearing:

- `-moz-window-dragging: no-drag`. `#zotero-tabs-toolbar` carries
  `.zotero-toolbar`, which sets `-moz-window-dragging: drag` on macOS
  (`scss/components/_toolbar.scss`). Without `no-drag` the OS swallows single
  clicks — the same bug Zotero fixed for its own tab scroll arrows.
- `tabindex="-1"`. `zoteroPane.js` builds a *closed* keyboard action map over the
  hardcoded ids of the title-bar buttons. An HTML `<button>` is focusable by
  default and would land in the Tab chain at a position that map has no entry
  for. The trade-off is that the button is keyboard-unreachable; the View menu
  item is the keyboard path.

Visibility is now driven by the per-window `Zotero.Notifier` `select`/`tab`
observer that `ui.ts` already registered, via `UIFactory.refreshWindow`. The old
`installTabbarObserver` watched `documentElement` with
`{childList, subtree, attributes}` and re-ran the whole heuristic — two
`getBoundingClientRect()` calls plus two full-document tree walks — on *every*
DOM change anywhere in the main window. It is gone.

### `overflow: hidden` is a scrollport with no scrollbar

`focus()` and `scrollIntoView()` scroll **every** `overflow: hidden` ancestor to
reveal their target. Those boxes have no scrollbar, so whatever gets pushed out
of view never comes back — which is what cut the panel's own toolbar row off at
the top. Three rules follow: use `overflow: clip` for boxes that only clip, pass
`focus({ preventScroll: true })`, and scroll the intended scroller by hand
instead of calling `scrollIntoView()`.

`focusWebAISection` used to reset those `scrollTop`s and then call `focus()` one
line later, which re-created the scroll it had just undone.

### A note pad that lives inside the reader

The pad is a card in the reader's own document, opened from a button next to
Read Aloud. Four things about that were settled by running code, not by reading
it, and each one ruled out an approach that looked obviously right.

**The button cannot go where the reader invites plugins to put it.** The
sanctioned slot is `<CustomSections type="Toolbar"/>`, and it renders as the
first child of the toolbar's `.end` group — next to Appearance, at the far end
from Read Aloud. Sitting beside the headphones means inserting into `.start`
directly, which is a React-managed list. Measured: the inserted button survives,
keeps `#read-aloud` as its previous sibling and lays out at 28x28 like every
other toolbar button. A `MutationObserver` on `.start` re-anchors it, because
React does add `#numPages` to that group after mount. The `append()` the event
hands us stays as the fallback for a reader with no `.start` at all.

**A `<textarea>` would have been broken in ways that look like reader bugs.**
`KeyboardManager` and `FocusManager` both attach `keydown` in capture phase on
the reader iframe's `window`, so nothing inside the document can pre-empt them,
and their escape hatch — `isTextBox()` — recognises `input[type=text]` and
`[contenteditable="true"]` only. In a textarea inside a reader, `h` toggles the
hand tool mid-word, a digit repaints the highlight colour, `Cmd-A` is
preventDefaulted and the arrow keys move focus to another toolbar button.
`Backspace` is worse: its guard is `closest('input, .label-popup')`, so with an
annotation selected it deletes the annotation.

The pad is therefore a `contenteditable`, and it deliberately matches none of
`.annotation, .annotation-popup, .selection-popup, .label-popup,
.appearance-popup, .context-menu`. Because it matches none of them, focusing it
makes the reader deselect annotations — which is precisely what leaves
`Backspace` and `Cmd-C` with nothing to damage. One reader guard is turned into
the pad's guard.

What cannot be recovered is Tab: `FocusManager` preventDefaults it
unconditionally. Tab moves focus out of the note, the same as in Zotero's own
annotation comments.

**A `chrome://` webfont does not load in the reader.** `@font-face` with a
`chrome://` `src` fails there with *"NetworkError: A network error occurred"*,
while the identical rule works in a main window and while `<img
src="chrome://…">` has always worked in the reader — fonts go through a
principal check that images do not. Two obvious ways round it also failed, both
with *"Permission denied to access object"*: constructing a `FontFace` from the
reader window with a chrome-side `ArrayBuffer`, and minting a `blob:` URL in the
reader window. What works is reading the bytes once in chrome, where the URL is
legal, and inlining them as a `data:` URI. Inter, IBM Plex Sans and Noto Sans
ship as Latin + Vietnamese variable subsets, about 200 KB in total; only the
selected family is ever inlined, and the base64 is cached for the process.

None of the three is installed on a stock macOS — `fc-match` resolves all three
to Verdana — so without bundling, the font menu would have had three entries
that all looked the same.

**Only the background of the page is in the DOM.** For a PDF, `pdf-view.js` sets
`--background-color` on the pdf.js iframe root and hands the foreground to
pdf.js as a JS global; `--text-color` is never published. Measured on a sepia
page: `--background-color: #F4ECD8`, `--text-color: (none)`. So the pad
recomputes the theme from the inputs Zotero itself uses — the *reader window's*
`prefers-color-scheme`, `reader.lightTheme` / `reader.darkTheme`, and
`readerCustomThemes` — and uses the DOM only to cross-check the background.
Everything else is `color-mix` of those two colours, so a user's own theme needs
no code.

### The emoji picker

Three decisions are worth recording.

**The search field never loses focus.** The reader owns the keyboard from a
capture listener on its own window, and its escape hatch, `isTextBox()`,
recognises `input[type=text]` and `[contenteditable="true"]` and nothing else.
So the picker keeps focus in its search box for its whole life: typing is safe,
the arrow keys are ours, and the grid's "selection" is a highlighted cell
rather than real focus. Every `pointerdown` inside the picker is cancelled so
that clicking a cell cannot move focus either — which also means the caret in
the note is still where the user left it when the emoji arrives.

**The catalogue is a file, not a module.** 1906 emoji with English and
Vietnamese names and tags is 231 KB. Bundled, every session would parse it;
as `addon/content/emoji.txt` it is read once, the first time someone opens the
picker, through the same `fetch("chrome://…")` the fonts use. Skin tones come
from the data rather than from appending a modifier, because a modifier's
position in a multi-person sequence is not something to guess at — emoji built
from two people simply keep their default.

**Search ranks by name, then by Unicode order.** Folding accents is what makes
the picker usable for someone typing Vietnamese without them, and it is also
what makes it ambiguous: "cười" (smile), "cưới" (wedding) and "cưỡi" (ride) all
become "cuoi". The first version ranked by where the match fell in the string
and answered that query with 💒. Ranking a name match above a tag match, and
breaking ties by catalogue position — which is Unicode's own order, everyday
emoji first — answers it with 😀 😃 😄. Both rules were added because a
measured run was wrong, not on principle.

### Storage: a child note, and a pointer to it

The text is a Zotero child note on the paper titled "Paperly Notes". It syncs,
it is searchable, it shows up in the library, and it outlives the plugin. The
note's key is kept in `SyncedSettings` under `paperlyNote_u_<itemKey>`, mirroring
the key shape Zotero uses for `lastReadAloudPosition`.

The pointer exists because the fallback identity — matching the note's title —
is just its first line, so renaming the heading in Zotero's editor would orphan
the note and the pad would quietly start a second one. The body is *not* in the
pointer: when the server rejects a settings upload with 403, the client
re-downloads and deletes any local key the server does not have
(`sync/syncEngine.js`). Survivable for a key that can be rebuilt by title,
unacceptable for the only copy of what someone wrote. A preference was rejected
for a different reason: `prefs.js` is flushed lazily and is not transactional.

Saves are debounced 600 ms idle with a 2500 ms ceiling, serialised per note, and
flushed — awaited — on panel close, reader `pagehide`, main-window unload and
plugin shutdown. Zotero awaits shutdown listeners before closing the database,
so a save started there still commits. `setNote()` returns false when nothing
changed, which keeps a reload or a focus change from writing at all.

The pad is plain text. If a note comes back holding anything richer — a list, an
image, bold — it is flattened for display and the status line says so, and
nothing is written unless the user actually types.

### A thrown handler is not contained

`Zotero.Reader._dispatchEvent` walks its listener list with no `try`/`catch`,
and that list is shared with every plugin in the profile. During development one
exception in `onRenderToolbar` stopped a listener registered *later in this same
plugin*, and the only symptom was a feature that never ran — no error attributed
to it, nothing in the console pointing at the cause. Every reader event handler
now wraps its own body.

### The plugin's own icon

`assets/icon/` holds the logo, a page that frames it, and a script that renders
every size. Its README has the reasoning; two things are worth knowing from
outside.

**The whole emblem at every size, `z=1.10`.** That zoom trims the dead navy
the drawing carries around itself and nothing else -- at 1.14 the crown's
centre ball reaches the top edge, by 1.18 it is cut. The cost is knowing: at
20px a crown, a ribbon and a circuit ring cannot survive, so the toolbar button
is a navy square with a pale smudge. A face crop that kept **A.I.** legible
there was built and rejected; the logo is wanted whole.

**The toolbar icon is 24px in a 28px button.** The button stays 28 because
that is Zotero's own size in that row; the padding went from 4 to 2 so the
artwork could go from 20 to 24. Worth knowing why: the 20px tile was already
wider than the chevron and sync glyph beside it, but the emblem carries its
own margin, so the drawn part was smaller than theirs. 24 makes the retina
asset 48, which already existed -- `icon-40.png` is gone. `icon-20.png` stays,
and stays 20px, for the preferences pane.

### The floating bot

The emblem, floating over the window, draggable anywhere, and a click away from
the AI panel. `BOT.md` is the whole story; two decisions are worth having here
because they are the ones a later change is likely to undo.

**It has its own overlay frame.** `readerNoteDock.ts` became `overlayDock.ts`
and its docks are named: the pad's is `"note"`, the bot's is `"bot"`. Putting
the bot in the pad's frame was the obvious saving and it is the wrong one — the
pad recuts its clip from a `MutationObserver` over its whole document, so the
bot would make the pad recut on every hover and every frame of a drag, and the
two would have to share one clip path. Two frames cost nothing, because a
region a `clip-path` cuts away passes the click through to whatever is below,
and another overlay frame is just another thing below.

**Its box never changes size.** 96px, with the emblem at 72 inside it.
Everything that moves does so within that box, so the hole cut in the dock is
redrawn only when the bot is somewhere new. The alternative -- animating the
root and recutting to follow -- means a `getBoundingClientRect` and a clip
write on every frame of every hover.

The artwork is a cut-out, not the shipped tile. The first build used the tile
and it read as a second application icon in the corner; worse, a tile is
opaque, so the bot's halo was behind it. `assets/icon/README.md` records what
the flood fill has to be told before it will cut that field away without
bleaching her hair.

## Cutting Paperly loose from Zotero's servers

Three commits in `zotero-client`: `648e19588`, `c8cecb4e8`, `a8bad650c`.

The starting point is worth stating, because it makes the rest small: **Zotero
already runs completely without an account.** With no user ID it mints a local
key and the library URI becomes `http://zotero.org/users/local/<key>`
(`uri.js`). Nothing had to be built to make Paperly work offline. The work was
deciding what to stop offering.

### What actually phones home

Measured, not reasoned about. With `-ZoteroDebugText`, a startup logs every
request:

| Before | After |
| --- | --- |
| `api.zotero.org/retractions/list` ×2 | — |
| `repo.zotero.org/repo/updated` | `repo.zotero.org/repo/updated` |

That is the whole list. No sync, no streaming, no schema fetch. The repository
stays on deliberately: it is the translator and citation-style feed, the one
call home that buys something Paperly cannot produce for itself.

Retractions went off, and is worth knowing about because the feature is good and
its design is careful: it warns when a paper in the library has been retracted,
and does it without uploading the library. Each DOI is SHA-1'd, only the first
characters of the hash are sent, and matching happens locally. One pref restores
it.

What is left calls out only when asked -- Retrieve Metadata for PDF, the
Open-Access PDF lookup, proxy detection, dictionaries. None fire on their own.

### Hide the sync button, remove the pane

Opposite treatments, for a reason.

The **toolbar button is hidden**, not deleted. Its id is named directly in
ZoteroPane's keyboard `actionsMap`, and `moveFocus()` already skips a target
that is hidden or `display:none`, so hiding costs one attribute where deleting
would cost a rewrite of that map.

The **Account pane is removed** from `builtInPanes`, which is a clean array
edit. But nine places still call
`openPreferences('zotero-prefpane-account')`, and an unregistered pane would set
`navigation.value` to something no radio matches, so the select event never
fires and `waitForPaneSelect` never resolves: **the window hangs rather than
failing**. `navigateToPane` now falls back to the first pane.

Most of those nine need sync configured to be reachable. One does not: the
welcome screen on an empty library offered *"Already using Paperly on another
computer? [Set up syncing]"*. That paragraph is gone.

### Renaming the database, and the bug it uncovered

`ZOTERO_CONFIG.ID` went from `zotero` to `paperly`. It names the database file
and is what the Note Markdown translator rewrites `zotero://` links to on
export.

**Two schemes are registered now**, and both are needed. `zotero` because every
link already written into a note is a `zotero://` one; `paperly` because that
Markdown export writes `<ID>://` and would otherwise produce links nothing
answers. One handler serves both -- it dispatches on the path.

The rename runs from `DataDirectory.init()`, the last moment the data directory
is known and the database is still closed. A copy is taken under the old name
first. **The `-wal` moves before the database, and that ordering is the whole
safety argument:** SQLite finds the write-ahead log by filename, so a database
separated from its log silently loses whatever was not checkpointed. Interrupted
after the log moves, the next start migrates again and finds the log already at
the right name. Interrupted after the *database* moves, the next start would see
the new database, return early, and open it without its log.

Then the part that justifies testing on a copy. `Zotero.DB` was constructed as
`DBConnection('zotero')` -- the only place the main database was asked for by a
literal string. So after the migration the app **built a fresh empty database
beside the real one and used that**. The first test run left `paperly.sqlite`
holding 52 items while a new `zotero.sqlite` grew past 4MB. Never run a data
migration against the only copy of a library.

### Still Zotero, on purpose

`BASE_URI` stays `http://zotero.org/`. It is not branding, it is **data**:
`itemRelations.object` stores full URIs built from it, so changing it orphans
every relation between items. Nobody ever sees the string; it is a namespace,
like a UUID. The cost is a migration and the benefit is zero.

`GUID` and `DOMAIN_NAME` are likewise untouched -- neither is user-visible, and
`DOMAIN_NAME` is what the (now hidden) sync label reads.

### Licence

Zotero is **AGPLv3**, and so is the web-library that `paperly-web` forks.
Private modification carries no obligation at all. Distribution does: source
under AGPLv3, copyright notices kept, changes noted. AGPL §13 adds that users
interacting with it *over a network* must be offered source -- a local desktop
app does not trigger that, but **hosting `paperly-web` for others does**.

AGPL does not prevent commercial use. It requires source availability.

## Things believed and later disproved

Recorded so nobody re-runs these experiments.

- **React 19 does not fix the `attachEvent` error.** React 19.3.0 ships the same
  `isEventSupported("input")` guard and the same IE polyfill as 18. Verified by
  grepping the built bundle after upgrading.
- **An `oninput` shim on the document does not work either.** It was added, then
  removed. `readerIntegration.ts:2` imports `react-dom/client` *statically*, so
  react-dom evaluates at plugin load, before `bindDomGlobals()` runs. At that
  point `window`/`document` are undefined, `canUseDOM` is false, and
  `isInputEventSupported` is frozen `false` for the process lifetime. No later
  `defineProperty` can change it. Fixing this needs the static import deferred
  **and** the shim — neither alone is enough.
- **A chrome document does not only hear its own presses.** The pad's dock is a
  same-process `<iframe>` in the chrome window, and a `pointerdown` inside it
  carries on into `win.document` in the default group, with the pad's own
  button as `event.target`. A watch written there to catch presses *outside*
  the pad therefore caught every press *on* it, and closed the open menu
  between `pointerdown` and `click`: the colour palette, the emoji picker and
  the "/" menu all opened and then picked nothing. The same measurement showed
  the reverse for content — a press inside the reader's `<browser>` reached the
  window zero times, in either event group. `insideDock` in
  `readerNotePanel.ts` is the guard.
- **Focus is not a stand-in for a press.** Closing the pad's menus on `focusin`
  looked like a way to hear the presses no document gets — the page inside the
  reader, a provider's page in its own process. Measured, clicking the page
  moves focus in some places and not others, so the watch fired on some presses
  and not others. It was written, measured, and taken out again.
- **Neither React 19, the `oninput` shim, nor a `process.env.NODE_ENV` define
  caused the segfault.** Each was reverted in turn and the crash persisted. Only
  disabling the frame load stopped it.

## Known issues

1. **`attachEvent` still throws on focus in React inputs.** React takes an
   IE-only path because its feature detection fails in a XUL document. Needs the
   deferred import plus the shim described above.
2. **The tab-bar button still needs an open reader.** It renders only when
   `getActiveReader()` is truthy. There *is* a library-view entry point now —
   View → "Paperly AI Panel" (`webAIColumn.ts`) — but the tab-bar button is
   deliberately `tabindex="-1"` and so is not keyboard-reachable.
3. **Provider knowledge is scattered** across a Z.ai captcha mode, a ~250-line
   DeepSeek thinking-block serializer, and regexes stripping provider names from
   captures. Claude, Gemini and NotebookLM have no equivalents.
   `ADDING-A-PROVIDER.md` describes the capability record that should replace
   these branches before a ninth one is added.
4. **One 9,900-line file.** `WebAIWorkspace.tsx` holds nearly all behaviour.
5. **No tests.** `npx tsc --noEmit` is the only automated check.
6. **The pad's menus stay open if you press the rendered page.** The page is a
   frame inside the reader's `<browser>`, so neither the chrome document nor
   the reader's own hears the press. Pressing the reader's toolbar, Zotero's
   chrome, the pad itself, or Escape all put the menu away. This was true
   before the pad moved out of the reader as well.
