import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { CommandRunner } from "../src/core/tools.js";
import { detectTool, toolRegistry } from "../src/adapters/claude-code/toolRegistry.js";
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

// Fake runner that always returns code 1 (no external processes spawned)
const noopRunner: CommandRunner = {
  run: () => ({ code: 1, stdout: "", stderr: "" }),
};

// ============================================================
// 0. Registry shape: guide-only recommender, never an installer
// ============================================================
describe("tool registry shape", () => {
  it("every tool has metadata + an official install string (no exec plan)", () => {
    expect(toolRegistry.length).toBeGreaterThan(0);
    for (const spec of toolRegistry) {
      expect(spec.id).toBeTruthy();
      expect(spec.title).toBeTruthy();
      expect(spec.description).toBeTruthy();
      expect(spec.license).toBeTruthy();
      expect(spec.source).toMatch(/^https?:\/\//);
      // Recommender contract: install instructions are plain text to show the
      // user, never a structured plan leanrig would execute.
      expect(typeof spec.install).toBe("string");
      expect(spec.install.length).toBeGreaterThan(0);
      expect(spec).not.toHaveProperty("kind");
    }
  });
});

// ============================================================
// 1. detectTool: read-only file-system / settings checks
// ============================================================
describe("detectTool: file-system checks", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => { env = setupTmpEnv(); });
  afterEach(() => { env.cleanup(); });

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
// 2. doctor check: third-party detection + overlap warnings
// ============================================================
describe("doctor: third-party tool check", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => { env = setupTmpEnv(); });
  afterEach(() => { env.cleanup(); });

  // The third-party tool check is the last one in the array
  const thirdPartyCheck = doctorChecks[doctorChecks.length - 1]!;

  it("squeez + BASH_MAX_OUTPUT_LENGTH → overlap info finding", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      env: { BASH_MAX_OUTPUT_LENGTH: "20000" },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/path/squeez/bin/squeez" }] }] },
    }, null, 2), "utf8");

    const findings = await thirdPartyCheck(env.claudeConfigDir);

    const squeezFinding = findings.find((f) => f.title.includes("squeez"));
    expect(squeezFinding).toBeDefined();

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
