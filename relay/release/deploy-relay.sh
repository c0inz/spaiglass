#!/usr/bin/env bash
#
# deploy-relay.sh — Build and deploy everything to the SpAIglass relay droplet.
#
# Handles four things:
#   1. Frontend bundle    → /opt/sgcleanrelay/frontend/  (NOT frontend/dist/)
#   2. Relay source       → /opt/sgcleanrelay/src/
#   3. Legacy backend tar → /opt/sgcleanrelay/release/   (for existing fleet-rollout,
#                                                         pre-Phase-3 npm installs)
#   4. Phase 3 binaries   → /opt/sgcleanrelay/release/spaiglass-host-<target>.tar.gz
#                           Five cross-compiled bun-compile self-contained binaries:
#                           linux-x64 (AVX2-baseline), linux-arm64, darwin-x64,
#                           darwin-arm64, windows-x64. These are what
#                           install.sh / install.ps1 download for new VMs.
#
# After uploading, restarts the sgcleanrelay service and verifies health.
#
# Usage:
#   ./deploy-relay.sh                # full deploy (build + push + restart)
#   ./deploy-relay.sh --no-build     # push existing builds without rebuilding
#   ./deploy-relay.sh --frontend     # frontend only
#   ./deploy-relay.sh --backend      # backend (legacy tarball + Phase 3 binaries)
#   ./deploy-relay.sh --relay-src    # relay source only
#   ./deploy-relay.sh --binaries     # Phase 3 binaries only (all 5 targets)
#   ./deploy-relay.sh --no-binaries  # skip Phase 3 binary build/upload on full deploy
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$RELAY_DIR")"
FRONTEND_DIR="$REPO_ROOT/frontend"
BACKEND_DIR="$REPO_ROOT/backend"

DROPLET="root@137.184.187.234"
REMOTE_BASE="/opt/sgcleanrelay"

# Flags
DO_BUILD=1
DO_FRONTEND=1
DO_BACKEND=1
DO_RELAY_SRC=1
DO_BINARIES=1

for arg in "$@"; do
  case "$arg" in
    --no-build)    DO_BUILD=0 ;;
    --frontend)    DO_BACKEND=0; DO_RELAY_SRC=0; DO_BINARIES=0 ;;
    --backend)     DO_FRONTEND=0; DO_RELAY_SRC=0 ;;
    --relay-src)   DO_FRONTEND=0; DO_BACKEND=0; DO_BINARIES=0 ;;
    --binaries)    DO_FRONTEND=0; DO_BACKEND=0; DO_RELAY_SRC=0 ;;
    --no-binaries) DO_BINARIES=0 ;;
    -h|--help)     sed -n '2,24p' "$0"; exit 0 ;;
    *)             echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}==>${NC} $*"; }
ok()    { echo -e "${GREEN}==>${NC} $*"; }
fail()  { echo -e "${RED}==>${NC} $*"; exit 1; }

# Verify a Mach-O binary has a real embedded code signature. Matches the
# check in backend/scripts/build-binary.sh — see that file for why the two
# magic bytes are the right invariant. Duplicated here so deploy can be a
# second line of defense even if someone swaps build pipelines.
verify_darwin_signature() {
  local bin="$1"
  LC_ALL=C grep -q $'\xfa\xde\x0c\xc0' "$bin" || return 1
  LC_ALL=C grep -q $'\xfa\xde\x0c\x02' "$bin" || return 1
  return 0
}

# Extract a darwin tarball to a temp dir and verify the binary inside is
# actually signed. Catches the case where build-binary.sh succeeded but
# something went wrong during tarring (wrong file copied, stale tarball
# from a previous failed run, etc.). We'd rather fail loud at deploy time
# than at a user's Mac Mini at 11pm.
verify_darwin_tarball() {
  local tarball="$1"
  local target="$2"
  local tmp
  tmp=$(mktemp -d)
  tar -xzf "$tarball" -C "$tmp" --strip-components=1 "spaiglass-host-${target}/spaiglass-host" 2>/dev/null || {
    rm -rf "$tmp"
    fail "Tarball $tarball does not contain spaiglass-host binary"
  }
  if ! verify_darwin_signature "$tmp/spaiglass-host"; then
    rm -rf "$tmp"
    fail "Tarball $tarball contains an UNSIGNED darwin binary — would SIGKILL on Apple Silicon. Rebuild with: (cd $BACKEND_DIR && ./scripts/build-binary.sh $target)"
  fi
  rm -rf "$tmp"
}

# === Step 1: Build ===

if [[ "$DO_BUILD" -eq 1 ]]; then
  if [[ "$DO_FRONTEND" -eq 1 ]]; then
    info "Building frontend..."
    ( cd "$FRONTEND_DIR" && npm run build )
  fi

  if [[ "$DO_BACKEND" -eq 1 ]]; then
    info "Building backend tarball..."
    bash "$SCRIPT_DIR/pack.sh"
  fi

  if [[ "$DO_BINARIES" -eq 1 ]]; then
    # Build the full Phase 3 release matrix. bun cross-compiles all 5 targets
    # from a linux-x64 host in well under a minute total. This step used to
    # be missing, which caused install.sh to silently 404 on new VMs after
    # any deploy that rebuilt the frontend but forgot the binaries.
    info "Building Phase 3 per-platform binaries (5 targets)..."
    ( cd "$BACKEND_DIR" && ./scripts/build-binary.sh all )
  fi
else
  info "Skipping builds (--no-build)"
fi

# === Step 2: Upload ===

if [[ "$DO_FRONTEND" -eq 1 ]]; then
  info "Uploading frontend to $REMOTE_BASE/frontend/ ..."
  # IMPORTANT: deploy to /frontend/ NOT /frontend/dist/
  # The relay's RELAY_FRONTEND_DIR points to /opt/sgcleanrelay/frontend
  # and expects index.html + assets/ directly inside it.
  scp -r "$FRONTEND_DIR/dist/"* "$DROPLET:$REMOTE_BASE/frontend/"
  ok "Frontend uploaded"
fi

if [[ "$DO_RELAY_SRC" -eq 1 ]]; then
  info "Uploading relay source to $REMOTE_BASE/src/ ..."
  scp "$RELAY_DIR/src/"*.ts "$DROPLET:$REMOTE_BASE/src/"
  # Push package manifests and sync deps on the droplet so any new runtime
  # packages (e.g. marked for the architecture-manual route) are installed.
  scp "$RELAY_DIR/package.json" "$RELAY_DIR/package-lock.json" "$DROPLET:$REMOTE_BASE/"
  ssh "$DROPLET" "cd $REMOTE_BASE && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3"
  ok "Relay source uploaded"

  # Architecture manual — MANUAL.md + MANUAL-REFERENCE.md, served by the relay
  # at /architecture-manual (HTML) and /api/architecture-manual (raw markdown).
  # Deployed alongside relay-src because the routes live in server.ts.
  ARCH_DIR="$REPO_ROOT/architecture"
  if [[ -f "$ARCH_DIR/MANUAL.md" ]]; then
    info "Uploading architecture manual to $REMOTE_BASE/architecture/ ..."
    ssh "$DROPLET" "mkdir -p $REMOTE_BASE/architecture"
    scp "$ARCH_DIR/MANUAL.md" "$ARCH_DIR/MANUAL-REFERENCE.md" "$DROPLET:$REMOTE_BASE/architecture/" 2>/dev/null || \
      scp "$ARCH_DIR/MANUAL.md" "$DROPLET:$REMOTE_BASE/architecture/"
    ok "Architecture manual uploaded"
  fi
fi

if [[ "$DO_BACKEND" -eq 1 ]]; then
  info "Uploading backend tarball + VERSION to $REMOTE_BASE/release/ ..."
  scp "$SCRIPT_DIR/dist.tar.gz" "$SCRIPT_DIR/VERSION" "$DROPLET:$REMOTE_BASE/release/"
  ok "Backend tarball uploaded"
fi

if [[ "$DO_BINARIES" -eq 1 ]]; then
  info "Uploading Phase 3 binaries (5 targets) to $REMOTE_BASE/release/ ..."
  # Each tarball is ~25-45 MB. scp them all in one invocation so ssh session
  # setup cost is amortized.
  BIN_TARGETS=(linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64)
  BIN_PATHS=()
  for t in "${BIN_TARGETS[@]}"; do
    p="$BACKEND_DIR/dist/spaiglass-host-${t}.tar.gz"
    [[ -f "$p" ]] || fail "Missing binary tarball: $p (did build-binary.sh fail?)"
    BIN_PATHS+=("$p")
  done

  # Preflight: darwin tarballs MUST contain a signed binary. Apple Silicon
  # kernels SIGKILL unsigned Mach-O at exec with no error message — the
  # only way an end user finds out is their agent hangs. Verify here so
  # the failure is loud, local, and fixable before the upload completes.
  info "Preflight: verifying darwin binary signatures in tarballs..."
  verify_darwin_tarball "$BACKEND_DIR/dist/spaiglass-host-darwin-x64.tar.gz" darwin-x64
  verify_darwin_tarball "$BACKEND_DIR/dist/spaiglass-host-darwin-arm64.tar.gz" darwin-arm64
  ok "Darwin tarballs carry valid embedded signatures"

  scp "${BIN_PATHS[@]}" "$DROPLET:$REMOTE_BASE/release/"
  ok "Phase 3 binaries uploaded (${#BIN_TARGETS[@]} targets)"
fi

# Always upload install.sh + install.ps1 alongside any release-artifact deploy.
# The relay serves these directly from /opt/sgcleanrelay/release/install.{sh,ps1}
# (see relay/src/server.ts /install.sh + /install.ps1 routes), so any fix to the
# installers — Gatekeeper handling, codesign, BOM stripping, MOTW, linger logic
# — only reaches outside users when this file is uploaded. Previously the
# installers were uploaded only by manual `scp`, which made every deploy a
# silent regression risk: someone could ship a backend update and ship an
# old install.sh at the same time without noticing. We gate this on
# DO_BACKEND OR DO_BINARIES so frontend-only and relay-src-only deploys
# don't churn the installer files unnecessarily.
if [[ "$DO_BACKEND" -eq 1 || "$DO_BINARIES" -eq 1 ]]; then
  info "Uploading install.sh + install.ps1 to $REMOTE_BASE/release/ ..."
  scp "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/install.ps1" "$DROPLET:$REMOTE_BASE/release/"
  ok "Installers uploaded"
fi

# === Step 3: Restart relay ===

info "Restarting sgcleanrelay..."
ssh "$DROPLET" "systemctl restart sgcleanrelay"
sleep 2

# === Step 4: Health check ===

HEALTH=$(curl -fsSL --connect-timeout 10 https://spaiglass.xyz/api/health 2>/dev/null || true)
if [[ -z "$HEALTH" ]]; then
  fail "Health check failed — relay not responding"
fi

VERSION=$(printf '%s' "$HEALTH" | grep -oP '"spaiglassVersion":"[^"]+"' | cut -d'"' -f4)
FE_VERSION=$(printf '%s' "$HEALTH" | grep -oP '"frontendVersion":"[^"]+"' | cut -d'"' -f4)
CONNECTORS=$(printf '%s' "$HEALTH" | grep -oP '"connectors":\d+' | cut -d: -f2)

echo ""
ok "Relay healthy"
echo "   Version:  $VERSION"
echo "   Frontend: $FE_VERSION"
echo "   Connectors: $CONNECTORS"
echo ""

# === Step 5: Post-deploy smoke test ===
#
# Everything above tells us we uploaded files and the relay restarted. It
# does NOT tell us the relay is actually serving the files we just uploaded
# — the relay could be routing /releases/ wrong, an nginx cache could be
# stale, or scp could have landed in the wrong directory. The only way to
# know what end users will download is to download it ourselves over the
# public URL and check it.
#
# This block specifically guards against the two failure modes we hit
# on 2026-04-14:
#   1. Unsigned darwin-arm64 tarball shipping (kernel SIGKILL on Mac Mini)
#   2. Stale install.sh serving from /opt/sgcleanrelay/release/ (4 days old,
#      missing MOTW/BOM/codesign fixes) while we thought the deploy was clean
#
# Fail loud here and the bad artifact never reaches a real user.

if [[ "$DO_BINARIES" -eq 1 ]]; then
  info "Smoke test: fetching darwin-arm64 tarball via public URL..."
  SMOKE_TAR=$(mktemp --suffix=.tar.gz)
  trap 'rm -f "$SMOKE_TAR"' EXIT
  if ! curl -fsSL --connect-timeout 10 -o "$SMOKE_TAR" \
       "https://spaiglass.xyz/releases/spaiglass-host-darwin-arm64.tar.gz"; then
    fail "Smoke test failed: could not fetch darwin-arm64 tarball from public URL"
  fi
  SMOKE_DIR=$(mktemp -d)
  tar -xzf "$SMOKE_TAR" -C "$SMOKE_DIR" --strip-components=1 \
      spaiglass-host-darwin-arm64/spaiglass-host 2>/dev/null || {
    rm -rf "$SMOKE_DIR"
    fail "Smoke test failed: tarball served by relay has no spaiglass-host binary"
  }
  if ! verify_darwin_signature "$SMOKE_DIR/spaiglass-host"; then
    rm -rf "$SMOKE_DIR"
    fail "Smoke test failed: relay is serving an UNSIGNED darwin-arm64 binary. End users will SIGKILL. Deploy is in an unclean state — investigate before rerunning."
  fi
  rm -rf "$SMOKE_DIR"
  ok "Relay serves a signed darwin-arm64 binary"
fi

if [[ "$DO_BACKEND" -eq 1 || "$DO_BINARIES" -eq 1 ]]; then
  info "Smoke test: verifying relay serves current install.sh..."
  LOCAL_SUM=$(sha256sum "$SCRIPT_DIR/install.sh" | cut -d' ' -f1)
  REMOTE_SUM=$(curl -fsSL --connect-timeout 10 https://spaiglass.xyz/install.sh 2>/dev/null \
               | sha256sum | cut -d' ' -f1)
  if [[ "$LOCAL_SUM" != "$REMOTE_SUM" ]]; then
    fail "Smoke test failed: relay is serving a DIFFERENT install.sh than we just uploaded. Local=$LOCAL_SUM Remote=$REMOTE_SUM"
  fi
  ok "Relay serves current install.sh (sha256 match)"
fi

echo ""

if [[ "$DO_BACKEND" -eq 1 ]]; then
  echo -e "${BLUE}Next step:${NC} Run fleet-rollout to update VMs:"
  echo "   ~/scripts/fleet-rollout-spaiglass.sh --yes"
fi
