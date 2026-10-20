// Agent skills for the project's stack (plan 009). Installed once per project
// into a cache with the skills CLI (`npx skills add`), then copied into each
// agent's folder: Claude Code reads .claude/skills/, Codex reads .agents/skills/.
// The copies are git-excluded and replaced when the stack changes.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillSpec } from "../src/data/stack";
import { excludeFromGit } from "./agentFiles";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { projectHome } from "./paths";

const AGENT_DIRS = [".claude/skills", ".agents/skills"]; // Claude Code, Codex
const MARKER = "jsmhq-skills.json"; // in the clone's .git/info: what HQ put there

const cacheDir = (slug: string) => join(projectHome(slug), "skills-cache");
const key = (specs: SkillSpec[]) => JSON.stringify(specs);

let installing: Promise<void> | null = null;

/** Installs the specs into the project's cache (once per change of specs). */
export function ensureSkillCache(slug: string, specs: SkillSpec[]): Promise<void> {
  const run_ = async () => {
    const dir = cacheDir(slug);
    const stamp = join(dir, "installed.json");
    if (existsSync(stamp) && readFileSync(stamp, "utf8") === key(specs)) return;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    if (!specs.length) return writeFileSync(stamp, key(specs));
    await run("git", ["init", "-q"], { cwd: dir }); // the CLI installs into the current project
    const failed: string[] = [];
    for (const spec of specs) {
      const r = await run("npx", ["-y", "skills", "add", spec.source, "--skill", ...spec.skills, "-a", "claude-code", "codex", "-y", "--copy"], {
        cwd: dir,
        timeoutMs: 180_000,
      });
      if (!r.ok) failed.push(`${spec.source}: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
    }
    if (failed.length) throw new Error(`Some skills didn't install. ${failed.join("; ")}`);
    writeFileSync(stamp, key(specs));
  };
  // One install at a time per HQ; a second caller waits for the first.
  const next = (installing ?? Promise.resolve()).catch(() => {}).then(run_);
  installing = next.finally(() => {
    if (installing === next) installing = null;
  });
  return next;
}

/** Copies the cached skills into an agent's folder and removes ones HQ added before that the stack dropped. */
export async function syncSkillsInto(slug: string, workspace: string): Promise<string[]> {
  const gitInfo = join(workspace, ".git", "info");
  const marker = join(gitInfo, MARKER);
  const before: string[] = existsSync(marker) ? (JSON.parse(readFileSync(marker, "utf8")) as string[]) : [];
  const now: string[] = [];
  for (const sub of AGENT_DIRS) {
    const from = join(cacheDir(slug), sub);
    if (!existsSync(from)) continue;
    for (const name of readdirSync(from)) {
      const rel = `${sub}/${name}`;
      // Never overwrite a skill the repo itself commits.
      if ((await run("git", ["ls-files", "--error-unmatch", rel], { cwd: workspace })).ok) continue;
      rmSync(join(workspace, rel), { recursive: true, force: true });
      mkdirSync(join(workspace, sub), { recursive: true });
      cpSync(join(from, name), join(workspace, rel), { recursive: true });
      now.push(rel);
    }
  }
  for (const rel of before) if (!now.includes(rel)) rmSync(join(workspace, rel), { recursive: true, force: true });
  if (existsSync(gitInfo)) writeFileSync(marker, JSON.stringify(now));
  excludeFromGit(workspace, now);
  return now;
}

/** Install (if needed) and copy into the workspace. Never fails the agent's start. */
export async function prepareSkills(slug: string, workspace: string, specs: SkillSpec[]): Promise<{ count: number; error: string | null }> {
  try {
    await ensureSkillCache(slug, specs);
    const copied = await syncSkillsInto(slug, workspace);
    return { count: copied.filter((p) => p.startsWith(".claude/")).length, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`skills: ${msg}`);
    return { count: 0, error: msg };
  }
}
