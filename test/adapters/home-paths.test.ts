import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installClaudeHooks,
  uninstallClaudeHooks,
} from "../../src/adapters/claude-code/install.js";
import { skillPath } from "../../src/adapters/skill/index.js";

// On native Windows HOME is normally unset (the profile lives in USERPROFILE),
// so any user-global path derived from process.env.HOME silently degrades to a
// relative path and lands wherever the process happens to run. User-global
// destinations must derive from os.homedir(), which resolves on every platform.

describe("user-global paths derive from os.homedir(), not $HOME", () => {
  let savedHome: string | undefined;
  let savedProfile: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
  });

  afterEach(() => {
    if (savedHome === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined" in process.env
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedProfile === undefined) {
      // biome-ignore lint/performance/noDelete: same env-coercion reason as HOME above
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedProfile;
    }
  });

  it("skillPath(codex) stays absolute when HOME is unset", () => {
    // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined" in process.env
    delete process.env.HOME;
    const p = skillPath("codex", join(tmpdir(), "ws-unused"));
    expect(isAbsolute(p)).toBe(true);
    expect(p).toBe(join(homedir(), ".codex", "skills", "graphctx", "SKILL.md"));
  });

  it.runIf(process.platform === "win32")(
    "global claude hook install lands in the user profile when HOME is unset",
    () => {
      const fakeProfile = mkdtempSync(join(tmpdir(), "gctx-profile-"));
      try {
        // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined" in process.env
        delete process.env.HOME;
        process.env.USERPROFILE = fakeProfile;
        const { settingsPath } = installClaudeHooks({
          workspaceDir: join(tmpdir(), "ws-unused"),
          global: true,
          binPath: "graphctx",
        });
        expect(settingsPath).toBe(join(fakeProfile, ".claude", "settings.json"));
        expect(existsSync(settingsPath)).toBe(true);
        const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(settings.hooks.SessionStart).toBeDefined();
        uninstallClaudeHooks({ workspaceDir: join(tmpdir(), "ws-unused"), global: true });
      } finally {
        rmSync(fakeProfile, { recursive: true, force: true });
      }
    },
  );
});
