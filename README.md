# JSM HQ

A pixel-art office where you run a team of AI coding agents on your repo. One lead plans the work and assigns tasks; each worker gets its own desk, its own copy of the repo and its own Docker Sandbox. The office shows the team's work as it happens: the plan, tasks, pull requests, reviews and deploys.

Agents can run **Claude Code** or **Codex**. Everything runs on your machine.

## Quickstart (2 minutes)

From inside any git repo:

```bash
cd ~/developer/my-app
npx @therealjsmastery/jsm-hq
```

HQ opens your browser and walks you through the rest:

1. **Welcome:** name the project, pick a lead and workers (Claude Code or Codex for each) and a review tool. HQ saves this to `.jsmhq/config.json` in your repo.
2. **Setup checklist:** if something is missing on your machine, HQ shows what to install, with a Copy button, docs links and, for safe commands, **Run in terminal**.
3. **Start the team** from the top bar, then message the lead from their **Messages** tab, for example: *"Plan two small tasks for Bob and assign the first one."*

Want to try it without touching a real project? Make a throwaway repo:

```bash
mkdir hq-test && cd hq-test
git init -b main && echo "# HQ test" > README.md && git add . && git commit -m init
npx @therealjsmastery/jsm-hq
```

Use it often? Install it once and run `jsm-hq` from any repo:

```bash
npm install -g @therealjsmastery/jsm-hq
jsm-hq
```

### Options

```
jsm-hq --repo <path>   the repo to manage (default: current folder)
       --port <n>      HQ port (default: 7420)
       --no-open       don't open the browser
       --version, --help
```

## Requirements

| What                     | Why                                              | Install (macOS)                                                           |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------- |
| Node.js 20+              | Runs HQ                                          | [nodejs.org](https://nodejs.org)                                          |
| git                      | Each agent works in its own clone                | `xcode-select --install`                                                  |
| tmux                     | Agents keep running if HQ or the browser closes  | `brew install tmux`                                                       |
| Docker Sandboxes (`sbx`) | Each agent runs in its own microVM               | `brew trust docker/tap && brew install docker/tap/sbx`, then `sbx login` |
| GitHub CLI (`gh`)        | PRs and reviews (optional)                       | `brew install gh`, then `gh auth login`                                   |

Sandboxes need macOS 14+ on Apple silicon, Windows 11, or Ubuntu 24.04+. On other machines, set agents to **Local** in Settings → Team. They then run Claude Code or Codex installed on your machine, with permission prompts on.

## How it works

- **Workspaces.** Each agent gets a full clone of your repo at `~/.jsmhq/<project>/<agent>/`. HQ writes the agent's `ROLE.md`, hooks and MCP config there and excludes them from git.
- **Sessions.** Each agent runs in a tmux session (`hq-<project>-<agent>`) inside its sandbox. Its live terminal is in the agent's drawer, and you can attach from any terminal with `tmux attach -t hq-<project>-<agent>`.
- **Team MCP.** Agents talk to each other and to HQ through an MCP server called `hq`. The lead creates boards and tasks and assigns them; anyone can send a message. HQ delivers it right away if the agent is idle, or when its current turn ends if it's busy.
- **GitHub.** HQ reads PRs, checks and review comments through your `gh` login (every ~20 seconds). It matches PRs to tasks by `[TASK-ID]` in the title, tells the author about review comments, tells the lead when a PR passes and marks the task done when you merge. **HQ never merges.**
- **Sandbox settings** (Settings → Sandbox) go straight to `sbx`: CPU and memory, allowed and blocked domains, service keys, an env file for app variables, and the upstream proxy. HQ never stores key values, never reads your env files and only removes rules it added.
- **Files in your repo.** `.jsmhq/config.json` (team and workflow) and `.jsmhq/plan.json` (boards and tasks) are safe to commit. Turn on **Settings → Project → Export plan** to also get a readable `docs/plan.md`.

## Troubleshooting

| Problem                                                    | Fix                                                                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents fail to start with a sign-in error                  | Your Docker sign-in expired. Run `sbx login`, then **Check again** in the setup checklist.                                                                       |
| A Codex agent is stuck on "Do you trust this folder?"      | Codex asks once per workspace, and again to trust HQ's hooks. Answer it in the agent's terminal. HQ never answers trust prompts for you.                         |
| "Port 7420 is in use"                                      | Another HQ is running. Stop it, or use `npx @therealjsmastery/jsm-hq --port 7421`.                                                                                                  |
| Agent state never changes / messages never arrive          | The sandbox can't reach HQ. Check that `sbx policy ls` shows `localhost:<port>` and `host.docker.internal:<port>` allowed. HQ adds them on start if they're missing. |
| Windows                                                    | Run HQ inside WSL 2 (Ubuntu 24.04+). tmux isn't available on native Windows.                                                                                      |
| `posix_spawnp failed` when opening a terminal              | Reinstall (`npx clear-npx-cache` then `npx @therealjsmastery/jsm-hq`). HQ fixes the node-pty helper's permissions on install and on start.                                         |

**Clean up a project:** remove each agent in Settings → Team (it deletes the sandbox and, if you choose, the folder), then delete `~/.jsmhq/<project>`.

## Develop JSM HQ

Needs Node.js 20+ and pnpm 10 or 11 (`corepack enable` gets you pnpm).

```bash
git clone https://github.com/jsmastery-pro/jsm-hq && cd jsm-hq
pnpm install
pnpm dev                                   # UI with mock data, no agents
HQ_REPO=~/developer/hq-test pnpm dev:hq    # real HQ server + UI with hot reload
```

| Command          | Does                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| `pnpm dev`       | Demo UI with mock data at http://localhost:5173 (nothing leaves the browser) |
| `pnpm dev:hq`    | HQ server + UI with hot reload (`HQ_REPO=<path>`)                            |
| `pnpm hq`        | Builds the UI, then runs HQ like a release (`--repo <path> --port 7420`)     |
| `pnpm build`     | Type-checks, builds the UI to `dist/` and the server to `dist-server/`       |
| `pnpm typecheck` | Type-check only                                                              |
| `npm pack`       | Builds and packs the npm tarball, to test it before publishing               |

**Releasing:** bump `version` in `package.json`, merge to `main`, then from a clean `main` run `npm publish` (it builds first). Only members of the `therealjsmastery` npm org can publish.

Start HQ with `HQ_DEBUG=1` to log why a queued message is waiting.

**Keyboard:** `1`–`9` jump to an agent · `Esc` closes panels · `D` toggles debug · `+` / `-` zoom. Drag to pan, scroll to zoom.

```
src/
  data/      Domain types, the OfficeDataSource interface, mock (data/mock) and real (data/ws) sources
  store/     Zustand stores; the only code that talks to the data source
  office/    The PixiJS pixel office: layout generator, sprites, agents, belt
  ui/        Top bar, team panel, activity feed, drawers, settings, setup checklist, welcome
server/      Local HQ server: setup checks, workspaces, tmux + sbx sessions, hooks, Team MCP, GitHub
bin/         The jsm-hq command
docs/        Product idea and build spec
context/     Implementation plans
```

## License

Code: [MIT](LICENSE). The JSM HQ name and logo are not covered by the license; see [TRADEMARKS.md](TRADEMARKS.md).
