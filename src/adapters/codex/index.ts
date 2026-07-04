import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AdapterError } from "../../core/errors.js";
import type { Capsule, InjectionContext } from "../../core/types.js";
import type { Adapter, Capability, ChannelTier, InstallOptions } from "../adapter.js";
import { factsFromCapsule, writeAgentsCapsuleFacts } from "../boot-capsule.js";
import { assertWritableConfigPath, isSymlink } from "../config-path.js";

// Codex adapter (OpenAI Codex CLI). Codex has no lifecycle push hooks but is an
// MCP client (Tier 1 riders) and reads AGENTS.md project grounding (Tier 0).
// Install writes a `[mcp_servers.graphctx]` block into `~/.codex/config.toml`
// (user-global, the way Codex itself models MCP servers) plus the workspace
// AGENTS.md floor that init already maintains.
//
// Capability tops out at Tier 1.
export class CodexAdapter implements Adapter {
  readonly id = "codex";
  private readonly workspaceDir: string;
  private readonly homeDir: string;

  constructor(workspaceDir: string, homeDir: string = homedir()) {
    this.workspaceDir = workspaceDir;
    this.homeDir = homeDir;
  }

  async detect(): Promise<Capability> {
    return { tiers: [0, 1], highest: 1 };
  }

  async install(opts: InstallOptions): Promise<void> {
    const bin = opts.binPath ?? "graphctx";
    const codexDir = join(this.homeDir, ".codex");
    const cfgPath = join(codexDir, "config.toml");
    assertWritableConfigPath(codexDir, "Codex config directory");
    assertWritableConfigPath(cfgPath, "Codex config.toml file");
    mkdirSync(codexDir, { recursive: true });

    const existing = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "";
    const next = upsertCodexMcpServer(existing, "graphctx", bin, ["serve", "--mcp"]);
    writeFileSync(cfgPath, next, "utf8");
  }

  async uninstall(): Promise<void> {
    const cfgPath = join(this.homeDir, ".codex", "config.toml");
    if (!existsSync(cfgPath)) return;
    assertWritableConfigPath(cfgPath, "Codex config.toml file");
    const existing = readFileSync(cfgPath, "utf8");
    const next = removeCodexMcpServer(existing, "graphctx");
    writeFileSync(cfgPath, next, "utf8");
  }

  async deliver(capsule: Capsule, _ctx: InjectionContext, _tier: ChannelTier): Promise<void> {
    writeAgentsCapsuleFacts(this.workspaceDir, factsFromCapsule(capsule));
  }
}

export function hasCodexGraphctxInstall(homeDir: string = homedir()): boolean {
  const cfgPath = join(homeDir, ".codex", "config.toml");
  if (!existsSync(cfgPath)) return false;
  if (isSymlink(cfgPath)) return false;
  try {
    const text = readFileSync(cfgPath, "utf8");
    return findMcpServerBlock(text, "graphctx") !== null;
  } catch {
    return false;
  }
}

// ---------- minimal TOML splicing helpers ----------
//
// Codex config.toml may already contain other top-level tables, settings, and
// MCP servers we MUST NOT touch. We intentionally do not parse/rewrite the
// whole file; we just splice (or replace, or remove) the single
// `[mcp_servers.<name>]` block we own. This is robust to whatever else the
// user has configured.

interface BlockSpan {
  // Inclusive start of the header line (offset in file).
  start: number;
  // Exclusive end (offset just after the block's trailing newline).
  end: number;
}

// Recognizes a TOML table (`[key]`) or array-of-tables (`[[key]]`) header
// line, tolerating leading whitespace, an inline trailing comment, and CRLF.
// Returns the dotted key with whitespace around dots trimmed, or null when the
// line is not a header. Quoted key segments containing `]` or `#` are outside
// this grammar (we never write them; unrecognized lines stay untouched).
function tableHeaderKey(line: string): string | null {
  const m = /^\s*(\[\[|\[)([^\]]+)(\]\]|\])\s*(?:#.*)?$/.exec(line.replace(/\r$/, ""));
  const key = m?.[2];
  if (!m || key === undefined) return null;
  if ((m[1] === "[[") !== (m[3] === "]]")) return null;
  return key
    .split(".")
    .map((part) => part.trim())
    .join(".");
}

// Finds the span of the `[mcp_servers.<name>]` table via a line scan (a bare
// next-header regex misses commented headers and `[[array]]` tables, which
// made the block swallow whatever followed it). `withSubtables` extends the
// span across `[mcp_servers.<name>.*]` subtables: uninstall removes them so
// no orphaned subtable re-creates the server table; upsert leaves them alone
// so a user's env subtable survives updates. The span ends before trailing
// blank/comment-only lines so a comment attached to the next table survives.
function findMcpServerBlock(text: string, name: string, withSubtables = false): BlockSpan | null {
  const owned = `mcp_servers.${name}`;
  let start = -1;
  let end = -1;
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineEnd = Math.min(offset + line.length + 1, text.length);
    const key = tableHeaderKey(line);
    if (start < 0) {
      if (key === owned) {
        start = offset;
        end = lineEnd;
      }
    } else if (key !== null && key !== owned && !(withSubtables && key.startsWith(`${owned}.`))) {
      break;
    } else {
      const bare = line.replace(/\r$/, "").trim();
      if (bare.length > 0 && !bare.startsWith("#")) end = lineEnd;
    }
    offset += line.length + 1;
  }
  if (start < 0) return null;
  return { start, end };
}

function upsertCodexMcpServer(text: string, name: string, command: string, args: string[]): string {
  const block = renderMcpServerBlock(name, command, args);
  const existing = findMcpServerBlock(text, name);
  if (!existing) {
    const base = text.length === 0 ? "" : text.endsWith("\n") ? text : `${text}\n`;
    const sep = base.length > 0 && !base.endsWith("\n\n") ? "\n" : "";
    return `${base}${sep}${block}`;
  }
  return `${text.slice(0, existing.start)}${block}${text.slice(existing.end).replace(/^(?:\r?\n)+/, "\n")}`;
}

function removeCodexMcpServer(text: string, name: string): string {
  const existing = findMcpServerBlock(text, name, true);
  if (!existing) return text;
  const before = text
    .slice(0, existing.start)
    .replace(/(?:\r?\n)+$/, (m) => (m.startsWith("\r") ? "\r\n" : "\n"));
  const after = text.slice(existing.end).replace(/^(?:\r?\n)+/, "");
  if (before.length === 0) return after;
  if (after.length === 0) return before;
  return `${before}\n${after}`;
}

function renderMcpServerBlock(name: string, command: string, args: string[]): string {
  const tomlArgs = args.map((a) => tomlString(a)).join(", ");
  return `[mcp_servers.${name}]\ncommand = ${tomlString(command)}\nargs = [${tomlArgs}]\n`;
}

function tomlString(s: string): string {
  // TOML basic string: escape backslashes and quotes; preserve other UTF-8 bytes.
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

// Exposed for tests.
export const __internals = {
  findMcpServerBlock,
  upsertCodexMcpServer,
  removeCodexMcpServer,
  renderMcpServerBlock,
};
