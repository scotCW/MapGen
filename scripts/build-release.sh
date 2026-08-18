#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.signing"

if [[ -f "$ENV_FILE" ]]; then
  echo "==> Loading signing credentials from .env.signing"
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
else
  echo "==> .env.signing not found — expecting env vars to already be set"
fi

echo "==> Step 1: Build universal binary (arm64 + x86_64)"
cd "$REPO_ROOT"
PATH="$HOME/.cargo/bin:$PATH" yarn tauri build --target universal-apple-darwin

APP_PATH="$REPO_ROOT/src-tauri/target/universal-apple-darwin/release/bundle/macos/Hunting Map Generator.app"

if [[ ! -d "$APP_PATH" ]]; then
  echo "ERROR: Expected .app not found at: $APP_PATH" >&2
  exit 1
fi

echo "==> Step 2: Sign, notarize, and package as DMG"
bash "$SCRIPT_DIR/sign-and-notarize.sh" "$APP_PATH"

OUTPUT_DIR="${OUTPUT_DIR:-$HOME/Desktop}"
echo ""
echo "==> Release build complete."
echo "    DMG is at: $OUTPUT_DIR/Hunting Map Generator.dmg"
