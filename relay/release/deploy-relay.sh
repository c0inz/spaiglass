#!/usr/bin/env bash
#
# deploy-relay.sh — Build and deploy everything to the SpAIglass relay droplet.
#
# Handles three things:
#   1. Frontend bundle → /opt/sgcleanrelay/frontend/  (NOT frontend/dist/)
#   2. Relay source    → /opt/sgcleanrelay/src/
#   3. Backend tarball → /opt/sgcleanrelay/release/  (for fleet-rollout)
#
# After uploading, restarts the sgcleanrelay service and verifies health.
#
# Usage:
#   ./deploy-relay.sh                # full deploy (build + push + restart)
#   ./deploy-relay.sh --no-build     # push existing builds without rebuilding
#   ./deploy-relay.sh --frontend     # frontend only
#   ./deploy-relay.sh --backend      # backend tarball only (for fleet-rollout)
#   ./deploy-relay.sh --relay-src    # relay source only
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$RELAY_DIR")"
FRONTEND_DIR="$REPO_ROOT/frontend"

DROPLET="root@137.184.187.234"
REMOTE_BASE="/opt/sgcleanrelay"

# Flags
DO_BUILD=1
DO_FRONTEND=1
DO_BACKEND=1
DO_RELAY_SRC=1

for arg in "$@"; do
  case "$arg" in
    --no-build)   DO_BUILD=0 ;;
    --frontend)   DO_BACKEND=0; DO_RELAY_SRC=0 ;;
    --backend)    DO_FRONTEND=0; DO_RELAY_SRC=0 ;;
    --relay-src)  DO_FRONTEND=0; DO_BACKEND=0 ;;
    -h|--help)    sed -n '2,16p' "$0"; exit 0 ;;
    *)            echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}==>${NC} $*"; }
ok()    { echo -e "${GREEN}==>${NC} $*"; }
fail()  { echo -e "${RED}==>${NC} $*"; exit 1; }

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
  ok "Relay source uploaded"
fi

if [[ "$DO_BACKEND" -eq 1 ]]; then
  info "Uploading backend tarball + VERSION to $REMOTE_BASE/release/ ..."
  scp "$SCRIPT_DIR/dist.tar.gz" "$SCRIPT_DIR/VERSION" "$DROPLET:$REMOTE_BASE/release/"
  ok "Backend tarball uploaded"
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

if [[ "$DO_BACKEND" -eq 1 ]]; then
  echo -e "${BLUE}Next step:${NC} Run fleet-rollout to update VMs:"
  echo "   ~/scripts/fleet-rollout-spaiglass.sh --yes"
fi
