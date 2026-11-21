// Reads the repo's package.json files for "Detect from repo" in Settings → Stack (issue #33).
// Names only: no install, no network, no AI. The catalog decides what they mean (detectStack).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { FoundPackage } from "../src/data/stack";

const MAX_PACKAGES = 40;

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const names = (v: unknown): string[] => (v && typeof v === "object" ? Object.keys(v) : []);

function depsOf(pkg: Record<string, unknown>): string[] {
  return [...new Set([...names(pkg.dependencies), ...names(pkg.devDependencies), ...names(pkg.peerDependencies)])];
}

/** Workspace globs from package.json `workspaces` (array or { packages }) and pnpm-workspace.yaml. */
function workspaceGlobs(root: string, pkg: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  const ws = pkg?.workspaces;
  const list = Array.isArray(ws) ? ws : ws && typeof ws === "object" ? (ws as { packages?: unknown }).packages : null;
  if (Array.isArray(list)) out.push(...list.filter((g): g is string => typeof g === "string"));
  const yaml = join(root, "pnpm-workspace.yaml");
  if (existsSync(yaml)) {
    // Only the `packages:` list; a YAML parser would be a new dependency for two lines of syntax.
    let inPackages = false;
    for (const line of readFileSync(yaml, "utf8").split(/\r?\n/)) {
      if (/^packages\s*:/.test(line)) inPackages = true;
      else if (/^\S/.test(line)) inPackages = false;
      else if (inPackages) {
        const m = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
        if (m) out.push(m[1].trim());
      }
    }
  }
  return out.filter((g) => !g.startsWith("!"));
}

/** Folders a glob names: "apps/web", or every folder in "apps/*" ("**" is treated as one level). */
function expand(root: string, glob: string): string[] {
  const clean = glob.replace(/\/+$/, "").replace(/\/\*\*$/, "/*");
  if (!clean.includes("*")) return [join(root, clean)];
  const star = clean.indexOf("*");
  const parent = join(root, clean.slice(0, clean.lastIndexOf("/", star) + 1));
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .filter((d) => !d.startsWith(".") && d !== "node_modules")
    .map((d) => join(parent, d))
    .filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false; // a broken link
      }
    });
}

/** The root package.json and the workspace packages, with their dependency names. */
export function findPackages(root: string): FoundPackage[] {
  const rootPkg = readJson(join(root, "package.json"));
  const found: FoundPackage[] = rootPkg ? [{ where: "", deps: depsOf(rootPkg) }] : [];
  const seen = new Set<string>();
  for (const glob of workspaceGlobs(root, rootPkg)) {
    for (const dir of expand(root, glob)) {
      const where = relative(root, dir).split(sep).join("/");
      // Never outside the repo, never twice.
      if (!where || where.startsWith("..") || seen.has(where)) continue;
      seen.add(where);
      const pkg = readJson(join(dir, "package.json"));
      if (pkg) found.push({ where, deps: depsOf(pkg) });
      if (found.length >= MAX_PACKAGES) return found;
    }
  }
  return found;
}
