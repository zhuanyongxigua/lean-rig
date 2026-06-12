#!/usr/bin/env node
import { program } from "commander";
import pc from "picocolors";
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

// bench
program
  .command("bench")
  .description("Benchmark token usage (planned for v0.2).")
  .action(() => {
    console.log(pc.dim("bench: planned for v0.2 — not yet implemented."));
  });

program.parse(process.argv);
