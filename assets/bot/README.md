# The bot's characters

Who can sit in the floating bot's bubble. The list is `characters.json`; the
plugin reads it at build time (`src/modules/botCharacters.ts`), and
`build-portraits.sh` renders each face from it into `addon/content/icons/`.

On the first launch the bot offers the list in a picker beside itself. After
that it is a right-click on the bot, or **View → Paperly AI Bot Character**.
The choice is the pref `extensions.zotero.zotero-webai.floatingBotCharacter`;
empty means nobody has chosen yet, which is what makes the picker appear.

## Adding a character

1. Put the drawing in this directory: `jpg`, `png` or `webp`, as large as you
   have. The crop circle is drawn at 192px, so one smaller than that across
   is blown up and goes soft. Gojo's, 276px, is about as small as it should go.
2. If the character should be cut out of its background, run `matte.py` on it
   (see below). Otherwise skip this.
3. Add an entry to `characters.json`:

   ```json
   {
     "id": "luffy",
     "name": "Luffy",
     "file": "bot-luffy.png",
     "frames": 1,
     "source": "luffy.png",
     "cutout": "luffy.cut.png",
     "crop": [512, 380, 300],
     "tint": [255, 120, 96]
   }
   ```

4. Run `./build-portraits.sh`, then build the plugin.

| Field | Meaning |
| --- | --- |
| `crop` | `[cx, cy, r]`: a circle in the source's own pixels. Everything outside it is never seen. |
| `cutout` | The drawing with its background removed, made by `matte.py`. Cropped instead of `source` when present. |
| `field` | `"white"` for art on a white page, when there is no cut-out: the page is flooded away from the crop's edge. Cruder than `matte.py`, but needs nothing but Chrome. |
| `opaque` | `true` when the crop keeps its own background. The glass behind it is then hidden, so its shading is painted over the picture instead. |
| `tint` | `[r, g, b]` for the bloom, the rings and the click ripple. Pick the character's colour. Leave it out and you get Anya's rose. |
| `frames` | `1` for a still face. `3` only for a hand-made blink strip like Anya's. |

### Reading off the crop

Open the source in anything that shows pixel coordinates. The framing every
face here uses: the whole head inside the circle where it fits, the eyes a
little above the middle, the face centred left to right. Take the point
between the eyes and the mouth as the centre, then grow `r` until the hair is
in. Then move the centre up until the eyes sit just above the middle.

| | source | cut out | crop |
| --- | --- | --- | --- |
| Anya · Waku Waku | 1056×594, pink page | `matte.py` | `[545, 215, 265]` |
| Anya · Heh | 630×354, blurred room | `matte.py` | `[338, 205, 175]` |
| Nezuko | 800×1426, hot pink page | `matte.py --key` | `[400, 350, 255]` |
| Gojo | 299×668, dark field | no: the model cannot find him in the glow | `[140, 222, 138]` |
| Naruto | 1200×1200, white page | `matte.py` | `[596, 382, 362]` |
| Itachi | 1079×1921, close-up | no: the model cannot find him, and his head runs off the top | `[600, 790, 470]` |

To look at a crop before building, open
`portrait.html?src=<file>&cx=..&cy=..&r=..&field=white` in Chrome started with
`--allow-file-access-from-files`.

## Cutting a character out: matte.py

```bash
python3 matte.py nezuko.webp nezuko.cut.png --key
```

It runs isnet-anime, the anime model rembg ships, straight through
onnxruntime, drops the specks the model leaves in busy backgrounds, and
un-mixes the page colour out of the half-covered pixels on the outline, which
is what stops a pink halo round dark hair. The cut-out is committed, so a
plugin build never needs any of it. Needs numpy, Pillow, scipy and
onnxruntime; the model (176 MB) is downloaded into `~/.cache/paperly/` on first
use, or read from `$PAPERLY_MATTE_MODEL`.

`--key` also clears whatever is the page's colour inside the figure: the gaps
between strands of hair, which the model reads as hair. Only for a page whose
colour the character does not wear: Nezuko on hot pink, not Anya, whose hair
is the colour of hers.

Look at every cut-out on a dark and a light page before using it. The model
fails quietly: on Gojo and Itachi it returns a faint ghost of the whole frame
rather than an error.

## Anya is different

Her face is not rendered here. It is a three-frame blink strip, open, half
and shut, cut out by hand-tuned code in `../icon/bot.html` and built by
`../icon/build-icons.sh`. A blink needs the eyes found and repainted for that
one drawing, so the faces added here hold still.

## Whose drawings these are

Every face here is somebody's artwork, and the characters belong to their
studios. Anya · Heh is a frame from the show with a site's watermark faint on
her forehead. That is fine on your own machine. Before shipping a public
build, get permission or swap in art you have the rights to.
