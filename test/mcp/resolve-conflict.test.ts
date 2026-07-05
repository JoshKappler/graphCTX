import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_TOOLS } from "../../src/mcp/tools.js";
import { Runtime } from "../../src/runtime.js";

// PR #9 review regression: equal-precedence contradictory remembers mark BOTH
// facts disputed, but conflictCandidates only queried active-status facts —
// the conflict vanished from resolve_conflict the moment it was created, so
// the surfaced dispute could never be settled through the advertised tool.

const resolveTool = MCP_TOOLS.find((t) => t.name === "resolve_conflict");
if (!resolveTool) throw new Error("resolve_conflict tool not registered");

interface ResolveOutput {
  winners: string[];
  conflicts: Array<{ conflict_id: string; summary: string }>;
}

describe("mcp resolve_conflict reaches disputed facts", () => {
  let dir: string;
  let rt: Runtime;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gctx-resolve-"));
    rt = new Runtime({ workspaceDir: dir, userId: "u" });
  });

  afterEach(() => {
    rt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces a disputed workspace pair as winner + conflict, not {[],[]}", async () => {
    const first = await rt.rememberFact({
      text: "use pnpm for installs",
      subject: "repo",
      predicate: "package_manager",
      kind: "decision",
    });
    const second = await rt.rememberFact({
      text: "use yarn for installs",
      subject: "repo",
      predicate: "package_manager",
      kind: "decision",
    });
    expect(rt.facts.get(first.fact_id)?.status).toBe("disputed");
    expect(rt.facts.get(second.fact_id)?.status).toBe("disputed");

    const out = (await resolveTool.handler(rt, {})) as ResolveOutput;
    const pairWinners = out.winners.filter((id) => id === first.fact_id || id === second.fact_id);
    expect(pairWinners).toHaveLength(1);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]?.summary).toContain("package_manager");
  });

  it("reaches session-scoped disputes only for the referenced session", async () => {
    const first = await rt.rememberFact({
      text: "tabs",
      subject: "repo",
      predicate: "indent_style",
      kind: "decision",
      sessionId: "s1",
    });
    const second = await rt.rememberFact({
      text: "spaces",
      subject: "repo",
      predicate: "indent_style",
      kind: "decision",
      sessionId: "s1",
    });
    expect(rt.facts.get(first.fact_id)?.status).toBe("disputed");
    expect(rt.facts.get(second.fact_id)?.status).toBe("disputed");

    const inSession = (await resolveTool.handler(rt, { session_id: "s1" })) as ResolveOutput;
    expect(inSession.conflicts).toHaveLength(1);
    expect(inSession.conflicts[0]?.summary).toContain("indent_style");

    const outsideSession = (await resolveTool.handler(rt, {})) as ResolveOutput;
    expect(outsideSession.winners).toHaveLength(0);
    expect(outsideSession.conflicts).toHaveLength(0);
  });
});
