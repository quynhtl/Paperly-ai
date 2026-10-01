# The floating bot

Her face, floating over the whole window, draggable anywhere, blinking, and a
click away from the AI panel. `src/modules/floatingBot.ts` owns all of it.

| Question | File |
| --- | --- |
| *How do I change the note pad?* | `NOTE.md` |
| *Why is it built this way?* | `PAPERLY-FORK.md` |
| *Does it still work?* | `TESTING.md` |

---

## Where it lives

In its own `about:blank` iframe over the main window, built by
`overlayDock.ts` under the name `"bot"`. The frame is clipped to the bot's own
box, and `clip-path` drives hit-testing in Gecko, so everywhere else the click
goes straight through to Zotero. Measured in the running app: a point at the
bot's centre resolves to `iframe#paperly-overlay-bot`, and a point 200px to
its left resolves to Zotero's item table.

**Why its own frame and not the note pad's.** A clipped-away region passes the
click through to whatever is below, and another overlay frame is just another
thing below, so two frames never fight. Sharing one would mean sharing one clip
path between modules that have nothing to say to each other — and the pad
recuts its clip from a `MutationObserver` over its whole document, so a bot in
there would make the pad recut on every hover and every frame of a drag.

The bot's frame sits one above the pad's, because it is the launcher: small,
deliberately movable, and useless if a note panel can bury it.

## The box never changes size — and nothing may paint outside it

140px, with the bubble drawn at 96 inside it. Everything that moves — the idle
bob and squash, the hover swell, the press, the tilt while it is carried —
moves *within* that box, so the hole cut in the dock is only redrawn when the
bot is somewhere new, not on every animation frame.

The 22px of margin all round is not slack, it is **budget**. `clip-path` cuts
paint as well as hit-testing, so anything reaching past the box is sliced along
a straight edge. The first version did exactly that: the rim glow reached the
box exactly, the hover swell pushed it 4.8px past and the click ripple 12.5px
past, so hovering or clicking drew a hard grey rectangle over the page. Read
off the report of it: a straight cut at +58px repeated over 34 rows, and
another over 98 columns.

Measured from the centre, the worst case has to stay under `BOX / 2` = 70:

| | half-extent |
| --- | --- |
| bubble 48 + shadow blur 12 + offset 4, × 1.06 hover × 1.016 squash | 68.9 |
| ripple 48 × 1.42 + 2px border | 69.2 |
| orbit ring (49.5 / 50) × 62 | 61.4 |

Verified by rendering the real stylesheet at its worst case onto a transparent
page and measuring the alpha: painted `101..238` inside a box of `100..239`.
**Anything added here has to be checked against 70, or it will be cut.**

That is also why there are two nested elements under the root:
`.paperly-bot-body` carries the transforms JavaScript writes, and
`.paperly-bot-float` has the idle bob to itself. One element cannot hold both,
because a running CSS animation overrides an inline `transform`.

The one thing that hangs outside the box is the hover bubble, so it contributes
its own rectangle to the clip while it is showing — see `syncClip`.

## Click, or carry

Both gestures start the same way, so one `pointerdown` handler runs both: a
press becomes a drag only once the pointer has travelled `DRAG_SLOP` (4px).
Short of that it is a click, and a click toggles the AI column.

| Thing | Where |
| --- | --- |
| Press, carry, release | `attachPointer` |
| Dismiss | the `×`, `setFloatingBotEnabled(win, false)` |
| Magnet to the window's edges | `snap` — within `SNAP` (36px), rest flush; `PAD` is already a 22px gap |
| Kept on screen when the window shrinks | the `resize` listener in `installFloatingBot` |
| Remembered between sessions | `floatingBotPosition`, `"<x>,<y>"` in CSS px |
| Lit while the panel is open | `setActive`, via `subscribeWebAIColumnChange` |

Position is stored in pixels and clamped on load, not stored as a fraction of
the window: a fraction drifts the bot every time the window is resized, which
is the one thing a parked object must not do.

## It has weight

A bubble that jumps to the pointer is a cursor with a picture on it. This one
falls behind, overshoots and wobbles, and the air around it is dragged along
late.

The trick is that **there are two positions**, not one. `bot.x/y` is the box: it
follows the pointer exactly, because it is what the clip is cut from and what
gets written to the pref. `bot.px/py` is the bubble, and it chases the box on a
spring. Everything the eye sees hangs off the gap between the two.

| What you see | What it is |
| --- | --- |
| Falling behind, then overshooting | `translate(px - x, py - y)` on the body |
| Stretching along its travel, squashing across it | `rotate(to the travel) scale(1 + k, 1 − 0.72k) rotate(back)`, `k` from speed |
| The rings and the bloom streaming after it | the same gap × `TRAIL` (1.7), handed to CSS as `--paperly-trail-x/y` |

`SPRING` 0.17 against `DAMPING` 0.76 was chosen by simulating the loop rather
than by feel: four swings over about 700ms on a hard throw, three over 450ms on
a gentle one. Stiffer rings too long; softer reads as lag rather than as weight.

**The lag is capped at `LAG_MAX` (18px)**, and that is not cosmetic. Uncapped, a
fast throw leaves the bubble most of a screen behind, and the clip below would
have to be widened to whatever the spring happened to do that time. Capped, the
budget is a fixed number.

### Why the clip is inflated, and only while it wobbles

The resting box has no room for a wobble — `BOX` is already spent to the pixel.
Rather than make every idle bot carry a dead margin for a wobble it is not
having, `syncClip` widens the hole by `MOTION_BLEED` (32px) exactly while the
spring is running, and puts the tight box back when it stops. Simulated at the
worst case:

| | half-extent |
| --- | --- |
| (48 + 12 + 4) × 1.19 stretch × 1.06 swell + 18 lag | 98.7 |
| orbit 61.4 + 18 × 1.7 trail | 92.0 |
| allowed — `BOX / 2` + `MOTION_BLEED` | 102 |

### Two transforms that had to be freed

The wind is a `transform` on `.paperly-bot-orbit` and `.paperly-bot-glow`, and a
running CSS animation beats a computed transform every frame. The rings were
already safe — their spin is on the `<circle>`s inside, not on the div — but the
bloom's breathing had to give up its `scale` and become opacity-only. It still
reads as breathing.

`.paperly-bot-body`'s `transition: transform` is switched off through
`.is-moving` for the same reason: easing that makes a hover swell pleasant turns
a per-frame spring into treacle.

**Reduce Motion turns the spring off entirely** — in `startMotion`, not just in
the stylesheet. The bubble then tracks its box exactly.

## The switch, and the button

`floatingBot` (default `true`). Three things now write it:

| | Sets it to | Why there |
| --- | --- | --- |
| The **×** on the bot | `false` | Dismissing something in the way should not need a menu |
| The **Paperly AI toolbar icon**, top right | `true` | One click out deserves one click back |
| **View ▸ Paperly AI Bot** | either | The durable switch, and the only one that survives not knowing the other two exist |

The earlier note here said the switch could not live on the bot, "because a
control that only exists on the thing it hides cannot turn it back on". That
was right about the half it described and wrong about the conclusion: the way
back does not have to be on the bot. It is on the toolbar icon, which is
already the other door to the same panel and is always on screen.

The icon keeps its own job. `restoreFloatingBot` is a no-op while the bot is
there, so the click still toggles the panel and no press is ever spent purely
on undoing the ×. The View menu item reads the pref on `popupshowing`, so its
tick follows whatever the × or the icon last did without being told.

The × is placed by arithmetic, not by eye: 20px, inset 21px from the top right
of the 140px box, so its centre lands 55px from the bot's centre -- 7px clear of
the 96px bubble's rim, and inside the 70px the clip allows. Measured in the
running app: 55px. Anything moved outward from there has to be checked against
that budget; see *The box never changes size*.

It is invisible and `pointer-events: none` until the bot is hovered, and hidden
again during a carry. Its `pointerdown` stops propagating, or pressing it would
start a drag instead of closing anything.

## The artwork

`addon/content/icons/bot-192.png`, rendered by `assets/icon/build-icons.sh`
from `face.png` through `bot.html`. It is **not** one picture: it is a strip of
three frames — eyes open, half, shut — laid side by side, 192px each, 576
wide. One file rather than three means one decode and no frame that can go
missing on its own.

The emblem (`logo.png`, the crown-and-ribbon crest) is still what the toolbar
button, the plugin manager and the preferences pane wear. The bot wears the
face, because a face can blink and a crest cannot.

### She is cut out of her field, by eroding the flood

What ships is her head on transparency, with no field behind her. That is what
lets the bubble be *translucent* — the page shows through it the way it shows
through glass — and a bubble you cannot see through is a marble.

A plain flood fill cannot do it, which is what an earlier note here concluded
and why she sat on a black disc for a while: her outline is the same near-black
as the field and touches it the whole way round, so the fill walks into the
linework and leaves raw pink edges. The fix is to flood and then **erode**. The
ring of field within `ERODE` (8px) of her is handed back, and that ring *is*
her outline — measured at 6–9px through most of its length.

### Fitted to the circle, not to the square

The first version scaled her so the widest part of her hair spanned 96% of the
plate, focused at 0.44 of the drawing's height. That fits her to the *square*,
and the disc is a *circle*: it put her widest point — the hair, 626px across at
y=600 of 778 — where the circle has already narrowed to 68% of its width, so
the hair was sheared off on both sides while the top of the disc sat empty.

`bot.html` now measures her own box off the cut-out and centres that. `FILL`
(0.92) is her width as a fraction of the frame and `CENTRE_Y` (0.52) is where
the middle of her box sits: 0.92 leaves the bubble a rim of glass to show
around her, 0.52 is where the ahoge clears the top and the collar still reaches
the bottom. The box is measured **once** and reused for every frame, because
only the eyes differ between them and a blink must not shift her.

### The bubble

Glass in CSS, not baked into the PNG: only CSS can keep it translucent, drift
its catchlight and answer the panel's state, and baking it would triple the
same gloss across three frames.

The tint is **clear in the middle and heaviest at the rim**, which is both what
a soap film actually does and what keeps her face crisp — the first pass put a
white wash at 34%/26%, straight across her forehead, and hazed the very thing
the bubble exists to show off.

The layer order carries the rest of it: `.paperly-bot-bubble` behind her,
`.paperly-bot-gloss` in front. She is *inside* the bubble, not printed on it,
and the catchlight riding over her hair is what says so. The gloss drifts 2px
on a 7.6s cycle, because a highlight nailed to one spot looks painted on.

### The blink is repainted, not covered

A lid drawn over the top of the art would have to know where her eyes are and
would clip her fringe the moment it was a pixel too tall. Instead `bot.html`
finds the pixels each eye actually occupies — grown from a seed over everything
that is not skin — and repaints only those.

Two things that has to be told, both found by rendering and looking:

- **A fence.** Her lashes run into the black outline of her hair, and both are
  the same black, so an unfenced fill follows the outline out and repaints her
  fringe. Measured: 17,000 pixels instead of 15,000, and two pale rectangles
  across her forehead. The fence is her eye's own ellipse, read off a 2x crop —
  centre (237, 480), radii (70, 76) on a 728×778 drawing, mirrored about the
  face's axis at x=358, which is the midpoint of the two pupils. Painting the
  mask back over the drawing shows it covering lashes, sclera and pupil, and
  nothing else.
- **Every row between the mask's top and bottom**, not only the masked ones.
  The white highlights sit inside the eye as holes in the mask, and left alone
  they float on top of a shut lid.

The lid comes down each column to its own depth, so it lands as a curve rather
than a bar — which is what a shut anime eye looks like. The three frames are
`f = 0`, `0.45` and `0.62`, and only the last sets `shut`, which decides what
happens *below* the lid: half-way it is left as drawn, so the bottom of the
pupil still shows and the frame reads as an in-between; shut it is skin, so all
that survives is the lash line. `0.62` and not `1.00` because the lid meets its
opposite lash about two thirds down — at 1.00 the line sits on the eye's own
bottom edge and half of it falls outside the mask.

The line is also drawn thicker when shut (22% of the eye's height against 14%),
because shut it is the only thing left of the eye and a hairline reads as a
smudge. An earlier version painted skin over the whole socket and left the line
at its half-frame weight; it came out as two pale blotches, not a closed eye.

### The rings

Two dashed circles turning against each other, in SVG rather than a dashed
border — a CSS dashed border sets its own dash length from the stroke width and
comes out uneven on a circle this small. They sit outside `.paperly-bot-float`,
so they hold their line while the head bobs inside them.

This is the part that says *machine*. She is a drawing of a girl; a bubble that
bobs with a face in it is a sticker, and the rings are what make it a bot. They
are kept faint, and rose rather than white so they read on a cream page as well
as on a dark toolbar — a bubble with a bright HUD around it stops reading as
glass.

## Who is in the bubble

Anya is one of several characters. The list is
`assets/bot/characters.json`, and `assets/bot/README.md` says how to add one.

| Thing | Where |
| --- | --- |
| The list, and the chosen one | `botCharacters.ts`; pref `floatingBotCharacter`, empty until someone chooses |
| Wearing a face | `applyCharacter`: a background image, a frame count, a tint, as properties and attributes on the root |
| The first-run offer | `installFloatingBot`, `PICKER_DELAY` after the bot appears, while the pref is still empty |
| The picker | `openPicker`, beside the bubble, a sibling of the root with its own hole in the dock |
| Changing later | right-click the bot, or **View → Paperly AI Bot Character** |

**A swap changes nothing that moves.** The spring, the wind, the bob, the
hover swell and the clip budget are the same for every face. Only paint
changes: `--paperly-face`, the strip's frame count, and a tint. So nothing in
*The box never changes size* has to be re-measured for a new character.

**Only a strip blinks.** `data-blink` is set for faces with more than one
frame. Stepping a one-frame face to "half" would show empty glass.

**Anya keeps her rose to the digit.** The tint rules are all
`[data-tint]:not(.is-active)` overrides written after her colours, and she has
no tint. Anyone with a tint takes over the bloom, both rings, the outer glow
and the ripple. Never the active state, which stays steel blue for everyone.

**A face with its own background hides the glass**, and the glass's shading
goes with it. `data-opaque` paints that shading over the picture as inset
shadows on the face.

**The new face arrives with a hop.** `hop` throws the bubble upward through
the carry's own spring (`vy -= 9`) and rings the ripple. It is the same motion
path as a drag, so it also inflates the clip while it runs.

**The picker is not inside the root.** The root starts a drag on every press
and swells on every hover, and neither should happen while the pointer is
choosing. So the picker is placed by hand beside the bot, follows it during a
carry, and adds its own rectangle to the clip, padded by `PICKER_BLEED` for
its shadow. It closes on Done, Escape or any press in the window outside the
dock, and closing it settles a first run, so it is only offered once.

## Traps

**`prefers-reduced-motion` is honoured, except the blink.** The bob, the rings,
the bloom, the catchlight drift, the ground shadow and the drag spring all stop. The blink stays: it moves nothing, it
lasts 76ms, and a bot that has stopped blinking reads as switched off rather
than as calm. If you add an animation that *moves* something, add it to that
block too.

**The clip is the paint budget.** See *The box never changes size*. A glow, a
shadow or a scale added without checking it against `BOX / 2` will be
guillotined into a visible rectangle over the page. That is not a Gecko bug —
it is `clip-path` doing exactly what the hit-testing needs it to do.

**Do not put a `title` on the root.** The native tooltip would appear on top of
the bubble. `aria-label` carries the same text.

**Do not try to measure the animations from a screenshot.** macOS stops
refreshing a window's surface once it is buried, so `screencapture` of it
returns the same bytes forever — 26 captures in a row came back
byte-identical while all six animations were in fact running. Read
`document.getAnimations()` and `getComputedStyle` from inside the window
instead; that is what proved the blink steps through all three frames
(`0px 0px | -96px 0px | -192px 0px`).

**And native mouse *moves* may not arrive even when native presses do.** In the
same state, `sendNativeMouseEvent` presses reached the bot and toggled the
panel while moves reached nothing, so a scripted drag registered as a tap. The
drag and the hover have to be driven with events dispatched at the element;
hit-testing is already covered by `elementFromPoint` and by the native press.

**The bot must be built before it can be placed.** `ensureOverlayDock` waits
for the frame's document, which is a handful of frames, and the window may be
gone or the bot switched off by the time it returns — `installFloatingBot`
rechecks both.
