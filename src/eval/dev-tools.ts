import { join } from "node:path";

// JS entry points for the dev tools the eval suites and tests spawn.
// Spawned via process.execPath instead of the node_modules/.bin shims: on
// win32 those shims are .cmd batch files, which execFile refuses to spawn
// without shell:true (CVE-2024-27980 hardening), failing with EINVAL.
// Running the current node binary against each tool's real entry is
// shim-free, injection-safe, and identical on every platform.

export function tsxEntry(repoRoot: string): string {
  return join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
}

export function vitestEntry(repoRoot: string): string {
  return join(repoRoot, "node_modules", "vitest", "vitest.mjs");
}

export function biomeEntry(repoRoot: string): string {
  return join(repoRoot, "node_modules", "@biomejs", "biome", "bin", "biome");
}
