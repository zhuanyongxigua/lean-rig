import fs from "fs";
import path from "path";
import pc from "picocolors";
import {
  hashContent,
  hashFile,
  generateBackupId,
  backupFile,
  restoreFile,
  deleteAndPruneDirs,
} from "./backup.js";
import { deepMerge } from "./jsonMerge.js";
import {
  writeManifest,
  readManifest,
  type Manifest,
  type ManifestFile,
} from "./manifest.js";
import { addInstall, removeInstall, getLastInstallId } from "./state.js";
import { leanrigHome } from "./paths.js";
import type { Finding } from "./report.js";

export interface PlannedFile {
  assetId: string;
  targetAbs: string;
  content: string;
  executable?: boolean;
}

export interface SettingsPatch {
  fileAbs: string;
  merge: Record<string, unknown>;
}

export interface InstallPlan {
  harness: string;
  profile: string;
  configDir: string;
  files: PlannedFile[];
  settings?: SettingsPatch;
}

export interface InstallOptions {
  dryRun: boolean;
  force: boolean;
}

export interface InstallResult {
  findings: Finding[];
  /** true if nothing was written (all-unchanged no-op) */
  noOp: boolean;
}

/** Load the manifest for the most recent install of `harness`, if any. */
function loadPreviousManifest(harness: string): Manifest | null {
  const lastId = getLastInstallId(harness);
  if (!lastId) return null;
  const backupDir = path.join(leanrigHome(), "backups", lastId);
  const manifest = readManifest(backupDir);
  if (!manifest) {
    // State claims an active install but its manifest is gone/unreadable.
    // Returning null here would make install() treat the harness as fresh and
    // stack a new backup layer over leanrig's own files (re-opening the
    // rollback-layering bug invariant #9 prevents). Fail loudly instead.
    throw new Error(
      `leanrig state references install "${lastId}" for ${harness}, but its manifest is ` +
        `missing or unreadable (${path.join(backupDir, "manifest.json")}). State may be corrupted. ` +
        `Remove ${path.join(leanrigHome(), "state.json")} or restore the backup before retrying.`
    );
  }
  return manifest;
}

/** Compute what the merged settings content would be. */
function computeMergedSettings(
  fileAbs: string,
  merge: Record<string, unknown>
): string {
  let base: Record<string, unknown> = {};
  if (fs.existsSync(fileAbs)) {
    try {
      base = JSON.parse(fs.readFileSync(fileAbs, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      base = {};
    }
  }
  const merged = deepMerge(base, merge);
  return JSON.stringify(merged, null, 2) + "\n";
}

export async function runInstall(
  plan: InstallPlan,
  opts: InstallOptions
): Promise<InstallResult> {
  const findings: Finding[] = [];
  const prevManifest = loadPreviousManifest(plan.harness);

  // Build a lookup: target -> writtenHash from previous manifest
  const prevHashes = new Map<string, string>();
  if (prevManifest) {
    for (const f of prevManifest.files) {
      prevHashes.set(f.target, f.writtenHash);
    }
    if (prevManifest.settings) {
      prevHashes.set(prevManifest.settings.path, prevManifest.settings.writtenHash);
    }
  }

  // --- Collision detection pass ---
  type FileAction = "create" | "overwrite" | "skip" | "unchanged";
  const fileActions = new Map<string, FileAction>();

  for (const pf of plan.files) {
    const existsNow = fs.existsSync(pf.targetAbs);
    if (!existsNow) {
      fileActions.set(pf.targetAbs, "create");
      continue;
    }
    const currentContent = fs.readFileSync(pf.targetAbs, "utf8");
    const currentHash = hashContent(currentContent);
    const newHash = hashContent(pf.content);

    if (currentHash === newHash) {
      fileActions.set(pf.targetAbs, "unchanged");
      continue;
    }

    const prevHash = prevHashes.get(pf.targetAbs);
    if (prevHash === undefined) {
      // Not from a previous leanrig install
      if (opts.force) {
        fileActions.set(pf.targetAbs, "overwrite");
        findings.push({
          level: "warn",
          title: `Overwriting non-leanrig file (--force): ${pf.targetAbs}`,
        });
      } else {
        fileActions.set(pf.targetAbs, "skip");
        findings.push({
          level: "warn",
          title: `Skipping collision (not from leanrig): ${pf.targetAbs}`,
          detail: "Use --force to overwrite.",
        });
      }
    } else {
      // From a previous leanrig install — check if user edited it since
      if (currentHash !== prevHash && !opts.force) {
        // User hand-edited after install; protect it
        fileActions.set(pf.targetAbs, "skip");
        findings.push({
          level: "warn",
          title: `Skipping (modified since install): ${pf.targetAbs}`,
          detail: "Use --force to overwrite.",
        });
      } else {
        // Untouched since install, or --force supplied → overwrite
        fileActions.set(pf.targetAbs, "overwrite");
      }
    }
  }

  // Determine settings action
  let settingsAction: FileAction = "create";
  let mergedSettingsContent = "";
  if (plan.settings) {
    mergedSettingsContent = computeMergedSettings(
      plan.settings.fileAbs,
      plan.settings.merge
    );
    if (fs.existsSync(plan.settings.fileAbs)) {
      const currentHash = hashFile(plan.settings.fileAbs);
      const mergedHash = hashContent(mergedSettingsContent);
      if (currentHash === mergedHash) {
        settingsAction = "unchanged";
      } else {
        settingsAction = "overwrite";
      }
    }
  }

  // Check if everything is unchanged (re-install same profile = no-op)
  const allFilesUnchanged = [...fileActions.values()].every(
    (a) => a === "unchanged" || a === "skip"
  );
  const settingsUnchanged = !plan.settings || settingsAction === "unchanged";

  if (opts.dryRun) {
    // Print plan, write nothing
    console.log(pc.bold("\nDry-run plan:"));
    for (const pf of plan.files) {
      const action = fileActions.get(pf.targetAbs) ?? "create";
      const label = actionLabel(action);
      console.log(`  ${label}  ${pf.targetAbs}`);
    }
    if (plan.settings) {
      const label = actionLabel(settingsAction);
      console.log(`  ${label}  ${plan.settings.fileAbs} (settings merge)`);
      const backupId = generateBackupId();
      const backupDir = path.join(leanrigHome(), "backups", backupId);
      console.log(pc.dim(`  (backup would go to ${backupDir})`));
    }
    // Reflect the real replace/refuse behavior so the preview isn't misleading.
    if (prevManifest && !(allFilesUnchanged && settingsUnchanged)) {
      if (prevManifest.profile !== plan.profile && !opts.force) {
        console.log(
          pc.yellow(
            `  note: profile "${prevManifest.profile}" is already installed — this would be REFUSED. ` +
              `Rollback first or use --force to replace.`
          )
        );
      } else {
        console.log(
          pc.dim(
            `  note: would replace the existing "${prevManifest.profile}" install (internal rollback to original, then reinstall).`
          )
        );
      }
    }
    findings.push({ level: "info", title: "Dry-run: no files written." });
    return { findings, noOp: false };
  }

  // Check no-op BEFORE doing anything
  if (allFilesUnchanged && settingsUnchanged) {
    findings.push({
      level: "ok",
      title: `Profile "${plan.profile}" already installed — nothing to do.`,
    });
    return { findings, noOp: true };
  }

  // --- One-active-layer invariant ---
  // If there is already an active install for this harness AND we are about to
  // write something (not a no-op), we must NOT stack a new backup layer on top
  // of leanrig's own files. Instead:
  //   1. If a DIFFERENT profile is requested without --force, refuse.
  //   2. Otherwise, internally roll back the existing install (force=true so
  //      even user-edited files revert to true original), then proceed with a
  //      fresh install. This guarantees exactly one active layer whose backups
  //      always reflect the true pre-leanrig disk state.
  if (prevManifest) {
    const differentProfile = prevManifest.profile !== plan.profile;
    if (differentProfile && !opts.force) {
      // Refuse: user must explicitly opt in to replacing
      throw new Error(
        `${plan.harness} already has profile '${prevManifest.profile}' installed. ` +
          `Run \`leanrig rollback\` first, or re-run with --force to replace it.`
      );
    }
    // Internal rollback: restore to true original before fresh install.
    // This must use force=true so even user-edited files are reverted.
    await runRollback(plan.harness, { force: true });
    // After internal rollback the disk is at true original and state has no
    // active install for this harness.  Re-compute file actions from scratch.
    return runInstall(plan, opts);
  }

  // --- Actual install ---
  const backupId = generateBackupId();
  const backupDir = path.join(leanrigHome(), "backups", backupId);
  fs.mkdirSync(backupDir, { recursive: true });

  const manifestFiles: ManifestFile[] = [];

  for (const pf of plan.files) {
    // FIX 5: guard that every target stays inside configDir
    const rel = path.relative(plan.configDir, pf.targetAbs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `Security: target "${pf.targetAbs}" escapes configDir "${plan.configDir}". Aborting.`
      );
    }

    const action = fileActions.get(pf.targetAbs) ?? "create";

    if (action === "skip") {
      findings.push({
        level: "warn",
        title: `Skipped: ${pf.targetAbs}`,
      });
      continue;
    }

    const existedBefore = fs.existsSync(pf.targetAbs);
    let backupRelPath: string | null = null;

    if (existedBefore) {
      backupRelPath = `files/${path.basename(pf.targetAbs)}`;
      // Make unique if needed
      let counter = 0;
      let unique = backupRelPath;
      while (fs.existsSync(path.join(backupDir, unique))) {
        unique = `files/${counter}_${path.basename(pf.targetAbs)}`;
        counter++;
      }
      backupRelPath = unique;
      backupFile(pf.targetAbs, backupDir, backupRelPath);
    }

    if (action !== "unchanged") {
      fs.mkdirSync(path.dirname(pf.targetAbs), { recursive: true });
      fs.writeFileSync(pf.targetAbs, pf.content, "utf8");
      if (pf.executable) {
        fs.chmodSync(pf.targetAbs, 0o755);
      }
    }

    const writtenHash = hashContent(pf.content);
    manifestFiles.push({
      target: pf.targetAbs,
      existedBefore,
      backupRelPath,
      writtenHash,
    });

    findings.push({
      level: "ok",
      title: `${action === "unchanged" ? "Unchanged" : action === "create" ? "Created" : "Updated"}: ${pf.targetAbs}`,
    });
  }

  // Settings
  let manifestSettings: Manifest["settings"] = undefined;
  if (plan.settings && settingsAction !== "unchanged") {
    const existedBefore = fs.existsSync(plan.settings.fileAbs);
    let backupRelPath: string | null = null;
    if (existedBefore) {
      backupRelPath = "settings.json.bak";
      backupFile(plan.settings.fileAbs, backupDir, backupRelPath);
    }
    fs.mkdirSync(path.dirname(plan.settings.fileAbs), { recursive: true });
    fs.writeFileSync(plan.settings.fileAbs, mergedSettingsContent, "utf8");
    const writtenHash = hashContent(mergedSettingsContent);
    manifestSettings = {
      path: plan.settings.fileAbs,
      existedBefore,
      backupRelPath,
      writtenHash,
    };
    findings.push({
      level: "ok",
      title: `Settings merged: ${plan.settings.fileAbs}`,
    });
  } else if (plan.settings && settingsAction === "unchanged") {
    findings.push({
      level: "ok",
      title: `Settings unchanged: ${plan.settings.fileAbs}`,
    });
  }

  // Write manifest
  const manifest: Manifest = {
    version: 1,
    harness: plan.harness,
    profile: plan.profile,
    createdAt: new Date().toISOString(),
    configDir: plan.configDir,
    files: manifestFiles,
    settings: manifestSettings,
  };
  writeManifest(backupDir, manifest);

  // Update state
  addInstall({
    id: backupId,
    harness: plan.harness,
    profile: plan.profile,
    createdAt: manifest.createdAt,
  });

  return { findings, noOp: false };
}

function actionLabel(action: string): string {
  switch (action) {
    case "create":
      return pc.green("create  ");
    case "overwrite":
      return pc.yellow("overwrite");
    case "skip":
      return pc.yellow("skip    ");
    case "unchanged":
      return pc.dim("unchanged");
    default:
      return action;
  }
}

export interface RollbackOptions {
  force: boolean;
}

export interface RollbackResult {
  findings: Finding[];
}

export async function runRollback(
  harness: string,
  opts: RollbackOptions
): Promise<RollbackResult> {
  const findings: Finding[] = [];
  const lastId = getLastInstallId(harness);
  if (!lastId) {
    findings.push({
      level: "warn",
      title: `No install found for harness "${harness}".`,
    });
    return { findings };
  }

  const backupDir = path.join(leanrigHome(), "backups", lastId);
  const manifest = readManifest(backupDir);
  if (!manifest) {
    findings.push({
      level: "warn",
      title: `Manifest not found in ${backupDir}`,
    });
    return { findings };
  }

  // Track whether any target was left in place (user-edited, no --force). A
  // partial rollback must NOT de-register the install or delete its backup —
  // the user needs both intact to finish with --force later.
  let skippedAny = false;

  for (const mf of manifest.files) {
    if (!fs.existsSync(mf.target)) {
      if (!mf.existedBefore) {
        // Already gone — fine
        findings.push({ level: "ok", title: `Already removed: ${mf.target}` });
        continue;
      } else {
        findings.push({
          level: "warn",
          title: `File to restore is missing: ${mf.target}`,
        });
        continue;
      }
    }

    // Check if user edited after install
    const currentHash = hashFile(mf.target);
    if (currentHash !== mf.writtenHash) {
      if (!opts.force) {
        findings.push({
          level: "warn",
          title: `Skipping (user-edited after install): ${mf.target}`,
          detail: "Use --force to restore anyway.",
        });
        skippedAny = true;
        continue;
      } else {
        findings.push({
          level: "warn",
          title: `Restoring user-edited file (--force): ${mf.target}`,
        });
      }
    }

    if (!mf.existedBefore) {
      deleteAndPruneDirs(mf.target, manifest.configDir);
      findings.push({ level: "ok", title: `Deleted: ${mf.target}` });
    } else if (mf.backupRelPath) {
      restoreFile(backupDir, mf.backupRelPath, mf.target);
      findings.push({ level: "ok", title: `Restored: ${mf.target}` });
    }
  }

  // Settings rollback
  if (manifest.settings) {
    const s = manifest.settings;
    const settingsExists = fs.existsSync(s.path);

    if (settingsExists) {
      const currentHash = hashFile(s.path);
      if (currentHash !== s.writtenHash) {
        if (!opts.force) {
          findings.push({
            level: "warn",
            title: `Skipping settings (user-edited after install): ${s.path}`,
            detail: "Use --force to restore anyway.",
          });
          skippedAny = true;
        } else {
          findings.push({
            level: "warn",
            title: `Restoring user-edited settings (--force): ${s.path}`,
          });
          if (!s.existedBefore) {
            fs.unlinkSync(s.path);
          } else if (s.backupRelPath) {
            restoreFile(backupDir, s.backupRelPath, s.path);
          }
        }
      } else {
        if (!s.existedBefore) {
          fs.unlinkSync(s.path);
          findings.push({ level: "ok", title: `Deleted settings: ${s.path}` });
        } else if (s.backupRelPath) {
          restoreFile(backupDir, s.backupRelPath, s.path);
          findings.push({
            level: "ok",
            title: `Restored settings: ${s.path}`,
          });
        }
      }
    }
  }

  if (skippedAny) {
    // Partial rollback: leave the install registered AND its backup on disk so
    // the user can complete it with --force. De-registering now would strand the
    // remaining leanrig files with no way to roll them back.
    findings.push({
      level: "warn",
      title: `Rollback incomplete for "${harness}": some files were edited after install and were left in place.`,
      detail: "Re-run `leanrig rollback --force` to finish.",
    });
    return { findings };
  }

  removeInstall(harness, lastId);
  // Backup dir has served its purpose now that the install is fully reverted.
  // Removing it keeps ~/.leanrig/backups from growing without bound across
  // repeated install/rollback (and internal replace) cycles.
  fs.rmSync(backupDir, { recursive: true, force: true });
  return { findings };
}

export interface DiffResult {
  findings: Finding[];
}

export async function runDiff(harness: string): Promise<DiffResult> {
  const { createTwoFilesPatch } = await import("diff");
  const findings: Finding[] = [];

  const lastId = getLastInstallId(harness);
  if (!lastId) {
    findings.push({
      level: "warn",
      title: `No install found for harness "${harness}".`,
    });
    return { findings };
  }

  const backupDir = path.join(leanrigHome(), "backups", lastId);
  const manifest = readManifest(backupDir);
  if (!manifest) {
    findings.push({
      level: "warn",
      title: `Manifest not found in ${backupDir}`,
    });
    return { findings };
  }

  for (const mf of manifest.files) {
    const targetExists = fs.existsSync(mf.target);
    const currentContent = targetExists
      ? fs.readFileSync(mf.target, "utf8")
      : "";

    const backupContent =
      mf.backupRelPath && mf.existedBefore
        ? fs.readFileSync(path.join(backupDir, mf.backupRelPath), "utf8")
        : "";

    const currentHash = hashContent(currentContent);

    if (!targetExists) {
      findings.push({
        level: "info",
        title: `Deleted since install: ${mf.target}`,
      });
      continue;
    }

    if (currentHash === mf.writtenHash) {
      findings.push({ level: "ok", title: `Unchanged: ${mf.target}` });
      continue;
    }

    findings.push({
      level: "warn",
      title: `Modified since install: ${mf.target}`,
    });

    const patch = createTwoFilesPatch(
      "backup" + (mf.backupRelPath ? `/${mf.backupRelPath}` : " (none)"),
      mf.target,
      backupContent,
      currentContent,
      "",
      ""
    );
    console.log(patch);
  }

  return { findings };
}
