// The files HQ writes into each agent's folder. All of them are listed in the
// clone's .git/info/exclude, so they are never committed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, HqConfig } from "../src/data/types";

/** Team MCP config, passed with `claude --mcp-config` (so the project's own .mcp.json is untouched). */
export const MCP_CONFIG = ".claude/hq-mcp.json";
export const HQ_FILES = ["ROLE.md", ".claude/settings.local.json", MCP_CONFIG];
const MARK = "# jsmhq-hook";

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop", "SessionEnd"] as const;

/** URL agents use to reach HQ: through the sandbox proxy, or straight to localhost. */
export function hqUrl(agent: AgentConfig, port: number): string {
  return agent.mode === "sandbox" ? `http://host.docker.internal:${port}` : `http://127.0.0.1:${port}`;
}

export function roleMd(agent: AgentConfig, cfg: HqConfig): string {
  const team = cfg.team.map((a) => `- ${a.name} — ${a.role}${a.isLead ? " (lead)" : ""}${a.id === agent.id ? " ← you" : ""}`).join("\n");
  const rules = agent.isLead
    ? [
        "You plan the work and assign it to the team. You never write app code.",
        "Keep tasks small: one task = one branch = one PR. Give each task the files it may edit and a clear done-when.",
        "Assign only to agents that are running and free (check list_workers).",
        "Decide merge order and resolve conflicts between PRs.",
      ]
    : [
        "Work only on the task you were given. One task = one branch = one PR.",
        "When HQ tells you to start a task, call get_my_task first, then `git pull origin main` and create a branch.",
        "Edit only the files the task lists. Need another file? Ask the lead with send_message.",
        "Title PRs `[TASK-ID] Short title` and open them with `gh pr create`, then call set_my_status in-review with the PR number.",
        "set_my_status tells the lead automatically. Don't also send_message the same news.",
        "If you are blocked or need a decision, call set_my_status blocked with the reason.",
      ];
  const tools = agent.isLead
    ? "list_workers, get_status, list_tasks, create_board, create_task, update_task, assign_task, send_message"
    : "get_my_task, set_my_status, list_workers, get_status, list_tasks, send_message";
  return [
    `# ${agent.name} — ${agent.role}`,
    "",
    agent.roleMd.trim(),
    "",
    "## Team",
    team,
    "",
    "## Rules",
    ...rules.map((r) => `- ${r}`),
    "",
    "## Team MCP (server `hq`)",
    `Your tools: ${tools}.`,
    "Messages that start with `[HQ]` come from JSM HQ: assignments from the lead, or messages from teammates. Act on them.",
    "Teammates work in their own sandboxes and cannot see your files or terminal. Talk to them only with send_message.",
    "",
    `Project: ${cfg.project.name} (${cfg.project.repo}). You are managed by JSM HQ.`,
    "",
  ].join("\n");
}

type HookEntry = { matcher?: string; hooks: { type: "command"; command: string; timeout?: number }[] };
type Settings = { hooks?: Record<string, HookEntry[]>; permissions?: { allow?: string[]; [k: string]: unknown }; [k: string]: unknown };

function hookCommand(url: string, token: string, agentId: string, event: string): string {
  // Stop prints HQ's reply: {"decision":"block","reason":…} hands over queued messages.
  const out = event === "Stop" ? "2>/dev/null" : ">/dev/null 2>&1";
  return `curl -sf -m 4 -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' --data-binary @- '${url}/hook/${agentId}/${event}' ${out} || true ${MARK}`;
}

/**
 * Hooks report state to HQ. SessionStart also prints ROLE.md, which Claude Code
 * adds to the session's context. Existing user hooks are kept.
 */
export function writeSettings(dir: string, agent: AgentConfig, port: number, token: string) {
  const file = join(dir, ".claude", "settings.local.json");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  let settings: Settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Settings;
    } catch {
      settings = {};
    }
  }
  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) };
  const url = hqUrl(agent, port);
  for (const event of HOOK_EVENTS) {
    const kept = (hooks[event] ?? [])
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !h.command.includes(MARK)) }))
      .filter((e) => e.hooks.length);
    const ours: HookEntry["hooks"] = [{ type: "command", command: hookCommand(url, token, agent.id, event), timeout: 5 }];
    if (event === "SessionStart") ours.unshift({ type: "command", command: `cat "$CLAUDE_PROJECT_DIR/ROLE.md" 2>/dev/null || true ${MARK}` });
    hooks[event] = [...kept, event === "PreToolUse" ? { matcher: "*", hooks: ours } : { hooks: ours }];
  }
  // Let the agent use the Team MCP without a permission prompt for every call.
  const allow = new Set([...(settings.permissions?.allow ?? []), "mcp__hq"]);
  writeFileSync(file, JSON.stringify({ ...settings, hooks, permissions: { ...(settings.permissions ?? {}), allow: [...allow] } }, null, 2) + "\n");
}

/** Team MCP config: HQ's URL plus this agent's identity and token. */
export function writeMcpConfig(dir: string, agent: AgentConfig, port: number, token: string) {
  const config = {
    mcpServers: {
      hq: { type: "http", url: `${hqUrl(agent, port)}/mcp`, headers: { Authorization: `Bearer ${token}`, "X-HQ-Agent": agent.id } },
    },
  };
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, MCP_CONFIG), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export function writeAgentFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string) {
  writeFileSync(join(dir, "ROLE.md"), roleMd(agent, cfg));
  writeSettings(dir, agent, cfg.project.hqPort, token);
  writeMcpConfig(dir, agent, cfg.project.hqPort, token);
  excludeFromGit(dir, HQ_FILES);
}

/** Adds paths to .git/info/exclude (a per-clone .gitignore that is never committed). */
export function excludeFromGit(dir: string, paths: string[]) {
  const infoDir = join(dir, ".git", "info");
  if (!existsSync(join(dir, ".git"))) return;
  mkdirSync(infoDir, { recursive: true });
  const file = join(infoDir, "exclude");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const missing = paths.filter((p) => !current.split("\n").includes(p));
  if (missing.length) writeFileSync(file, current + (current.endsWith("\n") || !current ? "" : "\n") + "# JSM HQ\n" + missing.join("\n") + "\n");
}
