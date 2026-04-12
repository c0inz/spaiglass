#!/usr/bin/env bash
#
# pack.sh — build the slim SpAIglass VM tarball that the installer downloads.
#
# Layout produced:
#
#   spaiglass/
#     VERSION                  (date-stamped)
#     install.sh               (the installer)
#     backend/package.json     (runtime deps + bin)
#     backend/dist/cli/...     (bundled backend entry)
#     backend/dist/connector.js
#
# The frontend is intentionally NOT bundled into this tarball — the relay
# serves it. See /opt/sgcleanrelay/frontend on the droplet.
#
# Usage:
#   ./pack.sh                 # rebuild backend, repack tarball
#   ./pack.sh --no-build      # repack only (assume backend/dist is fresh)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$RELAY_DIR")"
BACKEND_DIR="$REPO_ROOT/backend"
RELEASE_DIR="$SCRIPT_DIR"

DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    -h|--help)  sed -n '2,18p' "$0"; exit 0 ;;
    *)          echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

VERSION="$(date -u +%Y.%m.%d)"
echo "==> SpAIglass VM tarball pack — version $VERSION"

# 1. Build backend bundle (skip the static copy step entirely — relay serves frontend)
if [ "$DO_BUILD" = "1" ]; then
  echo "==> Building backend (bundle only, no static)"
  ( cd "$BACKEND_DIR" && npm run build:clean && npm run build:bundle )
else
  echo "==> Skipping build (--no-build)"
fi

[ -f "$BACKEND_DIR/dist/cli/node.js" ]    || { echo "missing backend/dist/cli/node.js"   >&2; exit 1; }
[ -f "$BACKEND_DIR/dist/connector.js" ]   || { echo "missing backend/dist/connector.js"  >&2; exit 1; }

# 2. Stage. Fresh tmp dir each time so stale files never sneak in.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/spaiglass"
mkdir -p "$PKG/backend/dist/cli"

cp "$BACKEND_DIR/dist/cli/node.js"          "$PKG/backend/dist/cli/node.js"
[ -f "$BACKEND_DIR/dist/cli/node.js.map" ] && cp "$BACKEND_DIR/dist/cli/node.js.map" "$PKG/backend/dist/cli/node.js.map"
cp "$BACKEND_DIR/dist/connector.js"         "$PKG/backend/dist/connector.js"
cp "$BACKEND_DIR/package.json"              "$PKG/backend/package.json"
cp "$RELEASE_DIR/install.sh"                "$PKG/install.sh"
echo "$VERSION" > "$PKG/VERSION"

# Refresh the canonical VERSION file the relay serves alongside the tarball
echo "$VERSION" > "$RELEASE_DIR/VERSION"

# 3. Pack
TARBALL="$RELEASE_DIR/dist.tar.gz"
( cd "$STAGE" && tar -czf "$TARBALL" spaiglass )

SIZE_BYTES=$(stat -c%s "$TARBALL" 2>/dev/null || stat -f%z "$TARBALL")
SIZE_KB=$(( SIZE_BYTES / 1024 ))

echo
echo "==> Wrote $TARBALL ($SIZE_KB KB)"
tar -tzf "$TARBALL" | sort
echo
echo "==> Done. Version $VERSION"
