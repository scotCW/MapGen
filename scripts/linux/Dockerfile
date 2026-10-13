# Build environment for the Linux packages (.deb, .rpm, Flatpak).
# Used by scripts/build-linux-docker.sh; see BUILDING.md → Linux Packages.
#
# Ubuntu 22.04 is deliberate: the binary's glibc floor is set by the build
# host, and 22.04 is the oldest release with webkit2gtk-4.1 (Tauri v2).
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
      build-essential curl wget file ca-certificates git xz-utils \
      libssl-dev libxdo-dev patchelf rpm \
      flatpak flatpak-builder \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (Vite 8 needs >= 20.19) and Yarn 1 — the project is a Yarn workspace.
ARG NODE_VERSION=22.20.0
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && npm install -g yarn@1.22.22

ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable

RUN flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
