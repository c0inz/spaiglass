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

# Verify a Mach-O binary carries a real embedded code signature (not bun's
# 16-byte placeholder stub). Checks for CSMAGIC_EMBEDDED_SIGNATURE and
# CSMAGIC_CODEDIRECTORY magic bytes — these are present in any valid
# SuperBlob, regardless of signing identity. If either is missing, ldid
# silently no-oped and the binary will SIGKILL on Apple Silicon.
#
# Added 2026-04-14 after a session where an unsigned darwin-arm64 binary
# shipped to a Mac Mini and was kernel-killed at exec. Without this check,
# a broken ldid (missing, wrong version, aborted mid-sign) would pass the
# build silently and only manifest on an end-user machine.
verify_darwin_signature() {
  local bin="$1"
  # CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0 (big-endian SuperBlob wrapper)
  if ! LC_ALL=C grep -q $'\xfa\xde\x0c\xc0' "$bin"; then
    echo "error: $bin has no CSMAGIC_EMBEDDED_SIGNATURE — LC_CODE_SIGNATURE placeholder was not overwritten by ldid" >&2
    return 1
  fi
  # CSMAGIC_CODEDIRECTORY = 0xfade0c02 (the hash table inside the SuperBlob)
  if ! LC_ALL=C grep -q $'\xfa\xde\x0c\x02' "$bin"; then
    echo "error: $bin has SuperBlob wrapper but no CodeDirectory — signature is malformed" >&2
    return 1
  fi
  return 0
}

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

  # For x64 targets, use the baseline variant so the binary runs on CPUs
  # without AVX2 (Sandy/Ivy Bridge Xeons, older cloud instances, many VMs).
  # The default bun-linux-x64 / bun-windows-x64 targets assume AVX2 and
  # SIGILL on older CPUs. arm64 and darwin have no baseline split.
  BUN_TARGET="bun-${TARGET}"
  case "$TARGET" in
    linux-x64|windows-x64) BUN_TARGET="bun-${TARGET}-baseline" ;;
  esac

  echo "==> Compiling for $TARGET (${BUN_TARGET}) -> $OUTDIR/$BIN_NAME"
  "$BUN" build \
    --compile \
    --target="$BUN_TARGET" \
    cli/spaiglass-host.ts \
    --outfile "$OUTDIR/$BIN_NAME"

  # macOS — ad-hoc code-sign the binary at BUILD TIME using ldid so
  # end-users don't need Xcode Command Line Tools (~3 GB of dev tools just
  # to install our app). Apple's `codesign` is macOS-only, but ldid
  # (https://github.com/ProcursusTeam/ldid — Jay Freeman's iOS-jailbreak-era
  # Linux-friendly Mach-O signing tool) produces valid Apple ad-hoc
  # signatures from any platform.
  #
  # Why this is required: on Apple Silicon (arm64) the kernel itself
  # refuses to load any unsigned Mach-O binary — independent of Gatekeeper,
  # independent of quarantine. The binary SIGKILLs at exec with no error.
  # An ad-hoc signature is enough to satisfy the kernel; we don't need a
  # Developer ID certificate or notarization for day-one installs, just a
  # valid CMS signature blob.
  #
  # Why ldid and not rcodesign: bun's `--compile` output ships with a
  # PLACEHOLDER LC_CODE_SIGNATURE load command pointing at a 16-byte stub.
  # rcodesign tries to parse that stub as a real SuperBlob, fails with
  # "SuperBlob data is malformed", and refuses to sign. ldid is more
  # permissive — it overwrites the placeholder with a real signature
  # blob without complaining. (Verified 2026-04-14 — ldid `-S` produces
  # a valid 800KB SuperBlob with CodeDirectory + RequirementSet + Signature
  # that rcodesign can subsequently parse cleanly.)
  #
  # We sign darwin-x64 too — strictly speaking only arm64 needs it, but
  # signing both keeps one code path and Intel macOS is happy with an
  # ad-hoc sig as well.
  case "$TARGET" in
    darwin-x64|darwin-arm64)
      LDID="${LDID:-$HOME/.local/bin/ldid}"
      if [[ ! -x "$LDID" ]] && command -v ldid >/dev/null 2>&1; then
        LDID=$(command -v ldid)
      fi
      if [[ -x "$LDID" ]]; then
        echo "==> Ad-hoc signing $TARGET binary with ldid"
        "$LDID" -S "$OUTDIR/$BIN_NAME"
        # Fail loud if ldid silently no-oped or produced a broken signature.
        # We'd rather break the build here than ship an unsigned binary.
        if ! verify_darwin_signature "$OUTDIR/$BIN_NAME"; then
          echo "error: darwin signature verification failed for $OUTDIR/$BIN_NAME" >&2
          echo "  This binary would SIGKILL on Apple Silicon. Aborting build." >&2
          exit 1
        fi
        echo "==> Verified embedded signature (SuperBlob + CodeDirectory present)"
      else
        echo "ERROR: ldid not found. Darwin binary will SIGKILL on Apple Silicon." >&2
        echo "  Install on Debian/Ubuntu: sudo apt install libssl-dev libplist-dev pkg-config" >&2
        echo "  Then: git clone https://github.com/ProcursusTeam/ldid /tmp/ldid && cd /tmp/ldid && make && install -m755 ldid ~/.local/bin/" >&2
        exit 1
      fi
      ;;
  esac

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
