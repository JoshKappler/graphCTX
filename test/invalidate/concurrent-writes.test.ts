import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../../src/runtime.js";

// STATUS §14 advertises "never silent LWW", and reconcileWrite (SPEC §14)
// implements it — but the live write path (learn → classifyRelation) resolved
// two parallel sessions' default remembers as `refines`: the newer fact
// silently superseded the older with no dispute surfaced. These tests pin the
// guard to the REAL path: a contradicting durable write at equal precedence
// only supersedes when the writer provably saw the value it replaces.

describe("concurrent contradictory durable writes (live path)", () => {
  let dir: string;
  let rt: Runtime;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gctx-race-"));
    rt = new Runtime({ workspaceDir: dir, userId: "u" });
  });

  afterEach(() => {
    rt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a contradicting remember that never saw the current value disputes instead of superseding", async () => {
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

    const older = rt.facts.get(first.fact_id);
    const newer = rt.facts.get(second.fact_id);
    expect(older?.status).toBe("disputed");
    expect(newer?.status).toBe("disputed");
    const kinds = rt.edges.touching(first.fact_id).map((e) => e.edge_kind);
    expect(kinds).toContain("CONFLICTS_WITH");
  });

  it("an update that provably saw the current value supersedes cleanly", async () => {
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
      baseSeenFactId: first.fact_id,
    });

    const older = rt.facts.get(first.fact_id);
    expect(older?.status).toBe("superseded");
    expect(older?.time.invalidated_by).toBe(second.fact_id);
    expect(rt.facts.get(second.fact_id)?.status).toBe("active");
  });

  it("an interactive update via currentFactIdFor supersedes like the CLI does", async () => {
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
      baseSeenFactId: rt.currentFactIdFor("repo", "package_manager"),
    });

    expect(rt.currentFactIdFor("repo", "package_manager")).toBe(second.fact_id);
    expect(rt.facts.get(first.fact_id)?.status).toBe("superseded");
    expect(rt.facts.get(second.fact_id)?.status).toBe("active");
  });

  it("higher-precedence trusted value still supersedes lower-trust prose without a dispute", async () => {
    const prose = await rt.learn({
      subject: "repo",
      predicate: "package_manager",
      object: "npm",
      fact_kind: "constraint",
      temporal_kind: "static",
      scope: { user_id: "u", workspace_id: rt.workspaceId },
      trust_tier: "low",
      status: "active",
      promotion_state: "workspace_active",
      source: { asserted_by: "deterministic_parser", event_ids: [] },
    });
    const decision = await rt.rememberFact({
      text: "pnpm",
      subject: "repo",
      predicate: "package_manager",
      kind: "decision",
    });

    expect(rt.facts.get(prose.fact_id)?.status).toBe("superseded");
    expect(rt.facts.get(decision.fact_id)?.status).toBe("active");
  });

  it("deterministic re-extraction still refreshes parser facts without a dispute", async () => {
    const v1 = await rt.learn({
      subject: "repo",
      predicate: "test_command",
      object: "npm test",
      fact_kind: "procedural",
      temporal_kind: "static",
      scope: { user_id: "u", workspace_id: rt.workspaceId },
      trust_tier: "high",
      status: "active",
      promotion_state: "workspace_active",
      source: { asserted_by: "deterministic_parser", event_ids: [] },
    });
    const v2 = await rt.learn({
      subject: "repo",
      predicate: "test_command",
      object: "pnpm test",
      fact_kind: "procedural",
      temporal_kind: "static",
      scope: { user_id: "u", workspace_id: rt.workspaceId },
      trust_tier: "high",
      status: "active",
      promotion_state: "workspace_active",
      source: { asserted_by: "deterministic_parser", event_ids: [] },
    });

    expect(rt.facts.get(v1.fact_id)?.status).toBe("superseded");
    expect(rt.facts.get(v2.fact_id)?.status).toBe("active");
  });
});
