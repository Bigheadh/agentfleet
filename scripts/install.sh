#!/usr/bin/env sh
# One-line installer for AgentFleet standalone binaries (Linux / macOS, x64 / arm64).
#
# Examples:
#   curl -fsSL https://raw.githubusercontent.com/Bigheadh/agentfleet/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/Bigheadh/agentfleet/main/scripts/install.sh | sh -s -- --hub
#   curl -fsSL https://raw.githubusercontent.com/Bigheadh/agentfleet/main/scripts/install.sh | sh -s -- --all
#
# Env overrides:
#   VERSION=v0.1.0          Pin a specific release tag (default: latest)
#   INSTALL_DIR=/usr/local/bin  Destination directory (default: ~/.local/bin)
#   REPO=Bigheadh/agentfleet
set -eu

REPO="${REPO:-Bigheadh/agentfleet}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${VERSION:-latest}"
INSTALL_NODE=1
INSTALL_HUB=0

for arg in "$@"; do
  case "$arg" in
    --hub) INSTALL_HUB=1; INSTALL_NODE=0 ;;
    --node) INSTALL_NODE=1; INSTALL_HUB=0 ;;
    --all) INSTALL_HUB=1; INSTALL_NODE=1 ;;
    -h|--help)
      echo "Usage: install.sh [--node | --hub | --all]"
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$OS" in
  linux|darwin) ;;
  *) echo "Unsupported OS: $OS (Linux and macOS only)" >&2; exit 1 ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
TARGET="${OS}-${ARCH}"

if [ "$VERSION" = "latest" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
  if [ -z "$VERSION" ]; then
    echo "Failed to resolve latest release from https://github.com/${REPO}/releases" >&2
    exit 1
  fi
fi

BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading checksums for AgentFleet ${VERSION} (${TARGET})..."
curl -fsSL "${BASE_URL}/SHA256SUMS.txt" -o "$TMP/SHA256SUMS.txt"

verify_sha256() {
  file="$1"
  expected="$(awk -v f="$file" '$2 == f { print $1 }' "$TMP/SHA256SUMS.txt")"
  if [ -z "$expected" ]; then
    echo "Checksum entry not found for $file" >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$TMP/$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$TMP/$file" | awk '{print $1}')"
  else
    echo "Warning: sha256sum/shasum not found, skipping checksum verification" >&2
    return 0
  fi
  if [ "$actual" != "$expected" ]; then
    echo "Checksum mismatch for $file! expected=$expected actual=$actual" >&2
    exit 1
  fi
}

install_bin() {
  name="$1"
  archive="${name}-${VERSION}-${TARGET}.tar.gz"
  echo "Downloading ${archive}..."
  curl -fsSL "${BASE_URL}/${archive}" -o "$TMP/${archive}"
  verify_sha256 "$archive"
  mkdir -p "$INSTALL_DIR"
  tar -xzf "$TMP/${archive}" -C "$INSTALL_DIR" "$name"
  chmod +x "$INSTALL_DIR/$name"
  echo "Installed: $INSTALL_DIR/$name ($("$INSTALL_DIR/$name" --version))"
}

[ "$INSTALL_NODE" = "1" ] && install_bin "agentfleet-node"
[ "$INSTALL_HUB" = "1" ] && install_bin "agentfleet-hub"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Note: add $INSTALL_DIR to your PATH (e.g. export PATH=\"$INSTALL_DIR:\$PATH\")" ;;
esac
