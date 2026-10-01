#!/bin/bash
# Renders the Paperly AI plugin icons into addon/content/icons/, and into the
# web port's copies of the same files. Two drawings, two pages:
#   logo.png  -> icon.html -> icon-{20,48,96}.png   the emblem, as a tile
#   face.png  -> bot.html  -> bot-anya.png          her face, as a blink strip,
#                             bot-192.png           and the web port's older one
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

# The floating bot's face: three frames of a blink, side by side.
#
# The plugin's bot gives a face a 112px frame around its 96px disc, so her head
# can come up out of it; 224 is that frame at 2x. She is fitted a little larger
# and a little higher than in the old frame -- 0.89 of its width, centred at
# 0.51 of its height -- which puts her ears and her ahoge over the disc's rim
# and keeps her chin inside it. (assets/bot/README.md has the frame.)
shoot "$TMP/bot-anya.png" 672 224 "file://$HERE/bot.html?size=224&sheet=1&fill=0.89&centre=0.51"
# The web port still draws her the old way, a 192px frame that is all disc.
shoot "$TMP/bot-192.png" 576 192 "file://$HERE/bot.html?size=192&sheet=1"


install_into() { # install_into <dir> <bot face file> [sizes...]
	local dir="$1" face="$2"; shift 2
	[ -d "$dir" ] || { echo "   skip (absent): $dir"; return; }
	for s in "$@"; do
		cp "$TMP/icon-$s.png" "$dir/icon-$s.png"
	done
	cp "$TMP/$face" "$dir/$face"
	echo "   $dir"
}

echo "==> Installing"
install_into "$PLUGIN/addon/content/icons" bot-anya.png 20 48 96
install_into "$WEB/packages/webai-core/addon/content/icons" bot-192.png 20 48 96
install_into "$WEB/apps/companion/static/icons" bot-192.png 20 48 96

echo "==> Done"
