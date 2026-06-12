import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { runInstall, runRollback, type InstallPlan } from "../src/core/installer.js";
import { readState } from "../src/core/state.js";

/**
 * Helper: create a tmp dir, set env vars, return cleanup fn.
 */
function setupTmpEnv() {
  const leanrigHome = fs.mkdtempSync(path.join(os.tmpdir(), "leanrig-test-home-"));
  const claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "leanrig-test-config-"));
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

function makePlan(
  configDir: string,
  overrides: Partial<InstallPlan> = {}
): InstallPlan {
  return {
    harness: "test-harness",
    profile: "test-profile",
    configDir,
    files: [
      {
        assetId: "file-a",
        targetAbs: path.join(configDir, "agents", "leanrig-test.md"),
        content: "# Hello\nThis is test content.\n",
      },
    ],
    ...overrides,
  };
}

// ============================================================
// Install -> Rollback roundtrip
// ============================================================
describe("install -> rollback roundtrip", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => {
    env = setupTmpEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("created files are removed on rollback", async () => {
    const plan = makePlan(env.claudeConfigDir);
    const target = plan.files[0]!.targetAbs;

    await runInstall(plan, { dryRun: false, force: false });
    expect(fs.existsSync(target)).toBe(true);

    await runRollback("test-harness", { force: false });
    expect(fs.existsSync(target)).toBe(false);
  });

  it("pre-existing files are restored byte-exact after rollback", async () => {
    const target = path.join(env.claudeConfigDir, "agents", "leanrig-test.md");
    const originalContent = "# Original\nSome existing content.\n";
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, originalContent, "utf8");

    const plan = makePlan(env.claudeConfigDir);
    await runInstall(plan, { dryRun: false, force: true }); // force to overwrite
    expect(fs.readFileSync(target, "utf8")).toBe(plan.files[0]!.content);

    await runRollback("test-harness", { force: false });
    expect(fs.readFileSync(target, "utf8")).toBe(originalContent);
  });

  it("settings.json: pre-existing user keys preserved, added keys rolled back", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    const originalSettings = { userKey: "userValue", nested: { a: 1 } };
    fs.writeFileSync(settingsPath, JSON.stringify(originalSettings, null, 2) + "\n", "utf8");

    const plan = makePlan(env.claudeConfigDir, {
      settings: {
        fileAbs: settingsPath,
        merge: { leanrigKey: "leanrigValue" },
      },
    });

    await runInstall(plan, { dryRun: false, force: false });
    const merged = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(merged.userKey).toBe("userValue");
    expect(merged.leanrigKey).toBe("leanrigValue");

    await runRollback("test-harness", { force: false });
    const restored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(restored).toEqual(originalSettings);
    expect(restored.leanrigKey).toBeUndefined();
  });

  it("settings file created by install is deleted on rollback when it did not exist before", async () => {
    const settingsPath = path.join(env.claudeConfigDir, "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(false);

    const plan = makePlan(env.claudeConfigDir, {
      settings: {
        fileAbs: settingsPath,
        merge: { leanrigKey: "value" },
      },
    });

    await runInstall(plan, { dryRun: false, force: false });
    expect(fs.existsSync(settingsPath)).toBe(true);

    await runRollback("test-harness", { force: false });
    expect(fs.existsSync(settingsPath)).toBe(false);
  });
});

// ============================================================
// Collision policy
// ============================================================
describe("collision policy", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => {
    env = setupTmpEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("skips existing different file without --force", async () => {
    const target = path.join(env.claudeConfigDir, "agents", "leanrig-test.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "# Different content\n", "utf8");

    const plan = makePlan(env.claudeConfigDir);
    const result = await runInstall(plan, { dryRun: false, force: false });

    // File should remain unchanged
    expect(fs.readFileSync(target, "utf8")).toBe("# Different content\n");
    // Should have a warn finding about skipping
    const warnFindings = result.findings.filter((f) => f.level === "warn");
    expect(warnFindings.length).toBeGreaterThan(0);
  });

  it("overwrites and backs up with --force", async () => {
    const target = path.join(env.claudeConfigDir, "agents", "leanrig-test.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "# Different content\n", "utf8");

    const plan = makePlan(env.claudeConfigDir);
    await runInstall(plan, { dryRun: false, force: true });

    expect(fs.readFileSync(target, "utf8")).toBe(plan.files[0]!.content);
  });

  it("identical content is reported as unchanged, not a collision", async () => {
    const plan = makePlan(env.claudeConfigDir);
    const target = plan.files[0]!.targetAbs;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Write same content as the plan
    fs.writeFileSync(target, plan.files[0]!.content, "utf8");

    const result = await runInstall(plan, { dryRun: false, force: false });
    const warnFindings = result.findings.filter((f) => f.level === "warn");
    // No collision warning — content is identical
    const collisionWarns = warnFindings.filter((f) =>
      f.title.toLowerCase().includes("collision") || f.title.toLowerCase().includes("skip")
    );
    expect(collisionWarns.length).toBe(0);
  });
});

// ============================================================
// User-edit detection
// ============================================================
describe("user-edit detection on rollback", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => {
    env = setupTmpEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("rollback without --force refuses user-edited file", async () => {
    const plan = makePlan(env.claudeConfigDir);
    const target = plan.files[0]!.targetAbs;

    await runInstall(plan, { dryRun: false, force: false });
    // User edits the file
    fs.writeFileSync(target, "# User edited this!\n", "utf8");

    const result = await runRollback("test-harness", { force: false });
    // File should NOT be restored
    expect(fs.readFileSync(target, "utf8")).toBe("# User edited this!\n");
    const warnFindings = result.findings.filter((f) => f.level === "warn");
    expect(warnFindings.length).toBeGreaterThan(0);
  });

  it("rollback with --force restores user-edited file", async () => {
    const plan = makePlan(env.claudeConfigDir);
    const target = plan.files[0]!.targetAbs;

    await runInstall(plan, { dryRun: false, force: false });
    fs.writeFileSync(target, "# User edited this!\n", "utf8");

    await runRollback("test-harness", { force: true });
    // File should be deleted (existed-before: false)
    expect(fs.existsSync(target)).toBe(false);
  });

  it("multiple files: edited file skipped, unedited file restored", async () => {
    const targetA = path.join(env.claudeConfigDir, "agents", "leanrig-a.md");
    const targetB = path.join(env.claudeConfigDir, "agents", "leanrig-b.md");

    const plan: InstallPlan = {
      harness: "test-harness",
      profile: "test-profile",
      configDir: env.claudeConfigDir,
      files: [
        { assetId: "a", targetAbs: targetA, content: "content-a\n" },
        { assetId: "b", targetAbs: targetB, content: "content-b\n" },
      ],
    };

    await runInstall(plan, { dryRun: false, force: false });
    // User edits A
    fs.writeFileSync(targetA, "edited-a\n", "utf8");

    const result = await runRollback("test-harness", { force: false });
    // A: refused (still has edited content)
    expect(fs.readFileSync(targetA, "utf8")).toBe("edited-a\n");
    // B: deleted (existedBefore=false)
    expect(fs.existsSync(targetB)).toBe(false);
    const warnFindings = result.findings.filter((f) => f.level === "warn");
    expect(warnFindings.some((f) => f.title.includes(targetA))).toBe(true);
  });
});

// ============================================================
// Dry-run writes nothing
// ============================================================
describe("dry-run", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => {
    env = setupTmpEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("does not write any files to either tmp dir", async () => {
    const plan = makePlan(env.claudeConfigDir, {
      settings: {
        fileAbs: path.join(env.claudeConfigDir, "settings.json"),
        merge: { dryRunKey: "value" },
      },
    });

    // Snapshot before
    const leanrigBefore = listDirRecursive(env.leanrigHome);
    const claudeBefore = listDirRecursive(env.claudeConfigDir);

    await runInstall(plan, { dryRun: true, force: false });

    const leanrigAfter = listDirRecursive(env.leanrigHome);
    const claudeAfter = listDirRecursive(env.claudeConfigDir);

    expect(leanrigAfter).toEqual(leanrigBefore);
    expect(claudeAfter).toEqual(claudeBefore);
  });
});

function listDirRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d)) {
      const full = path.join(d, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results.sort();
}

/** List all subdirectories (not files) under dir, recursively. */
function listSubDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d)) {
      const full = path.join(d, entry);
      if (fs.statSync(full).isDirectory()) {
        results.push(full);
        walk(full);
      }
    }
  }
  walk(dir);
  return results.sort();
}

// ============================================================
// FIX 1: install-overwrite must honor user-edit guard
// ============================================================
describe("user-edit guard on re-install (FIX 1)", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => {
    env = setupTmpEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("re-install without --force does NOT overwrite user-edited leanrig file", async () => {
    const plan = makePlan(env.claudeConfigDir);
    const target = plan.files[0]!.targetAbs;

    // First install
    await runInstall(plan, { dryRun: false, force: false });
    expect(fs.existsSync(target)).toBe(true);

    // User edits the installed file
    const userEdit = "# User edited this line\n" + plan.files[0]!.content;
    fs.writeFileSync(target, userEdit, "utf8");

    // Re-install same profile WITHOUT --force
    const result = await runInstall(plan, { dryRun: false, force: false });

    // File must retain the user's edit
    expect(fs.readFileSync(target, "utf8")).toBe(userEdit);

    // Must emit a skip/warn finding
    const warnFindings = result.findings.filter(
      (f) => f.level === "warn" && f.title.toLowerCase().includes("modified since install")
    );
    expect(warnFindings.length).toBeGreaterThan(0);
  });

  it("re-install WITH --force overwrites user-edited leanrig file", async () => {
    const plan = makePlan(env.claudeConfigDir);
    const target = plan.files[0]!.targetAbs;

    // First install
    await runInstall(plan, { dryRun: false, force: false });

    // User edits the installed file
    const userEdit = "# User edited this line\n" + plan.files[0]!.content;
    fs.writeFileSync(target, userEdit, "utf8");

    // Re-install same profile WITH --force
    await runInstall(plan, { dryRun: false, force: true });

    // File must now contain the plan content (overwritten)
    expect(fs.readFileSync(target, "utf8")).toBe(plan.files[0]!.content);
  });

  it("re-install without --force succeeds for untouched leanrig files", async () => {
    const plan = makePlan(env.claudeConfigDir, {
      files: [
        {
          assetId: "file-a",
          targetAbs: path.join(env.claudeConfigDir, "agents", "leanrig-test.md"),
          content: "# Hello v2\nUpdated content.\n",
        },
      ],
    });

    // First install (v1 content)
    const planV1 = makePlan(env.claudeConfigDir);
    await runInstall(planV1, { dryRun: false, force: false });

    // Install v2 of the same file (no user edit — hash matches what was written)
    const result = await runInstall(plan, { dryRun: false, force: false });

    // Should overwrite (file was not user-edited)
    const target = plan.files[0]!.targetAbs;
    expect(fs.readFileSync(target, "utf8")).toBe(plan.files[0]!.content);

    // No "modified since install" skip warning
    const skipWarns = result.findings.filter(
      (f) => f.level === "warn" && f.title.toLowerCase().includes("modified since install")
    );
    expect(skipWarns.length).toBe(0);
  });
});

// ============================================================
// FIX 2: configDir propagated correctly; rollback prunes dirs
// ============================================================
describe("rollback prunes empty leanrig dirs (FIX 2)", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => {
    env = setupTmpEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("full install+rollback leaves zero leftover empty leanrig-created subdirs", async () => {
    // Build a plan with files in several subdirs (simulating a real profile)
    const plan: InstallPlan = {
      harness: "test-harness",
      profile: "test-profile",
      configDir: env.claudeConfigDir,
      files: [
        {
          assetId: "agents/explorer",
          targetAbs: path.join(env.claudeConfigDir, "agents", "leanrig-explorer.md"),
          content: "# Explorer\n",
        },
        {
          assetId: "skills/delegate",
          targetAbs: path.join(env.claudeConfigDir, "skills", "leanrig-delegate", "SKILL.md"),
          content: "# Skill\n",
        },
        {
          assetId: "statusline",
          targetAbs: path.join(env.claudeConfigDir, "statusline", "leanrig-statusline.sh"),
          content: "#!/bin/sh\n",
        },
        {
          assetId: "output-styles/token-saver",
          targetAbs: path.join(env.claudeConfigDir, "output-styles", "leanrig-token-saver.md"),
          content: "# Token Saver\n",
        },
      ],
    };

    // Pre-seed a user directory that should survive rollback
    const userDir = path.join(env.claudeConfigDir, "my-custom-scripts");
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "my-script.sh"), "#!/bin/sh\necho hi\n", "utf8");

    await runInstall(plan, { dryRun: false, force: false });

    // Verify all files are installed
    for (const pf of plan.files) {
      expect(fs.existsSync(pf.targetAbs)).toBe(true);
    }

    await runRollback("test-harness", { force: false });

    // None of the installed files should remain
    for (const pf of plan.files) {
      expect(fs.existsSync(pf.targetAbs)).toBe(false);
    }

    // The leanrig-created subdirs must be gone
    const leanrigDirs = ["agents", "skills", "statusline", "output-styles"];
    for (const d of leanrigDirs) {
      expect(fs.existsSync(path.join(env.claudeConfigDir, d))).toBe(false);
    }

    // The pre-existing user dir must still be there
    expect(fs.existsSync(userDir)).toBe(true);
    expect(fs.existsSync(path.join(userDir, "my-script.sh"))).toBe(true);
  });
});

// ============================================================
// FIX 5: target escape guard
// ============================================================
describe("configDir containment guard (FIX 5)", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => {
    env = setupTmpEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("throws and writes nothing if a target escapes configDir via ../", async () => {
    const escapedTarget = path.join(env.claudeConfigDir, "..", "escaped-file.md");
    const plan: InstallPlan = {
      harness: "test-harness",
      profile: "test-profile",
      configDir: env.claudeConfigDir,
      files: [
        {
          assetId: "malicious",
          targetAbs: escapedTarget,
          content: "# Evil\n",
        },
      ],
    };

    await expect(runInstall(plan, { dryRun: false, force: false })).rejects.toThrow(
      /escapes configDir/
    );

    // Nothing written to the escaped path
    expect(fs.existsSync(escapedTarget)).toBe(false);
  });

  it("normal install does not throw (targets within configDir)", async () => {
    const plan = makePlan(env.claudeConfigDir);
    await expect(runInstall(plan, { dryRun: false, force: false })).resolves.toBeDefined();
  });
});

// ============================================================
// Re-install same profile = no-op
// ============================================================
describe("re-install same profile", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => {
    env = setupTmpEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("second install is a no-op and does not create duplicate state entries", async () => {
    const plan = makePlan(env.claudeConfigDir);

    await runInstall(plan, { dryRun: false, force: false });
    // Snapshot state before second install
    const statePath = path.join(env.leanrigHome, "state.json");
    const stateBefore = JSON.parse(fs.readFileSync(statePath, "utf8"));

    const result2 = await runInstall(plan, { dryRun: false, force: false });
    expect(result2.noOp).toBe(true);

    const stateAfter = JSON.parse(fs.readFileSync(statePath, "utf8"));
    // No new install entries
    expect(stateAfter.installs.length).toBe(stateBefore.installs.length);
    // Backup count should not grow
    const backupsBefore = fs.readdirSync(path.join(env.leanrigHome, "backups"));
    expect(backupsBefore.length).toBe(stateBefore.installs.length);
  });
});

// ============================================================
// FIX: one-active-layer invariant (re-install + rollback)
// ============================================================

// Helper: build a plan with multiple subdirs (approximating a real profile)
function makeMultiDirPlan(
  configDir: string,
  profile: string = "test-profile"
): InstallPlan {
  return {
    harness: "test-harness",
    profile,
    configDir,
    files: [
      {
        assetId: "agents/explorer",
        targetAbs: path.join(configDir, "agents", "leanrig-explorer.md"),
        content: `# Explorer ${profile}\n`,
      },
      {
        assetId: "skills/delegate",
        targetAbs: path.join(configDir, "skills", "leanrig-delegate", "SKILL.md"),
        content: `# Skill ${profile}\n`,
      },
      {
        assetId: "statusline",
        targetAbs: path.join(configDir, "statusline", "leanrig-statusline.sh"),
        content: `#!/bin/sh\n# ${profile}\n`,
      },
      {
        assetId: "output-styles/token-saver",
        targetAbs: path.join(configDir, "output-styles", "leanrig-token-saver.md"),
        content: `# Token Saver ${profile}\n`,
      },
    ],
  };
}

describe("one-active-layer: repro — install → edit → no-force → force → rollback", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => {
    env = setupTmpEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("after force-reinstall + rollback: zero leanrig files/dirs; user file/dir survive", async () => {
    // Pre-seed a user dir
    const userDir = path.join(env.claudeConfigDir, "my-stuff");
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "keep.txt"), "user file\n", "utf8");

    const plan = makeMultiDirPlan(env.claudeConfigDir, "balanced");

    // Install
    await runInstall(plan, { dryRun: false, force: false });

    // User edits an installed file
    const explorerPath = path.join(env.claudeConfigDir, "agents", "leanrig-explorer.md");
    fs.appendFileSync(explorerPath, "MY EDIT\n", "utf8");

    // Re-install without force (skips the edited file, but is effectively a partial skip — still a no-op here)
    await runInstall(plan, { dryRun: false, force: false });

    // Re-install WITH force (triggers internal rollback + fresh install)
    await runInstall(plan, { dryRun: false, force: true });

    // Rollback
    await runRollback("test-harness", { force: true });

    // Zero leanrig-* files
    const leanrigFiles = findFilesNamed(env.claudeConfigDir, /leanrig-/);
    expect(leanrigFiles).toHaveLength(0);

    // Zero leanrig-created dirs
    const leanrigDirs = ["agents", "skills", "statusline", "output-styles"];
    for (const d of leanrigDirs) {
      expect(fs.existsSync(path.join(env.claudeConfigDir, d))).toBe(false);
    }

    // User dir and file survive
    expect(fs.existsSync(userDir)).toBe(true);
    expect(fs.readFileSync(path.join(userDir, "keep.txt"), "utf8")).toBe("user file\n");
  });
});

describe("one-active-layer: profile switch", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => {
    env = setupTmpEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("install safe → install balanced --force → rollback → configDir back to true original", async () => {
    // Pre-seed a user file
    const userDir = path.join(env.claudeConfigDir, "user-content");
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "user.txt"), "original user content\n", "utf8");

    const planSafe = makeMultiDirPlan(env.claudeConfigDir, "safe");
    const planBalanced = makeMultiDirPlan(env.claudeConfigDir, "balanced");

    // Install safe
    await runInstall(planSafe, { dryRun: false, force: false });

    // Switch to balanced with --force (different profile)
    await runInstall(planBalanced, { dryRun: false, force: true });

    // Rollback
    await runRollback("test-harness", { force: false });

    // Zero leanrig files
    const leanrigFiles = findFilesNamed(env.claudeConfigDir, /leanrig-/);
    expect(leanrigFiles).toHaveLength(0);

    // Zero leanrig-created dirs
    for (const d of ["agents", "skills", "statusline", "output-styles"]) {
      expect(fs.existsSync(path.join(env.claudeConfigDir, d))).toBe(false);
    }

    // User content survives
    expect(fs.readFileSync(path.join(userDir, "user.txt"), "utf8")).toBe("original user content\n");
  });

  it("install safe → install balanced WITHOUT --force → refused with correct message, disk unchanged", async () => {
    const planSafe = makeMultiDirPlan(env.claudeConfigDir, "safe");
    const planBalanced = makeMultiDirPlan(env.claudeConfigDir, "balanced");

    await runInstall(planSafe, { dryRun: false, force: false });

    // Snapshot the configDir
    const snapshotBefore = listDirRecursive(env.claudeConfigDir).join("|");

    // Attempt to switch profile without --force: must throw
    await expect(
      runInstall(planBalanced, { dryRun: false, force: false })
    ).rejects.toThrow(/already has profile 'safe' installed/);

    // Disk must be unchanged
    const snapshotAfter = listDirRecursive(env.claudeConfigDir).join("|");
    expect(snapshotAfter).toBe(snapshotBefore);
  });
});

describe("one-active-layer: state accounting", () => {
  let env: ReturnType<typeof setupTmpEnv>;

  beforeEach(() => {
    env = setupTmpEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("install → install --force: exactly ONE active install; single rollback fully clears leanrig", async () => {
    const plan = makeMultiDirPlan(env.claudeConfigDir, "balanced");

    await runInstall(plan, { dryRun: false, force: false });
    await runInstall(plan, { dryRun: false, force: true });

    // Exactly one active install
    const state = readState();
    const activeInstalls = state.installs.filter((i) => i.harness === "test-harness");
    expect(activeInstalls).toHaveLength(1);
    expect(state.lastInstall["test-harness"]).toBeDefined();

    // Single rollback fully removes all leanrig files
    await runRollback("test-harness", { force: false });

    const leanrigFiles = findFilesNamed(env.claudeConfigDir, /leanrig-/);
    expect(leanrigFiles).toHaveLength(0);

    // No more active install
    const stateAfter = readState();
    expect(stateAfter.lastInstall["test-harness"]).toBeUndefined();
  });
});

/** Find all files under dir whose name matches pattern. */
function findFilesNamed(dir: string, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d)) {
      const full = path.join(d, entry);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else if (pattern.test(entry)) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}
