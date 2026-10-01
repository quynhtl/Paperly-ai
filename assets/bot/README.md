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
2. Add an entry to `characters.json`:

   ```json
   {
     "id": "luffy",
     "name": "Luffy",
     "file": "bot-luffy.png",
     "frames": 1,
     "source": "luffy.png",
     "crop": [512, 380, 300],
     "field": "white",
     "tint": [255, 120, 96]
   }
   ```

3. Run `./build-portraits.sh`, then build the plugin.

| Field | Meaning |
| --- | --- |
| `crop` | `[cx, cy, r]`: a circle in the source's own pixels. Everything outside it is never seen. |
| `field` | `"white"` for art on a white page: the page is cut away so the head floats in the glass. Leave it out for anything else. |
| `opaque` | `true` when the crop keeps its own background. The glass behind it is then hidden, so its shading is painted over the picture instead. |
| `tint` | `[r, g, b]` for the bloom, the rings and the click ripple. Pick the character's colour. Leave it out and you get Anya's rose. |
| `frames` | `1` for a still face. `3` only for a hand-made blink strip like Anya's. |

### Reading off the crop

Open the source in anything that shows pixel coordinates. The framing every
face here uses: the whole head inside the circle where it fits, the eyes a
little above the middle, the face centred left to right. Take the point
between the eyes and the mouth as the centre, then grow `r` until the hair is
in. Then move the centre up until the eyes sit just above the middle.

| | source | crop |
| --- | --- | --- |
| Nezuko | 600×899, white page | `[294, 288, 228]` |
| Gojo | 299×668, dark field | `[140, 222, 138]` |
| Naruto | 1200×1200, white page | `[596, 382, 362]` |
| Itachi | 640×853, marker on paper | `[325, 430, 265]` |

To look at a crop before building, open
`portrait.html?src=<file>&cx=..&cy=..&r=..&field=white` in Chrome started with
`--allow-file-access-from-files`.

## Anya is different

Her face is not rendered here. It is a three-frame blink strip, open, half
and shut, cut out by hand-tuned code in `../icon/bot.html` and built by
`../icon/build-icons.sh`. A blink needs the eyes found and repainted for that
one drawing, so the faces added here hold still.

## Whose drawings these are

Every face here is somebody's artwork: the characters belong to their studios,
and the Itachi drawing is by **@MCDrawAnime** (their signature sits below the
crop). That is fine on your own machine. Before shipping a public build, get
permission or swap in art you have the rights to.
