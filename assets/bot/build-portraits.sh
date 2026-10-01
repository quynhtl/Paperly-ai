#!/bin/bash
# Renders every character in characters.json that has a `source` into
# addon/content/icons/, as one 224px frame. Anya has no source here: her face is
# a hand-made blink strip, built by assets/icon/build-icons.sh.
#
#   ./build-portraits.sh
#   CHROME=/path/to/chrome ./build-portraits.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN="$(dirname "$(dirname "$HERE")")"
ICONS="$PLUGIN/addon/content/icons"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
# The bot draws a face in a 112px frame around its 96px disc; 224 is the 2x.
SIZE=224
BOX="$(node -p '112 / 96')"

[ -x "$CHROME" ] || { echo "No Chrome at $CHROME -- set CHROME=..." >&2; exit 1; }

# One query string per character. A cut-out is rendered whole, because the bot
# masks it itself (letting the head out over the disc); a framed portrait is
# rounded to the disc here.
ROWS="$(node -e '
	const { characters } = require(process.argv[1]);
	for (const c of characters) {
		if (!c.source) { continue; }
		const [cx, cy, r] = c.crop;
		const query = new URLSearchParams({
			src: c.cutout || c.source,
			cx, cy, r,
			shape: c.kind === "cutout" ? "free" : "disc",
		});
		if (c.field) { query.set("field", c.field); }
		if (c.fade) { query.set("fade", c.fade); }
		if (c.tone) { query.set("tone", c.tone.join(",")); }
		console.log([c.file, c.cutout || c.source, query].join("\t"));
	}
' "$HERE/characters.json")"

echo "==> Rendering"
while IFS=$'\t' read -r file drawing query; do
	[ -n "$file" ] || continue
	[ -f "$HERE/$drawing" ] || { echo "missing drawing: $drawing" >&2; exit 1; }
	out="$ICONS/$file"
	# --allow-file-access-from-files is what lets the page read the drawing's
	# pixels back out of the canvas; without it the flood sees nothing.
	"$CHROME" --headless --disable-gpu --hide-scrollbars \
		--allow-file-access-from-files --default-background-color=00000000 \
		--virtual-time-budget=12000 --force-device-scale-factor=1 \
		--screenshot="$out" --window-size="$SIZE,$SIZE" \
		"file://$HERE/portrait.html?size=$SIZE&box=$BOX&$query" 2>/dev/null
	[ -s "$out" ] || { echo "render failed: $file" >&2; exit 1; }
	echo "   $file"
done <<< "$ROWS"

echo "==> Done"
