// Test of Settings → Stack "Detect from repo" (issue #33): package.json files → catalog choices.
// Run from the repo root: npx tsx scripts/stack-detect-test.ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStack, mergeStack, stackAdditions, EMPTY_STACK, type StackConfig } from "../src/data/stack";
import { findPackages } from "../server/stackDetect";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failed++;
};

const tmp = mkdtempSync(join(tmpdir(), "hq-stack-"));
const pkg = (dir: string, deps: Record<string, string>, extra: Record<string, unknown> = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: deps, ...extra }));
};
const names = (s: StackConfig) => stackAdditions(EMPTY_STACK, s).join(", ");

try {
  // A pnpm monorepo: Next.js app, Hono API, a shared package, and things that must be skipped.
  const mono = join(tmp, "mono");
  pkg(mono, { turbo: "1" });
  writeFileSync(join(mono, "pnpm-workspace.yaml"), `packages:\n  - "apps/*"\n  - 'packages/**' # shared\n  - "!apps/legacy"\n  - ../outside\nonlyBuiltDependencies:\n  - esbuild\n`);
  pkg(join(mono, "apps/web"), { next: "15", react: "19", "@clerk/nextjs": "6", "posthog-js": "1" });
  pkg(join(mono, "apps/api"), { hono: "4", stripe: "17", "@upstash/ratelimit": "2" });
  pkg(join(mono, "packages/db"), { "@neondatabase/serverless": "1" });
  pkg(join(tmp, "outside"), { express: "5" });
  mkdirSync(join(mono, "apps/notes")); // a folder without package.json
  symlinkSync(join(mono, "nowhere"), join(mono, "apps/broken"));
  const found = findPackages(mono);
  check("finds root + apps + packages/** (one level)", found.map((p) => p.where).sort().join(",") === ",apps/api,apps/web,packages/db", found.map((p) => p.where).join(","));
  check("never reads outside the repo", !found.some((p) => p.deps.includes("express")));
  check("esbuild under another YAML key isn't a workspace", !found.some((p) => p.where === "esbuild"));
  const stack = detectStack(found);
  check(
    "monorepo → each framework where it lives, tools from any package",
    names(stack) === "Hono (apps/api), Next.js (apps/web), Clerk, Stripe, Neon, PostHog, Upstash Ratelimit",
    names(stack),
  );

  // package.json `workspaces` as { packages }.
  const yarn = join(tmp, "yarn");
  pkg(yarn, {}, { workspaces: { packages: ["site"] } });
  pkg(join(yarn, "site"), { astro: "5" });
  check("workspaces { packages } form", names(detectStack(findPackages(yarn))) === "Astro (site)", names(detectStack(findPackages(yarn))));

  // Single package rules.
  const one = (deps: string[]) => names(detectStack([{ where: "", deps }]));
  check("Next.js with a custom Express server is Next.js", one(["next", "express", "react"]) === "Next.js");
  check("react + vite → React (Vite)", one(["react", "vite", "react-router-dom"]) === "React (Vite)");
  check("React Router framework mode", one(["react", "vite", "@react-router/dev"]) === "React Router");
  check("Supabase client means the database, not auth", one(["@supabase/supabase-js"]) === "Supabase");
  check("a scope pattern matches its packages only", one(["@clerk/backend", "clerkish"]) === "Clerk");
  check("no package.json → nothing", names(detectStack(findPackages(join(tmp, "empty")))) === "");
  writeFileSync(join(tmp, "bad.json"), "{");
  mkdirSync(join(tmp, "bad"));
  writeFileSync(join(tmp, "bad", "package.json"), "{ not json");
  check("broken package.json → nothing, no crash", findPackages(join(tmp, "bad")).length === 0);

  // Merging never overwrites what the user chose.
  const mine: StackConfig = { frameworks: [{ id: "nextjs", where: "web" }], tools: { auth: { id: "auth0" } } };
  const merged = mergeStack(mine, stack);
  check("keeps the user's framework entry (and its where)", merged.frameworks[0].where === "web" && merged.frameworks.filter((f) => f.id === "nextjs").length === 1);
  check("keeps the user's auth choice", merged.tools.auth?.id === "auth0");
  check("fills empty categories", merged.tools.payments?.id === "stripe" && merged.tools.database?.id === "neon");
  check("Found: lists only what would be added", stackAdditions(mine, stack).join(", ") === "Hono (apps/api), Stripe, Neon, PostHog, Upstash Ratelimit", stackAdditions(mine, stack).join(", "));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
