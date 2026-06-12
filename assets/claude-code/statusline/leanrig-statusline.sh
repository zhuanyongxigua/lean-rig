#!/usr/bin/env bash
# leanrig-statusline.sh
#
# Rationale: Claude Code's statusLine feature pipes a JSON payload to this script
# on stdin after each exchange. We extract a few key metrics and print a compact
# one-line summary so the user can see model, context pressure, cost, and active
# output style at a glance — without opening /config or interrupting the session.
#
# Fields used (all confirmed in docs/claude-code-facts.md):
#   model.display_name          — human-readable model name
#   context_window.used_percentage — 0-100 integer
#   cost.total_cost_usd         — cumulative session cost
#   output_style.name           — active output style name
#
# Degrades gracefully when jq is absent or fields are null/missing.

set -euo pipefail

# Read stdin into a variable (may be empty)
input="$(cat)"

# If input is empty or whitespace-only, print a minimal fallback and exit cleanly
if [[ -z "${input// /}" ]]; then
  echo "[leanrig] no data"
  exit 0
fi

# Check for jq availability
if ! command -v jq &>/dev/null; then
  # No jq: print the raw session marker without parsing
  echo "[leanrig] statusline active (install jq for full output)"
  exit 0
fi

# Extract fields with fallback to "?" for null/missing
model="$(printf '%s' "$input" | jq -r '.model.display_name // "?"' 2>/dev/null || echo "?")"
ctx="$(printf '%s' "$input" | jq -r '.context_window.used_percentage // "?"' 2>/dev/null || echo "?")"
cost="$(printf '%s' "$input" | jq -r '.cost.total_cost_usd // "?"' 2>/dev/null || echo "?")"
style="$(printf '%s' "$input" | jq -r '.output_style.name // ""' 2>/dev/null || echo "")"

# Format cost: show 2 decimal places if it's a number
# Force LANG=C so awk uses '.' as decimal separator regardless of system locale
if [[ "$cost" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  cost_fmt="\$$(LANG=C awk -v n="$cost" 'BEGIN { printf "%.2f", n }')"
else
  cost_fmt="\$?"
fi

# Format context percentage
if [[ "$ctx" =~ ^[0-9]+$ ]]; then
  ctx_fmt="${ctx}%"
else
  ctx_fmt="?%"
fi

# Build the status line
line="[${model}] ctx ${ctx_fmt} | ${cost_fmt}"
if [[ -n "$style" ]]; then
  line="${line} | ${style}"
fi

printf '%s\n' "$line"
