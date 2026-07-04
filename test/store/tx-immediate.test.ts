import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../../src/runtime.js";
import { type DB, openDb, tx, txImmediate } from "../../src/store/db.js";

// Two connections to one WAL database, interleaved in-process. A deferred
// read-modify-write transaction snapshots at its first read; if another
// connection commits a write before the deferred tx's first write, that write
// dies with SQLITE_BUSY_SNAPSHOT — and busy_timeout does NOT retry snapshot
// conflicts. That is the promotion-sweep shape (two SessionEnd hooks, or a
// hook racing the MCP daemon, on one workspace DB): the I9 swallow hides the
// error and the ended session's promotions are lost for good.

const errCode = (e: unknown): string => (e as { code?: string }).code ?? "";

describe("read-modify-write transactions under write contention", () => {
  let dir: string;
  let a: DB;
  let b: DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gctx-txim-"));
    const file = join(dir, "workspace.db");
    a = openDb(file);
    b = openDb(file);
    a.exec("CREATE TABLE IF NOT EXISTS scratch (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
  });

  afterEach(() => {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("deferred read-modify-write dies mid-transaction on a snapshot conflict", () => {
    let code = "";
    try {
      tx(a, () => {
        a.prepare("SELECT count(*) AS c FROM scratch").get(); // take the read snapshot
        b.prepare("INSERT INTO scratch (v) VALUES ('other')").run(); // concurrent writer commits
        a.prepare("INSERT INTO scratch (v) VALUES ('mine')").run(); // deferred upgrade fails
      });
    } catch (e) {
      code = errCode(e);
    }
    expect(code).toBe("SQLITE_BUSY_SNAPSHOT");
  });

  it("txImmediate takes the write lock up front so the in-flight sweep cannot be poisoned", () => {
    // With the write lock held from BEGIN, the concurrent writer is the one
    // that fails — fast, with plain retryable SQLITE_BUSY at its own boundary —
    // while the read-modify-write completes and commits.
    b.exec("PRAGMA busy_timeout = 50");
    let concurrentCode = "";
    const result = txImmediate(a, () => {
      a.prepare("SELECT count(*) AS c FROM scratch").get();
      try {
        b.prepare("INSERT INTO scratch (v) VALUES ('other')").run();
      } catch (e) {
        concurrentCode = errCode(e);
      }
      a.prepare("INSERT INTO scratch (v) VALUES ('mine')").run();
      return "committed";
    });
    expect(result).toBe("committed");
    expect(concurrentCode).toBe("SQLITE_BUSY");
    const rows = a.prepare("SELECT v FROM scratch ORDER BY id").all() as Array<{ v: string }>;
    expect(rows.map((r) => r.v)).toEqual(["mine"]);
  });
});

describe("read-modify-write call sites run BEGIN IMMEDIATE", () => {
  let dir: string;
  let rt: Runtime;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gctx-txim-rt-"));
    rt = new Runtime({ workspaceDir: dir, userId: "u" });
  });

  afterEach(() => {
    rt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the promotion sweep uses the immediate transaction", async () => {
    let immediateCalls = 0;
    const original = rt.facts.transactionImmediate.bind(rt.facts);
    rt.facts.transactionImmediate = (fn) => {
      immediateCalls += 1;
      return original(fn);
    };
    await rt.runPromotionSweep("s1");
    expect(immediateCalls).toBeGreaterThan(0);
  });

  it("the invalidator apply path uses the immediate transaction", async () => {
    let immediateCalls = 0;
    const original = rt.facts.transactionImmediate.bind(rt.facts);
    rt.facts.transactionImmediate = (fn) => {
      immediateCalls += 1;
      return original(fn);
    };
    const first = await rt.rememberFact({
      text: "use pnpm",
      subject: "repo",
      predicate: "package_manager",
      kind: "decision",
    });
    await rt.rememberFact({
      text: "use yarn",
      subject: "repo",
      predicate: "package_manager",
      kind: "decision",
      baseSeenFactId: first.fact_id,
    });
    expect(immediateCalls).toBeGreaterThan(0);
  });
});
