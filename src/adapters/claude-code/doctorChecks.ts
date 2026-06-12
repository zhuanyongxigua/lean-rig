import fs from "fs";
import path from "path";
import os from "os";
import { leanrigHome } from "../../core/paths.js";
import type { Finding } from "../../core/report.js";
import { toolRegistry, cavemanInInstalledPlugins } from "./toolRegistry.js";

/** Signature for a single doctor check function. */
export type DoctorCheck = (configDir: string) => Promise<Finding[]>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read settings.json from configDir. Returns {} on missing or invalid JSON. */
function readSettings(configDir: string): Record<string, unknown> {
  const settingsPath = path.join(configDir, "settings.json");
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Count lines in a file. Returns null if file does not exist. */
function countLines(filePath: string): number | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf8");
  return content.split("\n").length;
}

// ---------------------------------------------------------------------------
// Check 1: CLAUDE.md size
// ---------------------------------------------------------------------------
const checkClaudeMdSize: DoctorCheck = async (configDir: string) => {
  const findings: Finding[] = [];
  const candidates: Array<{ label: string; filePath: string }> = [
    { label: "user CLAUDE.md", filePath: path.join(configDir, "CLAUDE.md") },
    { label: "project CLAUDE.md", filePath: path.join(process.cwd(), "CLAUDE.md") },
  ];

  for (const { label, filePath } of candidates) {
    const lineCount = countLines(filePath);
    if (lineCount === null) continue; // file does not exist

    if (lineCount > 200) {
      findings.push({
        level: "warn",
        title: `${label} is ${lineCount} lines (> 200)`,
        detail: `${filePath}\nLoaded into context at every session start. Move task-specific instructions to skills.\nTarget: under 200 lines per official guidance.`,
      });
    } else {
      findings.push({
        level: "ok",
        title: `${label} is ${lineCount} lines (within 200-line limit)`,
        detail: filePath,
      });
    }
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Check 2: Output-limit env caps unset
// ---------------------------------------------------------------------------
const checkOutputLimitCaps: DoctorCheck = async (configDir: string) => {
  const findings: Finding[] = [];
  const settings = readSettings(configDir);
  const env = (settings["env"] ?? {}) as Record<string, unknown>;

  const caps: Array<{ key: string; why: string }> = [
    {
      key: "BASH_MAX_OUTPUT_LENGTH",
      why: "Noisy Bash output flows fully into context; cap it to a char limit (e.g. 20000) so overflow is saved to a file instead.",
    },
    {
      key: "MAX_MCP_OUTPUT_TOKENS",
      why: "Uncapped MCP tool responses can exhaust context; default is 25,000 tokens. Consider 12,000 for routine use.",
    },
  ];

  for (const { key, why } of caps) {
    if (env[key] === undefined) {
      findings.push({
        level: "info",
        title: `${key} not set — no cap on tool output`,
        detail: why,
      });
    }
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Check 3: CLAUDE_CODE_SUBAGENT_MODEL set
// ---------------------------------------------------------------------------
const checkSubagentModelOverride: DoctorCheck = async (configDir: string) => {
  const settings = readSettings(configDir);
  const settingsEnv = (settings["env"] ?? {}) as Record<string, unknown>;
  const inSettings = settingsEnv["CLAUDE_CODE_SUBAGENT_MODEL"] !== undefined;
  const inProcessEnv = process.env["CLAUDE_CODE_SUBAGENT_MODEL"] !== undefined;

  if (inSettings || inProcessEnv) {
    const source = inSettings ? "settings.json env" : "process environment";
    return [
      {
        level: "warn",
        title: "CLAUDE_CODE_SUBAGENT_MODEL is set — overrides ALL agent model frontmatter",
        detail: `Source: ${source}\nThis env var takes highest precedence and silently overrides any per-agent "model:" frontmatter.\nCheap-subagent routing will not apply. Unset it to let agent files control their own models.`,
      },
    ];
  }

  return [];
};

// ---------------------------------------------------------------------------
// Check 4: Agents missing model frontmatter
// ---------------------------------------------------------------------------
const checkAgentsFrontmatter: DoctorCheck = async (configDir: string) => {
  const agentsDir = path.join(configDir, "agents");
  if (!fs.existsSync(agentsDir)) return [];

  const agentFiles = fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"));

  if (agentFiles.length === 0) return [];

  const missing: string[] = [];
  for (const filename of agentFiles) {
    const filePath = path.join(agentsDir, filename);
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    // Look for YAML frontmatter: starts with "---" on line 0
    let hasFrontmatter = false;
    let hasModel = false;
    if (lines[0]?.trim() === "---") {
      hasFrontmatter = true;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === "---") break; // end of frontmatter
        if (/^model\s*:/.test(lines[i]!)) {
          hasModel = true;
          break;
        }
      }
    }

    // Warn only if frontmatter exists but no model field, OR no frontmatter at all
    // (no frontmatter means no model set either)
    if (!hasModel) {
      missing.push(filename);
    }
  }

  if (missing.length === 0) return [];

  const CAP = 10;
  const shown = missing.slice(0, CAP);
  const extra = missing.length - shown.length;
  const fileList = shown.join(", ") + (extra > 0 ? `, and ${extra} more` : "");

  return [
    {
      level: "warn",
      title: `${missing.length} agent file(s) have no "model:" frontmatter`,
      detail: `Files: ${fileList}\nAgents without a model field inherit the main conversation model (possibly a premium model).\nAdd "model: haiku" or "model: sonnet" to each agent's frontmatter.`,
    },
  ];
};

// ---------------------------------------------------------------------------
// Check 5: MCP server count
// ---------------------------------------------------------------------------
const checkMcpServerCount: DoctorCheck = async (configDir: string) => {
  const findings: Finding[] = [];
  let totalCount = 0;
  const sources: string[] = [];

  // Project scope: ./.mcp.json
  const projectMcp = path.join(process.cwd(), ".mcp.json");
  if (fs.existsSync(projectMcp)) {
    try {
      const raw = fs.readFileSync(projectMcp, "utf8");
      const data = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      const count = Object.keys(data.mcpServers ?? {}).length;
      totalCount += count;
      sources.push(`project .mcp.json: ${count}`);
    } catch {
      // ignore malformed
    }
  }

  // User scope: ~/.claude.json (does NOT move with CLAUDE_CONFIG_DIR)
  const claudeJson = path.join(os.homedir(), ".claude.json");
  if (fs.existsSync(claudeJson)) {
    try {
      const raw = fs.readFileSync(claudeJson, "utf8");
      const data = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      const count = Object.keys(data.mcpServers ?? {}).length;
      totalCount += count;
      sources.push(`~/.claude.json: ${count}`);
    } catch {
      // ignore malformed
    }
  }

  if (sources.length === 0) return [];

  const note = totalCount > 10
    ? ` Consider auditing — many MCP servers increase attack surface and can slow startup.`
    : "";

  findings.push({
    level: "info",
    title: `MCP servers configured: ${totalCount} total`,
    detail: sources.join(", ") + "." + note,
  });

  return findings;
};

// ---------------------------------------------------------------------------
// Check 6: Output style active
// ---------------------------------------------------------------------------
const checkOutputStyle: DoctorCheck = async (configDir: string) => {
  const settings = readSettings(configDir);
  const style = settings["outputStyle"];

  if (style !== undefined && style !== null && style !== "") {
    return [
      {
        level: "info",
        title: `Output style set: "${style}"`,
        detail: `Active from settings.json outputStyle. Takes effect after /clear or new session.`,
      },
    ];
  }

  return [
    {
      level: "info",
      title: "No output style set",
      detail: `Setting a concise output style (e.g. "Token Saver") can reduce output tokens significantly.\nSet via settings.json "outputStyle" or /config → Output style.`,
    },
  ];
};

// ---------------------------------------------------------------------------
// Check 7: Statusline present
// ---------------------------------------------------------------------------
const checkStatusline: DoctorCheck = async (configDir: string) => {
  const settings = readSettings(configDir);
  const statusLine = settings["statusLine"];

  if (statusLine !== undefined && statusLine !== null) {
    return [
      {
        level: "ok",
        title: "Custom statusline configured",
        detail: `statusLine: ${JSON.stringify(statusLine)}`,
      },
    ];
  }

  return [
    {
      level: "info",
      title: "No custom statusline configured",
      detail: `A statusline script can show model, context usage, and cost at a glance.\nSet settings.json "statusLine": { "type": "command", "command": "<path>" }.`,
    },
  ];
};

// ---------------------------------------------------------------------------
// Check 8: Hooks disabled
// ---------------------------------------------------------------------------
const checkHooksDisabled: DoctorCheck = async (configDir: string) => {
  const settings = readSettings(configDir);

  if (settings["disableAllHooks"] === true) {
    return [
      {
        level: "warn",
        title: "disableAllHooks is true — all hooks AND custom statusline are disabled",
        detail: `settings.json "disableAllHooks": true\nThis also disables any custom statusline script. Remove or set to false to re-enable hooks.`,
      },
    ];
  }

  return [];
};

// ---------------------------------------------------------------------------
// Check 9: LeanRig backup state
// ---------------------------------------------------------------------------
const checkLeanrigBackupState: DoctorCheck = async (_configDir: string) => {
  const home = leanrigHome();
  const statePath = path.join(home, "state.json");

  if (!fs.existsSync(statePath)) {
    return [
      {
        level: "info",
        title: "No leanrig install found — no rollback backup available",
        detail: `Run "leanrig install claude-code --profile <name>" to install a profile.`,
      },
    ];
  }

  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const state = JSON.parse(raw) as {
      installs?: Array<{ harness: string; profile: string; createdAt: string }>;
      lastInstall?: Record<string, string>;
    };

    const claudeInstalls = (state.installs ?? []).filter(
      (i) => i.harness === "claude-code"
    );

    if (claudeInstalls.length === 0) {
      return [
        {
          level: "info",
          title: "No claude-code install in leanrig state — no rollback backup available",
          detail: `Run "leanrig install claude-code --profile <name>" to create a backup point.`,
        },
      ];
    }

    const last = claudeInstalls[claudeInstalls.length - 1]!;
    return [
      {
        level: "ok",
        title: "Rollback backup available",
        detail: `Profile: ${last.profile}, installed: ${last.createdAt}\nRun "leanrig rollback claude-code" to restore.`,
      },
    ];
  } catch {
    return [
      {
        level: "info",
        title: "Could not read leanrig state.json",
        detail: statePath,
      },
    ];
  }
};

// ---------------------------------------------------------------------------
// Check 10: Third-party tool detection (file-system / settings visible only)
// ---------------------------------------------------------------------------
const checkThirdPartyTools: DoctorCheck = async (configDir: string) => {
  const findings: Finding[] = [];
  const settings = readSettings(configDir);
  const settingsPath = path.join(configDir, "settings.json");

  // ccusage-statusline: check statusLine.command contains "ccusage"
  const statusLine = settings["statusLine"] as Record<string, unknown> | undefined;
  const statusLineCmd = typeof statusLine?.["command"] === "string" ? statusLine["command"] : "";
  if (statusLineCmd.includes("ccusage")) {
    const spec = toolRegistry.find((t) => t.id === "ccusage-statusline")!;
    findings.push({
      level: "info",
      title: `Third-party tool detected: ${spec.title}`,
      detail: `statusLine.command contains "ccusage". ${spec.overlaps ?? ""}`,
    });
  }

  // squeez: binary at <configDir>/squeez/bin/squeez, or settings.json contains "squeez"
  const squeezBin = path.join(configDir, "squeez", "bin", "squeez");
  const settingsRaw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "";
  const squeezDetected = fs.existsSync(squeezBin) || settingsRaw.includes("squeez");
  if (squeezDetected) {
    const spec = toolRegistry.find((t) => t.id === "squeez")!;
    findings.push({
      level: "info",
      title: `Third-party tool detected: ${spec.title}`,
      detail: [spec.description, spec.overlaps].filter(Boolean).join(" "),
    });

    // Overlap: squeez detected AND BASH_MAX_OUTPUT_LENGTH set
    const env = (settings["env"] ?? {}) as Record<string, unknown>;
    if (env["BASH_MAX_OUTPUT_LENGTH"] !== undefined) {
      findings.push({
        level: "info",
        title: "squeez + BASH_MAX_OUTPUT_LENGTH both active",
        detail:
          "Both squeez (output compression) and BASH_MAX_OUTPUT_LENGTH are configured. " +
          "This is generally fine — both work independently — but worth knowing you have double compression active.",
      });
    }
  }

  // caveman: read-only detection via plugins/installed_plugins.json
  if (cavemanInInstalledPlugins(configDir)) {
    const spec = toolRegistry.find((t) => t.id === "caveman")!;
    findings.push({
      level: "info",
      title: `Third-party tool detected: ${spec.title}`,
      detail: [spec.description, spec.overlaps].filter(Boolean).join(" "),
    });

    // Overlap: caveman AND an output style both compress output
    const outputStyle = settings["outputStyle"];
    if (outputStyle !== undefined && outputStyle !== null && outputStyle !== "") {
      findings.push({
        level: "info",
        title: `caveman + output style "${outputStyle}" both active`,
        detail:
          "Both compress Claude's output. They stack, but the docs for each recommend picking one — " +
          "consider removing caveman or unsetting outputStyle.",
      });
    }
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Exported array of all checks
// ---------------------------------------------------------------------------
export const doctorChecks: DoctorCheck[] = [
  checkClaudeMdSize,
  checkOutputLimitCaps,
  checkSubagentModelOverride,
  checkAgentsFrontmatter,
  checkMcpServerCount,
  checkOutputStyle,
  checkStatusline,
  checkHooksDisabled,
  checkLeanrigBackupState,
  checkThirdPartyTools,
];
