// Persistence in the repo: .jsmhq/config.json (team + workflow, safe to commit)
// and .jsmhq/plan.json (boards + tasks, owned by HQ).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, Board, HqConfig, SandboxSettings, Task } from "../src/data/types";
import type { RepoInfo } from "./repo";

export interface PlanFile {
  boards: Board[];
  tasks: Task[];
}

const dir = (root: string) => join(root, ".jsmhq");

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Atomic write so a crash never leaves half a file. */
function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

export const defaultSandbox = (): SandboxSettings => ({
  resources: { cpus: null, memoryGb: null }, // sbx's own defaults
  policy: "balanced",
  allow: ["registry.npmjs.org", "github.com"],
  deny: [],
  proxy: null,
  secrets: ["github"],
});

export function newAgent(id: string, name: string, role: string, color: string, isLead: boolean): AgentConfig {
  return {
    id,
    name,
    role,
    isLead,
    model: isLead ? "Opus" : "Sonnet",
    mode: "sandbox",
    color,
    skills: [],
    roleMd: isLead
      ? `You are ${name}, the lead. You plan and assign work. You never write app code.`
      : `You are ${name}, a ${role.toLowerCase()} on the team. You build the tasks assigned to you.`,
    sandbox: defaultSandbox(),
    workspacePath: null,
  };
}

function defaultConfig(repo: RepoInfo, port: number): HqConfig {
  return {
    project: { name: repo.name, repo: repo.github ?? repo.name, path: repo.root, hqPort: port },
    team: [newAgent("john", "John", "Lead", "#ff77a8", true), newAgent("bob", "Bob", "Developer", "#29adff", false)],
    workflow: {
      review: { enabled: true, tool: repo.hasCodeRabbit ? "coderabbit" : "human", command: "" },
      merge: { by: "human" },
      deploy: { enabled: repo.hasInsta, tool: "instacloud", command: "", perAgentEnvironments: repo.hasInsta },
    },
  };
}

export function loadConfig(repo: RepoInfo, port: number): HqConfig {
  const file = join(dir(repo.root), "config.json");
  const found = readJson<HqConfig>(file);
  if (found) {
    // Older files may miss newer fields.
    for (const a of found.team) {
      a.workspacePath ??= null;
      a.sandbox.resources ??= { cpus: null, memoryGb: null };
    }
    found.project.path = repo.root;
    return found;
  }
  const cfg = defaultConfig(repo, port);
  saveConfig(repo.root, cfg);
  return cfg;
}

export function saveConfig(root: string, cfg: HqConfig) {
  // The path is machine-specific; teammates get their own.
  const { path: _path, ...project } = cfg.project;
  writeJson(join(dir(root), "config.json"), { ...cfg, project: { ...project, path: "" } });
}

export function loadPlan(root: string): PlanFile {
  return readJson<PlanFile>(join(dir(root), "plan.json")) ?? { boards: [{ id: "B1", title: "Backlog", status: "active", order: 0 }], tasks: [] };
}

export function savePlan(root: string, plan: PlanFile) {
  writeJson(join(dir(root), "plan.json"), plan);
}
