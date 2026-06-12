/**
 * Third-party tools engine (harness-agnostic).
 * No harness-specific strings in this file.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { leanrigHome } from "./paths.js";
import { deepMerge } from "./jsonMerge.js";
import type { Finding } from "./report.js";
import type { ToolSpec, ToolPlan } from "../adapters/toolTypes.js";

// ---------------------------------------------------------------------------
// CommandRunner interface
// ---------------------------------------------------------------------------

export interface CommandRunner {
  run(argv: string[]): { code: number; stdout: string; stderr: string };
}

export const realRunner: CommandRunner = {
  run(argv: string[]) {
    const [cmd, ...args] = argv;
    if (!cmd) return { code: 1, stdout: "", stderr: "empty argv" };
    const result = spawnSync(cmd, args, { shell: false, encoding: "utf8" });
    return {
      code: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  },
};

// ---------------------------------------------------------------------------
// ToolRunOptions
// ---------------------------------------------------------------------------

export interface ToolRunOptions {
  dryRun: boolean;
  force: boolean;
  runner?: CommandRunner;
}

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

interface KeyRecord {
  path: string;         // dot-separated leaf path, e.g. "statusLine.command"
  previous: unknown;    // value before add, or { absent: true }
  written: unknown;     // value written by add
}

interface SettingsManifest {
  version: 1;
  toolId: string;
  harness: string;
  kind: "settings";
  addedAt: string;
  settingsPath: string;
  keys: KeyRecord[];
  settingsBackupRelPath: string; // relative to manifest's directory
}

interface ExternalManifest {
  version: 1;
  toolId: string;
  harness: string;
  kind: "external";
  addedAt: string;
}

type ToolManifest = SettingsManifest | ExternalManifest;

// ---------------------------------------------------------------------------
// Manifest path helpers
// ---------------------------------------------------------------------------

function manifestDir(harness: string): string {
  return path.join(leanrigHome(), "tools", harness);
}

function manifestPath(harness: string, toolId: string): string {
  return path.join(manifestDir(harness), `${toolId}.json`);
}

function readManifest(harness: string, toolId: string): ToolManifest | null {
  const p = manifestPath(harness, toolId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as ToolManifest;
  } catch {
    return null;
  }
}

function writeManifest(harness: string, toolId: string, manifest: ToolManifest): void {
  const dir = manifestDir(harness);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(harness, toolId), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

function deleteManifest(harness: string, toolId: string): void {
  const p = manifestPath(harness, toolId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ---------------------------------------------------------------------------
// Settings helpers: get/set leaf values by dot-path
// ---------------------------------------------------------------------------

function getLeaf(obj: Record<string, unknown>, dotPath: string): { found: true; value: unknown } | { found: false } {
  const parts = dotPath.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return { found: false };
    cur = (cur as Record<string, unknown>)[part];
    if (cur === undefined) return { found: false };
  }
  return { found: true, value: cur };
}

function setLeaf(obj: Record<string, unknown>, dotPath: string, value: unknown): Record<string, unknown> {
  const parts = dotPath.split(".");
  const result = { ...obj };
  let cur: Record<string, unknown> = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cur[part];
    if (next !== null && typeof next === "object" && !Array.isArray(next)) {
      cur[part] = { ...(next as Record<string, unknown>) };
    } else {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
  return result;
}

function deleteLeaf(obj: Record<string, unknown>, dotPath: string): Record<string, unknown> {
  const parts = dotPath.split(".");
  const result = { ...obj };

  function del(cur: Record<string, unknown>, remaining: string[]): Record<string, unknown> {
    if (remaining.length === 0) return cur;
    const [head, ...tail] = remaining as [string, ...string[]];
    if (tail.length === 0) {
      const copy = { ...cur };
      delete copy[head];
      return copy;
    }
    const child = cur[head];
    if (child === null || typeof child !== "object" || Array.isArray(child)) return cur;
    const updatedChild = del(child as Record<string, unknown>, tail);
    const copy = { ...cur };
    // Prune empty parent objects
    if (Object.keys(updatedChild).length === 0) {
      delete copy[head];
    } else {
      copy[head] = updatedChild;
    }
    return copy;
  }

  return del(result, parts);
}

/**
 * Collect all leaf key paths from a nested object.
 * E.g. { statusLine: { command: "x", type: "command" } } → ["statusLine.command", "statusLine.type"]
 */
function collectLeafPaths(obj: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      paths.push(...collectLeafPaths(v as Record<string, unknown>, full));
    } else {
      paths.push(full);
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// read/write settings.json safely
// ---------------------------------------------------------------------------

function readSettingsStrict(settingsPath: string): Record<string, unknown> {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, "utf8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`settings.json is corrupt (invalid JSON) at ${settingsPath}: ${(e as Error).message}`);
  }
}

function writeSettings(settingsPath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// runAddTool
// ---------------------------------------------------------------------------

export async function runAddTool(
  harness: string,
  plan: ToolPlan,
  spec: ToolSpec,
  opts: ToolRunOptions
): Promise<{ findings: Finding[] }> {
  const runner = opts.runner ?? realRunner;
  const findings: Finding[] = [];

  if (plan.kind === "settings") {
    // Check for existing manifest (no --force bypass)
    const existing = readManifest(harness, spec.id);
    if (existing) {
      throw new Error(`Tool "${spec.id}" is already added. Run \`leanrig remove ${spec.id}\` first.`);
    }

    const settings = readSettingsStrict(plan.settingsPath);
    const leafPaths = collectLeafPaths(plan.merge);
    const keyRecords: KeyRecord[] = [];

    for (const lp of leafPaths) {
      const current = getLeaf(settings, lp);
      const mergedObj = deepMerge({}, plan.merge);
      const writtenLeaf = getLeaf(mergedObj, lp);
      keyRecords.push({
        path: lp,
        previous: current.found ? current.value : { absent: true },
        written: writtenLeaf.found ? writtenLeaf.value : null,
      });
    }

    if (opts.dryRun) {
      findings.push({
        level: "info",
        title: `[dry-run] Would merge settings into ${plan.settingsPath}`,
        detail: JSON.stringify(plan.merge, null, 2),
      });
      return { findings };
    }

    // Write settings backup
    const mDir = manifestDir(harness);
    fs.mkdirSync(mDir, { recursive: true });
    const backupName = `${spec.id}.settings.backup.json`;
    const backupPath = path.join(mDir, backupName);
    const rawOrEmpty = fs.existsSync(plan.settingsPath)
      ? fs.readFileSync(plan.settingsPath, "utf8")
      : "{}";
    fs.writeFileSync(backupPath, rawOrEmpty, "utf8");

    // Merge and write
    const merged = deepMerge(settings, plan.merge);
    writeSettings(plan.settingsPath, merged);

    // Write manifest
    const manifest: SettingsManifest = {
      version: 1,
      toolId: spec.id,
      harness,
      kind: "settings",
      addedAt: new Date().toISOString(),
      settingsPath: plan.settingsPath,
      keys: keyRecords,
      settingsBackupRelPath: backupName,
    };
    writeManifest(harness, spec.id, manifest);

    findings.push({
      level: "ok",
      title: `Added "${spec.title}" — settings merged`,
      detail: `Modified: ${plan.settingsPath}`,
    });
    return { findings };
  }

  if (plan.kind === "external") {
    if (opts.dryRun) {
      if (plan.requires) {
        findings.push({
          level: "info",
          title: `[dry-run] Would check for required binary: ${plan.requires}`,
        });
      }
      findings.push({
        level: "info",
        title: `[dry-run] Would run ${plan.commands.length} command(s)`,
        detail: plan.commands.map((argv) => argv.join(" ")).join("\n"),
      });
      return { findings };
    }

    // Check requires
    if (plan.requires) {
      const check = runner.run([plan.requires, "--version"]);
      if (check.code !== 0) {
        throw new Error(
          `Required binary "${plan.requires}" not found or returned non-zero. ` +
          `Please install it first, then retry.`
        );
      }
    }

    const executed: string[] = [];
    for (const argv of plan.commands) {
      executed.push(argv.join(" "));
      const result = runner.run(argv);
      if (result.code !== 0) {
        const stderrSnip = result.stderr.slice(0, 500);
        findings.push({
          level: "warn",
          title: `Command failed: ${argv.join(" ")}`,
          detail: [
            `Exit code: ${result.code}`,
            stderrSnip ? `stderr: ${stderrSnip}` : "",
            executed.length > 1
              ? `Commands executed before failure:\n${executed.slice(0, -1).join("\n")}`
              : "No commands executed before this one.",
          ]
            .filter(Boolean)
            .join("\n"),
        });
        return { findings };
      }
    }

    // Write manifest
    const manifest: ExternalManifest = {
      version: 1,
      toolId: spec.id,
      harness,
      kind: "external",
      addedAt: new Date().toISOString(),
    };
    writeManifest(harness, spec.id, manifest);

    findings.push({
      level: "ok",
      title: `Added "${spec.title}"`,
      detail: `Ran ${executed.length} command(s):\n${executed.join("\n")}`,
    });
    return { findings };
  }

  if (plan.kind === "guide") {
    findings.push({
      level: "info",
      title: `Instructions for "${spec.title}"`,
      detail: plan.instructions,
    });
    return { findings };
  }

  // TypeScript exhaustiveness guard
  throw new Error(`Unknown plan kind: ${(plan as { kind: string }).kind}`);
}

// ---------------------------------------------------------------------------
// runRemoveTool
// ---------------------------------------------------------------------------

export async function runRemoveTool(
  harness: string,
  plan: ToolPlan,
  spec: ToolSpec,
  opts: ToolRunOptions
): Promise<{ findings: Finding[] }> {
  const runner = opts.runner ?? realRunner;
  const findings: Finding[] = [];

  if (plan.kind === "settings") {
    const manifest = readManifest(harness, spec.id);
    if (!manifest || manifest.kind !== "settings") {
      throw new Error(
        `No leanrig manifest found for tool "${spec.id}". ` +
        `This tool may not have been added by leanrig, or it was already removed.`
      );
    }

    const settings = readSettingsStrict(manifest.settingsPath);
    let skipped = false;

    if (opts.dryRun) {
      for (const kr of manifest.keys) {
        const current = getLeaf(settings, kr.path);
        const currentVal = current.found ? current.value : { absent: true };
        const writtenStr = JSON.stringify(kr.written);
        const currentStr = JSON.stringify(currentVal);
        if (currentStr !== writtenStr && !opts.force) {
          findings.push({
            level: "warn",
            title: `[dry-run] Would skip key "${kr.path}" — user-modified`,
            detail: `Written: ${writtenStr}\nCurrent: ${currentStr}\nUse --force to restore anyway.`,
          });
        } else {
          const prev = kr.previous as { absent?: boolean };
          findings.push({
            level: "info",
            title: `[dry-run] Would restore key "${kr.path}"`,
            detail: prev?.absent
              ? "Would delete (was absent before add)"
              : `Would restore to: ${JSON.stringify(kr.previous)}`,
          });
        }
      }
      return { findings };
    }

    let updated = { ...settings };
    for (const kr of manifest.keys) {
      const current = getLeaf(updated, kr.path);
      const currentVal = current.found ? current.value : { absent: true };
      const writtenStr = JSON.stringify(kr.written);
      const currentStr = JSON.stringify(currentVal);

      if (currentStr !== writtenStr && !opts.force) {
        findings.push({
          level: "warn",
          title: `Skipping key "${kr.path}" — value was modified after tool was added`,
          detail: `Expected: ${writtenStr}\nFound: ${currentStr}\nUse --force to restore anyway.`,
        });
        skipped = true;
      } else {
        const prev = kr.previous as { absent?: boolean };
        if (prev?.absent) {
          updated = deleteLeaf(updated, kr.path);
        } else {
          updated = setLeaf(updated, kr.path, kr.previous);
        }
      }
    }

    writeSettings(manifest.settingsPath, updated);

    if (skipped && !opts.force) {
      findings.push({
        level: "warn",
        title: `Tool "${spec.id}" partially removed — manifest kept (re-run with --force to complete)`,
        detail: `settings.json was updated except for user-modified keys.`,
      });
      // Keep manifest; don't delete
    } else {
      deleteManifest(harness, spec.id);
      findings.push({
        level: "ok",
        title: `Removed "${spec.title}" — settings keys restored`,
        detail: `Modified: ${manifest.settingsPath}`,
      });
    }

    return { findings };
  }

  if (plan.kind === "external") {
    const manifest = readManifest(harness, spec.id);
    if (!manifest) {
      findings.push({
        level: "info",
        title: `No leanrig manifest for "${spec.id}" — tool may have been installed manually`,
        detail: `Proceeding to run uninstall commands anyway.`,
      });
    }

    if (opts.dryRun) {
      findings.push({
        level: "info",
        title: `[dry-run] Would run ${plan.commands.length} command(s)`,
        detail: plan.commands.map((argv) => argv.join(" ")).join("\n"),
      });
      return { findings };
    }

    const executed: string[] = [];
    for (const argv of plan.commands) {
      executed.push(argv.join(" "));
      const result = runner.run(argv);
      if (result.code !== 0) {
        const stderrSnip = result.stderr.slice(0, 500);
        findings.push({
          level: "warn",
          title: `Command failed: ${argv.join(" ")}`,
          detail: [
            `Exit code: ${result.code}`,
            stderrSnip ? `stderr: ${stderrSnip}` : "",
            executed.length > 1
              ? `Commands executed before failure:\n${executed.slice(0, -1).join("\n")}`
              : "No commands executed before this one.",
          ]
            .filter(Boolean)
            .join("\n"),
        });
        return { findings };
      }
    }

    if (manifest) {
      deleteManifest(harness, spec.id);
    }

    findings.push({
      level: "ok",
      title: `Removed "${spec.title}"`,
      detail: `Ran ${executed.length} command(s):\n${executed.join("\n")}`,
    });
    return { findings };
  }

  if (plan.kind === "guide") {
    findings.push({
      level: "info",
      title: `"${spec.title}" is a guide-only tool — not managed by leanrig`,
      detail: `Leanrig cannot automatically uninstall this tool. Please follow your tool's documentation.`,
    });
    return { findings };
  }

  throw new Error(`Unknown plan kind: ${(plan as { kind: string }).kind}`);
}
