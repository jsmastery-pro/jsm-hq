# JSM HQ

A pixel-art office where you run a team of AI coding agents on your repo. One lead plans the work and assigns tasks; each worker gets its own desk, its own copy of the repo and its own Docker Sandbox. The office shows the team's work as it happens: the plan, tasks, pull requests, reviews and deploys.

Agents can run **Claude Code** or **Codex**. Everything runs on your machine.

## Quickstart (2 minutes)

**First time?** Follow the [getting-started guide](docs/getting-started.md): it installs Docker Sandboxes, sets its network policy, connects GitHub and sets up a repo, step by step for macOS, Linux and Windows.

Already set up? From inside any git repo with a GitHub remote:

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
| tmux (macOS, Linux)      | Agents keep running if HQ or the browser closes  | `brew install tmux`                                                       |
| Docker Sandboxes (`sbx`) | Each agent runs in its own microVM               | `brew trust docker/tap && brew install docker/tap/sbx`, then `sbx login` and `sbx policy init balanced` (once) |
| GitHub CLI (`gh`)        | PRs and reviews                                  | `brew install gh`, then `gh auth login`                                   |
| A GitHub repo            | Agents push branches and open PRs there          | `gh repo create --source . --private --push`                              |

Sandboxes need macOS 14+ on Apple silicon, Windows 11, or Ubuntu 24.04+. On other machines, set agents to **Local** in Settings → Team. They then run Claude Code or Codex installed on your machine, with permission prompts on.

On Linux, install the same tools with your package manager (for example `sudo apt install git tmux gh`).

### Windows 11 (experimental)

Run `npx @therealjsmastery/jsm-hq` in PowerShell or Windows Terminal, not in WSL. Install the tools with winget (`winget install Git.Git Docker.sbx GitHub.cli`); the setup checklist shows the exact commands. On Windows:

- There's no tmux, so HQ runs the agents itself. **Agents stop when HQ stops.** Their sandboxes and folders are kept; press **Start** to run them again.
- Use the terminal in the agent's drawer; there's no `tmux attach`.
- In Local mode, the agent's env file isn't loaded. Use Sandbox mode for app variables.

## How it works

- **Workspaces.** Each agent gets a full clone of your repo at `~/.jsmhq/<project>/<agent>/`. HQ writes the agent's role (`.jsmhq-role.md`: the ROLE.md text from Settings → Team plus the team, rules and tools), hooks and MCP config there and excludes them from git. If the folder has its own `ROLE.md`, it's included, never overwritten.
- **Sessions.** On macOS and Linux each agent runs in a tmux session (`hq-<project>-<agent>`) inside its sandbox. Its live terminal is in the agent's drawer, and you can attach from any terminal with `tmux attach -t hq-<project>-<agent>`. On Windows, HQ runs the agents itself.
- **Team MCP.** Agents talk to each other and to HQ through an MCP server called `hq`. The lead creates boards and tasks and assigns them; anyone can send a message. HQ delivers it right away if the agent is idle, or when its current turn ends if it's busy.
- **GitHub.** HQ reads PRs, checks and review comments through your `gh` login (every ~20 seconds). It matches PRs to tasks by `[TASK-ID]` in the title, tells the author about review comments, tells the lead when a PR passes and marks the task done when you merge. **HQ never merges.**
- **Sandbox settings** (Settings → Sandbox) go straight to `sbx`: CPU and memory, allowed and blocked domains, service keys, an env file for app variables, and the upstream proxy. HQ never stores key values, never reads your env files and only removes rules it added.
- **Stack (optional).** Settings → Stack (or the welcome) says what the project uses: frameworks, and tools for auth, payments, database, analytics and security, or your own under "Other". Agents get it in their ROLE.md, the tools' agent skills are installed into their folders (`.claude/skills`, `.agents/skills`, git-excluded), and you can allow the tools' docs and API domains for every sandbox in one click. Skip it and nothing changes.
- **Access requests.** Sandboxes block most websites. When an agent needs one (docs or an API), it asks with the `request_access` tool instead of working around it. It turns red, and its drawer shows **Allow for this agent / Allow for everyone / Deny**. Allow adds a rule for that sandbox only; the base policy is never touched.
- **Blocked requests.** HQ also reads sbx's queue of everything a sandbox blocked (`sbx policy approval ls`), even when the agent never asked: the agent's card shows "N blocked", and its drawer lists them with **Allow / Dismiss**. Allow adds a rule for that sandbox only.
- **MCP servers** (Settings → MCP) come from Docker Sandboxes' registry (`sbx mcp`). Add a server (URL plus an optional API key, or a local command), sign in if it needs it, and tick which agents get it. A running agent gets the tools right away, without a restart. Sign-ins and keys stay with Docker Sandboxes and never enter a sandbox. sbx can't detach a server from one sandbox, so unticking takes effect when that sandbox is recreated.
- **App variables** (Settings → Sandbox → App variables) become environment variables in the agent's session and its Shell tab, not a `.env` file in the project. Agents are told they exist (names only). HQ never reads the file.
- **Files in your repo.** `.jsmhq/config.json` (team and workflow) and `.jsmhq/plan.json` (boards and tasks) are safe to commit. Turn on **Settings → Project → Export plan** to also get a readable `docs/plan.md`.

## Troubleshooting

| Problem                                                    | Fix                                                                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start fails: "network policy has not been initialized"     | A fresh Docker Sandboxes install needs a base policy once: `sbx policy init balanced` (see the [guide](docs/getting-started.md#3-sign-in-and-choose-a-network-policy)). |
| Agents fail to start with a sign-in error                  | Your Docker sign-in expired. Run `sbx login`, then **Check again** in the setup checklist.                                                                       |
| A Codex agent is stuck on "Do you trust this folder?"      | Codex asks once per workspace, and again to trust HQ's hooks. Answer it in the agent's terminal. HQ never answers trust prompts for you.                         |
| "Port 7420 is in use"                                      | Another HQ is running. Stop it, or use `npx @therealjsmastery/jsm-hq --port 7421`.                                                                                                  |
| Agent state never changes / messages never arrive          | The sandbox can't reach HQ. Check that `sbx policy ls` shows `localhost:<port>` and `host.docker.internal:<port>` allowed. HQ adds them on start if they're missing. |
| Windows: `listen EACCES` on start                          | Windows reserved that port for Hyper-V, WSL or Docker. Use another: `npx @therealjsmastery/jsm-hq --port 8420`.                                                  |
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
server/      Local HQ server: setup checks, workspaces, sessions (tmux, or HQ-owned on Windows) + sbx, hooks, Team MCP, GitHub
bin/         The jsm-hq command
docs/        Product idea and build spec
context/     Implementation plans
```

## License

Code: [MIT](LICENSE). The JSM HQ name and logo are not covered by the license; see [TRADEMARKS.md](TRADEMARKS.md).
