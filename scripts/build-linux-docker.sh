#!/usr/bin/env bash
#
# Builds the Linux packages (.deb, .rpm, AppImage, Flatpak) from macOS or any
# Docker host, inside an x86_64 Ubuntu 22.04 container.
#
#   ./scripts/build-linux-docker.sh          # output in dist-linux/
#
# Builds the committed HEAD (via `git archive`), never uncommitted changes, so
# what ships matches a commit. On Apple Silicon run Docker with x86_64
# emulation — e.g. `colima start --vm-type vz --vz-rosetta` — or the Rust
# build is very slow under QEMU.
#
# The container runs --privileged because flatpak-builder sandboxes each build
# step with bubblewrap, which needs user namespaces.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="$PWD/dist-linux"
IMAGE=mapgen-linux-build
mkdir -p "$OUT"

docker build --platform linux/amd64 -t "$IMAGE" scripts/linux

git archive --format=tar HEAD | docker run --rm -i --privileged --platform linux/amd64 \
  -v mapgen-cargo-registry:/usr/local/cargo/registry \
  -v mapgen-cargo-target:/build/src-tauri/target \
  -v mapgen-yarn-cache:/usr/local/share/.cache/yarn \
  -v mapgen-flatpak:/var/lib/flatpak \
  -v "$OUT":/out \
  "$IMAGE" bash -c '
    set -euo pipefail
    mkdir -p /build && cd /build && tar -x
    yarn install --frozen-lockfile
    ./scripts/build-linux.sh --appimage --flatpak-direct --system
    # build-linux.sh empties the bundle dir first, so only this build is here.
    b=src-tauri/target/release/bundle
    cp "$b"/deb/*.deb "$b"/rpm/*.rpm "$b"/appimage/*.AppImage "$b"/*.flatpak /out/
  '

echo "==> Linux packages in $OUT:"
ls -lh "$OUT"
