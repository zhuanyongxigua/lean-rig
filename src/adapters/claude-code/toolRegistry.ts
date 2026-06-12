/**
 * Claude Code third-party tools registry.
 * All tool ids, licenses, commands copied verbatim from docs/claude-code-facts.md.
 */
import fs from "fs";
import path from "path";
import type { ToolSpec, ToolStatus, ToolPlan } from "../toolTypes.js";
import type { CommandRunner } from "../../core/tools.js";
import { realRunner } from "../../core/tools.js";

// ---------------------------------------------------------------------------
// Registry entries (from docs/claude-code-facts.md "Third-party tools")
// ---------------------------------------------------------------------------

export const toolRegistry: ToolSpec[] = [
  {
    id: "ccusage-statusline",
    title: "ccusage statusline",
    description: "Shows model, cost, context, and rate-limit info in the terminal statusline.",
    license: "MIT",
    source: "https://ccusage.com/guide/statusline",
    kind: "settings",
    overlaps: "Replaces any current statusLine setting, including leanrig's.",
  },
  {
    id: "caveman",
    title: "Caveman",
    description: "Makes Claude talk like a caveman — cuts ~75% of output tokens, keeps technical accuracy.",
    license: "MIT",
    source: "https://github.com/JuliusBrussee/caveman",
    kind: "external",
    overlaps: "Stacks with Token Saver output style; pick one for output compression.",
  },
  {
    id: "squeez",
    title: "squeez",
    description: "Hook-based Bash output compressor with cross-call dedup — up to 95% compression.",
    license: "Apache-2.0",
    source: "https://github.com/claudioemmanuel/squeez",
    kind: "external",
    overlaps: "Composes with BASH_MAX_OUTPUT_LENGTH; doctor notes redundancy.",
  },
  {
    id: "lean-ctx",
    title: "lean-ctx",
    description: "Local context-intelligence binary — compressed reads, cached re-reads, 60-90% fewer tokens.",
    license: "Apache-2.0",
    source: "https://github.com/yvgude/lean-ctx",
    kind: "guide",
  },
];

// ---------------------------------------------------------------------------
// Helper: get configDir (reads env at call time)
// ---------------------------------------------------------------------------

function getConfigDir(): string {
  return (
    process.env["CLAUDE_CONFIG_DIR"] ?? path.join(process.env["HOME"] ?? process.env["USERPROFILE"] ?? "", ".claude")
  );
}

// ---------------------------------------------------------------------------
// detectTool (best-effort, read-only)
// ---------------------------------------------------------------------------

/**
 * Read-only caveman detection: <configDir>/plugins/installed_plugins.json
 * lists installed plugins under keys like "caveman@caveman". Observed
 * structure (not documented) — treat as best-effort only.
 */
export function cavemanInInstalledPlugins(configDir: string): boolean {
  const installedPath = path.join(configDir, "plugins", "installed_plugins.json");
  if (!fs.existsSync(installedPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(installedPath, "utf8")) as {
      plugins?: Record<string, unknown>;
    };
    return Object.keys(data.plugins ?? {}).some((k) => k.startsWith("caveman@"));
  } catch {
    return false;
  }
}

export async function detectTool(id: string, runner: CommandRunner = realRunner): Promise<ToolStatus> {
  const configDir = getConfigDir();
  const settingsPath = path.join(configDir, "settings.json");

  function readSettings(): Record<string, unknown> {
    if (!fs.existsSync(settingsPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  switch (id) {
    case "ccusage-statusline": {
      const settings = readSettings();
      const statusLine = settings["statusLine"] as Record<string, unknown> | undefined;
      const cmd = typeof statusLine?.["command"] === "string" ? statusLine["command"] : "";
      if (cmd.includes("ccusage")) {
        return { installed: true, detail: "statusLine.command contains 'ccusage'" };
      }
      return { installed: false };
    }

    case "caveman": {
      // Read-only path first: <configDir>/plugins/installed_plugins.json has
      // plugin keys like "caveman@caveman" (observed structure, best-effort).
      if (cavemanInInstalledPlugins(configDir)) {
        return { installed: true, detail: "found in plugins/installed_plugins.json" };
      }
      const result = runner.run(["claude", "plugin", "list"]);
      if (result.code !== 0) {
        // claude CLI not available or error
        return { installed: false, detail: "claude CLI not available" };
      }
      if (result.stdout.includes("caveman")) {
        return { installed: true, detail: "found in `claude plugin list` output" };
      }
      return { installed: false };
    }

    case "squeez": {
      // Check binary at <configDir>/squeez/bin/squeez
      const binaryPath = path.join(configDir, "squeez", "bin", "squeez");
      if (fs.existsSync(binaryPath)) {
        return { installed: true, detail: `binary found at ${binaryPath}` };
      }
      // Check if settings.json serialized contains "squeez"
      const settingsRaw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "";
      if (settingsRaw.includes("squeez")) {
        return { installed: true, detail: "settings.json references squeez" };
      }
      return { installed: false };
    }

    case "lean-ctx": {
      const result = runner.run(["lean-ctx", "--version"]);
      if (result.code === 0) {
        return { installed: true, detail: "lean-ctx binary found on PATH" };
      }
      return { installed: false };
    }

    default:
      throw new Error(`Unknown tool id: "${id}"`);
  }
}

// ---------------------------------------------------------------------------
// planAddTool
// ---------------------------------------------------------------------------

export function planAddTool(id: string): ToolPlan {
  const configDir = getConfigDir();

  switch (id) {
    case "ccusage-statusline":
      return {
        kind: "settings",
        settingsPath: path.join(configDir, "settings.json"),
        merge: {
          statusLine: {
            type: "command",
            command: "npx -y ccusage statusline",
            padding: 0,
          },
        },
      };

    case "caveman":
      return {
        kind: "external",
        requires: "claude",
        commands: [
          ["claude", "plugin", "marketplace", "add", "JuliusBrussee/caveman"],
          ["claude", "plugin", "install", "caveman@caveman"],
        ],
      };

    case "squeez":
      return {
        kind: "external",
        requires: "npm",
        commands: [
          ["npm", "install", "-g", "squeez"],
          ["squeez", "setup", "--host=claude-code"],
        ],
      };

    case "lean-ctx":
      return {
        kind: "guide",
        instructions: [
          "lean-ctx is a guide-only tool. Install it manually:",
          "",
          "  brew tap yvgude/lean-ctx",
          "  brew install lean-ctx",
          "",
          "Source and docs: https://github.com/yvgude/lean-ctx",
        ].join("\n"),
      };

    default:
      throw new Error(`Unknown tool id: "${id}"`);
  }
}

// ---------------------------------------------------------------------------
// planRemoveTool
// ---------------------------------------------------------------------------

export function planRemoveTool(id: string): ToolPlan {
  const configDir = getConfigDir();

  switch (id) {
    case "ccusage-statusline":
      return {
        kind: "settings",
        settingsPath: path.join(configDir, "settings.json"),
        merge: {
          statusLine: {
            type: "command",
            command: "npx -y ccusage statusline",
            padding: 0,
          },
        },
      };

    case "caveman":
      return {
        kind: "external",
        requires: "claude",
        commands: [
          ["claude", "plugin", "uninstall", "caveman"],
          ["claude", "plugin", "marketplace", "remove", "caveman"],
        ],
      };

    case "squeez":
      return {
        kind: "external",
        requires: "npm",
        commands: [["squeez", "uninstall", "--host=claude-code"]],
      };

    case "lean-ctx":
      return {
        kind: "guide",
        instructions: "lean-ctx is not managed by leanrig. Please uninstall it manually.",
      };

    default:
      throw new Error(`Unknown tool id: "${id}"`);
  }
}
