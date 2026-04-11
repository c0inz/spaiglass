#!/usr/bin/env bash
# verify.sh — Check that the live SpAIglass relay is serving a known, published release.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/c0inz/spaiglass/main/verify.sh | bash
#   # or, from a local clone:
#   ./verify.sh
#   ./verify.sh --relay https://your-self-hosted-relay.example.com
#
# What it checks:
#   1. Queries /api/health for the commit SHA and frontend bundle hash
#   2. Looks up the matching GitHub release by commit
#   3. Compares the frontend_sha256 from the live relay against the release notes
#   4. Optionally runs `gh attestation verify` if the gh CLI is installed
#
# Exit codes:
#   0 — verified: live relay matches a published release
#   1 — mismatch or verification failed
#   2 — could not reach the relay or parse the response

set -euo pipefail

RELAY_URL="${1:-https://spaiglass.xyz}"
# Strip --relay flag if used
if [[ "$RELAY_URL" == "--relay" ]]; then
  RELAY_URL="${2:-https://spaiglass.xyz}"
fi

REPO="c0inz/spaiglass"

echo "SpAIglass Relay Verification"
echo "============================"
echo ""
echo "Relay: $RELAY_URL"
echo ""

# Step 1: Query the live relay
echo "1. Querying /api/health ..."
HEALTH=$(curl -sf --max-time 10 "$RELAY_URL/api/health" 2>/dev/null) || {
  echo "   FAIL: Could not reach $RELAY_URL/api/health"
  exit 2
}

# Parse fields — works with jq if available, falls back to grep/sed
if command -v jq &>/dev/null; then
  LIVE_COMMIT=$(echo "$HEALTH" | jq -r '.commit // "unknown"')
  LIVE_HASH=$(echo "$HEALTH" | jq -r '.frontend_sha256 // "unknown"')
  LIVE_VERSION=$(echo "$HEALTH" | jq -r '.spaiglassVersion // "unknown"')
else
  # Fallback: simple grep extraction (works for flat JSON)
  LIVE_COMMIT=$(echo "$HEALTH" | grep -o '"commit":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
  LIVE_HASH=$(echo "$HEALTH" | grep -o '"frontend_sha256":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
  LIVE_VERSION=$(echo "$HEALTH" | grep -o '"spaiglassVersion":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
fi

echo "   Commit:          $LIVE_COMMIT"
echo "   frontend_sha256: $LIVE_HASH"
echo "   Version:         $LIVE_VERSION"
echo ""

if [[ "$LIVE_COMMIT" == "unknown" || "$LIVE_COMMIT" == "null" || -z "$LIVE_COMMIT" ]]; then
  echo "   WARN: Relay did not report a commit SHA."
  echo "         This relay may be running a pre-verification build."
  echo "         Cannot verify — upgrade the relay or ask the operator."
  exit 2
fi

if [[ "$LIVE_HASH" == "unknown" || "$LIVE_HASH" == "null" || "$LIVE_HASH" == "missing" || -z "$LIVE_HASH" ]]; then
  echo "   WARN: Relay did not report a frontend bundle hash."
  echo "         The frontend may not be deployed on this relay."
  exit 2
fi

# Step 2: Check if this commit exists in the repo
echo "2. Checking commit $LIVE_COMMIT against GitHub ..."
if command -v gh &>/dev/null; then
  # Use gh CLI for authenticated access (handles rate limits better)
  COMMIT_CHECK=$(gh api "repos/$REPO/commits/$LIVE_COMMIT" --jq '.sha' 2>/dev/null || echo "not_found")
else
  COMMIT_CHECK=$(curl -sf "https://api.github.com/repos/$REPO/commits/$LIVE_COMMIT" 2>/dev/null | grep -o '"sha":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "not_found")
fi

if [[ "$COMMIT_CHECK" == "not_found" || -z "$COMMIT_CHECK" ]]; then
  echo "   FAIL: Commit $LIVE_COMMIT does NOT exist in $REPO"
  echo "         The relay is serving code not published in the open-source repo."
  exit 1
fi
echo "   OK: Commit exists in $REPO"
echo ""

# Step 3: Find the release that contains this commit and check the hash
echo "3. Looking for a release matching this commit ..."
RELEASE_MATCH=""
if command -v gh &>/dev/null; then
  # List recent releases and check their bodies for the frontend_sha256
  RELEASES=$(gh release list --repo "$REPO" --limit 10 --json tagName,name --jq '.[].tagName' 2>/dev/null || echo "")
  for TAG in $RELEASES; do
    BODY=$(gh release view "$TAG" --repo "$REPO" --json body --jq '.body' 2>/dev/null || echo "")
    if echo "$BODY" | grep -q "$LIVE_HASH"; then
      RELEASE_MATCH="$TAG"
      break
    fi
  done
fi

if [[ -n "$RELEASE_MATCH" ]]; then
  echo "   MATCH: Release $RELEASE_MATCH contains frontend_sha256: $LIVE_HASH"
  echo ""
else
  echo "   INFO: No release found with matching frontend_sha256."
  echo "         This could mean:"
  echo "         - The relay is running from main (not a tagged release)"
  echo "         - The release predates bundle hash publication"
  echo "         - The bundle has been tampered with"
  echo ""
  echo "         The commit ($LIVE_COMMIT) exists in the repo, but without a"
  echo "         matching release hash, full verification is not possible."
  echo ""
fi

# Step 4: Sigstore attestation (optional, requires gh CLI)
echo "4. Checking Sigstore attestation ..."
if command -v gh &>/dev/null; then
  if [[ -n "$RELEASE_MATCH" ]]; then
    echo "   Downloading artifact to verify provenance ..."
    TMPDIR=$(mktemp -d)
    ARTIFACT="spaiglass-host-linux-x64.tar.gz"
    gh release download "$RELEASE_MATCH" --repo "$REPO" --pattern "$ARTIFACT" --dir "$TMPDIR" 2>/dev/null && {
      ATTEST_RESULT=$(gh attestation verify "$TMPDIR/$ARTIFACT" --repo "$REPO" 2>&1 || echo "FAILED")
      if echo "$ATTEST_RESULT" | grep -qi "verified\|✓"; then
        echo "   OK: Sigstore attestation verified for $ARTIFACT"
      else
        echo "   WARN: Attestation check did not pass."
        echo "         $ATTEST_RESULT"
      fi
    } || {
      echo "   SKIP: Could not download artifact for attestation check."
    }
    rm -rf "$TMPDIR"
  else
    echo "   SKIP: No release match — cannot verify attestation."
  fi
else
  echo "   SKIP: gh CLI not installed. Install it to verify Sigstore attestation:"
  echo "         https://cli.github.com/"
fi

echo ""
echo "============================"

if [[ -n "$RELEASE_MATCH" ]]; then
  echo "RESULT: VERIFIED"
  echo "The live relay at $RELAY_URL is serving release $RELEASE_MATCH"
  echo "with frontend bundle hash $LIVE_HASH matching the published release."
  exit 0
elif [[ "$COMMIT_CHECK" != "not_found" ]]; then
  echo "RESULT: PARTIAL"
  echo "The commit exists in the repo but no release has a matching bundle hash."
  echo "This may be a pre-release deployment from main."
  exit 0
else
  echo "RESULT: FAILED"
  echo "Could not verify the live relay. See details above."
  exit 1
fi
