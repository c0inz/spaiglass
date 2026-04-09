#!/bin/bash
# deploy-webui.sh — Deploy Spyglass to a remote VM via SSH
#
# Single host:
#   ./deploy-webui.sh --host 192.168.1.200 --role Designer
#
# Bulk deploy from manifest:
#   ./deploy-webui.sh --manifest deploy-manifest.json
#
# Manifest format (JSON array):
#   [
#     { "host": "192.168.1.200", "role": "Designer", "password": "secret" },
#     { "host": "192.168.1.201", "role": "QA" }
#   ]

set -euo pipefail

REPO_URL="https://github.com/c0inz/spyglass.git"
REMOTE_USER="johntdavenport"
INSTALL_DIR="/home/$REMOTE_USER/projects/spyglass"
NODE_BIN="/home/linuxbrew/.linuxbrew/bin"

# --- Argument parsing ---
HOST=""
ROLE=""
PASSWORD=""
MANIFEST=""
SSH_KEY=""

usage() {
  echo "Usage:"
  echo "  $0 --host <ip> --role <role> [--password <pass>] [--ssh-key <path>]"
  echo "  $0 --manifest <file.json> [--ssh-key <path>]"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)     HOST="$2";     shift 2 ;;
    --role)     ROLE="$2";     shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --ssh-key)  SSH_KEY="$2";  shift 2 ;;
    -h|--help)  usage ;;
    *)          echo "Unknown option: $1"; usage ;;
  esac
done

# --- SSH helper ---
ssh_cmd() {
  local target_host="$1"
  shift
  local ssh_opts=(-o StrictHostKeyChecking=no -o ConnectTimeout=10)
  if [[ -n "$SSH_KEY" ]]; then
    ssh_opts+=(-i "$SSH_KEY")
  fi
  ssh "${ssh_opts[@]}" "$REMOTE_USER@$target_host" "$@"
}

# --- Deploy to a single host ---
deploy_host() {
  local target_host="$1"
  local target_role="$2"
  local target_password="${3:-}"

  echo "=== Deploying to $target_host (role: $target_role) ==="

  # Check connectivity
  if ! ssh_cmd "$target_host" "echo ok" &>/dev/null; then
    echo "  ERROR: Cannot SSH to $target_host"
    return 1
  fi

  # Clone or pull
  ssh_cmd "$target_host" bash -s <<REMOTE
set -euo pipefail

# Ensure projects dir exists
mkdir -p "$(dirname "$INSTALL_DIR")"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Pulling latest..."
  cd "$INSTALL_DIR" && git pull --ff-only
else
  echo "  Cloning..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# Install dependencies
echo "  Installing backend deps..."
cd "$INSTALL_DIR/backend" && $NODE_BIN/npm install --production 2>&1 | tail -1

echo "  Installing frontend deps..."
cd "$INSTALL_DIR/frontend" && $NODE_BIN/npm install 2>&1 | tail -1

# Write .env
cat > "$INSTALL_DIR/.env" <<EOF
VM_ROLE=$target_role
HOST=0.0.0.0
PORT=8080
${target_password:+AUTH_PASSWORD=$target_password}
EOF

# Install systemd services
echo "  Installing systemd services..."
sudo cp "$INSTALL_DIR/systemd/spyglass-backend.service" /etc/systemd/system/
sudo cp "$INSTALL_DIR/systemd/spyglass-frontend.service" /etc/systemd/system/
sudo cp "$INSTALL_DIR/systemd/spyglass-portal.service" /etc/systemd/system/
sudo cp "$INSTALL_DIR/systemd/spyglass.target" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable spyglass.target
sudo systemctl restart spyglass.target

echo "  Waiting for backend..."
sleep 3
if curl -sf http://localhost:8080/api/health > /dev/null 2>&1; then
  echo "  OK — backend healthy"
else
  echo "  WARNING — backend not responding yet (may still be starting)"
fi
REMOTE

  echo "=== Done: $target_host ==="
  echo ""
}

# --- Main ---

if [[ -n "$MANIFEST" ]]; then
  # Bulk deploy from manifest
  if [[ ! -f "$MANIFEST" ]]; then
    echo "Manifest file not found: $MANIFEST"
    exit 1
  fi

  # Read manifest entries
  count=$(jq length "$MANIFEST")
  echo "Deploying to $count hosts from $MANIFEST"
  echo ""

  for i in $(seq 0 $((count - 1))); do
    m_host=$(jq -r ".[$i].host" "$MANIFEST")
    m_role=$(jq -r ".[$i].role" "$MANIFEST")
    m_pass=$(jq -r ".[$i].password // empty" "$MANIFEST")
    deploy_host "$m_host" "$m_role" "$m_pass" || true
  done

  echo "Bulk deploy complete."
elif [[ -n "$HOST" && -n "$ROLE" ]]; then
  # Single host deploy
  deploy_host "$HOST" "$ROLE" "$PASSWORD"
else
  usage
fi
