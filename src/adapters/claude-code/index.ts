import fs from "fs";
import path from "path";
import { homeDir, packageRoot } from "../../core/paths.js";
import type { Adapter, DetectResult, AdapterInstallOptions } from "../types.js";
import type { Finding } from "../../core/report.js";
import type { InstallPlan, PlannedFile, SettingsPatch } from "../../core/installer.js";
import { deepMerge } from "../../core/jsonMerge.js";
import { doctorChecks } from "./doctorChecks.js";

// ---------------------------------------------------------------------------
// Asset ID -> { src path relative to assets/claude-code/, target filename }
// ---------------------------------------------------------------------------
interface AssetMapping {
  src: string;
  target: string;
  executable?: boolean;
}

const ASSET_MAP: Record<string, AssetMapping> = {
  "agents/explorer": {
    src: "agents/explorer.md",
    target: "agents/leanrig-explorer.md",
  },
  "agents/worker": {
    src: "agents/worker.md",
    target: "agents/leanrig-worker.md",
  },
  "agents/reviewer": {
    src: "agents/reviewer.md",
    target: "agents/leanrig-reviewer.md",
  },
  "skills/delegate": {
    src: "skills/delegate/SKILL.md",
    target: "skills/leanrig-delegate/SKILL.md",
  },
  "output-styles/token-saver": {
    src: "output-styles/token-saver.md",
    target: "output-styles/leanrig-token-saver.md",
  },
  statusline: {
    src: "statusline/leanrig-statusline.sh",
    target: "statusline/leanrig-statusline.sh",
    executable: true,
  },
  "hooks/bash-guard": {
    src: "hooks/leanrig-bash-guard.sh",
    target: "hooks/leanrig-bash-guard.sh",
    executable: true,
  },
};

// ---------------------------------------------------------------------------
// Profile JSON shape
// ---------------------------------------------------------------------------
interface ProfileJson {
  name: string;
  extends?: string;
  description?: string;
  assets?: string[];
  vars?: Record<string, string>;
  settings?: Record<string, unknown>;
}

interface ResolvedProfile {
  assets: string[];
  vars: Record<string, string>;
  settings: Record<string, unknown>;
}

/** Load and resolve profile with single-inheritance `extends`. */
function resolveProfile(
  name: string,
  profilesDir: string,
  seen: Set<string> = new Set()
): ResolvedProfile {
  if (seen.has(name)) {
    throw new Error(
      `Cyclic profile inheritance detected: ${[...seen, name].join(" -> ")}`
    );
  }
  seen.add(name);

  const profilePath = path.join(profilesDir, `${name}.json`);
  if (!fs.existsSync(profilePath)) {
    throw new Error(
      `Profile "${name}" not found at ${profilePath}`
    );
  }
  const raw = fs.readFileSync(profilePath, "utf8");
  const p = JSON.parse(raw) as ProfileJson;

  if (!p.extends) {
    return {
      assets: p.assets ?? [],
      vars: p.vars ?? {},
      settings: p.settings ?? {},
    };
  }

  // Resolve parent first
  const parent = resolveProfile(p.extends, profilesDir, seen);

  // Child assets APPEND to parent (union, parent-first, no duplicates)
  const childAssets = p.assets ?? [];
  const mergedAssets = [...parent.assets];
  for (const a of childAssets) {
    if (!mergedAssets.includes(a)) {
      mergedAssets.push(a);
    }
  }

  // Vars: deep-merge, child wins
  const mergedVars: Record<string, string> = {
    ...parent.vars,
    ...(p.vars ?? {}),
  };

  // Settings: deep-merge, child wins
  const mergedSettings = deepMerge(
    parent.settings,
    (p.settings ?? {}) as Record<string, unknown>
  );

  return {
    assets: mergedAssets,
    vars: mergedVars,
    settings: mergedSettings,
  };
}

/** Substitute {{var}} placeholders. Throws on unresolved. */
function substituteVars(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (!(key in vars)) {
      throw new Error(`Unresolved placeholder: {{${key}}}`);
    }
    return vars[key]!;
  });
}

/**
 * Substitute {{configDir}} in settings string values (one level deep into objects/arrays).
 * Applied to the resolved settings before creating the SettingsPatch.
 * Only this one placeholder is supported in settings; profile vars use substituteVars above.
 */
function substituteConfigDir(
  obj: Record<string, unknown>,
  configDir: string
): Record<string, unknown> {
  const jsonStr = JSON.stringify(obj).replace(/\{\{configDir\}\}/g, configDir);
  return JSON.parse(jsonStr) as Record<string, unknown>;
}

/** Get configDir: reads CLAUDE_CONFIG_DIR at call time. */
function getConfigDir(): string {
  return process.env["CLAUDE_CONFIG_DIR"] ?? path.join(homeDir(), ".claude");
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------
export const claudeCodeAdapter: Adapter = {
  name: "claude-code",

  async detect(): Promise<DetectResult> {
    const configDir = getConfigDir();
    const installed = fs.existsSync(configDir);
    return {
      installed,
      configDir,
      detail: installed
        ? `Config dir found: ${configDir}`
        : `Config dir not found: ${configDir}`,
    };
  },

  async doctor(): Promise<Finding[]> {
    const configDir = getConfigDir();
    const installed = fs.existsSync(configDir);

    // Header finding: installed or not
    const header: Finding = installed
      ? { level: "info", title: "Claude Code detected", detail: configDir }
      : {
          level: "warn",
          title: "Claude Code config dir not found",
          detail: `Expected: ${configDir}. Set CLAUDE_CONFIG_DIR or install Claude Code.`,
        };

    const findings: Finding[] = [header];

    // Run all registered checks
    for (const check of doctorChecks) {
      const checkFindings = await check(configDir);
      findings.push(...checkFindings);
    }

    return findings;
  },

  async listProfiles(): Promise<string[]> {
    const pkgRoot = packageRoot();
    const profilesDir = path.join(pkgRoot, "profiles", "claude-code");
    if (!fs.existsSync(profilesDir)) return [];
    return fs
      .readdirSync(profilesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.basename(f, ".json"));
  },

  async planInstall(
    profileName: string,
    _opts: AdapterInstallOptions
  ): Promise<InstallPlan> {
    const configDir = getConfigDir();
    const pkgRoot = packageRoot();
    const profilesDir = path.join(pkgRoot, "profiles", "claude-code");
    const assetsDir = path.join(pkgRoot, "assets", "claude-code");

    const resolved = resolveProfile(profileName, profilesDir);

    const plannedFiles: PlannedFile[] = [];
    for (const assetId of resolved.assets) {
      const mapping = ASSET_MAP[assetId];
      if (!mapping) {
        throw new Error(
          `Unknown asset id: "${assetId}". Known ids: ${Object.keys(ASSET_MAP).join(", ")}`
        );
      }
      const srcPath = path.join(assetsDir, mapping.src);
      if (!fs.existsSync(srcPath)) {
        throw new Error(`Asset file not found: ${srcPath}`);
      }
      const rawContent = fs.readFileSync(srcPath, "utf8");
      const content = substituteVars(rawContent, resolved.vars);
      const targetAbs = path.join(configDir, mapping.target);

      plannedFiles.push({
        assetId,
        targetAbs,
        content,
        executable: mapping.executable,
      });
    }

    let settingsPatch: SettingsPatch | undefined;
    if (Object.keys(resolved.settings).length > 0) {
      // Resolve {{configDir}} in settings string values (used by statusLine command path, hooks, etc.)
      const resolvedSettings = substituteConfigDir(resolved.settings, configDir);
      settingsPatch = {
        fileAbs: path.join(configDir, "settings.json"),
        merge: resolvedSettings,
      };
    }

    return {
      harness: "claude-code",
      profile: profileName,
      configDir,
      files: plannedFiles,
      settings: settingsPatch,
    };
  },
};
