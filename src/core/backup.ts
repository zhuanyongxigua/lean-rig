import fs from "fs";
import path from "path";
import crypto from "crypto";

export function hashContent(content: string | Buffer): string {
  return crypto
    .createHash("sha256")
    .update(typeof content === "string" ? Buffer.from(content, "utf8") : content)
    .digest("hex");
}

export function hashFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Generate a unique backup ID using a sanitized ISO timestamp + 4 random hex chars.
 */
export function generateBackupId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_");
  const rand = crypto.randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

/**
 * Copy `src` into `backupDir`, preserving its relative structure within a
 * named slot. Returns the relative path used inside backupDir.
 */
export function backupFile(
  srcAbs: string,
  backupDir: string,
  relName: string
): string {
  const dest = path.join(backupDir, relName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(srcAbs, dest);
  return relName;
}

/**
 * Restore `backupDir/relName` to `destAbs`. Creates parent dirs as needed.
 */
export function restoreFile(
  backupDir: string,
  relName: string,
  destAbs: string
): void {
  const src = path.join(backupDir, relName);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(src, destAbs);
}

/**
 * Delete `filePath` and then prune any ancestor directories that become
 * empty, stopping at `stopAt` (exclusive).
 */
export function deleteAndPruneDirs(filePath: string, stopAt: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // best effort
    return;
  }
  let dir = path.dirname(filePath);
  while (dir !== stopAt && dir.startsWith(stopAt + path.sep)) {
    try {
      const entries = fs.readdirSync(dir);
      if (entries.length === 0) {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}
