#!/usr/bin/env bash
# Install the shared libraries needed by Playwright's bundled Chromium into a
# local directory, without root privileges. Sets CHROMIUM_DEPS_DIR for the
# Playwright config. Idempotent; safe to re-run.
#
# On a normal desktop with system Chromium libraries this script is unnecessary.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS_DIR="${CHROMIUM_DEPS_DIR:-$ROOT/.cache/chromium-deps}"
ARCH="$(dpkg --print-architecture 2>/dev/null || echo arm64)"
MIRROR="https://deb.debian.org/debian"

PACKAGES=(
  libnspr4 libnss3 libxcomposite1 libxdamage1 libxfixes3 libxrandr2
  libasound2 libatk1.0-0 libatspi2.0-0 libdbus-1-3 libgbm1 libxkbcommon0
  libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon-x11-0 libpango-1.0-0
  libcairo2 libpixman-1-0 libfontconfig1 libfreetype6 libharfbuzz0b
  libgraphite2-3 libthai0 libdatrie1 libfribidi0 libpng16-16 libbrotli1
  libbsd0 libmd0 libselinux1 libpcre2-8-0 libuuid1 libffi8 libglib2.0-0
  libxcb1 libx11-6 libxext6 libxi6 libxtst6 liblzma5 libzstd1
  libwayland-server0
)

if [ -d "$DEPS_DIR/usr/lib/aarch64-linux-gnu" ] || [ -d "$DEPS_DIR/usr/lib/x86_64-linux-gnu" ]; then
  echo "chromium deps already present at $DEPS_DIR"
else
  mkdir -p "$DEPS_DIR"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "fetching Debian package index for $ARCH"
  curl -fsSL "$MIRROR/dists/bookworm/main/binary-$ARCH/Packages.gz" -o "$tmp/Packages.gz"
  gzip -dc "$tmp/Packages.gz" | awk '/^Package: /{p=$2} /^Filename: /{print p, $2}' > "$tmp/index"
  for pkg in "${PACKAGES[@]}"; do
    file="$(awk -v p="$pkg" '$1==p {print $2; exit}' "$tmp/index")"
    [ -n "$file" ] || { echo "warning: package $pkg not found"; continue; }
    curl -fsSL "$MIRROR/$file" -o "$tmp/$(basename "$file")"
    dpkg-deb -x "$tmp/$(basename "$file")" "$DEPS_DIR"
  done
  echo "installed chromium deps at $DEPS_DIR"
fi

echo "export CHROMIUM_DEPS_DIR=$DEPS_DIR/usr/lib/$ARCH-linux-gnu:$DEPS_DIR/lib/$ARCH-linux-gnu"
