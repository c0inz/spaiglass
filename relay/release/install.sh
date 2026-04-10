#!/usr/bin/env bash
#
# Spaiglass VM installer (Linux + macOS) — Phase 3 binary edition.
#
# Run on a fresh host after registering it on https://spaiglass.xyz:
#
#     curl -fsSL https://spaiglass.xyz/install.sh | bash -s -- \
#         --token=YOUR_TOKEN --id=YOUR_ID --name=YOUR_VM_NAME
#
# This installer downloads a single self-contained binary (no Node, no npm,
# no node_modules) for your platform, drops it under ~/spaiglass, writes a
# .env, and registers a per-user service that runs at boot/login.
#
# Idempotent — re-running upgrades the binary in place, preserves the .env,
# and restarts the service. To uninstall: pass --uninstall.
#
# Requires:  bash, curl, ~/.local/bin/claude (Anthropic Claude Code CLI).
#            No Node, no npm, no developer tools.
# Installs:  ~/spaiglass/{spaiglass-host[.exe],static/,VERSION,.env}
#            Linux:  ~/.config/systemd/user/spaiglass.service
#            macOS:  ~/Library/LaunchAgents/xyz.spaiglass.vm.plist
#
# Windows users: use install.ps1 instead — `iwr https://spaiglass.xyz/install.ps1 -useb`.
#
set -euo pipefail

# ----- platform detection -----
case "$(uname -s)" in
  Linux)  PLATFORM="linux"  ;;
  Darwin) PLATFORM="darwin" ;;
  *)      printf 'Unsupported platform: %s\n' "$(uname -s)" >&2
          printf 'Linux + macOS use install.sh; Windows uses install.ps1.\n' >&2
          exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  ARCH="x64"   ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

TARGET="${PLATFORM}-${ARCH}"

# ----- defaults -----
RELAY_URL="${RELAY_URL:-https://spaiglass.xyz}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/spaiglass}"
TOKEN=""
CONN_ID=""
CONN_NAME=""
UNINSTALL=0
PORT="${PORT:-8080}"
# By default the local backend binds to 127.0.0.1 — the connector reaches it
# over loopback, and nothing on the VM's LAN can hit it directly. Pass
# --lan-bind to listen on 0.0.0.0 instead.
LAN_BIND=0

# ----- pretty output -----
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$CYAN$BOLD" "$RESET" "$*"; }
ok()   { printf '%s ✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s ⚠%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '%s ✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# ----- arg parsing -----
for arg in "$@"; do
  case "$arg" in
    --token=*)     TOKEN="${arg#*=}" ;;
    --id=*)        CONN_ID="${arg#*=}" ;;
    --name=*)      CONN_NAME="${arg#*=}" ;;
    --relay=*)     RELAY_URL="${arg#*=}" ;;
    --dir=*)       INSTALL_DIR="${arg#*=}" ;;
    --port=*)      PORT="${arg#*=}" ;;
    --lan-bind)    LAN_BIND=1 ;;
    --uninstall)   UNINSTALL=1 ;;
    -h|--help)
      sed -n '2,18p' "$0" 2>/dev/null || true
      exit 0
      ;;
    *) fail "Unknown argument: $arg" ;;
  esac
done

# ----- uninstall path -----
if [ "$UNINSTALL" = "1" ]; then
  log "Uninstalling Spaiglass"
  if [ "$PLATFORM" = "linux" ]; then
    systemctl --user stop spaiglass.service 2>/dev/null || true
    systemctl --user disable spaiglass.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/spaiglass.service"
    systemctl --user daemon-reload 2>/dev/null || true
  else
    PLIST="$HOME/Library/LaunchAgents/xyz.spaiglass.vm.plist"
    launchctl bootout "gui/$(id -u)/xyz.spaiglass.vm" 2>/dev/null || \
      launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
  fi
  rm -rf "$INSTALL_DIR"
  ok "Removed $INSTALL_DIR and the service unit"
  ok "Left ~/.local/bin/claude and ~/projects untouched"
  exit 0
fi

# ----- preflight -----
log "Pre-flight checks"

# Upgrade-in-place: if no --token was given but a previous .env exists, reuse it.
if [ -z "$TOKEN" ] && [ -f "$INSTALL_DIR/.env" ]; then
  # shellcheck disable=SC1090
  set -a; . "$INSTALL_DIR/.env"; set +a
  TOKEN="${TOKEN:-${CONNECTOR_TOKEN:-}}"
  CONN_ID="${CONN_ID:-${CONNECTOR_ID:-}}"
  CONN_NAME="${CONN_NAME:-${CONNECTOR_NAME:-}}"
  if [ -n "$TOKEN" ]; then
    ok "Upgrading existing install (reusing $INSTALL_DIR/.env)"
  fi
fi

[ -n "$TOKEN" ]     || fail "Missing --token=... (get it from $RELAY_URL/fleetrelay when you add a VM)"
[ -n "$CONN_ID" ]   || fail "Missing --id=..."
[ -n "$CONN_NAME" ] || fail "Missing --name=..."

command -v curl >/dev/null || fail "curl not found"
command -v tar  >/dev/null || fail "tar not found"

CLAUDE_BIN="$HOME/.local/bin/claude"
if [ ! -x "$CLAUDE_BIN" ]; then
  if command -v claude >/dev/null; then
    CLAUDE_BIN=$(command -v claude)
    warn "Using claude at $CLAUDE_BIN (not the standard ~/.local/bin/claude)"
  else
    fail "Claude Code CLI not found. Install with: curl -fsSL https://claude.ai/install.sh | bash"
  fi
fi
ok "Claude $("$CLAUDE_BIN" --version 2>&1 | head -1)"
ok "Target platform: $TARGET"

# ----- download binary tarball -----
# The relay publishes per-platform tarballs at /releases/spaiglass-host-<target>.tar.gz.
# Each tarball contains the binary, the static frontend dir, and a VERSION file.
log "Fetching $TARGET binary from $RELAY_URL"
TMP_TAR="$(mktemp --suffix=.tar.gz 2>/dev/null || mktemp -t spaiglass)"
trap 'rm -f "$TMP_TAR"' EXIT
TARBALL_URL="$RELAY_URL/releases/spaiglass-host-${TARGET}.tar.gz"
if ! curl -fsSL --connect-timeout 10 -o "$TMP_TAR" "$TARBALL_URL"; then
  fail "Could not download $TARBALL_URL"
fi
TAR_SIZE=$(stat -c%s "$TMP_TAR" 2>/dev/null || stat -f%z "$TMP_TAR")
ok "Downloaded $(( TAR_SIZE / 1024 / 1024 )) MB"

# ----- extract -----
log "Installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
# Extract over the install dir, stripping the top-level "spaiglass-host-<target>/" component.
tar -xzf "$TMP_TAR" -C "$INSTALL_DIR" --strip-components=1
[ -f "$INSTALL_DIR/VERSION" ] || fail "Tarball is missing VERSION file"
[ -x "$INSTALL_DIR/spaiglass-host" ] || fail "Tarball is missing the spaiglass-host binary"
VERSION=$(cat "$INSTALL_DIR/VERSION")
ok "Extracted spaiglass $VERSION"

# Clean stale files from a pre-Phase-3 npm-based install if present.
if [ -d "$INSTALL_DIR/backend" ]; then
  rm -rf "$INSTALL_DIR/backend"
  ok "Removed legacy backend/ dir from previous npm-based install"
fi
if [ -d "$INSTALL_DIR/node_modules" ]; then
  rm -rf "$INSTALL_DIR/node_modules"
  ok "Removed legacy node_modules"
fi

BIN_PATH="$INSTALL_DIR/spaiglass-host"

# ----- write .env -----
if [ "$LAN_BIND" = "1" ]; then
  BIND_HOST="0.0.0.0"
  BIND_LABEL="all interfaces — LAN-accessible"
else
  BIND_HOST="127.0.0.1"
  BIND_LABEL="loopback only — reachable only via spaiglass.xyz"
fi

log "Writing .env (binding: $BIND_LABEL)"
cat > "$INSTALL_DIR/.env" <<EOF
# Spaiglass VM connector — generated by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Edit RELAY_URL or PORT if you need to; do not change CONNECTOR_TOKEN unless
# you re-register the connector on $RELAY_URL/dashboard.
RELAY_URL=$RELAY_URL
CONNECTOR_TOKEN=$TOKEN
CONNECTOR_ID=$CONN_ID
CONNECTOR_NAME=$CONN_NAME
SPAIGLASS_VERSION=$VERSION
PORT=$PORT
HOST=$BIND_HOST
EOF
chmod 600 "$INSTALL_DIR/.env"
ok "Wrote $INSTALL_DIR/.env (mode 600)"

# Note: ~/projects/*/agents/ auto-registration in ~/.claude.json is now done
# by the binary itself on every boot (see backend/utils/register-projects.ts),
# so the installer no longer needs node to set it up.

# ----- service installation (per-platform) -----
if [ "$PLATFORM" = "linux" ]; then
  log "Installing systemd --user service"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/spaiglass.service" <<EOF
[Unit]
Description=Spaiglass VM (single-binary host)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$INSTALL_DIR/.env
WorkingDirectory=$INSTALL_DIR
ExecStart=$BIN_PATH --host \${HOST} --port \${PORT} --claude-path $CLAUDE_BIN
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=spaiglass

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable spaiglass.service >/dev/null 2>&1 || true
  systemctl --user restart spaiglass.service
  ok "systemd --user service installed and started"

  if ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
    warn "User lingering is OFF — service will stop when you log out."
    warn "  Enable persistence with:  sudo loginctl enable-linger $USER"
  fi

  LOGS_HINT="journalctl --user -u spaiglass -f"
else
  log "Installing launchd agent (~/Library/LaunchAgents/xyz.spaiglass.vm.plist)"
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST="$PLIST_DIR/xyz.spaiglass.vm.plist"
  LOGS_DIR="$INSTALL_DIR/logs"
  mkdir -p "$PLIST_DIR" "$LOGS_DIR"

  # launchd doesn't read .env files — inline the values into EnvironmentVariables.
  # shellcheck disable=SC1090
  set -a; . "$INSTALL_DIR/.env"; set +a

  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>xyz.spaiglass.vm</string>
  <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN_PATH</string>
    <string>--host</string><string>$BIND_HOST</string>
    <string>--port</string><string>$PORT</string>
    <string>--claude-path</string><string>$CLAUDE_BIN</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
    <key>RELAY_URL</key><string>$RELAY_URL</string>
    <key>CONNECTOR_TOKEN</key><string>$TOKEN</string>
    <key>CONNECTOR_ID</key><string>$CONN_ID</string>
    <key>CONNECTOR_NAME</key><string>$CONN_NAME</string>
    <key>SPAIGLASS_VERSION</key><string>$VERSION</string>
    <key>HOST</key><string>$BIND_HOST</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>StandardOutPath</key><string>$LOGS_DIR/spaiglass.out.log</string>
  <key>StandardErrorPath</key><string>$LOGS_DIR/spaiglass.err.log</string>
  <key>ThrottleInterval</key><integer>5</integer>
</dict>
</plist>
EOF

  launchctl bootout "gui/$(id -u)/xyz.spaiglass.vm" 2>/dev/null || true
  launchctl unload "$PLIST" 2>/dev/null || true
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
    launchctl kickstart -k "gui/$(id -u)/xyz.spaiglass.vm" 2>/dev/null || true
  else
    launchctl load -w "$PLIST"
  fi
  ok "launchd agent installed and started"
  LOGS_HINT="tail -F $LOGS_DIR/spaiglass.{out,err}.log"
fi

# ----- verify -----
log "Verifying"
sleep 3
if curl -fsS --connect-timeout 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 \
   || curl -fsS --connect-timeout 5 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  ok "Local backend responding on :$PORT"
else
  warn "Local backend didn't respond yet. Check: $LOGS_HINT"
fi

echo
printf '%s%sSpaiglass %s installed.%s\n' "$BOLD" "$GREEN" "$VERSION" "$RESET"
printf '  Fleet:      %s/fleetrelay\n' "$RELAY_URL"
printf '  This VM:    %s/vm/<your-login>.%s/\n' "$RELAY_URL" "$CONN_NAME"
printf '  Binding:    %s:%s (%s)\n' "$BIND_HOST" "$PORT" "$BIND_LABEL"
printf '  Logs:       %s\n' "$LOGS_HINT"
printf '  Update:     re-run this command\n'
printf '  Uninstall:  curl -fsSL %s/install.sh | bash -s -- --uninstall\n' "$RELAY_URL"
echo
