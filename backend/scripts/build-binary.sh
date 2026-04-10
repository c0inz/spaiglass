#!/usr/bin/env bash
#
# build-binary.sh — compile the SpAIglass host backend into a single
# self-contained binary using `bun build --compile`.
#
# Output layout (per platform):
#   dist/spaiglass-host-<platform>-<arch>/
#     spaiglass-host[.exe]   — the compiled binary
#     static/                — frontend dist (copied from ../frontend/dist)
#
# The static/ directory sits next to the binary so cli/node.ts can find it
# at runtime via <execPath>/../static when running as a compiled binary.
#
# Usage:
#   ./scripts/build-binary.sh                  # build for current host
#   ./scripts/build-binary.sh linux-x64        # build for one target
#   ./scripts/build-binary.sh all              # build the full release matrix
#
# Targets:
#   linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64

set -euo pipefail

cd "$(dirname "$0")/.."

BUN="${BUN:-$HOME/.bun/bin/bun}"
if [[ ! -x "$BUN" ]]; then
  if command -v bun >/dev/null 2>&1; then
    BUN=$(command -v bun)
  else
    echo "error: bun not found. install from https://bun.sh" >&2
    exit 1
  fi
fi

ALL_TARGETS=(linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64)

detect_host_target() {
  local os arch
  case "$(uname -s)" in
    Linux)  os=linux ;;
    Darwin) os=darwin ;;
    MINGW*|MSYS*|CYGWIN*) os=windows ;;
    *) echo "error: unsupported host OS $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "error: unsupported host arch $(uname -m)" >&2; exit 1 ;;
  esac
  echo "${os}-${arch}"
}

case "${1:-}" in
  "")    TARGETS=("$(detect_host_target)") ;;
  all)   TARGETS=("${ALL_TARGETS[@]}") ;;
  *)     TARGETS=("$1") ;;
esac

# Build the frontend if dist is missing or older than source.
FRONTEND_DIST="../frontend/dist"
if [[ ! -d "$FRONTEND_DIST" ]] || [[ ! -f "$FRONTEND_DIST/index.html" ]]; then
  echo "==> Building frontend (dist missing)"
  (cd ../frontend && npm run build)
fi

# Generate version info so the binary reports something sensible.
node scripts/generate-version.js >/dev/null 2>&1 || true

mkdir -p dist

for TARGET in "${TARGETS[@]}"; do
  case "$TARGET" in
    linux-x64|linux-arm64|darwin-x64|darwin-arm64|windows-x64) ;;
    *) echo "error: unknown target '$TARGET'" >&2; exit 1 ;;
  esac

  OUTDIR="dist/spaiglass-host-${TARGET}"
  rm -rf "$OUTDIR"
  mkdir -p "$OUTDIR"

  BIN_NAME="spaiglass-host"
  [[ "$TARGET" == windows-* ]] && BIN_NAME="spaiglass-host.exe"

  echo "==> Compiling for $TARGET -> $OUTDIR/$BIN_NAME"
  "$BUN" build \
    --compile \
    --target="bun-${TARGET}" \
    cli/spaiglass-host.ts \
    --outfile "$OUTDIR/$BIN_NAME"

  echo "==> Copying frontend static files"
  cp -r "$FRONTEND_DIST" "$OUTDIR/static"

  # VERSION file — read from the generated dist/version.json if present, else
  # fall back to today's date in the spaiglass YYYY.MM.DD format.
  if [[ -f dist/version.json ]]; then
    node -e 'process.stdout.write(require("./dist/version.json").version || "")' \
      > "$OUTDIR/VERSION" 2>/dev/null || true
  fi
  if [[ ! -s "$OUTDIR/VERSION" ]]; then
    date +%Y.%m.%d > "$OUTDIR/VERSION"
  fi

  # Tarball: <outdir>.tar.gz with the spaiglass-host-<target>/ top-level dir
  # so install.sh can use --strip-components=1 cleanly.
  TARBALL="dist/spaiglass-host-${TARGET}.tar.gz"
  rm -f "$TARBALL"
  ( cd dist && tar -czf "spaiglass-host-${TARGET}.tar.gz" "spaiglass-host-${TARGET}" )
  TAR_SIZE=$(du -sh "$TARBALL" | cut -f1)

  SIZE=$(du -sh "$OUTDIR" | cut -f1)
  echo "==> $TARGET done — dir $SIZE, tarball $TAR_SIZE"
done

echo
echo "Build complete. Artifacts in dist/:"
ls -1d dist/spaiglass-host-* 2>/dev/null || true
