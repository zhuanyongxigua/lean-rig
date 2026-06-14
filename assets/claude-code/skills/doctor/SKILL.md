---
name: leanrig-doctor
description: Audit this Claude Code setup for token/cost waste and recommend the right cost-saving fixes — including which third-party tools (ccusage, caveman, squeez, lean-ctx) fit the user's actual situation, with their official install commands. Use when the user wants to reduce Claude Code token usage, lower their API bill, or asks which money-saving tools they should install.
---

## What this skill does

Bridge the deterministic `leanrig doctor` audit to concrete, prioritized
recommendations. The CLI measures (fast, offline, no guessing); you judge —
decide which fixes and which third-party tools actually fit *this* setup, and
hand the user the exact commands.

**You never install anything automatically.** leanrig is a recommender, not an
installer of third-party software. Show the official commands; let the user run
them.

## Procedure

1. **Measure.** Run the deterministic audit as JSON:

   ```
   leanrig doctor --json
   ```

   Each finding is `{ level: "ok"|"info"|"warn", title, detail }`. Warnings are
   real waste; infos are opportunities.

2. **See the tool registry + what's already installed:**

   ```
   leanrig tools --json
   ```

   Each entry has `id`, `description`, `license`, `source`, `install` (official
   command), optional `remove`, optional `overlaps`, and `installed` (bool).

3. **Judge and prioritize.** Map findings → fixes, biggest lever first:
   - **Config-level waste is usually the bigger win — fix it before adding tools.**
     Large CLAUDE.md, uncapped `BASH_MAX_OUTPUT_LENGTH` / `MAX_MCP_OUTPUT_TOKENS`,
     `CLAUDE_CODE_SUBAGENT_MODEL` overriding routing, subagents with no `model:`
     (inheriting a premium model). These are fixed by `leanrig install
     <profile>` (reversible) or a one-line settings/frontmatter edit — no
     third-party tool needed.
   - **Then recommend tools that match the actual gap**, e.g.:
     - no output compression + verbose sessions → consider `caveman` (but note
       it overlaps the Token Saver output style — pick one).
     - huge Bash/test logs flooding context → `squeez`.
     - no cost visibility → `ccusage-statusline`.
     - lots of repeated large file reads → `lean-ctx`.

4. **Respect overlaps and current state.**
   - Never recommend a tool that `leanrig tools --json` already reports
     `installed: true`.
   - If an entry has `overlaps`, surface it (e.g. don't stack `caveman` on top
     of the Token Saver output style without telling the user to choose one).

5. **Present a short, ranked plan.** For each recommendation give: the finding
   it addresses, the one-line rationale, and the exact command — leanrig's own
   (`leanrig install ...`) for config fixes, or the tool's `install` string for
   third-party tools. Lead with the highest-impact item.

## Boundaries

- Do **not** run third-party install commands yourself — present them for the
  user to run through the tool's official channel.
- You **may** run `leanrig install <harness> --profile <p>` for leanrig's own
  reversible config when the user agrees (`leanrig diff` / `leanrig rollback`
  undo it).
- Keep recommendations grounded in the JSON output — don't invent waste the
  audit didn't find, and don't recommend a tool that doesn't address a real
  finding.
