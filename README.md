# LeanRig

**Put your AI coding agent on a budget.**

Your agent should not spend premium-model tokens on grep, logs, boilerplate summaries, failed test spam, and "let me explain what I just did" paragraphs.

LeanRig installs safe, reversible cost-control profiles for AI coding agents.

Claude Code first. Harness-agnostic by design.

```bash
leanrig doctor
leanrig install claude-code --profile balanced
leanrig diff
leanrig rollback
```

## Why

Modern coding agents are powerful.

They are also extremely good at wasting context.

They read too much. They summarize too much. They keep stale instructions around. They send huge tool outputs back into the conversation. They use premium models for cheap work. They explain obvious things. They forget that every useless token compounds.

LeanRig gives your agent a budget.

## What LeanRig does

LeanRig installs safe, reversible cost-saving profiles for agent harnesses.

For Claude Code, it can configure:

- cheap exploration agents
- bounded worker subagents
- independent reviewers
- terse output styles
- delegation skills
- tool-output limits
- context hygiene rules
- usage-aware statusline
- backup, diff, and rollback

The goal is not to make the model dumber.

The goal is to stop paying premium prices for low-value work.

## The basic idea

Use the expensive model for judgment. Use cheaper models for work.

```
Premium model:
  planning
  architecture
  conflict resolution
  final synthesis

Cheaper workers:
  grep
  file discovery
  implementation
  tests
  log reading
  first-pass review
  repetitive edits
```

LeanRig turns that into an installable profile.

## Profiles

### `safe`

Minimal changes. Good defaults. Concise output style, cheap subagents with explicit models, no aggressive truncation, easy rollback.

```bash
leanrig install claude-code --profile safe
```

### `balanced`

Recommended. Everything in `safe`, plus a delegation skill, tool-output limits, and a usage statusline.

```bash
leanrig install claude-code --profile balanced
```

### `aggressive`

For people who would rather retry than burn tokens. Stricter output limits, stronger tool-output caps, more aggressive delegation.

```bash
leanrig install claude-code --profile aggressive
```

### `fable-router`

For premium-main workflows. Use the premium model as the coordinator, push routine work to cheaper workers.

```
Premium main session
  ├─ haiku explorer
  ├─ sonnet worker
  └─ reviewer
```

### `sonnet-main`

For cheaper default sessions. Sonnet as the main model, escalate only when necessary.

## Commands

| Command | What it does |
|---|---|
| `leanrig doctor` | Find token waste in your current setup |
| `leanrig install claude-code --profile <p>` | Install a profile (`--dry-run` to preview) |
| `leanrig diff` | Show exactly what LeanRig changed |
| `leanrig rollback` | Restore your previous config |
| `leanrig profiles` | List available profiles |

## Doctor

```
$ leanrig doctor

Claude Code detected

WARN  CLAUDE.md is 914 lines
      This is loaded into context by default.
      Move task-specific instructions into skills.

WARN  haiku-explorer has no model field
      It may inherit your main premium model.

WARN  CLAUDE_CODE_SUBAGENT_MODEL is set
      This overrides per-agent model routing.

OK    rollback backup available
OK    statusline installed
```

## Not just output compression

Output compression helps. But most waste is not "the assistant wrote too many words."

Real waste comes from repeated file reads, huge test logs, long command output, stale session history, bloated project memory, overpowered model routing, verbose subagent reports, MCP overhead, and premium models doing cheap tasks.

LeanRig attacks the whole stack.

## Safety

Every install is backed up. Every change is visible. Every profile is reversible.

```bash
leanrig install claude-code --profile balanced --dry-run   # preview first
leanrig diff                                               # see what changed
leanrig rollback                                           # undo everything
```

LeanRig never deletes your files, never overwrites modified files without `--force`, and keeps a manifest of everything it touches.

## Harness-agnostic

LeanRig is designed around adapters.

Today: `claude-code`.

Planned: `codex`, `gemini-cli`, `opencode`, `cursor-agent`, `aider`, `cline`.

```bash
leanrig install <harness> --profile <profile>
leanrig doctor <harness>
```

## Philosophy

- Premium tokens are for judgment. Cheap tokens are for labor.
- Context is a budget.
- Logs are radioactive. Summarize them before they touch the main session.
- Summaries should earn their keep.
- The best token is the one your agent never sends.
- Every agent needs a spending limit.

## Status

Experimental (v0.1). Built for people who use AI coding agents heavily and are tired of watching them burn context on avoidable noise.

Use `safe` first. Use `balanced` when you trust it. Use `aggressive` when you know what you are doing.

## License

MIT

## Dev

```bash
npm install          # install dependencies
npm run build        # tsc -> dist/
npm test             # vitest unit tests
npm run e2e          # end-to-end install/rollback roundtrip (uses throwaway tmp dirs)
```

Requirements: Node >= 20, npm >= 9.
