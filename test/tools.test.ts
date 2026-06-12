import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { runAddTool, runRemoveTool } from "../src/core/tools.js";
import type { CommandRunner, ToolRunOptions } from "../src/core/tools.js";
import type { ToolSpec, ToolPlan } from "../src/adapters/toolTypes.js";
import { detectTool } from "../src/adapters/claude-code/toolRegistry.js";
import { doctorChecks } from "../src/adapters/claude-code/doctorChecks.js";

// ---------------------------------------------------------------------------
// Tmp environment setup (identical pattern to installer.test.ts)
// ---------------------------------------------------------------------------

function setupTmpEnv() {
  const leanrigHome = fs.mkdtempSync(path.join(os.tmpdir(), "leanrig-tools-home-"));
  const claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "leanrig-tools-config-"));
  process.env["LEANRIG_HOME"] = leanrigHome;
  process.env["CLAUDE_CONFIG_DIR"] = claudeConfigDir;
  return {
    leanrigHome,
    claudeConfigDir,
    cleanup() {
      delete process.env["LEANRIG_HOME"];
      delete process.env["CLAUDE_CONFIG_DIR"];
      fs.rmSync(leanrigHome, { recursive: true, force: true });
      fs.rmSync(claudeConfigDir, { recursive: true, force: true });
    },
  };
}

function listDirRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d)) {
      const full = path.join(d, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else results.push(full);
    }
  }
  walk(dir);
  return results.sort();
}

// ---------------------------------------------------------------------------
// Fake CommandRunner
// ---------------------------------------------------------------------------

interface FakeCall {
  argv: string[];
  code: number;
  stdout: string;
  stderr: string;
}

function makeFakeRunner(responses: Array<{ argv?: string[]; code: number; stdout?: string; stderr?: string }>): {
  runner: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  let idx = 0;
  const runner: CommandRunner = {
    run(argv: string[]) {
      calls.push(argv);
      const resp = responses[idx++] ?? { code: 0, stdout: "", stderr: "" };
      return {
        code: resp.code,
        stdout: resp.stdout ?? "",
        stderr: resp.stderr ?? "",
      };
    },
  };
  return { runner, calls };
}

// ---------------------------------------------------------------------------
// Common fixture helpers
// ---------------------------------------------------------------------------

const HARNESS = "test-harness";

function makeSettingsSpec(): ToolSpec {
  return {
    id: "ccusage-statusline",
    title: "ccusage statusline",
    description: "Shows cost in statusline",
    license: "MIT",
    source: "https://ccusage.com",
    kind: "settings",
  };
}

function makeExternalSpec(): ToolSpec {
  return {
    id: "squeez",
    title: "squeez",
    description: "Compresses Bash output",
    license: "Apache-2.0",
    source: "https://github.com/squeez/squeez",
    kind: "external",
  };
}

function makeGuideSpec(): ToolSpec {
  return {
    id: "lean-ctx",
    title: "lean-ctx",
    description: "Context injection tool",
    license: "Apache-2.0",
    source: "https://github.com/yvgude/lean-ctx",
    kind: "guide",
  };
}

// ============================================================
// 1. settings-kind add: correct merge, manifest with previous, backup
// ============================================================
describe("settings-kind add", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => { env = setupTmpEnv(); });
  afterEach(() => { env.cleanup(); });

  it("merges settings.json and records previous (absent case)", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    const plan: ToolPlan = {
      kind: "settings",
      settingsPath,
      merge: { statusLine: { type: "command", command: "npx -y ccusage statusline", padding: 0 } },
    };
    const spec = makeSettingsSpec();
    const opts: ToolRunOptions = { dryRun: false, force: false };

    const result = await runAddTool(HARNESS, plan, spec, opts);

    // Settings file should exist and contain merged keys
    expect(fs.existsSync(settingsPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(written.statusLine.command).toBe("npx -y ccusage statusline");
    expect(written.statusLine.type).toBe("command");
    expect(written.statusLine.padding).toBe(0);

    // Manifest should exist
    const manifestPath = path.join(env.leanrigHome, "tools", HARNESS, `${spec.id}.json`);
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.kind).toBe("settings");
    expect(manifest.toolId).toBe(spec.id);

    // Keys should record { absent: true } for previously absent keys
    const commandKey = manifest.keys.find((k: { path: string }) => k.path === "statusLine.command");
    expect(commandKey).toBeDefined();
    expect(commandKey.previous).toEqual({ absent: true });
    expect(commandKey.written).toBe("npx -y ccusage statusline");

    // Backup should exist
    const backupPath = path.join(env.leanrigHome, "tools", HARNESS, manifest.settingsBackupRelPath);
    expect(fs.existsSync(backupPath)).toBe(true);

    // Result should have ok finding
    expect(result.findings.some((f) => f.level === "ok")).toBe(true);
  });

  it("records previous value when statusLine already exists", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    const existing = {
      statusLine: { type: "command", command: "/usr/local/bin/my-statusline.sh", padding: 2 },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), "utf8");

    const plan: ToolPlan = {
      kind: "settings",
      settingsPath,
      merge: { statusLine: { type: "command", command: "npx -y ccusage statusline", padding: 0 } },
    };
    const spec = makeSettingsSpec();
    await runAddTool(HARNESS, plan, spec, { dryRun: false, force: false });

    const manifestPath = path.join(env.leanrigHome, "tools", HARNESS, `${spec.id}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    const commandKey = manifest.keys.find((k: { path: string }) => k.path === "statusLine.command");
    expect(commandKey.previous).toBe("/usr/local/bin/my-statusline.sh");
    expect(commandKey.written).toBe("npx -y ccusage statusline");

    const paddingKey = manifest.keys.find((k: { path: string }) => k.path === "statusLine.padding");
    expect(paddingKey.previous).toBe(2);
    expect(paddingKey.written).toBe(0);
  });
});

// ============================================================
// 2. settings-kind: remove restores original statusLine
// ============================================================
describe("settings-kind add then remove: restore original statusLine", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => { env = setupTmpEnv(); });
  afterEach(() => { env.cleanup(); });

  it("remove restores the original statusLine value", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    const originalSettings = {
      statusLine: { type: "command", command: "/my-old-statusline.sh", padding: 1 },
      otherKey: "preserved",
    };
    fs.writeFileSync(settingsPath, JSON.stringify(originalSettings, null, 2), "utf8");

    const plan: ToolPlan = {
      kind: "settings",
      settingsPath,
      merge: { statusLine: { type: "command", command: "npx -y ccusage statusline", padding: 0 } },
    };
    const spec = makeSettingsSpec();
    await runAddTool(HARNESS, plan, spec, { dryRun: false, force: false });

    // Verify it was merged
    const afterAdd = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(afterAdd.statusLine.command).toBe("npx -y ccusage statusline");

    // Now remove
    await runRemoveTool(HARNESS, plan, spec, { dryRun: false, force: false });

    const afterRemove = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(afterRemove.statusLine.command).toBe("/my-old-statusline.sh");
    expect(afterRemove.statusLine.padding).toBe(1);
    expect(afterRemove.otherKey).toBe("preserved");

    // Manifest should be deleted
    const manifestPath = path.join(env.leanrigHome, "tools", HARNESS, `${spec.id}.json`);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });
});

// ============================================================
// 3. settings-kind remove: absent key deleted, empty parent cleaned
// ============================================================
describe("settings-kind remove: absent key cleanup", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => { env = setupTmpEnv(); });
  afterEach(() => { env.cleanup(); });

  it("removes the key and prunes empty parent when key was absent before add", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    // Settings with only unrelated keys
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { BASH_MAX_OUTPUT_LENGTH: "20000" } }, null, 2), "utf8");

    const plan: ToolPlan = {
      kind: "settings",
      settingsPath,
      merge: { statusLine: { type: "command", command: "npx -y ccusage statusline", padding: 0 } },
    };
    const spec = makeSettingsSpec();
    await runAddTool(HARNESS, plan, spec, { dryRun: false, force: false });

    const afterAdd = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(afterAdd.statusLine).toBeDefined();

    await runRemoveTool(HARNESS, plan, spec, { dryRun: false, force: false });

    const afterRemove = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    // statusLine should be gone (was absent before); empty parent pruned
    expect(afterRemove.statusLine).toBeUndefined();
    // Unrelated key preserved
    expect(afterRemove.env?.BASH_MAX_OUTPUT_LENGTH).toBe("20000");
  });
});

// ============================================================
// 4. User modified key → skip+warn; --force bypasses
// ============================================================
describe("settings-kind remove: user-modified key", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => { env = setupTmpEnv(); });
  afterEach(() => { env.cleanup(); });

  it("skip+warn when user changed the written value; manifest kept", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    const plan: ToolPlan = {
      kind: "settings",
      settingsPath,
      merge: { statusLine: { type: "command", command: "npx -y ccusage statusline", padding: 0 } },
    };
    const spec = makeSettingsSpec();
    await runAddTool(HARNESS, plan, spec, { dryRun: false, force: false });

    // User modifies the command
    const current = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    current.statusLine.command = "/user-changed-this.sh";
    fs.writeFileSync(settingsPath, JSON.stringify(current, null, 2), "utf8");

    const result = await runRemoveTool(HARNESS, plan, spec, { dryRun: false, force: false });

    // Should have warn findings
    const warns = result.findings.filter((f) => f.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.some((f) => f.title.includes("Skipping key"))).toBe(true);

    // Manifest should still exist
    const manifestPath = path.join(env.leanrigHome, "tools", HARNESS, `${spec.id}.json`);
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  it("--force removes key even when user changed it; manifest deleted", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    const plan: ToolPlan = {
      kind: "settings",
      settingsPath,
      merge: { statusLine: { type: "command", command: "npx -y ccusage statusline", padding: 0 } },
    };
    const spec = makeSettingsSpec();
    await runAddTool(HARNESS, plan, spec, { dryRun: false, force: false });

    // User modifies the command
    const current = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    current.statusLine.command = "/user-changed-this.sh";
    fs.writeFileSync(settingsPath, JSON.stringify(current, null, 2), "utf8");

    const result = await runRemoveTool(HARNESS, plan, spec, { dryRun: false, force: true });

    // Should succeed
    const oks = result.findings.filter((f) => f.level === "ok");
    expect(oks.length).toBeGreaterThan(0);

    // Manifest should be deleted
    const manifestPath = path.join(env.leanrigHome, "tools", HARNESS, `${spec.id}.json`);
    expect(fs.existsSync(manifestPath)).toBe(false);

    // statusLine should be absent (was absent before add)
    const afterRemove = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(afterRemove.statusLine).toBeUndefined();
  });
});

// ============================================================
// 5. Duplicate add → error
// ============================================================
describe("duplicate add", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => { env = setupTmpEnv(); });
  afterEach(() => { env.cleanup(); });

  it("second add of same tool throws 'already added'", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    const plan: ToolPlan = {
      kind: "settings",
      settingsPath,
      merge: { statusLine: { type: "command", command: "npx -y ccusage statusline", padding: 0 } },
    };
    const spec = makeSettingsSpec();
    await runAddTool(HARNESS, plan, spec, { dryRun: false, force: false });

    await expect(
      runAddTool(HARNESS, plan, spec, { dryRun: false, force: false })
    ).rejects.toThrow(/already added/);
  });
});

// ============================================================
// 6. dry-run: zero filesystem changes (both add and remove)
// ============================================================
describe("dry-run writes nothing", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => { env = setupTmpEnv(); });
  afterEach(() => { env.cleanup(); });

  it("dry-run add: no files written anywhere", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    const plan: ToolPlan = {
      kind: "settings",
      settingsPath,
      merge: { statusLine: { type: "command", command: "npx -y ccusage statusline", padding: 0 } },
    };
    const spec = makeSettingsSpec();

    const leanrigBefore = listDirRecursive(env.leanrigHome);
    const claudeBefore = listDirRecursive(env.claudeConfigDir);

    await runAddTool(HARNESS, plan, spec, { dryRun: true, force: false });

    const leanrigAfter = listDirRecursive(env.leanrigHome);
    const claudeAfter = listDirRecursive(env.claudeConfigDir);

    expect(leanrigAfter).toEqual(leanrigBefore);
    expect(claudeAfter).toEqual(claudeBefore);
  });

  it("dry-run remove (settings-kind): no files modified", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    const plan: ToolPlan = {
      kind: "settings",
      settingsPath,
      merge: { statusLine: { type: "command", command: "npx -y ccusage statusline", padding: 0 } },
    };
    const spec = makeSettingsSpec();

    // First do a real add so there is a manifest
    await runAddTool(HARNESS, plan, spec, { dryRun: false, force: false });

    const leanrigBefore = listDirRecursive(env.leanrigHome);
    const claudeBefore = listDirRecursive(env.claudeConfigDir);
    const settingsBefore = fs.readFileSync(settingsPath, "utf8");

    await runRemoveTool(HARNESS, plan, spec, { dryRun: true, force: false });

    const leanrigAfter = listDirRecursive(env.leanrigHome);
    const claudeAfter = listDirRecursive(env.claudeConfigDir);
    const settingsAfter = fs.readFileSync(settingsPath, "utf8");

    expect(leanrigAfter).toEqual(leanrigBefore);
    expect(claudeAfter).toEqual(claudeBefore);
    expect(settingsAfter).toEqual(settingsBefore);
  });

  it("dry-run add (external-kind): no commands run, no files written", async () => {
    const { runner, calls } = makeFakeRunner([]);
    const plan: ToolPlan = {
      kind: "external",
      requires: "npm",
      commands: [["npm", "install", "-g", "squeez"], ["squeez", "setup", "--host=claude-code"]],
    };
    const spec = makeExternalSpec();

    const leanrigBefore = listDirRecursive(env.leanrigHome);

    await runAddTool(HARNESS, plan, spec, { dryRun: true, force: false, runner });

    expect(calls).toHaveLength(0);
    expect(listDirRecursive(env.leanrigHome)).toEqual(leanrigBefore);
  });
});

// ============================================================
// 7. external add: correct argv sequence; non-zero stops and reports
// ============================================================
describe("external add", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => { env = setupTmpEnv(); });
  afterEach(() => { env.cleanup(); });

  it("fake runner receives the exact argv sequence from registry", async () => {
    const { runner, calls } = makeFakeRunner([
      { code: 0 }, // requires check: npm --version
      { code: 0 }, // npm install -g squeez
      { code: 0 }, // squeez setup --host=claude-code
    ]);
    const plan: ToolPlan = {
      kind: "external",
      requires: "npm",
      commands: [
        ["npm", "install", "-g", "squeez"],
        ["squeez", "setup", "--host=claude-code"],
      ],
    };
    const spec = makeExternalSpec();

    await runAddTool(HARNESS, plan, spec, { dryRun: false, force: false, runner });

    expect(calls[0]).toEqual(["npm", "--version"]);
    expect(calls[1]).toEqual(["npm", "install", "-g", "squeez"]);
    expect(calls[2]).toEqual(["squeez", "setup", "--host=claude-code"]);
    expect(calls).toHaveLength(3);

    // Manifest written
    const manifestPath = path.join(env.leanrigHome, "tools", HARNESS, `${spec.id}.json`);
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  it("caveman: correct argv sequence", async () => {
    const { runner, calls } = makeFakeRunner([
      { code: 0 }, // requires claude --version
      { code: 0 }, // claude plugin marketplace add ...
      { code: 0 }, // claude plugin install caveman@caveman
    ]);
    const cavemanSpec: ToolSpec = {
      id: "caveman",
      title: "Caveman",
      description: "Logs Bash commands",
      license: "MIT",
      source: "https://github.com/JuliusBrussee/caveman",
      kind: "external",
    };
    const plan: ToolPlan = {
      kind: "external",
      requires: "claude",
      commands: [
        ["claude", "plugin", "marketplace", "add", "JuliusBrussee/caveman"],
        ["claude", "plugin", "install", "caveman@caveman"],
      ],
    };

    await runAddTool(HARNESS, plan, cavemanSpec, { dryRun: false, force: false, runner });

    expect(calls[0]).toEqual(["claude", "--version"]);
    expect(calls[1]).toEqual(["claude", "plugin", "marketplace", "add", "JuliusBrussee/caveman"]);
    expect(calls[2]).toEqual(["claude", "plugin", "install", "caveman@caveman"]);
  });

  it("non-zero exit code stops execution and reports stderr", async () => {
    const { runner, calls } = makeFakeRunner([
      { code: 0 },  // requires npm --version
      { code: 1, stderr: "npm ERR! something went wrong" }, // npm install fails
      { code: 0 },  // squeez setup — should NOT be called
    ]);
    const plan: ToolPlan = {
      kind: "external",
      requires: "npm",
      commands: [
        ["npm", "install", "-g", "squeez"],
        ["squeez", "setup", "--host=claude-code"],
      ],
    };
    const spec = makeExternalSpec();

    const result = await runAddTool(HARNESS, plan, spec, { dryRun: false, force: false, runner });

    // Only 2 calls: requires check + first command
    expect(calls).toHaveLength(2);

    // Should have warn finding
    const warns = result.findings.filter((f) => f.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]!.detail).toContain("npm ERR! something went wrong");

    // No manifest written
    const manifestPath = path.join(env.leanrigHome, "tools", HARNESS, `${spec.id}.json`);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });
});

// ============================================================
// 8. external add: requires probe failure stops everything
// ============================================================
describe("external add: requires probe failure", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => { env = setupTmpEnv(); });
  afterEach(() => { env.cleanup(); });

  it("throws if requires binary is missing; no install commands run", async () => {
    const { runner, calls } = makeFakeRunner([
      { code: 1, stderr: "command not found: npm" }, // npm --version fails
    ]);
    const plan: ToolPlan = {
      kind: "external",
      requires: "npm",
      commands: [
        ["npm", "install", "-g", "squeez"],
        ["squeez", "setup", "--host=claude-code"],
      ],
    };
    const spec = makeExternalSpec();

    await expect(
      runAddTool(HARNESS, plan, spec, { dryRun: false, force: false, runner })
    ).rejects.toThrow(/not found/);

    // Only the requires probe was called
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["npm", "--version"]);
  });
});

// ============================================================
// 9. guide add: only info findings, no writes
// ============================================================
describe("guide add", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => { env = setupTmpEnv(); });
  afterEach(() => { env.cleanup(); });

  it("produces info findings and writes nothing", async () => {
    const plan: ToolPlan = {
      kind: "guide",
      instructions: "brew tap yvgude/lean-ctx && brew install lean-ctx",
    };
    const spec = makeGuideSpec();

    const leanrigBefore = listDirRecursive(env.leanrigHome);
    const claudeBefore = listDirRecursive(env.claudeConfigDir);

    const result = await runAddTool(HARNESS, plan, spec, { dryRun: false, force: false });

    expect(listDirRecursive(env.leanrigHome)).toEqual(leanrigBefore);
    expect(listDirRecursive(env.claudeConfigDir)).toEqual(claudeBefore);

    const infos = result.findings.filter((f) => f.level === "info");
    expect(infos.length).toBeGreaterThan(0);
    expect(infos[0]!.detail).toContain("lean-ctx");
  });
});

// ============================================================
// 10. detectTool: file-system checks (ccusage-statusline, squeez)
// ============================================================
describe("detectTool: file-system checks", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => { env = setupTmpEnv(); });
  afterEach(() => { env.cleanup(); });

  // Fake runner that always returns code 1 (no external processes)
  const noopRunner: CommandRunner = {
    run: () => ({ code: 1, stdout: "", stderr: "" }),
  };

  it("ccusage-statusline: detected when statusLine.command contains 'ccusage'", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: "command", command: "npx -y ccusage statusline", padding: 0 },
    }, null, 2), "utf8");

    const status = await detectTool("ccusage-statusline", noopRunner);
    expect(status.installed).toBe(true);
  });

  it("ccusage-statusline: not detected when statusLine.command does not contain 'ccusage'", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: "command", command: "/my-statusline.sh", padding: 0 },
    }, null, 2), "utf8");

    const status = await detectTool("ccusage-statusline", noopRunner);
    expect(status.installed).toBe(false);
  });

  it("ccusage-statusline: not detected when settings.json does not exist", async () => {
    const status = await detectTool("ccusage-statusline", noopRunner);
    expect(status.installed).toBe(false);
  });

  it("squeez: detected via binary path", async () => {
    const binPath = path.join(env.claudeConfigDir, "squeez", "bin", "squeez");
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "#!/bin/sh\n", "utf8");

    const status = await detectTool("squeez", noopRunner);
    expect(status.installed).toBe(true);
    expect(status.detail).toContain("binary found");
  });

  it("squeez: detected via settings.json containing 'squeez'", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/squeez/bin/squeez" }] }] },
    }, null, 2), "utf8");

    const status = await detectTool("squeez", noopRunner);
    expect(status.installed).toBe(true);
  });

  it("squeez: not detected when neither binary nor settings reference present", async () => {
    const status = await detectTool("squeez", noopRunner);
    expect(status.installed).toBe(false);
  });
});

// ============================================================
// 11. doctor check: squeez + BASH_MAX_OUTPUT_LENGTH overlap
// ============================================================
describe("doctor: third-party tool check", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => { env = setupTmpEnv(); });
  afterEach(() => { env.cleanup(); });

  // The third-party tool check is the last one (index 9)
  const thirdPartyCheck = doctorChecks[doctorChecks.length - 1]!;

  it("squeez + BASH_MAX_OUTPUT_LENGTH → overlap info finding", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    // Simulate squeez detected via settings AND BASH_MAX_OUTPUT_LENGTH set
    fs.writeFileSync(settingsPath, JSON.stringify({
      env: { BASH_MAX_OUTPUT_LENGTH: "20000" },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/path/squeez/bin/squeez" }] }] },
    }, null, 2), "utf8");

    const findings = await thirdPartyCheck(env.claudeConfigDir);

    // Should detect squeez
    const squeezFinding = findings.find((f) => f.title.includes("squeez"));
    expect(squeezFinding).toBeDefined();

    // Should note the overlap
    const overlapFinding = findings.find((f) => f.title.includes("BASH_MAX_OUTPUT_LENGTH"));
    expect(overlapFinding).toBeDefined();
    expect(overlapFinding!.level).toBe("info");
  });

  it("ccusage-statusline detected → info finding", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: "command", command: "npx -y ccusage statusline", padding: 0 },
    }, null, 2), "utf8");

    const findings = await thirdPartyCheck(env.claudeConfigDir);

    const ccusageFinding = findings.find((f) => f.title.includes("ccusage"));
    expect(ccusageFinding).toBeDefined();
    expect(ccusageFinding!.level).toBe("info");
  });

  it("no tools detected → empty findings", async () => {
    const findings = await thirdPartyCheck(env.claudeConfigDir);
    expect(findings).toHaveLength(0);
  });

  it("caveman via installed_plugins.json + outputStyle → overlap info finding", async () => {
    const pluginsDir = path.join(env.claudeConfigDir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "caveman@caveman": [{ scope: "user" }] } }, null, 2),
      "utf8"
    );
    fs.writeFileSync(
      path.join(env.claudeConfigDir, "settings.json"),
      JSON.stringify({ outputStyle: "Token Saver" }, null, 2),
      "utf8"
    );

    const findings = await thirdPartyCheck(env.claudeConfigDir);

    const cavemanFinding = findings.find((f) => f.title.includes("Caveman"));
    expect(cavemanFinding).toBeDefined();
    expect(cavemanFinding!.level).toBe("info");

    const overlapFinding = findings.find((f) => f.title.includes("output style"));
    expect(overlapFinding).toBeDefined();
    expect(overlapFinding!.level).toBe("info");
  });

  it("caveman without outputStyle → detection but no overlap finding", async () => {
    const pluginsDir = path.join(env.claudeConfigDir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "caveman@caveman": [{ scope: "user" }] } }, null, 2),
      "utf8"
    );

    const findings = await thirdPartyCheck(env.claudeConfigDir);

    expect(findings.find((f) => f.title.includes("Caveman"))).toBeDefined();
    expect(findings.find((f) => f.title.includes("output style"))).toBeUndefined();
  });
});

// ============================================================
// 12. external remove: correct argv; manifest deleted on success
// ============================================================
describe("external remove", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => { env = setupTmpEnv(); });
  afterEach(() => { env.cleanup(); });

  it("runs remove commands and deletes manifest", async () => {
    const addPlan: ToolPlan = {
      kind: "external",
      requires: "npm",
      commands: [
        ["npm", "install", "-g", "squeez"],
        ["squeez", "setup", "--host=claude-code"],
      ],
    };
    const removePlan: ToolPlan = {
      kind: "external",
      requires: "npm",
      commands: [["squeez", "uninstall", "--host=claude-code"]],
    };
    const spec = makeExternalSpec();

    // Add first
    const { runner: addRunner } = makeFakeRunner([
      { code: 0 }, { code: 0 }, { code: 0 },
    ]);
    await runAddTool(HARNESS, addPlan, spec, { dryRun: false, force: false, runner: addRunner });

    // Now remove
    const { runner: removeRunner, calls: removeCalls } = makeFakeRunner([
      { code: 0 }, // squeez uninstall
    ]);
    const result = await runRemoveTool(HARNESS, removePlan, spec, { dryRun: false, force: false, runner: removeRunner });

    expect(removeCalls[0]).toEqual(["squeez", "uninstall", "--host=claude-code"]);
    expect(result.findings.some((f) => f.level === "ok")).toBe(true);

    // Manifest deleted
    const manifestPath = path.join(env.leanrigHome, "tools", HARNESS, `${spec.id}.json`);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });
});
