// The files HQ writes into each agent's folder. All of them are listed in the
// clone's .git/info/exclude, so they are never committed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, HqConfig } from "../src/data/types";

/** Team MCP config, passed with `claude --mcp-config` (so the project's own .mcp.json is untouched). */
export const MCP_CONFIG = ".claude/hq-mcp.json";
/** Local mode on Windows: hooks run this with node (no sh or curl there). */
export const HOOK_SCRIPT = ".jsmhq-hook.mjs";
export const HQ_FILES = ["ROLE.md", ".claude/settings.local.json", MCP_CONFIG, HOOK_SCRIPT];
export const MARK = "# jsmhq-hook";
/** Same marker for node hook commands (cmd and PowerShell have no `#` comments). */
const MARK_ARG = "--jsmhq-hook";
const isOurs = (command: string) => command.includes(MARK) || command.includes(MARK_ARG);

/**
 * Hooks run where the agent runs. Sandboxes are Linux, so they use sh + curl;
 * a Local-mode agent on Windows uses the node script instead.
 * HQ_NODE_HOOKS=1 forces the script (to test it on macOS/Linux).
 */
export function hookScriptFor(agent: AgentConfig, dir: string): string | null {
  if (agent.mode !== "local" || (process.platform !== "win32" && process.env.HQ_NODE_HOOKS !== "1")) return null;
  return join(dir, HOOK_SCRIPT).replace(/\\/g, "/");
}

const HOOK_SCRIPT_SOURCE = `// Written by JSM HQ (git-excluded). Sends this agent's hook events to HQ.
// Usage: node .jsmhq-hook.mjs <url> <token> [--print-reply] | --print-role
import { readFileSync } from "node:fs";

const args = process.argv.slice(2).filter((a) => a !== "${MARK_ARG}");
if (args[0] === "--print-role") {
  try {
    process.stdout.write(readFileSync(new URL("./ROLE.md", import.meta.url), "utf8"));
  } catch {}
  process.exit(0);
}
const [url, token, print] = args;
let body = "";
let sent = false;
const send = async () => {
  if (sent) return;
  sent = true;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body || "{}",
      signal: AbortSignal.timeout(4000),
    });
    // Stop: HQ's reply ({"decision":"block",...}) hands over queued messages.
    if (print === "--print-reply" && res.ok) process.stdout.write(await res.text());
  } catch {}
  process.exit(0);
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (body += d));
process.stdin.on("end", send);
setTimeout(send, 2000).unref();
`;

export function writeHookScript(dir: string) {
  writeFileSync(join(dir, HOOK_SCRIPT), HOOK_SCRIPT_SOURCE);
}

// PostToolUse: the moment a question or permission prompt is answered, the tool completes.
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"] as const;

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

export function hookCommand(url: string, token: string, agentId: string, event: string, script: string | null = null): string {
  if (script) return `node "${script}" ${url}/hook/${agentId}/${event} ${token}${event === "Stop" ? " --print-reply" : ""} ${MARK_ARG}`;
  // Stop prints HQ's reply: {"decision":"block","reason":…} hands over queued messages.
  const out = event === "Stop" ? "2>/dev/null" : ">/dev/null 2>&1";
  return `curl -sf -m 4 -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' --data-binary @- '${url}/hook/${agentId}/${event}' ${out} || true ${MARK}`;
}

/**
 * Hooks report state to HQ. SessionStart also prints ROLE.md, which Claude Code
 * adds to the session's context. Existing user hooks are kept.
 */
export function writeSettings(dir: string, agent: AgentConfig, port: number, token: string) {
  const script = hookScriptFor(agent, dir);
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
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !isOurs(h.command)) }))
      .filter((e) => e.hooks.length);
    const ours: HookEntry["hooks"] = [{ type: "command", command: hookCommand(url, token, agent.id, event, script), timeout: 5 }];
    if (event === "SessionStart")
      ours.unshift({ type: "command", command: script ? `node "${script}" --print-role ${MARK_ARG}` : `cat "$CLAUDE_PROJECT_DIR/ROLE.md" 2>/dev/null || true ${MARK}` });
    hooks[event] = [...kept, event === "PreToolUse" || event === "PostToolUse" ? { matcher: "*", hooks: ours } : { hooks: ours }];
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

/** Claude Code's files: ROLE.md (loaded by the SessionStart hook), hooks, and the Team MCP config. */
export function writeClaudeFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string) {
  writeFileSync(join(dir, "ROLE.md"), roleMd(agent, cfg));
  writeSettings(dir, agent, cfg.project.hqPort, token);
  writeMcpConfig(dir, agent, cfg.project.hqPort, token);
  if (hookScriptFor(agent, dir)) writeHookScript(dir);
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
