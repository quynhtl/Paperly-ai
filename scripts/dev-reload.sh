#!/bin/bash
# Rebuild the plugin and install it into an ISOLATED dev profile, never the
# profile you use day to day. Testing a crashing build must not disturb real work.
#
# Usage: ./scripts/dev-reload.sh [--launch]
#   default    build + install into the dev profile only
#   --launch   also start Zotero on the dev profile and dev data dir
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZOTERO_SRC="${ZOTERO_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../paperly-client" && pwd)}"
DEV_PROFILE="${PAPERLY_DEV_PROFILE:-$HOME/Library/Application Support/Zotero/Profiles/paperly-dev}"
DEV_DATA="${PAPERLY_DEV_DATA:-$HOME/Zotero-paperly-dev}"
ADDON_ID="zotero-webai@lineex.dev"
ZOTERO_BIN="$ZOTERO_SRC/app/staging/Paperly.app/Contents/MacOS/paperly"
LAUNCH=0
[[ "${1:-}" == "--launch" ]] && LAUNCH=1

echo "==> Building"
cd "$PLUGIN_DIR"
NODE_ENV=production npm run build

XPI="$(ls -t "$PLUGIN_DIR"/.scaffold/build/*.xpi | head -1)"
[[ -f "$XPI" ]] || { echo "No XPI produced" >&2; exit 1; }

echo "==> Installing into dev profile"
mkdir -p "$DEV_PROFILE/extensions" "$DEV_DATA"
cp "$XPI" "$DEV_PROFILE/extensions/$ADDON_ID.xpi"

# Zotero disables side-loaded plugins by default.
if [[ -f "$DEV_PROFILE/extensions.json" ]]; then
  python3 - "$DEV_PROFILE/extensions.json" "$ADDON_ID" <<'PY'
import json, sys
path, addon_id = sys.argv[1], sys.argv[2]
with open(path) as fh:
    data = json.load(fh)
for addon in data.get("addons", []):
    if addon.get("id") == addon_id:
        addon["userDisabled"] = False
        addon["active"] = True
        addon["seen"] = True
with open(path, "w") as fh:
    json.dump(data, fh)
PY
fi

if [[ $LAUNCH -eq 1 ]]; then
  # Log to a persistent path: /tmp is wiped between sessions, which has already
  # cost us one diagnostic run.
  LOG="${PAPERLY_DEV_LOG:-$HOME/paperly-dev.log}"
  echo "==> Launching on dev profile (log: $LOG)"
  exec "$ZOTERO_BIN" -profile "$DEV_PROFILE" -datadir "$DEV_DATA" \
    -no-remote -jsconsole -ZoteroDebugText 2>&1 | tee "$LOG"
fi
echo "==> Installed (not launched). Run with --launch to start the dev instance."
