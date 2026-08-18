#!/usr/bin/env bash
set -euo pipefail

REQUIRED_VARS=(
  APPLE_SIGNING_IDENTITY
  APPLE_ID
  APPLE_APP_SPECIFIC_PASSWORD
  APPLE_TEAM_ID
)

for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is not set. Copy .env.signing.example to .env.signing and fill it in." >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTITLEMENTS="$REPO_ROOT/src-tauri/entitlements.plist"

locate_app() {
  local candidates=(
    "$REPO_ROOT/src-tauri/target/universal-apple-darwin/release/bundle/macos/Hunting Map Generator.app"
    "$REPO_ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Hunting Map Generator.app"
    "$REPO_ROOT/src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Hunting Map Generator.app"
    "$REPO_ROOT/src-tauri/target/release/bundle/macos/Hunting Map Generator.app"
  )
  for c in "${candidates[@]}"; do
    [[ -d "$c" ]] && { echo "$c"; return 0; }
  done
  return 1
}

if [[ $# -ge 1 ]]; then
  APP_PATH="$1"
else
  echo "==> No .app path given, searching src-tauri/target/ ..."
  if ! APP_PATH="$(locate_app)"; then
    echo "ERROR: Could not find a built .app. Pass it as argument or build first." >&2
    exit 1
  fi
fi

[[ -d "$APP_PATH" ]] || { echo "ERROR: Not a directory: $APP_PATH" >&2; exit 1; }

OUTPUT_DIR="${OUTPUT_DIR:-$HOME/Desktop}"
APP_NAME="$(basename "$APP_PATH" .app)"
DMG_PATH="$OUTPUT_DIR/${APP_NAME}.dmg"
ZIP_PATH="$(mktemp -d)/notarize-upload.zip"

echo "==> App path     : $APP_PATH"
echo "==> Output DMG   : $DMG_PATH"
echo "==> Entitlements : $ENTITLEMENTS"
echo ""

echo "==> Step 1: Sign nested dylibs and frameworks (bottom-up)"
while IFS= read -r -d '' binary; do
  codesign \
    --force \
    --options runtime \
    --sign "$APPLE_SIGNING_IDENTITY" \
    --entitlements "$ENTITLEMENTS" \
    "$binary"
done < <(find "$APP_PATH" \( -name "*.dylib" -o -name "*.so" \) -print0)

if [[ -d "$APP_PATH/Contents/Frameworks" ]]; then
  find "$APP_PATH/Contents/Frameworks" -maxdepth 1 -mindepth 1 | while read -r fw; do
    codesign \
      --deep \
      --force \
      --options runtime \
      --sign "$APPLE_SIGNING_IDENTITY" \
      --entitlements "$ENTITLEMENTS" \
      "$fw"
  done
fi

echo "==> Step 2: Sign outer .app bundle"
codesign \
  --deep \
  --force \
  --options runtime \
  --sign "$APPLE_SIGNING_IDENTITY" \
  --entitlements "$ENTITLEMENTS" \
  "$APP_PATH"

echo "==> Step 3: Verify signature"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

echo "==> Step 4: Create zip for notarization upload"
ditto -c -k --rsrc --keepParent "$APP_PATH" "$ZIP_PATH"

echo "==> Step 5: Submit to Apple notarization (this may take several minutes)"
xcrun notarytool submit "$ZIP_PATH" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

echo "==> Step 6: Staple notarization ticket to .app"
xcrun stapler staple "$APP_PATH"

echo "==> Step 7: Package as DMG"
mkdir -p "$OUTPUT_DIR"
hdiutil create \
  -volname "Hunting Map Generator" \
  -srcfolder "$APP_PATH" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

echo "==> Step 8: Sign the DMG"
codesign \
  --force \
  --options runtime \
  --sign "$APPLE_SIGNING_IDENTITY" \
  "$DMG_PATH"

echo "==> Step 9: Notarize the DMG"
DMG_ZIP_PATH="$(mktemp -d)/notarize-dmg.zip"
ditto -c -k --rsrc --keepParent "$DMG_PATH" "$DMG_ZIP_PATH"

xcrun notarytool submit "$DMG_ZIP_PATH" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

echo "==> Step 10: Staple notarization ticket to DMG"
xcrun stapler staple "$DMG_PATH"

echo ""
echo "==> Done. Signed, notarized DMG:"
echo "    $DMG_PATH"
