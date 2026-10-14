// The files HQ writes into each agent's folder. All of them are listed in the
// clone's .git/info/exclude, so they are never committed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, HqConfig } from "../src/data/types";

export const HQ_FILES = ["ROLE.md", ".claude/settings.local.json"];
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
        "Keep tasks small: one task = one branch = one PR.",
        "Decide merge order and resolve conflicts between PRs.",
      ]
    : [
        "Work only on the task you were given. One task = one branch = one PR.",
        "Start each task from an up-to-date main: `git pull origin main`, then a new branch.",
        "Title PRs `[TASK-ID] Short title` and open them with `gh pr create`.",
        "When review comments arrive, fix them on the same branch.",
        "If you are blocked or need a decision, ask clearly and wait.",
      ];
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
    `Project: ${cfg.project.name} (${cfg.project.repo}). You are managed by JSM HQ.`,
    "",
  ].join("\n");
}

type HookEntry = { matcher?: string; hooks: { type: "command"; command: string; timeout?: number }[] };
type Settings = { hooks?: Record<string, HookEntry[]>; [k: string]: unknown };

function hookCommand(url: string, token: string, agentId: string, event: string): string {
  return `curl -s -m 3 -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' --data-binary @- '${url}/hook/${agentId}/${event}' >/dev/null 2>&1 || true ${MARK}`;
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
  writeFileSync(file, JSON.stringify({ ...settings, hooks }, null, 2) + "\n");
}

export function writeAgentFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string) {
  writeFileSync(join(dir, "ROLE.md"), roleMd(agent, cfg));
  writeSettings(dir, agent, cfg.project.hqPort, token);
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
