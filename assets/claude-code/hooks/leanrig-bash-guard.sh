#!/usr/bin/env bash
# leanrig-bash-guard.sh
#
# Rationale: This script is a PreToolUse hook wired for the "aggressive" leanrig
# profile. Its intended long-term purpose is to observe (and eventually gate)
# Bash commands before they run, giving the user a safety layer against
# unintended destructive commands.
#
# !! OBSERVE-ONLY IN v0.1 !!
#
# Command rewriting and blocking are intentionally deferred to a later version.
# Reasons:
#   1. The "updatedInput" mechanism in Claude Code emits permissionDecision:"allow",
#      which bypasses the normal permission prompt for that call. Doing this broadly
#      (for arbitrary commands) is unsafe — the allowlist must be carefully designed.
#   2. A no-op hook is still useful: it exercises the full install / rollback / hook
#      plumbing so that the infrastructure is proven before the logic lands.
#
# Current behavior:
#   - Reads hook JSON from stdin (contains tool_name, tool_input.command, etc.).
#   - If tool_name != "Bash": exit 0 silently (no effect on other tools).
#   - If tool_name == "Bash": exit 0 silently (no-op; normal permission flow continues).
#   - Never emits permissionDecision, so the hook has zero effect on execution.
#   - Does not crash if stdin is empty or if jq is missing.

set -euo pipefail

# Read stdin (may be empty)
input="$(cat 2>/dev/null || true)"

# Empty or whitespace input: nothing to do
if [[ -z "${input// /}" ]]; then
  exit 0
fi

# If jq is not available, we cannot parse the JSON — exit cleanly
if ! command -v jq &>/dev/null; then
  exit 0
fi

# Extract tool_name (fall back to empty string on parse error)
tool_name="$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")"

# Only act on Bash tool calls; silently pass everything else
if [[ "$tool_name" != "Bash" ]]; then
  exit 0
fi

# OBSERVE-ONLY: exit 0 with no stdout.
# The hook emits nothing, so Claude Code sees no permissionDecision and proceeds
# through its normal permission prompt flow.
#
# TODO (v0.2): implement a narrow allowlist-based rewriter here.
exit 0
