#!/usr/bin/env node
import { program } from "commander";
import pc from "picocolors";
import readline from "node:readline/promises";
import {
  registerAdapter,
  getAdapter,
  listAdapters,
} from "./adapters/types.js";
import { claudeCodeAdapter } from "./adapters/claude-code/index.js";
import { renderFindings } from "./core/report.js";
import {
  runInstall,
  runRollback,
  runDiff,
} from "./core/installer.js";
import { runAddTool, runRemoveTool, realRunner } from "./core/tools.js";

// Register built-in adapters
registerAdapter(claudeCodeAdapter);

const DEFAULT_HARNESS = "claude-code";

function resolveAdapter(harness: string | undefined) {
  const name = harness ?? DEFAULT_HARNESS;
  const adapter = getAdapter(name);
  if (!adapter) {
    const available = listAdapters().join(", ");
    console.error(
      pc.red(`Unknown harness: "${name}". Available: ${available}`)
    );
    process.exit(1);
  }
  return adapter;
}

/**
 * Wrap an async command action so any thrown error renders as a clean
 * one-line message and exits non-zero, instead of dumping a Node stack
 * trace. Expected refusals (e.g. installing over an existing profile) and
 * unexpected failures both surface the same way.
 */
function action<A extends unknown[]>(
  fn: (...args: A) => Promise<void>
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(pc.red(`error: ${(err as Error).message}`));
      process.exit(1);
    }
  };
}

program
  .name("leanrig")
  .description("Install safe, reversible cost-control profiles into AI coding agent harnesses.")
  .version("0.1.0");

// doctor
program
  .command("doctor [harness]")
  .description("Read-only audit of your harness configuration.")
  .action(action(async (harness?: string) => {
    const adapter = resolveAdapter(harness);
    const detectResult = await adapter.detect();
    if (!detectResult.installed) {
      console.log(pc.yellow(`Harness "${adapter.name}" not detected: ${detectResult.detail ?? ""}`));
    }
    const findings = await adapter.doctor();
    renderFindings(findings);
  }));

// install
program
  .command("install <harness>")
  .description("Install a profile into a harness.")
  .requiredOption("--profile <name>", "Profile name to install")
  .option("--dry-run", "Print plan without writing anything", false)
  .option("--force", "Overwrite colliding files and user-edited files", false)
  .action(action(async (harness: string, opts: { profile: string; dryRun: boolean; force: boolean }) => {
    const adapter = resolveAdapter(harness);
    const plan = await adapter.planInstall(opts.profile, { force: opts.force });
    const result = await runInstall(plan, { dryRun: opts.dryRun, force: opts.force });
    renderFindings(result.findings);
    if (result.noOp) {
      console.log(pc.dim("(No changes made.)"));
    }
  }));

// diff
program
  .command("diff [harness]")
  .description("Show what changed in installed files since the install.")
  .action(action(async (harness?: string) => {
    const adapter = resolveAdapter(harness);
    const result = await runDiff(adapter.name);
    renderFindings(result.findings);
  }));

// rollback
program
  .command("rollback [harness]")
  .description("Restore the pre-install state.")
  .option("--force", "Restore even user-edited files", false)
  .action(action(async (harness: string | undefined, opts: { force: boolean }) => {
    const adapter = resolveAdapter(harness);
    const result = await runRollback(adapter.name, { force: opts.force });
    renderFindings(result.findings);
  }));

// profiles
program
  .command("profiles [harness]")
  .description("List available profiles for a harness.")
  .action(action(async (harness?: string) => {
    const adapter = resolveAdapter(harness);
    const profiles = await adapter.listProfiles();
    if (profiles.length === 0) {
      console.log(pc.dim("No profiles found."));
    } else {
      console.log(pc.bold(`Profiles for ${adapter.name}:`));
      for (const p of profiles) {
        console.log(`  ${p}`);
      }
    }
  }));

// tools
program
  .command("tools [harness]")
  .description("List third-party tools in the registry with install status.")
  .action(action(async (harness?: string) => {
    const adapter = resolveAdapter(harness);
    if (!adapter.listTools) {
      console.log(pc.dim(`No tools registry for harness "${adapter.name}".`));
      return;
    }
    const entries = await adapter.listTools();
    if (entries.length === 0) {
      console.log(pc.dim("No tools in registry."));
      return;
    }
    console.log(pc.bold(`Tools for ${adapter.name}:`));
    for (const { spec, status } of entries) {
      const statusStr = status.installed
        ? pc.green("installed")
        : pc.dim("not installed");
      console.log(`  ${pc.bold(spec.id)}  [${statusStr}]  ${spec.license}`);
      console.log(`    ${spec.description}`);
      if (status.detail && status.installed) {
        console.log(pc.dim(`    ${status.detail}`));
      }
    }
  }));

// add
program
  .command("add <tool> [harness]")
  .description("Add a third-party tool to a harness.")
  .option("--dry-run", "Print plan without executing anything", false)
  .option("--yes", "Skip confirmation prompt", false)
  .option("--force", "Force restore of user-modified keys (settings-kind remove)", false)
  .action(action(async (tool: string, harness: string | undefined, opts: { dryRun: boolean; yes: boolean; force: boolean }) => {
    const adapter = resolveAdapter(harness);
    if (!adapter.planAddTool || !adapter.detectTool) {
      throw new Error(`No tools registry for harness "${adapter.name}".`);
    }

    // Find spec
    const allTools = adapter.listTools ? await adapter.listTools() : [];
    const entry = allTools.find((e) => e.spec.id === tool);
    if (!entry) {
      throw new Error(`Unknown tool "${tool}" for harness "${adapter.name}". Run \`leanrig tools\` to see available tools.`);
    }
    const { spec } = entry;
    const plan = await adapter.planAddTool(tool);

    // Print plan header
    console.log(pc.bold(`\nTool: ${spec.title}`));
    console.log(`  License : ${spec.license}`);
    console.log(`  Source  : ${spec.source}`);
    if (spec.overlaps) {
      console.log(pc.yellow(`  Overlap : ${spec.overlaps}`));
    }

    // Print what will happen
    if (plan.kind === "settings") {
      console.log(`\n  Will merge into ${plan.settingsPath}:`);
      console.log(JSON.stringify(plan.merge, null, 2).split("\n").map((l) => `    ${l}`).join("\n"));
    } else if (plan.kind === "external") {
      if (plan.requires) {
        console.log(`\n  Requires: ${plan.requires}`);
      }
      console.log(`\n  Will run:`);
      for (const argv of plan.commands) {
        console.log(`    ${argv.join(" ")}`);
      }
    } else if (plan.kind === "guide") {
      console.log(`\n  Instructions:\n`);
      console.log(plan.instructions.split("\n").map((l) => `    ${l}`).join("\n"));
    }

    if (opts.dryRun) {
      console.log(pc.dim("\n(dry-run — no changes made)"));
      const result = await runAddTool(adapter.name, plan, spec, { dryRun: true, force: opts.force, runner: realRunner });
      renderFindings(result.findings);
      return;
    }

    // Confirmation
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        console.log(pc.yellow("\nStdin is not a TTY and --yes was not passed. Aborting. Re-run with --yes to confirm."));
        process.exit(0);
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("\nProceed? [y/N] ");
      rl.close();
      if (answer.trim().toLowerCase() !== "y") {
        console.log(pc.dim("Cancelled."));
        process.exit(0);
      }
    }

    const result = await runAddTool(adapter.name, plan, spec, { dryRun: false, force: opts.force, runner: realRunner });
    renderFindings(result.findings);
  }));

// remove
program
  .command("remove <tool> [harness]")
  .description("Remove a third-party tool from a harness.")
  .option("--dry-run", "Print plan without executing anything", false)
  .option("--yes", "Skip confirmation prompt", false)
  .option("--force", "Force restore of user-modified keys", false)
  .action(action(async (tool: string, harness: string | undefined, opts: { dryRun: boolean; yes: boolean; force: boolean }) => {
    const adapter = resolveAdapter(harness);
    if (!adapter.planRemoveTool) {
      throw new Error(`No tools registry for harness "${adapter.name}".`);
    }

    // Find spec
    const allTools = adapter.listTools ? await adapter.listTools() : [];
    const entry = allTools.find((e) => e.spec.id === tool);
    if (!entry) {
      throw new Error(`Unknown tool "${tool}" for harness "${adapter.name}". Run \`leanrig tools\` to see available tools.`);
    }
    const { spec } = entry;
    const plan = await adapter.planRemoveTool(tool);

    // Print plan header
    console.log(pc.bold(`\nTool: ${spec.title}`));
    console.log(`  License : ${spec.license}`);
    console.log(`  Source  : ${spec.source}`);

    // Print what will happen
    if (plan.kind === "settings") {
      console.log(`\n  Will restore settings keys in ${plan.settingsPath}`);
    } else if (plan.kind === "external") {
      console.log(`\n  Will run:`);
      for (const argv of plan.commands) {
        console.log(`    ${argv.join(" ")}`);
      }
    } else if (plan.kind === "guide") {
      console.log(`\n  This is a guide-only tool; leanrig cannot auto-remove it.`);
    }

    if (opts.dryRun) {
      console.log(pc.dim("\n(dry-run — no changes made)"));
      const result = await runRemoveTool(adapter.name, plan, spec, { dryRun: true, force: opts.force, runner: realRunner });
      renderFindings(result.findings);
      return;
    }

    // Confirmation
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        console.log(pc.yellow("\nStdin is not a TTY and --yes was not passed. Aborting. Re-run with --yes to confirm."));
        process.exit(0);
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("\nProceed? [y/N] ");
      rl.close();
      if (answer.trim().toLowerCase() !== "y") {
        console.log(pc.dim("Cancelled."));
        process.exit(0);
      }
    }

    const result = await runRemoveTool(adapter.name, plan, spec, { dryRun: false, force: opts.force, runner: realRunner });
    renderFindings(result.findings);
  }));

// bench
program
  .command("bench")
  .description("Benchmark token usage (planned for v0.2).")
  .action(() => {
    console.log(pc.dim("bench: planned for v0.2 — not yet implemented."));
  });

program.parse(process.argv);
