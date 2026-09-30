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
# Paperly reads its profiles from Application Support/Paperly (Vendor/Name in
# application.ini). Follow the migrated location, but fall back to the old one so
# this keeps working on a machine where paperly-client/app/scripts/migrate_profile
# has not been run yet.
if [[ -z "${PAPERLY_DEV_PROFILE:-}" ]]; then
  DEV_PROFILE="$HOME/Library/Application Support/Paperly/Profiles/paperly-dev"
  LEGACY_PROFILE="$HOME/Library/Application Support/Zotero/Profiles/paperly-dev"
  if [[ ! -d "$DEV_PROFILE" && -d "$LEGACY_PROFILE" ]]; then
    echo "==> Using pre-migration dev profile: $LEGACY_PROFILE"
    DEV_PROFILE="$LEGACY_PROFILE"
  fi
else
  DEV_PROFILE="$PAPERLY_DEV_PROFILE"
fi
DEV_DATA="${PAPERLY_DEV_DATA:-$HOME/Zotero-paperly-dev}"
ADDON_ID="paperly-ai@paperly.org"
# The id this plugin used to ship under. A changed id makes the add-on manager treat
# the new build as a different plugin, so the old one stays installed and you get two
# AI panels side by side -- which has happened once already. Remove it.
LEGACY_ADDON_ID="zotero-webai@lineex.dev"
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

if [[ -e "$DEV_PROFILE/extensions/$LEGACY_ADDON_ID.xpi" ]]; then
  echo "==> Removing the plugin's previous id ($LEGACY_ADDON_ID)"
  rm -f "$DEV_PROFILE/extensions/$LEGACY_ADDON_ID.xpi"
  if [[ -f "$DEV_PROFILE/extensions.json" ]]; then
    python3 - "$DEV_PROFILE/extensions.json" "$LEGACY_ADDON_ID" <<'LEGACY_PY'
import json, sys
path, legacy_id = sys.argv[1], sys.argv[2]
with open(path) as fh:
    data = json.load(fh)
before = len(data.get("addons", []))
data["addons"] = [a for a in data.get("addons", []) if a.get("id") != legacy_id]
if len(data["addons"]) != before:
    with open(path, "w") as fh:
        json.dump(data, fh)
LEGACY_PY
  fi
  rm -f "$DEV_PROFILE/addonStartup.json.lz4"
fi

cp "$XPI" "$DEV_PROFILE/extensions/$ADDON_ID.xpi"

# Paperly disables side-loaded plugins by default: XPIDatabase checks the location's
# scope against extensions.autoDisableScopes and sets userDisabled on anything that
# was merely dropped into the extensions directory, which is exactly what this script
# does. Turning the pref off for THIS profile is the fix that holds.
#
# Patching extensions.json afterwards, below, only ever worked for a plugin that was
# already recorded there. The first install of a new id has no record to patch, so it
# came up disabled and looked like every feature had vanished. That is not
# hypothetical: it happened when the id changed to paperly-ai@paperly.org.
mkdir -p "$DEV_PROFILE"
if ! grep -q 'extensions.autoDisableScopes' "$DEV_PROFILE/prefs.js" 2>/dev/null; then
  echo 'user_pref("extensions.autoDisableScopes", 0);' >> "$DEV_PROFILE/prefs.js"
  echo "==> Allowed side-loaded plugins in the dev profile"
fi

# Belt and braces for a profile that already holds a disabled record: the pref above
# only governs the moment an add-on is first seen.
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
