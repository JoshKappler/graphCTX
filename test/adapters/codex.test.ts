import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter, hasCodexGraphctxInstall } from "../../src/adapters/codex/index.js";

let workDir: string;
let homeDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "gctx-codex-work-"));
  homeDir = mkdtempSync(join(tmpdir(), "gctx-codex-home-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe("codex adapter", () => {
  it("creates ~/.codex/config.toml with an [mcp_servers.graphctx] block on first install", async () => {
    const adapter = new CodexAdapter(workDir, homeDir);
    await adapter.install({ workspaceDir: workDir, binPath: "graphctx" });
    const cfgPath = join(homeDir, ".codex", "config.toml");
    expect(existsSync(cfgPath)).toBe(true);
    const text = readFileSync(cfgPath, "utf8");
    expect(text).toContain("[mcp_servers.graphctx]");
    expect(text).toContain('command = "graphctx"');
    expect(text).toContain('args = ["serve", "--mcp"]');
    expect(hasCodexGraphctxInstall(homeDir)).toBe(true);
  });

  it("preserves the user's existing config and other MCP servers", async () => {
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    const existing = [
      'model = "gpt-5"',
      'approval_policy = "never"',
      "",
      "[mcp_servers.exa]",
      'url = "https://mcp.exa.ai/mcp"',
      "",
    ].join("\n");
    writeFileSync(join(homeDir, ".codex", "config.toml"), existing, "utf8");

    await new CodexAdapter(workDir, homeDir).install({
      workspaceDir: workDir,
      binPath: "graphctx",
    });

    const result = readFileSync(join(homeDir, ".codex", "config.toml"), "utf8");
    expect(result).toContain('model = "gpt-5"');
    expect(result).toContain('approval_policy = "never"');
    expect(result).toContain("[mcp_servers.exa]");
    expect(result).toContain('url = "https://mcp.exa.ai/mcp"');
    expect(result).toContain("[mcp_servers.graphctx]");
  });

  it("is idempotent: a second install replaces the previous block, not duplicates it", async () => {
    const adapter = new CodexAdapter(workDir, homeDir);
    await adapter.install({ workspaceDir: workDir, binPath: "graphctx" });
    await adapter.install({ workspaceDir: workDir, binPath: "/abs/path/to/graphctx" });
    const text = readFileSync(join(homeDir, ".codex", "config.toml"), "utf8");
    const headers = text.match(/^\[mcp_servers\.graphctx\]/gm) ?? [];
    expect(headers).toHaveLength(1);
    expect(text).toContain('command = "/abs/path/to/graphctx"');
  });

  it("uninstall removes the graphctx block and leaves other config intact", async () => {
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    const existing = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.exa]",
      'url = "https://mcp.exa.ai/mcp"',
      "",
    ].join("\n");
    writeFileSync(join(homeDir, ".codex", "config.toml"), existing, "utf8");

    const adapter = new CodexAdapter(workDir, homeDir);
    await adapter.install({ workspaceDir: workDir, binPath: "graphctx" });
    expect(hasCodexGraphctxInstall(homeDir)).toBe(true);

    await adapter.uninstall();
    expect(hasCodexGraphctxInstall(homeDir)).toBe(false);

    const text = readFileSync(join(homeDir, ".codex", "config.toml"), "utf8");
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain("[mcp_servers.exa]");
    expect(text).not.toContain("[mcp_servers.graphctx]");
  });

  it("uninstall on a fresh home is a no-op", async () => {
    await new CodexAdapter(workDir, homeDir).uninstall();
    expect(existsSync(join(homeDir, ".codex", "config.toml"))).toBe(false);
  });

  it("detect reports Tier 0 + Tier 1 capability", async () => {
    const cap = await new CodexAdapter(workDir, homeDir).detect();
    expect(cap.tiers).toEqual([0, 1]);
    expect(cap.highest).toBe(1);
  });
});

describe("codex adapter TOML splicing against real-world configs", () => {
  const cfgPath = () => join(homeDir, ".codex", "config.toml");
  const writeCfg = (text: string) => {
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    writeFileSync(cfgPath(), text, "utf8");
  };

  it("uninstall keeps a following server whose header carries an inline comment", async () => {
    writeCfg(
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.graphctx]",
        'command = "graphctx"',
        'args = ["serve", "--mcp"]',
        "",
        "# web search server",
        "[mcp_servers.exa] # keep me",
        'url = "https://mcp.exa.ai/mcp"',
        'api_key = "exa-key-123"',
        "",
      ].join("\n"),
    );

    await new CodexAdapter(workDir, homeDir).uninstall();

    const text = readFileSync(cfgPath(), "utf8");
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain("# web search server");
    expect(text).toContain("[mcp_servers.exa] # keep me");
    expect(text).toContain('api_key = "exa-key-123"');
    expect(text).not.toContain("mcp_servers.graphctx");
  });

  it("uninstall keeps a following array-of-tables section", async () => {
    writeCfg(
      [
        "[mcp_servers.graphctx]",
        'command = "graphctx"',
        'args = ["serve", "--mcp"]',
        "",
        "[[profiles]]",
        'name = "work"',
        "",
        "[[profiles]]",
        'name = "home"',
        "",
      ].join("\n"),
    );

    await new CodexAdapter(workDir, homeDir).uninstall();

    const text = readFileSync(cfgPath(), "utf8");
    expect(text.match(/^\[\[profiles\]\]/gm)).toHaveLength(2);
    expect(text).toContain('name = "work"');
    expect(text).toContain('name = "home"');
    expect(text).not.toContain("mcp_servers.graphctx");
  });

  it("reinstall replaces the block without swallowing servers below it", async () => {
    writeCfg(
      [
        "[mcp_servers.graphctx]",
        'command = "graphctx"',
        'args = ["serve", "--mcp"]',
        "",
        "[mcp_servers.exa] # added after graphctx",
        'url = "https://mcp.exa.ai/mcp"',
        "",
      ].join("\n"),
    );

    await new CodexAdapter(workDir, homeDir).install({
      workspaceDir: workDir,
      binPath: "/abs/path/to/graphctx",
    });

    const text = readFileSync(cfgPath(), "utf8");
    expect(text).toContain("[mcp_servers.exa] # added after graphctx");
    expect(text).toContain('url = "https://mcp.exa.ai/mcp"');
    expect(text).toContain('command = "/abs/path/to/graphctx"');
    expect(text.match(/\[mcp_servers\.graphctx\]/g)).toHaveLength(1);
  });

  it("uninstall removes the graphctx env subtable along with the block", async () => {
    writeCfg(
      [
        "[mcp_servers.graphctx]",
        'command = "graphctx"',
        'args = ["serve", "--mcp"]',
        "",
        "[mcp_servers.graphctx.env]",
        'GRAPHCTX_INJECT_TOTAL_BUDGET_TOKENS = "900"',
        "",
        "[mcp_servers.other]",
        'command = "other"',
        "",
      ].join("\n"),
    );

    await new CodexAdapter(workDir, homeDir).uninstall();

    const text = readFileSync(cfgPath(), "utf8");
    expect(text).not.toContain("mcp_servers.graphctx");
    expect(text).not.toContain("GRAPHCTX_INJECT_TOTAL_BUDGET_TOKENS");
    expect(text).toContain("[mcp_servers.other]");
    expect(text).toContain('command = "other"');
  });

  it("reinstall preserves a user's graphctx env subtable", async () => {
    writeCfg(
      [
        "[mcp_servers.graphctx]",
        'command = "graphctx"',
        'args = ["serve", "--mcp"]',
        "",
        "[mcp_servers.graphctx.env]",
        'GRAPHCTX_INJECT_TOTAL_BUDGET_TOKENS = "900"',
        "",
      ].join("\n"),
    );

    await new CodexAdapter(workDir, homeDir).install({
      workspaceDir: workDir,
      binPath: "/abs/path/to/graphctx",
    });

    const text = readFileSync(cfgPath(), "utf8");
    expect(text).toContain('command = "/abs/path/to/graphctx"');
    expect(text).toContain("[mcp_servers.graphctx.env]");
    expect(text).toContain('GRAPHCTX_INJECT_TOTAL_BUDGET_TOKENS = "900"');
    expect(text.match(/\[mcp_servers\.graphctx\]/g)).toHaveLength(1);
  });

  it("reinstall replaces the block when the user annotated our header, instead of duplicating it", async () => {
    writeCfg(
      [
        "[mcp_servers.graphctx] # managed by graphctx",
        'command = "graphctx"',
        'args = ["serve", "--mcp"]',
        "",
      ].join("\n"),
    );

    await new CodexAdapter(workDir, homeDir).install({
      workspaceDir: workDir,
      binPath: "/abs/path/to/graphctx",
    });

    const text = readFileSync(cfgPath(), "utf8");
    expect(text.match(/\[mcp_servers\.graphctx\]/g)).toHaveLength(1);
    expect(text).toContain('command = "/abs/path/to/graphctx"');
  });

  it("uninstall keeps servers below the block in a CRLF config", async () => {
    writeCfg(
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.graphctx]",
        'command = "graphctx"',
        'args = ["serve", "--mcp"]',
        "",
        "[mcp_servers.exa] # crlf config",
        'api_key = "exa-key-123"',
        "",
      ].join("\r\n"),
    );

    await new CodexAdapter(workDir, homeDir).uninstall();

    const text = readFileSync(cfgPath(), "utf8");
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain("[mcp_servers.exa] # crlf config");
    expect(text).toContain('api_key = "exa-key-123"');
    expect(text).not.toContain("mcp_servers.graphctx");
  });
});
