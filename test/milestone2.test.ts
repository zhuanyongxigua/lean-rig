/**
 * Milestone 2 tests:
 * - Profile plan resolution for safe + balanced (no unresolved {{var}}, correct target files)
 * - balanced keeps the premium model as main (sets no top-level model)
 * - Doctor checks with fixtures
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupTmpEnv() {
  const leanrigHome = fs.mkdtempSync(path.join(os.tmpdir(), "lr2-home-"));
  const claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "lr2-config-"));
  const prevLeanrigHome = process.env["LEANRIG_HOME"];
  const prevConfigDir = process.env["CLAUDE_CONFIG_DIR"];
  process.env["LEANRIG_HOME"] = leanrigHome;
  process.env["CLAUDE_CONFIG_DIR"] = claudeConfigDir;
  return {
    leanrigHome,
    claudeConfigDir,
    cleanup() {
      // Restore previous env
      if (prevLeanrigHome === undefined) {
        delete process.env["LEANRIG_HOME"];
      } else {
        process.env["LEANRIG_HOME"] = prevLeanrigHome;
      }
      if (prevConfigDir === undefined) {
        delete process.env["CLAUDE_CONFIG_DIR"];
      } else {
        process.env["CLAUDE_CONFIG_DIR"] = prevConfigDir;
      }
      fs.rmSync(leanrigHome, { recursive: true, force: true });
      fs.rmSync(claudeConfigDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Profile plan resolution
// ---------------------------------------------------------------------------

describe("profile plan resolution — safe + balanced", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => {
    env = setupTmpEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  async function getPlan(profileName: string) {
    // Import adapter fresh (it reads CLAUDE_CONFIG_DIR at call time)
    const { claudeCodeAdapter } = await import("../src/adapters/claude-code/index.js");
    return claudeCodeAdapter.planInstall(profileName, { force: false });
  }

  function assertNoUnresolvedPlaceholders(plan: Awaited<ReturnType<typeof getPlan>>) {
    for (const file of plan.files) {
      expect(
        file.content,
        `Unresolved {{ in ${file.targetAbs}`
      ).not.toMatch(/\{\{/);
    }
    if (plan.settings) {
      const settingsJson = JSON.stringify(plan.settings.merge);
      expect(settingsJson, "Unresolved {{ in settings").not.toMatch(/\{\{/);
    }
  }

  it("safe: resolves without throwing; contains explorer + token-saver targets", async () => {
    const plan = await getPlan("safe");
    const targets = plan.files.map((f) => f.targetAbs);
    expect(targets.some((t) => t.endsWith("agents/leanrig-explorer.md"))).toBe(true);
    expect(targets.some((t) => t.endsWith("output-styles/leanrig-token-saver.md"))).toBe(true);
    assertNoUnresolvedPlaceholders(plan);
  });

  it("balanced: resolves; includes worker, reviewer, delegate, statusline", async () => {
    const plan = await getPlan("balanced");
    const targets = plan.files.map((f) => f.targetAbs);
    expect(targets.some((t) => t.endsWith("agents/leanrig-worker.md"))).toBe(true);
    expect(targets.some((t) => t.endsWith("agents/leanrig-reviewer.md"))).toBe(true);
    expect(targets.some((t) => t.endsWith("skills/leanrig-delegate/SKILL.md"))).toBe(true);
    expect(targets.some((t) => t.endsWith("statusline/leanrig-statusline.sh"))).toBe(true);
    assertNoUnresolvedPlaceholders(plan);
  });

  it("balanced: {{configDir}} resolved to tmp configDir in settings statusLine command", async () => {
    const plan = await getPlan("balanced");
    expect(plan.settings).toBeDefined();
    const settingsJson = JSON.stringify(plan.settings!.merge);
    // Must not contain the literal placeholder
    expect(settingsJson).not.toMatch(/\{\{configDir\}\}/);
    // Must contain the actual configDir path
    expect(settingsJson).toContain(env.claudeConfigDir);
  });

  it("balanced: keeps premium model as main — sets no top-level model", async () => {
    const plan = await getPlan("balanced");
    expect(plan.settings).toBeDefined();
    const merge = plan.settings!.merge as Record<string, unknown>;
    // The whole point of the recommender positioning: premium stays the main
    // coordinator, so balanced must not pin a top-level model.
    expect(merge["model"]).toBeUndefined();
    // env caps and statusLine are still configured, though.
    expect(merge["env"]).toBeDefined();
    expect(merge["statusLine"]).toBeDefined();
  });

  it("balanced: appends a CLAUDE.md delegation block", async () => {
    const plan = await getPlan("balanced");
    expect(plan.claudeMd).toBeDefined();
    expect(plan.claudeMd!.block).toMatch(/leanrig-explorer|delegat/i);
  });
});

// ---------------------------------------------------------------------------
// Doctor checks with fixture configDirs
// ---------------------------------------------------------------------------

describe("doctor checks", () => {
  let env: ReturnType<typeof setupTmpEnv>;
  let originalCwd: string;

  beforeEach(() => {
    env = setupTmpEnv();
    // Clear CLAUDE_CODE_SUBAGENT_MODEL from process.env for tests that don't set it
    delete process.env["CLAUDE_CODE_SUBAGENT_MODEL"];
    // FIX 3: redirect process.cwd() to the tmp config dir so checkClaudeMdSize
    // and checkMcpServerCount do NOT read real project CLAUDE.md or .mcp.json.
    originalCwd = process.cwd();
    process.chdir(env.claudeConfigDir);
  });

  afterEach(() => {
    // Restore cwd before cleanup (rmSync needs to operate on existing paths)
    process.chdir(originalCwd);
    env.cleanup();
    delete process.env["CLAUDE_CODE_SUBAGENT_MODEL"];
  });

  // Import doctorChecks lazily to pick up correct module
  async function getChecks() {
    const { doctorChecks } = await import("../src/adapters/claude-code/doctorChecks.js");
    return doctorChecks;
  }

  async function runAllChecks(configDir: string) {
    const checks = await getChecks();
    const all = [];
    for (const check of checks) {
      const findings = await check(configDir);
      all.push(...findings);
    }
    return all;
  }

  it("CLAUDE.md with 300 lines → warn", async () => {
    // Write a 300-line CLAUDE.md into configDir
    const claudeMdPath = path.join(env.claudeConfigDir, "CLAUDE.md");
    const content = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
    fs.writeFileSync(claudeMdPath, content, "utf8");

    const findings = await runAllChecks(env.claudeConfigDir);
    const warnFindings = findings.filter(
      (f) => f.level === "warn" && f.title.includes("CLAUDE.md")
    );
    expect(warnFindings.length).toBeGreaterThan(0);
    expect(warnFindings[0]!.title).toMatch(/300/);
  });

  it("CLAUDE.md with 100 lines → ok (no warn)", async () => {
    const claudeMdPath = path.join(env.claudeConfigDir, "CLAUDE.md");
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    fs.writeFileSync(claudeMdPath, content, "utf8");

    const findings = await runAllChecks(env.claudeConfigDir);
    const warnFindings = findings.filter(
      (f) => f.level === "warn" && f.title.includes("CLAUDE.md")
    );
    expect(warnFindings.length).toBe(0);
  });

  it("settings.json with CLAUDE_CODE_SUBAGENT_MODEL in env → warn", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
        },
      }),
      "utf8"
    );

    const findings = await runAllChecks(env.claudeConfigDir);
    const warnFindings = findings.filter(
      (f) => f.level === "warn" && f.title.includes("CLAUDE_CODE_SUBAGENT_MODEL")
    );
    expect(warnFindings.length).toBeGreaterThan(0);
  });

  it("process.env CLAUDE_CODE_SUBAGENT_MODEL set → warn", async () => {
    process.env["CLAUDE_CODE_SUBAGENT_MODEL"] = "sonnet";

    const findings = await runAllChecks(env.claudeConfigDir);
    const warnFindings = findings.filter(
      (f) => f.level === "warn" && f.title.includes("CLAUDE_CODE_SUBAGENT_MODEL")
    );
    expect(warnFindings.length).toBeGreaterThan(0);
  });

  it("agents/foo.md with no model: line → warn", async () => {
    const agentsDir = path.join(env.claudeConfigDir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "foo.md"),
      `---\nname: foo\ndescription: test agent\n---\n\nBody text.`,
      "utf8"
    );

    const findings = await runAllChecks(env.claudeConfigDir);
    const warnFindings = findings.filter(
      (f) => f.level === "warn" && f.title.includes("model")
    );
    expect(warnFindings.length).toBeGreaterThan(0);
    expect(warnFindings[0]!.detail).toContain("foo.md");
  });

  it("agents/bar.md WITH model: line → no warn about missing model", async () => {
    const agentsDir = path.join(env.claudeConfigDir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "bar.md"),
      `---\nname: bar\ndescription: test agent\nmodel: haiku\n---\n\nBody text.`,
      "utf8"
    );

    const findings = await runAllChecks(env.claudeConfigDir);
    const warnFindings = findings.filter(
      (f) => f.level === "warn" && f.title.includes("model")
    );
    expect(warnFindings.length).toBe(0);
  });

  it("disableAllHooks true → warn", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ disableAllHooks: true }),
      "utf8"
    );

    const findings = await runAllChecks(env.claudeConfigDir);
    const warnFindings = findings.filter(
      (f) => f.level === "warn" && f.title.includes("disableAllHooks")
    );
    expect(warnFindings.length).toBeGreaterThan(0);
  });

  it("settings.json outputStyle set → info mentioning it", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ outputStyle: "Token Saver" }),
      "utf8"
    );

    const findings = await runAllChecks(env.claudeConfigDir);
    const styleFindings = findings.filter(
      (f) => f.level === "info" && f.title.includes("Token Saver")
    );
    expect(styleFindings.length).toBeGreaterThan(0);
  });

  it("missing settings.json → no throw, returns findings gracefully", async () => {
    // configDir exists but no settings.json
    fs.mkdirSync(env.claudeConfigDir, { recursive: true });

    const checks = await getChecks();
    for (const check of checks) {
      // Should not throw
      await expect(check(env.claudeConfigDir)).resolves.toBeDefined();
    }
  });
});
