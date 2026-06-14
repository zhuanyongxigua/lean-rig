import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  runInstall,
  runRollback,
  CLAUDE_MD_START,
  CLAUDE_MD_END,
  type InstallPlan,
} from "../src/core/installer.js";

function setupTmpEnv() {
  const leanrigHome = fs.mkdtempSync(path.join(os.tmpdir(), "leanrig-cmd-home-"));
  const claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "leanrig-cmd-config-"));
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

const BLOCK = "Delegate routine work to leanrig-* subagents.";

function makePlan(configDir: string): InstallPlan {
  return {
    harness: "test-harness",
    profile: "test-profile",
    configDir,
    files: [],
    claudeMd: { fileAbs: path.join(configDir, "CLAUDE.md"), block: BLOCK },
  };
}

describe("CLAUDE.md append + rollback", () => {
  let env: ReturnType<typeof setupTmpEnv>;
  let claudeMd: string;

  beforeEach(() => {
    env = setupTmpEnv();
    claudeMd = path.join(env.claudeConfigDir, "CLAUDE.md");
  });
  afterEach(() => env.cleanup());

  it("appends a marked block to an existing CLAUDE.md without touching prior content", async () => {
    const original = "# My project\n\nMy own house rules.\n";
    fs.writeFileSync(claudeMd, original, "utf8");

    await runInstall(makePlan(env.claudeConfigDir), { dryRun: false, force: false });

    const after = fs.readFileSync(claudeMd, "utf8");
    expect(after).toContain("My own house rules.");
    expect(after.startsWith(original.trimEnd())).toBe(true);
    expect(after).toContain(CLAUDE_MD_START);
    expect(after).toContain(CLAUDE_MD_END);
    expect(after).toContain(BLOCK);
  });

  it("rollback removes only the block and restores the original content", async () => {
    const original = "# My project\n\nMy own house rules.\n";
    fs.writeFileSync(claudeMd, original, "utf8");

    await runInstall(makePlan(env.claudeConfigDir), { dryRun: false, force: false });
    await runRollback("test-harness", { force: false });

    const after = fs.readFileSync(claudeMd, "utf8");
    expect(after).not.toContain(CLAUDE_MD_START);
    expect(after).not.toContain(BLOCK);
    expect(after).toContain("My own house rules.");
    expect(after.trim()).toBe(original.trim());
  });

  it("creates CLAUDE.md when absent and deletes it on rollback", async () => {
    expect(fs.existsSync(claudeMd)).toBe(false);

    await runInstall(makePlan(env.claudeConfigDir), { dryRun: false, force: false });
    expect(fs.existsSync(claudeMd)).toBe(true);
    expect(fs.readFileSync(claudeMd, "utf8")).toContain(BLOCK);

    await runRollback("test-harness", { force: false });
    expect(fs.existsSync(claudeMd)).toBe(false);
  });

  it("is idempotent: re-install does not append the block twice (no-op)", async () => {
    await runInstall(makePlan(env.claudeConfigDir), { dryRun: false, force: false });
    const firstPass = fs.readFileSync(claudeMd, "utf8");

    const result = await runInstall(makePlan(env.claudeConfigDir), { dryRun: false, force: false });

    expect(result.noOp).toBe(true);
    expect(fs.readFileSync(claudeMd, "utf8")).toBe(firstPass);
    const occurrences = firstPass.split(CLAUDE_MD_START).length - 1;
    expect(occurrences).toBe(1);
  });

  it("surgical rollback preserves user content added AFTER the block", async () => {
    fs.writeFileSync(claudeMd, "# Before leanrig\n", "utf8");
    await runInstall(makePlan(env.claudeConfigDir), { dryRun: false, force: false });

    // User appends their own notes after leanrig's block.
    fs.appendFileSync(claudeMd, "\n## My later notes\nkeep me\n", "utf8");

    await runRollback("test-harness", { force: false });

    const after = fs.readFileSync(claudeMd, "utf8");
    expect(after).not.toContain(CLAUDE_MD_START);
    expect(after).not.toContain(BLOCK);
    expect(after).toContain("# Before leanrig");
    expect(after).toContain("My later notes");
    expect(after).toContain("keep me");
  });
});
