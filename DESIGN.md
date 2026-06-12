# LeanRig — Design (v0.1)

Internal contract for implementation. README is the marketing surface; this file is the engineering truth.

## Goal

A CLI (`leanrig`) that installs **safe, reversible cost-control profiles** into AI coding agent harnesses. v0.1 ships one adapter: **claude-code**.

Commands (v0.1):

```
leanrig doctor [harness]                      # read-only audit of token waste
leanrig install <harness> --profile <name>    # install a profile (--dry-run, --force)
leanrig diff [harness]                        # what changed since install (vs backup)
leanrig rollback [harness]                    # restore pre-install state (--force)
leanrig profiles [harness]                    # list available profiles
leanrig bench                                 # stub in v0.1: prints roadmap notice
```

Default harness: `claude-code`.

## Non-goals (v0.1)

- No benchmark engine (stub only).
- No command-rewriting for arbitrary Bash (only a small allowlisted PreToolUse hook, aggressive profile only, and only if the hook `updatedInput` mechanism is confirmed in docs).
- No integration with third-party tools (LeanCTX, squeez, ccusage) beyond doctor *detection*.
- No telemetry, no network calls at runtime.

## Stack

- TypeScript, Node >= 20, ESM (`"type": "module"`).
- Runtime deps: `commander`, `picocolors`, `diff`. Nothing else.
- Dev deps: `typescript`, `vitest`, `@types/node`.
- Build: `tsc` → `dist/`. Bin: `dist/index.js` (shebang).
- npm package `leanrig`; `files`: `dist`, `assets`, `profiles`, `README.md`, `LICENSE`.

## Layout

```
src/
  index.ts                  # commander CLI entry
  commands/                 # thin command handlers; logic lives in core/adapters
  core/
    paths.ts                # LEANRIG_HOME (~/.leanrig), per-adapter config dirs
    state.ts                # ~/.leanrig/state.json (install history)
    manifest.ts             # manifest types + io
    backup.ts               # snapshot/restore engine
    installer.ts            # executes InstallPlan (dry-run, backup, write, merge, manifest)
    jsonMerge.ts            # deep merge for settings.json patches
    diffRender.ts           # unified diff rendering (uses `diff` package)
    report.ts               # Finding {level: ok|info|warn}, terminal renderer
  adapters/
    types.ts                # Adapter interface
    claude-code/
      index.ts              # detect(), doctor(), planInstall()
      doctorChecks.ts
assets/claude-code/         # template files (shipped in package, copied on install)
  agents/  skills/  output-styles/  hooks/  statusline/
profiles/claude-code/       # safe.json balanced.json aggressive.json fable-router.json sonnet-main.json
test/                       # vitest; all fs tests run against tmp dirs
docs/claude-code-facts.md   # verified doc facts (env vars, schemas) — source of truth for adapter
```

## Core concepts

### Adapter

```ts
interface Adapter {
  name: string;                       // "claude-code"
  detect(): Promise<DetectResult>;    // installed? config dir? version?
  doctor(): Promise<Finding[]>;       // read-only
  planInstall(profileName: string): Promise<InstallPlan>;
}
```

The engine (installer/backup/rollback/diff) is **harness-agnostic**: no claude-specific strings outside `adapters/claude-code/` and its assets/profiles dirs.

### InstallPlan

```ts
interface PlannedFile { assetId: string; targetAbs: string; content: string; executable?: boolean }
interface SettingsPatch { fileAbs: string; merge: Record<string, unknown> }  // deep-merged
interface InstallPlan { harness: string; profile: string; files: PlannedFile[]; settings?: SettingsPatch }
```

### Profiles

JSON, may `extends` another profile (single inheritance, assets unioned, vars/settings deep-merged, child wins).

```json
{
  "name": "balanced",
  "extends": "safe",
  "description": "...",
  "assets": ["agents/explorer", "agents/worker", "agents/reviewer", "skills/delegate"],
  "vars": { "explorerModel": "haiku", "workerModel": "sonnet", "reviewerModel": "sonnet" },
  "settings": { "env": { "BASH_MAX_OUTPUT_LENGTH": "20000" } }
}
```

Assets are templates with `{{var}}` substitution from `vars`. Installed claude files are prefixed `leanrig-` (e.g. `agents/leanrig-explorer.md`) so ownership is unambiguous.

### Manifest + state

Every install writes `~/.leanrig/backups/<id>/manifest.json`:

```json
{
  "version": 1, "harness": "claude-code", "profile": "balanced",
  "createdAt": "...", "configDir": "/Users/x/.claude",
  "files": [{ "target": "...", "existedBefore": false, "backupRelPath": null, "writtenHash": "sha256..." }],
  "settings": { "path": "...", "backupRelPath": "...", "writtenHash": "..." }
}
```

`~/.leanrig/state.json` keeps the install list + last install id per harness. `LEANRIG_HOME` env var overrides `~/.leanrig` (required for tests).

## Safety invariants (reviewer: verify each)

1. Any file we modify or overwrite is copied into the backup dir **first**.
2. Rollback only (a) deletes files with `existedBefore: false`, (b) restores backups. It never touches unlisted files.
3. If a target file exists with different content and was not written by us → **skip + warn**; overwrite only with `--force` (still backed up).
4. If a manifest file's current hash ≠ `writtenHash` (user edited it after install), rollback/overwrite of that file requires `--force`.
5. `--dry-run` writes nothing anywhere (including `~/.leanrig`).
6. settings.json is parsed, deep-merged, and re-serialized (2-space indent); rollback restores the backed-up file wholesale.
7. Doctor is strictly read-only.
8. Re-installing the same profile over itself with no drift is a no-op (idempotent; reported as such).
9. **One active layer per harness.** Backups always capture the user's *true pre-leanrig* state, never a prior leanrig install. A single `rollback` always returns the configDir to that true original, no matter how many times the user re-installed. Re-installing when an active install exists is implemented as *internal rollback-to-original, then fresh install* — it never stacks a layer over leanrig's own files. Installing a **different** profile while one is active is refused unless `--force` (message: "<harness> already has profile '<X>' installed. Run `leanrig rollback` first, or re-run with --force to replace it."). With `--force`, the replace path runs the internal rollback (force) then installs the new profile.

## Doctor checks (claude-code)

Read-only; sources: `$CLAUDE_CONFIG_DIR` or `~/.claude`, `~/.claude.json`, project `./CLAUDE.md` + `./.claude/`, `./.mcp.json`. Checks: CLAUDE.md size (warn > 200 lines per official guidance); output-limit env caps unset (`BASH_MAX_OUTPUT_LENGTH`, `MAX_MCP_OUTPUT_TOKENS`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, subagent cap per facts doc); `CLAUDE_CODE_SUBAGENT_MODEL` set (overrides per-agent routing); agents missing `model` frontmatter; MCP server count; output style / statusline / hooks presence; leanrig backup state. Exact env names and schemas come from `docs/claude-code-facts.md` — do not invent them.

## Testing

Vitest. All fs tests run with `LEANRIG_HOME` and `CLAUDE_CONFIG_DIR` pointed at per-test tmp dirs — **tests must never touch the real `~/.claude` or `~/.leanrig`**. Required coverage: jsonMerge apply semantics; install→rollback byte-exact roundtrip (created files removed, modified files restored); collision policy (skip vs `--force`); user-edit detection via hash; dry-run writes nothing; profile inheritance resolution.

## Roadmap (not v0.1)

`bench`; more adapters (codex, gemini-cli, opencode); default-on tool-output hooks; third-party tool integration; uninstall-vs-rollback split.
