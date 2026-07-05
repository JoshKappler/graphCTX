import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";

// `~` in configured storage paths must expand via os.homedir(): on native
// Windows HOME is unset, and expanding against process.env.HOME turned the
// path relative, silently re-rooting the user store inside the workspace.

describe("config path expansion", () => {
  let workDir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "gctx-config-"));
    savedHome = process.env.HOME;
  });

  afterEach(() => {
    if (savedHome === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined" in process.env
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it("expands ~ against os.homedir() even when HOME is unset", () => {
    // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined" in process.env
    delete process.env.HOME;
    const { paths } = loadConfig({
      workspaceDir: workDir,
      overrides: { storage: { user_db: "~/gctx-test/user.db" } },
    });
    expect(paths.userDb).toBe(join(homedir(), "gctx-test", "user.db"));
  });

  it("keeps resolving bare relative paths against the workspace", () => {
    const { paths } = loadConfig({
      workspaceDir: workDir,
      overrides: { storage: { user_db: ".graphctx/custom.db" } },
    });
    expect(paths.userDb).toBe(join(workDir, ".graphctx", "custom.db"));
  });
});
