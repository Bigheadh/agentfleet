#!/usr/bin/env bash
# Build standalone single-file binaries for AgentFleet Hub & Node using Bun.
#
# Usage:
#   VERSION=v0.1.0 ./scripts/build-release.sh <target> [out_dir]
#
# Supported targets:
#   linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64
set -euo pipefail

TARGET="${1:-}"
OUT_DIR="${2:-dist/release}"
VERSION="${VERSION:-0.1.0}"

case "$TARGET" in
  linux-x64|linux-arm64|darwin-arm64|darwin-x64) ;;
  *)
    echo "Usage: VERSION=v0.1.0 $0 <linux-x64|linux-arm64|darwin-arm64|darwin-x64> [out_dir]" >&2
    exit 1
    ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Bun stores downloaded cross-compilation runtimes under $BUN_INSTALL/install/cache.
# Fall back to $HOME/.bun if the system bun directory (e.g. /usr/local/bun) is not writable.
if [ -z "${BUN_INSTALL:-}" ] || [ ! -w "${BUN_INSTALL}" ]; then
  export BUN_INSTALL="$HOME/.bun"
fi
mkdir -p "$BUN_INSTALL/install/cache"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT_DIR"

build_one() {
  local name="$1"
  local entry="$2"
  local bin="$STAGE/$name"
  local archive="$OUT_DIR/${name}-${VERSION}-${TARGET}.tar.gz"

  echo "==> Building $name ($VERSION, bun-$TARGET)"
  bun build "$entry" \
    --compile \
    --minify \
    --target="bun-$TARGET" \
    --define "__AGENTFLEET_VERSION__=\"$VERSION\"" \
    --outfile "$bin"

  # Smoke-test when building for the current host platform.
  local host_os host_arch
  host_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  host_arch="$(uname -m)"
  case "$host_arch" in
    x86_64|amd64) host_arch="x64" ;;
    aarch64|arm64) host_arch="arm64" ;;
  esac
  if [ "${host_os}-${host_arch}" = "$TARGET" ]; then
    echo "    smoke test: $("$bin" --version)"
  fi

  tar -czf "$archive" -C "$STAGE" "$name"
  echo "    packed: $archive ($(du -h "$archive" | awk '{print $1}'))"
}

build_one "agentfleet-hub" "packages/hub/src/cli.ts"
build_one "agentfleet-node" "packages/fleetd/src/cli.ts"
