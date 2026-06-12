import type { Finding } from "../core/report.js";
import type { InstallPlan } from "../core/installer.js";
import type { ToolSpec, ToolStatus, ToolPlan } from "./toolTypes.js";

export type { ToolSpec, ToolStatus, ToolPlan };

export interface DetectResult {
  installed: boolean;
  configDir: string;
  detail?: string;
}

export interface AdapterInstallOptions {
  force: boolean;
}

export interface Adapter {
  name: string;
  detect(): Promise<DetectResult>;
  doctor(): Promise<Finding[]>;
  planInstall(
    profileName: string,
    opts: AdapterInstallOptions
  ): Promise<InstallPlan>;
  /** List available profile names */
  listProfiles(): Promise<string[]>;

  // Optional third-party tools registry methods (v0.2)
  listTools?(): Promise<Array<{ spec: ToolSpec; status: ToolStatus }>>;
  detectTool?(id: string): Promise<ToolStatus>;
  planAddTool?(id: string): Promise<ToolPlan>;
  planRemoveTool?(id: string): Promise<ToolPlan>;
}

/** Global adapter registry: name -> Adapter */
const registry = new Map<string, Adapter>();

export function registerAdapter(adapter: Adapter): void {
  registry.set(adapter.name, adapter);
}

export function getAdapter(name: string): Adapter | undefined {
  return registry.get(name);
}

export function listAdapters(): string[] {
  return [...registry.keys()];
}
