import fs from "fs";
import path from "path";
import { leanrigHome } from "./paths.js";

export interface StateInstall {
  id: string;
  harness: string;
  profile: string;
  createdAt: string;
}

export interface State {
  version: 1;
  installs: StateInstall[];
  /** Maps harness name -> most recent install id */
  lastInstall: Record<string, string>;
}

function statePath(): string {
  return path.join(leanrigHome(), "state.json");
}

export function readState(): State {
  const p = statePath();
  if (!fs.existsSync(p)) {
    return { version: 1, installs: [], lastInstall: {} };
  }
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw) as State;
}

export function writeState(state: State): void {
  const home = leanrigHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function addInstall(entry: StateInstall): void {
  const state = readState();
  state.installs.push(entry);
  state.lastInstall[entry.harness] = entry.id;
  writeState(state);
}

export function removeInstall(harness: string, id: string): void {
  const state = readState();
  state.installs = state.installs.filter((i) => i.id !== id);
  // Update lastInstall to the previous install for this harness, if any
  const remaining = state.installs
    .filter((i) => i.harness === harness)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (remaining.length > 0) {
    state.lastInstall[harness] = remaining[remaining.length - 1]!.id;
  } else {
    delete state.lastInstall[harness];
  }
  writeState(state);
}

export function getLastInstallId(harness: string): string | null {
  const state = readState();
  return state.lastInstall[harness] ?? null;
}
