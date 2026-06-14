/**
 * Command runner used for read-only third-party tool *detection*
 * (e.g. `claude plugin list`, `lean-ctx --version`).
 *
 * leanrig never installs or uninstalls third-party tools on the user's
 * behalf, so there is no add/remove engine here — only this read-only probe
 * helper. Recommendations and official install commands are surfaced by
 * `leanrig tools` and the leanrig-doctor skill; the user runs them manually.
 */
import { spawnSync } from "child_process";

export interface CommandRunner {
  run(argv: string[]): { code: number; stdout: string; stderr: string };
}

export const realRunner: CommandRunner = {
  run(argv: string[]) {
    const [cmd, ...args] = argv;
    if (!cmd) return { code: 1, stdout: "", stderr: "empty argv" };
    const result = spawnSync(cmd, args, { shell: false, encoding: "utf8" });
    return {
      code: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  },
};
