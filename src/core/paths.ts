import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

/**
 * Returns the leanrig home directory.
 * Reads LEANRIG_HOME at call time (not module load time) so tests can override.
 */
export function leanrigHome(): string {
  return process.env["LEANRIG_HOME"] ?? path.join(homeDir(), ".leanrig");
}

/**
 * Returns the OS home directory.
 */
export function homeDir(): string {
  const h = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!h) throw new Error("Cannot determine home directory");
  return h;
}

/**
 * Walk up from `startDir` to find the nearest directory containing a
 * package.json with `name === "leanrig"`. This resolves the package root
 * whether running from compiled dist/ or from source via vitest.
 */
export function findPackageRoot(startDir: string): string {
  let dir = startDir;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, "utf8");
        const pkg = JSON.parse(raw) as { name?: string };
        if (pkg.name === "leanrig") {
          return dir;
        }
      } catch {
        // malformed package.json — keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find leanrig package root walking up from ${startDir}`
      );
    }
    dir = parent;
  }
}

/**
 * Resolve the package root from the current module's location.
 * Works from both src/ (vitest) and dist/ (tsc output).
 */
export function packageRoot(): string {
  // import.meta.url points to this file (paths.ts / paths.js)
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  return findPackageRoot(thisDir);
}
