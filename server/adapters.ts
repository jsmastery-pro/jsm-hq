// Per-CLI differences: which files HQ writes into the agent's folder and how
// the agent is launched. Everything else (hooks → state, Team MCP, delivery)
// is shared — Codex and Claude Code send the same hook payloads.

import { agentRead, agentWrite } from "./lib/agentFs";
import type { AgentCli, AgentConfig, HqConfig } from "../src/data/types";
import { adoptRoleFile, excludeFromGit, HOOK_SCRIPT, type RoleExtras, hookCommand, hookScriptFor, hqUrl, MCP_CONFIG, ROLE_FILE, roleMd, writeClaudeFiles, writeHookScript } from "./agentFiles";
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

const antigravity: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    const ownRole = await adoptRoleFile(dir);
    const roleContent = roleMd(agent, cfg, { ...extras, ownRole });
    agentWrite(dir, ROLE_FILE, roleContent);

    // Workspace rules: .agents/rules/jsmhq-role.md (always active)
    agentWrite(dir, AGY_RULES_ROLE, `---\ntrigger: always_on\n---\n${roleContent}`);

    // If GEMINI.md is not tracked by the repo, write it too for instant rule discovery
    const trackedGemini = await run("git", ["ls-files", "--error-unmatch", "GEMINI.md"], { cwd: dir });
    if (!trackedGemini.ok) {
      agentWrite(dir, "GEMINI.md", roleContent);
    }

    // Merge or write .agents/hooks.json
    let existingHooks: Record<string, unknown> = {};
    const hooksText = agentRead(dir, AGY_HOOKS_CONFIG);
    if (hooksText) {
      try {
        existingHooks = JSON.parse(hooksText) as Record<string, unknown>;
      } catch {}
    }
    const hqHooks = agyHooksConfig(agent, cfg, token, dir);
    agentWrite(dir, AGY_HOOKS_CONFIG, JSON.stringify({ ...existingHooks, ...hqHooks }, null, 2) + "\n");

    // Merge or write .agents/mcp_config.json
    let existingMcp: { mcpServers?: Record<string, unknown> } = {};
    const mcpText = agentRead(dir, AGY_MCP_CONFIG);
    if (mcpText) {
      try {
        existingMcp = JSON.parse(mcpText) as { mcpServers?: Record<string, unknown> };
      } catch {}
    }
    const hqMcp = agyMcpConfig(agent, cfg, token);
    const mcpServers = { ...(existingMcp.mcpServers ?? {}), ...((hqMcp as { mcpServers: Record<string, unknown> }).mcpServers) };
    agentWrite(dir, AGY_MCP_CONFIG, JSON.stringify({ ...existingMcp, mcpServers }, null, 2) + "\n");

    if (hookScriptFor(agent, dir)) writeHookScript(dir);
    excludeFromGit(dir, [
      ROLE_FILE,
      AGY_RULES_ROLE,
      AGY_HOOKS_CONFIG,
      AGY_MCP_CONFIG,
      ...(trackedGemini.ok ? [] : ["GEMINI.md"]),
      HOOK_SCRIPT,
    ]);
  },
  launch(agent) {
    const model = agent.model.trim() && !/^default$/i.test(agent.model.trim()) ? agent.model.trim() : null;
    return { sbxAgent: "agy", args: model ? ["--model", model] : [] };
  },
};

export const adapters: Record<AgentCli, CliAdapter> = { claude, codex, antigravity };

/** The command a Local-mode agent runs on the host. */
export const localBinary: Record<AgentCli, string> = { claude: "claude", codex: "codex", antigravity: "agy" };
