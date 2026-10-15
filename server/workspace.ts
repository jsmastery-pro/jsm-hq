// Agent folders: an HQ-managed clone per agent, or a folder the user chose.

import { existsSync } from "node:fs";
import type { AgentConfig } from "../src/data/types";
import { run } from "./lib/exec";
import { managedWorkspace } from "./paths";
import type { RepoInfo } from "./repo";

export function workspaceFor(agent: AgentConfig, projectSlug: string): string {
  return agent.workspacePath || managedWorkspace(projectSlug, agent.id);
}

/**
 * Makes sure the agent's folder exists and is a git repo.
 * A full clone (not a worktree): inside a sandbox a worktree loses git access.
 */
export async function ensureWorkspace(agent: AgentConfig, projectSlug: string, repo: RepoInfo): Promise<string> {
  const dir = workspaceFor(agent, projectSlug);
  if (agent.workspacePath) {
    if (!existsSync(dir)) throw new Error(`Folder not found: ${dir}`);
    if (!(await run("git", ["rev-parse", "--git-dir"], { cwd: dir })).ok) throw new Error(`${dir} is not a git repository.`);
    return dir;
  }
  if (!existsSync(dir)) {
    const clone = await run("git", ["clone", "--quiet", repo.root, dir], { timeoutMs: 300_000 });
    if (!clone.ok) throw new Error(`git clone failed: ${clone.stderr.trim()}`);
  }
  // A local clone points origin at the folder; agents need the real remote to push.
  if (repo.originUrl) await run("git", ["remote", "set-url", "origin", repo.originUrl], { cwd: dir });
  return dir;
}
