// Per-CLI differences: which files HQ writes into the agent's folder and how
// the agent is launched. Everything else (hooks → state, Team MCP, delivery)
// is shared — Codex and Claude Code send the same hook payloads.

import { agentRead, agentWrite } from "./lib/agentFs";
import type { AgentCli, AgentConfig, HqConfig } from "../src/data/types";
import { adoptRoleFile, excludeFromGit, HOOK_SCRIPT, type RoleExtras, hookCommand, hookScriptFor, hqUrl, isHqRole, MCP_CONFIG, ROLE_FILE, roleMd, writeClaudeFiles, writeHookScript } from "./agentFiles";
import { run } from "./lib/exec";

export interface Launch {
  sbxAgent: string; // agent name for `sbx run`
  args: string[]; // the CLI's own arguments (not shell-quoted)
}

export interface CliAdapter {
  /** Writes HQ's files into the agent's folder (all git-excluded). */
  writeFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string, extras?: RoleExtras): Promise<void>;
  launch(agent: AgentConfig): Launch;
}

// ---------------------------------------------------------------- Claude Code

const claude: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    const ownRole = await adoptRoleFile(dir);
    writeClaudeFiles(dir, agent, cfg, token, { ...extras, ownRole });
  },
  launch(agent) {
    // "Opus" / "Sonnet" / "Haiku" → Claude Code's aliases; anything else is passed as a full model id.
    const m = agent.model.trim();
    const model = !m || /^default$/i.test(m) ? null : /^(opus|sonnet|haiku)$/i.test(m) ? m.toLowerCase() : m;
    // Relative to the agent's folder, where it starts. An absolute path would be the host's, and on
    // Windows the folder has a different path inside the sandbox (C:\x on the host, /c/x in the sandbox).
    return { sbxAgent: "claude", args: ["--mcp-config", MCP_CONFIG, ...(model ? ["--model", model] : [])] };
  },
};

// ---------------------------------------------------------------- Codex

export const CODEX_CONFIG = ".codex/config.toml";
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop", "SessionEnd"];

/** TOML basic string (JSON's escaping is valid TOML for these characters). */
const t = (s: string) => JSON.stringify(s);

export function codexConfig(agent: AgentConfig, cfg: HqConfig, token: string, dir: string, extras: RoleExtras = {}): string {
  const url = hqUrl(agent, cfg.project.hqPort);
  const script = hookScriptFor(agent, dir);
  const lines = [
    "# Written by JSM HQ for this agent (git-excluded). Codex loads it once you trust this folder.",
    `developer_instructions = ${t(roleMd(agent, cfg, extras))}`,
    "",
    "[features]",
    "hooks = true",
    "",
    "[mcp_servers.hq]",
    `url = ${t(`${url}/mcp`)}`,
    `http_headers = { Authorization = ${t(`Bearer ${token}`)}, "X-HQ-Agent" = ${t(agent.id)} }`,
  ];
  for (const event of CODEX_EVENTS)
    lines.push("", `[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${t(hookCommand(url, token, agent.id, event, script))}`);
  return lines.join("\n") + "\n";
}

const codex: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    // A repo that commits its own Codex config can't take HQ's without changing a tracked file.
    const tracked = await run("git", ["ls-files", "--error-unmatch", CODEX_CONFIG], { cwd: dir });
    if (tracked.ok) throw new Error(`This repo commits ${CODEX_CONFIG}, so HQ can't add its Codex settings without changing a tracked file. Use Claude Code for this agent, or remove that file from the repo.`);
    // The role goes in the config (developer_instructions); the folder's own ROLE.md is included, never overwritten.
    const ownRole = await adoptRoleFile(dir);
    agentWrite(dir, CODEX_CONFIG, codexConfig(agent, cfg, token, dir, { ...extras, ownRole }), { mode: 0o600 });
    if (hookScriptFor(agent, dir)) writeHookScript(dir);
    excludeFromGit(dir, [CODEX_CONFIG, HOOK_SCRIPT]);
  },
  launch(agent) {
    const model = agent.model.trim() && !/^default$/i.test(agent.model.trim()) ? agent.model.trim() : null;
    return { sbxAgent: "codex", args: model ? ["-m", model] : [] };
  },
};

// ---------------------------------------------------------------- Antigravity (agy)

export const AGY_MCP_CONFIG = ".agents/mcp_config.json";
export const AGY_HOOKS_CONFIG = ".agents/hooks.json";
export const AGY_RULES_ROLE = ".agents/rules/jsmhq-role.md";

const AGY_EVENTS = ["SessionStart", "PreInvocation", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"] as const;

export function agyHooksConfig(agent: AgentConfig, cfg: HqConfig, token: string, dir: string): Record<string, unknown> {
  const url = hqUrl(agent, cfg.project.hqPort);
  const script = hookScriptFor(agent, dir);
  const hooks: Record<string, unknown> = {};
  for (const event of AGY_EVENTS) {
    const cmd = hookCommand(url, token, agent.id, event, script);
    if (event === "PreToolUse" || event === "PostToolUse") {
      hooks[event] = [{ matcher: "*", hooks: [{ type: "command", command: cmd, timeout: 5 }] }];
    } else {
      hooks[event] = [{ type: "command", command: cmd, timeout: 5 }];
    }
  }
  return { "jsmhq-hooks": hooks };
}

export function agyMcpConfig(agent: AgentConfig, cfg: HqConfig, token: string): Record<string, unknown> {
  const url = hqUrl(agent, cfg.project.hqPort);
  return {
    mcpServers: {
      hq: {
        url: `${url}/mcp`,
        headers: { Authorization: `Bearer ${token}`, "X-HQ-Agent": agent.id },
      },
    },
  };
}

/** Parses JSON with support for comments and trailing commas (JSONC), preserving quoted strings. */
export function parseJsonc<T = unknown>(text: string): T {
  // Pass 1: Strip single-line (//) and block (/* ... */) comments outside of quoted strings.
  let noComments = "";
  let inString = false;
  let isEscaped = false;
  let inSingleComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inSingleComment) {
      if (ch === "\n" || ch === "\r") {
        inSingleComment = false;
        noComments += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      } else if (ch === "\n") {
        noComments += ch;
      }
      continue;
    }
    if (inString) {
      noComments += ch;
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      noComments += ch;
    } else if (ch === "/" && next === "/") {
      inSingleComment = true;
      i++;
    } else if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else {
      noComments += ch;
    }
  }

  // Pass 2: Remove trailing commas before } or ] outside of quoted strings.
  let clean = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (inStr) {
      clean += ch;
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      clean += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < noComments.length && (noComments[j] === " " || noComments[j] === "\t" || noComments[j] === "\n" || noComments[j] === "\r")) {
        j++;
      }
      if (j < noComments.length && (noComments[j] === "}" || noComments[j] === "]")) {
        continue;
      }
    }
    clean += ch;
  }

  return JSON.parse(clean) as T;
}

const antigravity: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    // A repo that commits its own Antigravity config can't take HQ's without changing tracked files or exposing credentials.
    const trackedMcp = await run("git", ["ls-files", "--error-unmatch", AGY_MCP_CONFIG], { cwd: dir });
    if (trackedMcp.ok)
      throw new Error(`This repo commits ${AGY_MCP_CONFIG}, so HQ can't add its MCP configuration without committing credentials to a tracked file. Untrack that file to use Antigravity.`);

    const trackedHooks = await run("git", ["ls-files", "--error-unmatch", AGY_HOOKS_CONFIG], { cwd: dir });
    if (trackedHooks.ok)
      throw new Error(`This repo commits ${AGY_HOOKS_CONFIG}, so HQ can't add its lifecycle hooks without changing a tracked file. Untrack that file to use Antigravity.`);

    // Validate and parse both existing configurations before writing any credential files.
    let existingHooks: Record<string, unknown> = {};
    const hooksText = agentRead(dir, AGY_HOOKS_CONFIG);
    if (hooksText) {
      try {
        existingHooks = parseJsonc<Record<string, unknown>>(hooksText);
      } catch (err) {
        throw new Error(`Failed to parse existing ${AGY_HOOKS_CONFIG}: ${err instanceof Error ? err.message : String(err)}. Fix syntax or remove the file so HQ can manage it safely.`);
      }
    }

    let existingMcp: { mcpServers?: Record<string, unknown> } = {};
    const mcpText = agentRead(dir, AGY_MCP_CONFIG);
    if (mcpText) {
      try {
        existingMcp = parseJsonc<{ mcpServers?: Record<string, unknown> }>(mcpText);
      } catch (err) {
        throw new Error(`Failed to parse existing ${AGY_MCP_CONFIG}: ${err instanceof Error ? err.message : String(err)}. Fix syntax or remove the file so HQ can manage it safely.`);
      }
    }

    const ownRole = await adoptRoleFile(dir);
    const roleContent = roleMd(agent, cfg, { ...extras, ownRole });

    // If GEMINI.md is absent or verified as HQ-owned, write it for instant discovery; do not overwrite an existing user-authored GEMINI.md
    const existingGemini = agentRead(dir, "GEMINI.md");
    const trackedGemini = await run("git", ["ls-files", "--error-unmatch", "GEMINI.md"], { cwd: dir });
    const shouldWriteGemini = !trackedGemini.ok && (existingGemini === null || isHqRole(existingGemini));

    // Exclude credential-bearing files before writing them to disk so a failed write never leaves credentials exposed.
    excludeFromGit(dir, [
      ROLE_FILE,
      AGY_RULES_ROLE,
      AGY_HOOKS_CONFIG,
      AGY_MCP_CONFIG,
      ...(shouldWriteGemini ? ["GEMINI.md"] : []),
      HOOK_SCRIPT,
    ]);

    agentWrite(dir, ROLE_FILE, roleContent);

    // Workspace rules: .agents/rules/jsmhq-role.md (always active)
    agentWrite(dir, AGY_RULES_ROLE, `---\ntrigger: always_on\n---\n${roleContent}`);

    if (shouldWriteGemini) {
      agentWrite(dir, "GEMINI.md", roleContent);
    }

    const hqHooks = agyHooksConfig(agent, cfg, token, dir);
    agentWrite(dir, AGY_HOOKS_CONFIG, JSON.stringify({ ...existingHooks, ...hqHooks }, null, 2) + "\n");

    const hqMcp = agyMcpConfig(agent, cfg, token);
    const mcpServers = { ...(existingMcp.mcpServers ?? {}), ...((hqMcp as { mcpServers: Record<string, unknown> }).mcpServers) };
    agentWrite(dir, AGY_MCP_CONFIG, JSON.stringify({ ...existingMcp, mcpServers }, null, 2) + "\n");

    if (hookScriptFor(agent, dir)) writeHookScript(dir);
  },
  launch(agent) {
    const model = agent.model.trim() && !/^default$/i.test(agent.model.trim()) ? agent.model.trim() : null;
    return { sbxAgent: "agy", args: model ? ["--model", model] : [] };
  },
};

export const adapters: Record<AgentCli, CliAdapter> = { claude, codex, antigravity };

/** The command a Local-mode agent runs on the host. */
export const localBinary: Record<AgentCli, string> = { claude: "claude", codex: "codex", antigravity: "agy" };
