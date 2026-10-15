#!/usr/bin/env node
// jsm-hq — run JSM HQ for the git repo you're in.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`JSM HQ ${pkg.version} — a pixel office for your team of AI coding agents.

Usage:
  npx jsm-hq [options]          run inside a git repo

Options:
  --repo <path>   the git repo to manage (default: current folder)
  --port <n>      HQ server port (default: 7420)
  --no-open       don't open the browser
  -v, --version   print the version
  -h, --help      show this help

Needs: Docker Sandboxes (sbx) or Claude Code/Codex, tmux, git, gh.
HQ checks all of this on start and shows how to fix anything missing.
Docs: ${pkg.homepage ?? "https://github.com/jsmastery-pro/jsm-hq"}`);
  process.exit(0);
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`JSM HQ needs Node.js 20 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

await import("../dist-server/main.mjs");
