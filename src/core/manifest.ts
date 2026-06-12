import fs from "fs";
import path from "path";

export interface ManifestFile {
  target: string;
  existedBefore: boolean;
  backupRelPath: string | null;
  writtenHash: string;
}

export interface ManifestSettings {
  path: string;
  existedBefore: boolean;
  backupRelPath: string | null;
  writtenHash: string;
}

export interface Manifest {
  version: 1;
  harness: string;
  profile: string;
  createdAt: string;
  configDir: string;
  files: ManifestFile[];
  settings?: ManifestSettings;
}

export function writeManifest(backupDir: string, manifest: Manifest): void {
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, "manifest.json");
  fs.writeFileSync(dest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export function readManifest(backupDir: string): Manifest | null {
  const src = path.join(backupDir, "manifest.json");
  if (!fs.existsSync(src)) return null;
  const raw = fs.readFileSync(src, "utf8");
  return JSON.parse(raw) as Manifest;
}
