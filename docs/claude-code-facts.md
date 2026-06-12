# Claude Code — verified facts for the claude-code adapter

Verified 2026-06-11 against code.claude.com/docs. **This file is the only source of truth for Claude Code names/schemas in this repo. Do not use config keys or env vars that are not listed here.**

## Env vars (set via settings.json `"env"` block, values as strings)

| Name | Status | Semantics |
|---|---|---|
| `BASH_MAX_OUTPUT_LENGTH` | CONFIRMED (env-vars page) | Max characters of Bash tool output; overflow is saved to a file, Claude gets path + short preview. No documented default. |
| `MAX_MCP_OUTPUT_TOKENS` | CONFIRMED (mcp page) | Limits MCP tool response tokens. Default 25,000; warning at 10,000. |
| `MAX_THINKING_TOKENS` | CONFIRMED (settings page) | Caps extended thinking; `0` disables thinking (except Fable 5, which cannot disable thinking). Do NOT set in v0.1 profiles. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | CONFIRMED (sub-agents page) | Overrides `model` frontmatter for ALL subagents (highest precedence). Doctor should WARN when set. |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | NOT FOUND in current docs | Do not use anywhere. |
| `TASK_MAX_OUTPUT_LENGTH` / subagent output cap | NOT FOUND | Do not use anywhere. |

## settings.json (user: `<configDir>/settings.json`)

- `env`: object of env vars applied to every session. CONFIRMED.
- `outputStyle`: style **name** (string), e.g. `"Token Saver"`. CONFIRMED.
- `disableAllHooks`: boolean; disables all hooks AND custom statusline. CONFIRMED.
- `statusLine`: `{ "type": "command", "command": "<path>", "padding"?: number }`. CONFIRMED.
- `hooks`: `{ "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "<path>" } ] } ] }`. CONFIRMED.
- `model`: main model setting (e.g. `"sonnet"`). Used by sonnet-main profile.
- Precedence (high→low): managed > CLI flags > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`. `env` blocks do NOT merge across scopes — highest scope wins entirely.

## Output styles — CONFIRMED, not deprecated

- Location: `<configDir>/output-styles/*.md` (user) or `.claude/output-styles/` (project).
- Frontmatter: `name` (default: file name), `description`, `keep-coding-instructions` (default **false** — must set `true` to keep Claude Code's software-engineering instructions).
- Activated via `outputStyle` setting (by style name) or `/config` menu. `/output-style` command was REMOVED in v2.1.91 — never tell users to run it; say "/config → Output style" or set `outputStyle`.
- Takes effect after `/clear` or new session.

## Subagents

- Location: `<configDir>/agents/*.md` (user) or `.claude/agents/` (project).
- Frontmatter: `name` (lowercase + hyphens), `description` (when to delegate; required), optional `tools` (comma-separated), `model` (`sonnet` | `opus` | `haiku` | `fable` | full model ID | `inherit`), and others (`permissionMode`, `maxTurns`, ...).
- Model resolution: `CLAUDE_CODE_SUBAGENT_MODEL` env > per-invocation param > frontmatter `model` > main conversation model. So a missing `model` field means the agent may inherit a premium main model → doctor WARN.

## Skills

- Location: `<configDir>/skills/<name>/SKILL.md`. Frontmatter: `description` (recommended), `name` optional (dir name is the identifier).

## Statusline

- Config: see settings.json above. Script gets JSON on **stdin**. Useful fields (CONFIRMED): `model.display_name`, `model.id`, `cwd`, `workspace.current_dir`, `cost.total_cost_usd`, `cost.total_duration_ms`, `context_window.used_percentage`, `context_window.total_input_tokens`, `context_window.total_output_tokens`, `output_style.name`, `session_id`, `version`, `rate_limits.five_hour.used_percentage`.
- Runs locally; consumes no API tokens.

## PreToolUse hooks

- Hook receives JSON on stdin incl. `tool_name`, `tool_input` (for Bash: `tool_input.command`).
- A hook CAN modify tool input by printing:
  ```json
  { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": { "command": "<new command>" } } }
  ```
  NOTE: `permissionDecision: "allow"` bypasses the permission prompt for that call — any hook we ship must keep its rewrite allowlist tiny and document this.
- Exit 0 with no output = no decision (normal flow). Exit 2 = block.

## Paths

- `CLAUDE_CONFIG_DIR` relocates `~/.claude`. **`~/.claude.json` does NOT move** (stays in $HOME).
- MCP servers: user scope = top-level `mcpServers` in `~/.claude.json` (local scope nested under `projects.<path>.mcpServers`); project scope = `.mcp.json` at project root, `mcpServers` key.

## Memory / CLAUDE.md

- Loaded into context at session start. Official guidance: **target under 200 lines** per CLAUDE.md (memory page). Doctor warns above 200.

## Plugin CLI (verified 2026-06-12, docs page `discover-plugins` + local `claude plugin --help`)

Non-interactive shell commands (CONFIRMED locally on installed claude CLI):

- `claude plugin marketplace add <source>` — source may be `owner/repo` GitHub shorthand, git URL, local path, or marketplace.json URL.
- `claude plugin marketplace remove <name>` — **also uninstalls plugins that were installed from that marketplace** (docs warning).
- `claude plugin marketplace list`
- `claude plugin install <plugin>@<marketplace>` (alias `i`; `--scope` option exists)
- `claude plugin uninstall <plugin>` (alias `remove`)
- `claude plugin list`
- Plugin changes need `/reload-plugins` or a restart to take effect.

## Third-party tools (verified 2026-06-12; for the tools registry)

| Tool | License | Channel | Install | Uninstall | Detect |
|---|---|---|---|---|---|
| ccusage statusline | MIT (npm field) | settings.json patch only | `statusLine: {"type":"command","command":"npx -y ccusage statusline","padding":0}` (ccusage.com/guide/statusline) | revert settings keys | `statusLine.command` contains `ccusage` |
| caveman | MIT | Claude plugin marketplace (`JuliusBrussee/caveman` has `.claude-plugin/marketplace.json`; marketplace name `caveman`, plugin name `caveman`) | `claude plugin marketplace add JuliusBrussee/caveman` then `claude plugin install caveman@caveman` | `claude plugin uninstall caveman` then `claude plugin marketplace remove caveman` | read-only: `<configDir>/plugins/installed_plugins.json` `plugins` keys contain `caveman@...` (OBSERVED structure, version 2, not documented — best-effort only); fallback: `claude plugin list` output contains `caveman` |
| squeez | Apache-2.0 (npm v1.23.0) | npm | `npm install -g squeez` then `squeez setup --host=claude-code` | `squeez uninstall --host=claude-code` | binary at `<configDir>/squeez/bin/squeez`, or settings hooks mention squeez |
| lean-ctx | Apache-2.0 | brew tap / install script — **guide only, no auto-install in v0.2** | point user to github.com/yvgude/lean-ctx (`brew tap yvgude/lean-ctx && brew install lean-ctx`) | n/a | `lean-ctx` binary on PATH |

NEVER run `curl | bash`-style remote scripts on the user's behalf (caveman and lean-ctx READMEs suggest them; we use official package channels instead).
