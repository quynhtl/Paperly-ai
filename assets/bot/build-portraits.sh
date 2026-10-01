#!/bin/bash
# Renders every character in characters.json that has a `source` into
# addon/content/icons/, as one round 192px frame. Anya has no source here: her
# face is a hand-made blink strip, built by assets/icon/build-icons.sh.
#
#   ./build-portraits.sh
#   CHROME=/path/to/chrome ./build-portraits.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN="$(dirname "$(dirname "$HERE")")"
ICONS="$PLUGIN/addon/content/icons"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SIZE=192

[ -x "$CHROME" ] || { echo "No Chrome at $CHROME -- set CHROME=..." >&2; exit 1; }

# One line per character: file, drawing, cx, cy, r, field. The drawing is the
# cut-out when there is one (see matte.py), so the crop reads the same pixels.
ROWS="$(node -e '
	const { characters } = require(process.argv[1]);
	for (const c of characters) {
		if (!c.source) { continue; }
		const [cx, cy, r] = c.crop;
		console.log([c.file, c.cutout || c.source, cx, cy, r, c.field || "-"].join("\t"));
	}
' "$HERE/characters.json")"

echo "==> Rendering"
while IFS=$'\t' read -r file source cx cy r field; do
	[ -n "$file" ] || continue
	[ -f "$HERE/$source" ] || { echo "missing source: $source" >&2; exit 1; }
	[ "$field" = "-" ] && field=""
	out="$ICONS/$file"
	# --allow-file-access-from-files is what lets the page read the drawing's
	# pixels back out of the canvas; without it the flood sees nothing.
	"$CHROME" --headless --disable-gpu --hide-scrollbars \
		--allow-file-access-from-files --default-background-color=00000000 \
		--virtual-time-budget=12000 --force-device-scale-factor=1 \
		--screenshot="$out" --window-size="$SIZE,$SIZE" \
		"file://$HERE/portrait.html?size=$SIZE&src=$source&cx=$cx&cy=$cy&r=$r&field=$field" 2>/dev/null
	[ -s "$out" ] || { echo "render failed: $file" >&2; exit 1; }
	echo "   $file"
done <<< "$ROWS"

echo "==> Done"
