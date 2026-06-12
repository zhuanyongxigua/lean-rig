/**
 * Types for the third-party tools registry (v0.2).
 * Harness-agnostic; adapter-specific strings live in adapters/*.
 */

export interface ToolSpec {
  id: string;
  title: string;
  description: string; // what it saves, one line
  license: string;     // SPDX
  source: string;      // homepage/repo URL
  kind: "settings" | "external" | "guide";
  overlaps?: string;   // human-readable overlap warning
}

export interface ToolStatus {
  installed: boolean;
  detail?: string;
}

export type ToolPlan =
  | {
      kind: "settings";
      settingsPath: string; // <configDir>/settings.json
      merge: Record<string, unknown>;
    }
  | {
      kind: "external";
      requires?: string; // binary that must exist
      commands: string[][]; // argv arrays, executed in order
    }
  | {
      kind: "guide";
      instructions: string;
    };
