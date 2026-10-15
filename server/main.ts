// jsm-hq — start HQ for the git repo you're in.
//
//   jsm-hq [--repo <path>] [--port 7420] [--dev] [--no-open]
//
// --dev: the UI is served by Vite (pnpm dev:hq); HQ prints/opens the Vite URL.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCommands } from "./commands";
import { startHttp } from "./http";
import { Hub } from "./hub";
import { GitHubSync } from "./githubSync";
import { Inbox } from "./inbox";
import { Planner } from "./planner";
import { Sbx } from "./sbx";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { ensurePtyHelperExecutable } from "./lib/ptyFix";
import { agentToken, browserToken } from "./paths";
import { detectRepo } from "./repo";
import { Sessions } from "./sessions";
import { runSetupChecks } from "./setup";
import { loadConfig, loadPlan } from "./store";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  ensurePtyHelperExecutable();
  const dev = flag("dev");
  const port = Number(arg("port") ?? process.env.HQ_PORT ?? 7420);
  const repo = await detectRepo(resolve(arg("repo") ?? process.env.HQ_REPO ?? process.cwd()));
  const { config, isNew } = loadConfig(repo, port);
  config.project.hqPort = port;
  const slug = config.project.id;
  const token = agentToken(slug);
  const uiToken = browserToken(slug, dev);

  log.info(`repo   ${repo.root}${repo.github ? `  (github.com/${repo.github})` : ""}`);
  log.info("checking setup…");
  const setup = await runSetupChecks(repo, config.team);
  for (const c of setup.checks) log.info(`  ${c.status === "ok" ? "✓" : c.status === "warning" ? "!" : "✗"} ${c.label}: ${c.detail}`);

  const hub = new Hub(repo, slug, config, loadPlan(repo.root), setup);
  hub.snap.welcome = isNew;
  const sessions = new Sessions(hub, token);
  const inbox = new Inbox(hub, { type: (id, text) => sessions.typeInto(id, text), enter: (id) => sessions.pressEnter(id) });
  sessions.onSessionDown = (id) => inbox.sessionDown(id);
  sessions.onSessionReattached = (id) => inbox.sessionReattached(id);
  const sbx = new Sbx(hub);
  sessions.envFileFor = (id) => (existsSync(sbx.envFile(id)) ? sbx.envFile(id) : null);
  sessions.onSandboxReady = (id) => void sbx.syncRules(id);
  void sbx.refresh();
  const planner = new Planner(hub, inbox);

  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const distDir = join(root, "dist");
  const uiPort = Number(process.env.HQ_UI_PORT ?? 5173);
  const uiOrigin = dev ? `http://localhost:${uiPort}` : `http://127.0.0.1:${port}`;
  if (!dev && !existsSync(join(distDir, "index.html"))) log.warn("No built UI found. Run `pnpm build` first, or use `pnpm dev:hq`.");

  await startHttp({
    hub,
    inbox,
    planner,
    port,
    browserToken: uiToken,
    agentToken: token,
    distDir: dev ? null : distDir,
    allowedOrigins: [uiOrigin, `http://127.0.0.1:${uiPort}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`],
    commands: makeCommands(hub, sessions, planner, inbox, sbx),
  });
  sessions.startPolling();
  const github = new GitHubSync(hub, planner, repo.github);
  github.start();

  const url = `${uiOrigin}/?token=${uiToken}`;
  log.info(`\n\n  JSM HQ is running → ${url}\n`);
  if (!flag("no-open")) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    // Give Vite a moment in dev.
    setTimeout(() => void run(opener, [url]), dev ? 1500 : 0);
  }

  const quit = () => {
    log.info("stopping HQ — agent sessions keep running in tmux");
    sessions.shutdown();
    github.stop();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

main().catch((err) => {
  if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    log.error(`Port ${arg("port") ?? 7420} is in use — another HQ may be running. Stop it, or pick another port: npx @therealjsmastery/jsm-hq --port 7421`);
    process.exit(1);
  }
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
