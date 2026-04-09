#!/bin/bash
# Install Spyglass systemd services
# Run with: sudo bash systemd/install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing Spyglass systemd services..."

# Copy unit files
cp "$SCRIPT_DIR/spyglass-backend.service" /etc/systemd/system/
cp "$SCRIPT_DIR/spyglass-frontend.service" /etc/systemd/system/
cp "$SCRIPT_DIR/spyglass-portal.service" /etc/systemd/system/
cp "$SCRIPT_DIR/spyglass.target" /etc/systemd/system/

# Reload systemd
systemctl daemon-reload

# Enable all services (starts on boot)
systemctl enable spyglass.target
systemctl enable spyglass-backend.service
systemctl enable spyglass-frontend.service
systemctl enable spyglass-portal.service

echo "Installed. Start with: sudo systemctl start spyglass.target"
echo "Check status:          sudo systemctl status spyglass-backend spyglass-frontend spyglass-portal"
echo "View logs:             journalctl -u spyglass-backend -f"
