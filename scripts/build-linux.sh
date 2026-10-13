#!/usr/bin/env bash
#
# Builds the Linux packages for Hunting Map Generator (x86_64).
#
#   ./scripts/build-linux.sh              # .deb + .rpm
#   ./scripts/build-linux.sh --flatpak    # the above, then a Flatpak
#   ./scripts/build-linux.sh --appimage   # also an AppImage
#   ./scripts/build-linux.sh --deps       # install build prerequisites first
#   ./scripts/build-linux.sh --system     # Flatpak runtime/app system-wide
#                                         # (for root in a container)
#
# From macOS, ./scripts/build-linux-docker.sh runs this in a container.
#
# Must run on Linux. Tauri links against the system GTK/WebKitGTK libraries, so
# there is no supported way to cross-compile this from macOS or Windows — build
# on an Ubuntu machine, a VM, a container, or CI.
#
# Targets Ubuntu 22.04+ (needs webkit2gtk-4.1, which is not in 20.04). Building
# on the oldest release you intend to support keeps the glibc requirement low
# enough for newer ones to run the same binary.
set -euo pipefail

cd "$(dirname "$0")/.."

WANT_FLATPAK=0
WANT_DEPS=0
WANT_APPIMAGE=0
FLATPAK_SCOPE=--user
for arg in "$@"; do
  case "$arg" in
    --flatpak) WANT_FLATPAK=1 ;;
    --deps)    WANT_DEPS=1 ;;
    --appimage) WANT_APPIMAGE=1 ;;
    --system)  FLATPAK_SCOPE=--system ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  cat >&2 <<'EOF'
error: this script must run on Linux.

Tauri builds against the system WebKitGTK/GTK libraries, so a Linux package
cannot be produced from macOS. Use one of:
  - an Ubuntu 22.04+ machine or VM
  - a container:  docker run --rm -it -v "$PWD":/src -w /src ubuntu:22.04
  - CI (see BUILDING.md)
EOF
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "x86_64" ]]; then
  echo "warning: building on $ARCH; the published target is x86_64." >&2
fi

if [[ "$WANT_DEPS" == "1" ]]; then
  echo "==> Installing build prerequisites (requires sudo)"
  sudo apt-get update
  # webkit2gtk-4.1 is the Tauri v2 requirement; librsvg is needed by the icon
  # step of the bundler; the rest are the standard Tauri Linux prerequisites.
  sudo apt-get install -y \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    build-essential \
    curl wget file \
    libssl-dev \
    libxdo-dev \
    patchelf \
    rpm
  if [[ "$WANT_FLATPAK" == "1" ]]; then
    sudo apt-get install -y flatpak flatpak-builder
    flatpak remote-add --if-not-exists "$FLATPAK_SCOPE" \
      flathub https://flathub.org/repo/flathub.flatpakrepo
  fi
fi

command -v cargo >/dev/null || { echo "error: cargo not found — install Rust from https://rustup.rs" >&2; exit 1; }

echo "==> Building frontend + Tauri bundles"
# Start from an empty bundle dir: the Flatpak step packages whichever .deb it
# finds there, so a leftover from an older version must not be picked up.
rm -rf src-tauri/target/release/bundle
# `tauri build` runs the frontend build itself via beforeBuildCommand.
BUNDLES=deb,rpm
if [[ "$WANT_APPIMAGE" == "1" ]]; then
  BUNDLES="$BUNDLES,appimage"
  # linuxdeploy is itself an AppImage; this lets it run without FUSE
  # (containers, CI).
  export APPIMAGE_EXTRACT_AND_RUN=1
fi
if command -v yarn >/dev/null; then
  yarn tauri build --bundles "$BUNDLES"
else
  npx tauri build --bundles "$BUNDLES"
fi

BUNDLE_DIR="src-tauri/target/release/bundle"
echo
echo "==> Built:"
find "$BUNDLE_DIR" -maxdepth 2 -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) \
  -exec ls -lh {} \; | awk '{printf "    %-8s %s\n", $5, $NF}'

if [[ "$WANT_FLATPAK" == "1" ]]; then
  command -v flatpak-builder >/dev/null || {
    echo "error: flatpak-builder not found — re-run with --deps" >&2; exit 1; }

  echo
  echo "==> Installing Flatpak runtime"
  flatpak install "$FLATPAK_SCOPE" --noninteractive --or-update \
    flathub org.gnome.Platform//47 org.gnome.Sdk//47

  echo "==> Building Flatpak"
  flatpak-builder "$FLATPAK_SCOPE" --install --force-clean \
    build-flatpak flatpak/com.huntingmapgenerator.app.yml

  echo "==> Exporting single-file bundle"
  rm -rf .flatpak-repo
  flatpak-builder --repo=.flatpak-repo --force-clean \
    build-flatpak flatpak/com.huntingmapgenerator.app.yml
  flatpak build-bundle .flatpak-repo \
    "$BUNDLE_DIR/hunting-map-generator.flatpak" \
    com.huntingmapgenerator.app
  rm -rf .flatpak-repo

  echo
  echo "    Installed ($FLATPAK_SCOPE). Run with:"
  echo "      flatpak run com.huntingmapgenerator.app"
  echo "    Portable bundle: $BUNDLE_DIR/hunting-map-generator.flatpak"
  echo "    Install elsewhere with:"
  echo "      flatpak install --user hunting-map-generator.flatpak"
fi
