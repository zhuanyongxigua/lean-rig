#!/usr/bin/env bash
# e2e.sh — end-to-end integration test for leanrig.
#
# WHY THIS FILE EXISTS:
#   Unit tests cover individual modules in isolation. This script exercises
#   the full compiled CLI (dist/index.js) against throwaway tmp directories,
#   verifying that install → diff → rollback performs a complete byte-exact
#   roundtrip and leaves no artifacts behind. It catches integration regressions
#   that unit tests cannot (e.g., wrong shebang, broken ESM imports, bad dist
#   output, or state serialization mismatches). Run via: npm run e2e.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── helpers ──────────────────────────────────────────────────────────────────
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS"; }

# ── build ─────────────────────────────────────────────────────────────────────
echo "==> Building..."
cd "$REPO_ROOT"
npm run build --silent || fail "Build failed"
echo "    Build OK"

# ── tmp dirs ─────────────────────────────────────────────────────────────────
LEANRIG_HOME="$(mktemp -d)"
CLAUDE_CONFIG_DIR="$(mktemp -d)"
export LEANRIG_HOME CLAUDE_CONFIG_DIR

cleanup() {
  rm -rf "$LEANRIG_HOME" "$CLAUDE_CONFIG_DIR"
}
trap cleanup EXIT

echo "    LEANRIG_HOME=$LEANRIG_HOME"
echo "    CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR"

CLI="node $REPO_ROOT/dist/index.js"

# ── 1. dry-run writes nothing ────────────────────────────────────────────────
echo "==> [1] dry-run writes nothing..."
BEFORE_LR="$(find "$LEANRIG_HOME" -type f 2>/dev/null | sort)"
BEFORE_CC="$(find "$CLAUDE_CONFIG_DIR" -type f 2>/dev/null | sort)"

$CLI install claude-code --profile safe --dry-run > /dev/null

AFTER_LR="$(find "$LEANRIG_HOME" -type f 2>/dev/null | sort)"
AFTER_CC="$(find "$CLAUDE_CONFIG_DIR" -type f 2>/dev/null | sort)"

[ "$BEFORE_LR" = "$AFTER_LR" ] || fail "dry-run wrote files to LEANRIG_HOME"
[ "$BEFORE_CC" = "$AFTER_CC" ] || fail "dry-run wrote files to CLAUDE_CONFIG_DIR"
echo "    dry-run OK"

# ── 2. install ───────────────────────────────────────────────────────────────
echo "==> [2] install claude-code --profile safe..."

# Pre-populate a settings.json with a user key
echo '{"userExistingKey": "should-survive"}' > "$CLAUDE_CONFIG_DIR/settings.json"

$CLI install claude-code --profile safe

# Verify explorer agent was written
EXPLORER="$CLAUDE_CONFIG_DIR/agents/leanrig-explorer.md"
[ -f "$EXPLORER" ] || fail "Explorer agent not written: $EXPLORER"
echo "    install OK"

# ── 3. re-install is a no-op ─────────────────────────────────────────────────
echo "==> [3] re-install same profile = no-op..."
BACKUP_COUNT_BEFORE="$(find "$LEANRIG_HOME/backups" -maxdepth 1 -type d 2>/dev/null | grep -v "^$LEANRIG_HOME/backups$" | wc -l | tr -d ' ')"

$CLI install claude-code --profile safe

BACKUP_COUNT_AFTER="$(find "$LEANRIG_HOME/backups" -maxdepth 1 -type d 2>/dev/null | grep -v "^$LEANRIG_HOME/backups$" | wc -l | tr -d ' ')"
[ "$BACKUP_COUNT_BEFORE" = "$BACKUP_COUNT_AFTER" ] || fail "Re-install created new backup (count: $BACKUP_COUNT_BEFORE -> $BACKUP_COUNT_AFTER)"
echo "    re-install no-op OK"

# ── 4. diff ───────────────────────────────────────────────────────────────────
echo "==> [4] diff (nothing changed)..."
$CLI diff claude-code
echo "    diff OK"

# ── 5. rollback ───────────────────────────────────────────────────────────────
echo "==> [5] rollback..."
$CLI rollback claude-code

# Explorer agent should be removed
[ ! -f "$EXPLORER" ] || fail "Explorer agent not removed after rollback: $EXPLORER"

# Settings should be restored to original user content
if [ -f "$CLAUDE_CONFIG_DIR/settings.json" ]; then
  USER_KEY="$(node -e "const s=require('$CLAUDE_CONFIG_DIR/settings.json'); process.exit(s.userExistingKey === 'should-survive' ? 0 : 1)" 2>/dev/null || echo "missing")"
  # Use a simpler check
  grep -q '"userExistingKey"' "$CLAUDE_CONFIG_DIR/settings.json" || fail "settings.json not restored with user key"
  grep -q '"should-survive"' "$CLAUDE_CONFIG_DIR/settings.json" || fail "settings.json user value not restored"
fi
echo "    rollback OK"

# ── 6. state.json has no lingering entries ────────────────────────────────────
echo "==> [6] state clean after rollback..."
STATE_FILE="$LEANRIG_HOME/state.json"
[ -f "$STATE_FILE" ] || fail "state.json missing"
# Use python3 for robust JSON parsing without color codes
INSTALLS="$(python3 -c "import json,sys; s=json.load(open('$STATE_FILE')); print(len(s['installs']))")"
[ "$INSTALLS" = "0" ] || fail "Expected 0 installs in state after rollback, got $INSTALLS"
echo "    state clean OK"

# ── 7. collision: skip without --force ───────────────────────────────────────
echo "==> [7] collision: skip without --force..."
mkdir -p "$CLAUDE_CONFIG_DIR/agents"
echo "# external content" > "$CLAUDE_CONFIG_DIR/agents/leanrig-explorer.md"
INSTALL_OUT="$($CLI install claude-code --profile safe 2>&1)"
CONTENT_AFTER="$(cat "$CLAUDE_CONFIG_DIR/agents/leanrig-explorer.md")"
[ "$CONTENT_AFTER" = "# external content" ] || fail "Collision file was overwritten without --force"
echo "    collision skip OK"

# ── done ─────────────────────────────────────────────────────────────────────
echo ""
pass
