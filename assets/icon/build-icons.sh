#!/bin/bash
# Renders the Paperly AI plugin icons into addon/content/icons/, and into the
# web port's copies of the same files. Two drawings, two pages:
#   logo.png  -> icon.html -> icon-{20,48,96}.png   the emblem, as a tile
#   face.png  -> bot.html  -> bot-192.png           her face, as a blink strip
#
#   ./build-icons.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN="$(dirname "$(dirname "$HERE")")"
WEB="$(dirname "$PLUGIN")/paperly-web"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

[ -x "$CHROME" ] || { echo "No Chrome at $CHROME -- set CHROME=..." >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --allow-file-access-from-files is what lets the page read the drawing's
# pixels back out of the canvas; without it the frame cannot be measured.
shoot() { # shoot <out.png> <w> <h> <url>
	"$CHROME" --headless --disable-gpu --hide-scrollbars \
		--allow-file-access-from-files --default-background-color=00000000 \
		--virtual-time-budget=12000 \
		--screenshot="$1" --window-size="$2,$3" "$4" 2>/dev/null
	[ -s "$1" ] || { echo "render failed: $1" >&2; exit 1; }
}

render() { # render <out.png> <size> <query>
	shoot "$1" "$2" "$2" "file://$HERE/icon.html?size=$2&$3"
}

# The whole emblem at every size. 1.10 and not 1.00 because the drawing
# carries dead navy around itself; 1.10 trims that and nothing else. Measured
# against the edges: at 1.14 the crown's centre ball reaches the top, and by
# 1.18 it is cut. The ribbon's end flags survive 1.10 on both sides.
EMBLEM="z=1.10"

echo "==> Rendering"
# 48 is the toolbar button at 2x as well as the plugin manager at 1x.
for s in 20 48 96; do
	render "$TMP/icon-$s.png" "$s" "$EMBLEM"
done

# The floating bot's face: three frames of a blink, side by side. 192 is 2x
# the 96px the bot draws one frame at, so the strip is 576 wide.
shoot "$TMP/bot-192.png" 576 192 "file://$HERE/bot.html?size=192&sheet=1"


install_into() { # install_into <dir> [sizes...]
	local dir="$1"; shift
	[ -d "$dir" ] || { echo "   skip (absent): $dir"; return; }
	for s in "$@"; do
		cp "$TMP/icon-$s.png" "$dir/icon-$s.png"
	done
	cp "$TMP/bot-192.png" "$dir/bot-192.png"
	echo "   $dir"
}

echo "==> Installing"
install_into "$PLUGIN/addon/content/icons" 20 48 96
install_into "$WEB/packages/webai-core/addon/content/icons" 20 48 96
install_into "$WEB/apps/companion/static/icons" 20 48 96

echo "==> Done"
