/**
 * Types for the third-party tools registry.
 *
 * Design: leanrig is an aggregator/recommender, never an installer of
 * third-party software. The registry stores metadata plus the *official*
 * install/remove instructions as text. leanrig displays these (via
 * `leanrig tools` and the leanrig-doctor skill) but never executes them —
 * the user runs the commands themselves through each tool's official channel.
 * Harness-agnostic; adapter-specific strings live in adapters/*.
 */

export interface ToolSpec {
  id: string;
  title: string;
  description: string; // what it saves, one line
  license: string;     // SPDX
  source: string;      // homepage/repo URL
  /** Official install instructions, shown to the user — never run by leanrig. */
  install: string;
  /** Optional official uninstall instructions, shown to the user. */
  remove?: string;
  overlaps?: string;   // human-readable overlap warning
}

export interface ToolStatus {
  installed: boolean;
  detail?: string;
}
