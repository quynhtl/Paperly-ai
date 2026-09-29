# The Paperly AI plugin icon

`logo.png` is a finished emblem: a crown, a circuit ring, **A.I.** in her eyes
and an INTELLIGENCE ribbon, on a navy field. It is used as given. `icon.html`
frames it and `build-icons.sh` renders every size from it.

```bash
./build-icons.sh
CHROME=/path/to/chrome ./build-icons.sh
```

It writes `icon-{20,48,96}.png` into three places at once:

| Directory | Used by |
| --- | --- |
| `addon/content/icons/` | the plugin |
| `paperly-web/packages/webai-core/addon/content/icons/` | the web port's core |
| `paperly-web/apps/companion/static/icons/` | the companion extension |

The web app's own copy under `apps/web/src/static/paperly/` is generated:
`paperly-sync.mjs` copies the whole directory, so a new size arrives there on
the next build without anyone editing a list.

## Nothing is drawn on top of it

There is no separate AI badge. An earlier artwork needed one; this one says AI
twice by itself, and a third would be clutter. The only things added are the
superellipse corner -- so the tile matches the application icon and the system
icons it sits beside -- and a hairline, so it still has an edge on a dark
toolbar.

## The whole emblem, at every size

`z=1.10` about the centre, and nothing else. The drawing carries dead navy
around itself; 1.10 trims that and only that. Measured against the edges: at
`1.14` the crown's centre ball reaches the top, by `1.18` it is cut, and the
ribbon's end flags survive 1.10 on both sides.

**It does not read at 20px, and that is a knowing trade.** A crown, a ribbon
and a circuit ring cannot survive a 20px tile: the toolbar button is a dark
navy square with a pale smudge in it. A crop of her own face was built and
rendered at `z=1.90` about `(0.50, 0.47)` -- **A.I.** stayed legible at 20px --
and it was rejected, because the logo is wanted whole. Everything needed to
bring it back is still here: pass `z` and `cx`/`cy` per size in
`build-icons.sh`.

## Why there are three sizes and not four

`styles.css` draws the toolbar button's `img` at **24px** inside a 28px
button. The button is 28 because that is what Zotero's own toolbarbuttons in
that row are, and it is left alone; what grew is the artwork inside it, from
20 to 24, by taking the button's padding from 4 to 2.

That was worth doing because the box was never the problem. Measured against
its neighbours, the 20px tile was already *wider* than the chevron and the
sync glyph beside it (~15px each) -- but the emblem carries its own margin, so
the part actually drawn was smaller than theirs. Filling more of the box fixes
what shrinking the neighbours could not.

24px means the retina asset is 48, which already existed for the plugin
manager. So `icon-40.png` is gone: one file fewer, and no size that exists for
only one caller.

`icon-20.png` stays, and stays 20px, for the preferences pane -- Zotero decides
that one's size, not us.

## And one that is not the emblem at all

`bot-192.png`, for the floating bot. Different drawing, different page:
`face.png` through `bot.html`. The emblem stays on the toolbar button, the
plugin manager and the preferences pane; the bot wears her face, because a face
can blink and a crest cannot.

It is a **strip of three frames** — eyes open, half, shut — 192px each, 576
wide. One file rather than three: one decode, and no frame that can go missing
on its own. 192 because the bot draws one frame at 96 CSS px and grows it to
1.06 under the pointer.

It ships as **her head on transparency**, with no field of its own: the bubble
behind her is CSS, and it can only be translucent if nothing opaque is baked in
behind her. The field is flooded from the border and then **eroded** by 8px,
which hands back the ring of black nearest her — that ring is her outline. A
plain flood cannot be used: her outline is the same near-black as the field and
touches it all the way round, so the fill walks into the linework.

She is fitted to her own measured box, not to the drawing's frame — `FILL` and
`CENTRE_Y` in `bot.html`. The blink repaints the eye rather than covering it.
See `docs/BOT.md` for the fence the fill needs, the fit, and the bubble.

## Trap

**`--allow-file-access-from-files` is not optional.** Chrome will not let a
`file://` page read another local file into a canvas without it, and the
renders come out empty with nothing in the console to say why.
