#!/usr/bin/env bash
# restart-spaiglass.sh — safe self-restart of spaiglass.service from anywhere,
# including from inside a Claude Code session that is itself a descendant of
# spaiglass.service.
#
# The problem this solves:
#   `systemctl --user restart spaiglass.service` run from a shell that lives
#   inside the service's cgroup will be SIGTERMed by systemd as part of the
#   restart, before the restart command itself returns. The caller sees exit
#   144 and the service never comes back cleanly.
#
# The fix:
#   Use `systemd-run --user --scope` to spawn the restart command in a fresh
#   transient scope that is NOT a child of spaiglass.service. The restart then
#   completes normally even though the original shell is about to be killed.
#
# Usage:
#   ./restart-spaiglass.sh           # restart and detach
#   ./restart-spaiglass.sh --status  # restart and print status after
set -euo pipefail

UNIT="${SPAIGLASS_UNIT:-spaiglass.service}"

if ! command -v systemd-run >/dev/null 2>&1; then
  echo "systemd-run not found — falling back to plain restart (may exit 144)" >&2
  exec systemctl --user restart "$UNIT"
fi

# Detach into a transient scope owned by the user manager (not by
# spaiglass.service), so the restart survives the SIGTERM to the old cgroup.
systemd-run --user --scope --quiet --unit="spaiglass-restart-$$" \
  systemctl --user restart "$UNIT" &
RESTART_PID=$!

# Give systemd a moment to swap the unit before we lose this shell if we were
# running inside the old cgroup.
sleep 2

if [[ "${1:-}" == "--status" ]]; then
  # If this shell is still alive, the restart worked and we weren't in the
  # cgroup. Print status for the operator.
  wait "$RESTART_PID" 2>/dev/null || true
  systemctl --user status "$UNIT" --no-pager || true
  curl -s http://localhost:8080/api/health || true
fi
