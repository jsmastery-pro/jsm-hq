# JSM HQ

A pixel-art office where you run a team of AI coding agents. Every agent works at its own desk (its own Docker Sandbox), and the office shows the team's work as it happens: the plan, tasks, pull requests, reviews and deploys.

There are two ways to run it:

- **Demo**: the UI with mock data. No setup, nothing leaves your browser.
- **Real agents**: HQ runs real Claude Code agents on one of your repos.

## Requirements

- [Node.js](https://nodejs.org) 20 or newer
- [pnpm](https://pnpm.io) 10 or 11 (or run `corepack enable` to get it)

```bash
pnpm install
```

## Demo (mock data)

```bash
pnpm dev
```

Open **http://localhost:5173**. The top bar shows a **Demo data** label.

| Do this                           | What happens                                           |
| --------------------------------- | ------------------------------------------------------ |
| Click an agent or their desk      | The camera moves to them and their terminal opens     |
| Type in a terminal, press Enter   | The agent replies. A red "Needs input" agent continues |
| Click the plan wall               | Boards open. Assign a task to anyone                   |
| Click the review gate or PR board | Open and merged pull requests                          |
| Click a server rack               | That environment's details                             |
| **Settings → Team**               | Add or remove agents. The office grows to fit          |
| **Settings → Workflow**           | Switch review/deploy tools, or turn them off           |
| **2x / 4x** in the top bar        | Speed up the simulation                                |
| **Debug → Load preset**           | Switch to a 7-agent team or a 2-agent team             |

## Real agents (Phase A)

Run this **from the `jsm-hq` folder**, and set `HQ_REPO` to the git repo the agents should work on:

```bash
cd jsm-hq
HQ_REPO=~/developer/my-app pnpm dev:hq      # ← your repo's path
```

To try it safely first, make a throwaway repo:

```bash
mkdir -p ~/developer/hq-test && cd ~/developer/hq-test
git init -b main && echo "# HQ test" > README.md && git add . && git commit -m init
cd -   # back to jsm-hq
HQ_REPO=~/developer/hq-test pnpm dev:hq
```

Then: **Continue to the office** → press **2** (Bob) → **Start Bob** → type a prompt in his terminal.

HQ opens your browser. If something is missing on your machine, a **setup checklist** shows what to install, with a Copy button, docs links and, for safe commands, **Run in terminal**.

| What HQ needs              | Why                                        | Install (macOS)                                         |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| Docker Sandboxes (`sbx`)   | Each agent runs in its own microVM         | `brew trust docker/tap && brew install docker/tap/sbx`, then `sbx login` |
| tmux                       | Agents keep running if HQ or the browser closes | `brew install tmux`                               |
| GitHub CLI (`gh`)          | PRs and reviews (later phases)             | `brew install gh`, then `gh auth login`                 |
| Claude Code                | Only for agents in **Local mode**          | [claude.ai/install](https://docs.claude.com/en/docs/claude-code/setup) |

Sandboxes need macOS 14+ on Apple silicon, Windows 11, or Ubuntu 24.04+. On other machines, set agents to **Local** in Settings → Team: they run plain Claude Code with permission prompts on.

**What happens when you press Start:**

1. **The agent gets its own copy of your repo** at `~/.jsmhq/<project>/<agent>/`.
   - HQ writes the agent's `ROLE.md` and Claude Code hooks there.
   - Those files are git-excluded, so they are never committed.
2. **HQ lets sandboxes reach it.** It adds a network rule allowing `localhost:<port>` and `host.docker.internal:<port>` (port 7420 by default), only if the rule is missing.
3. **The agent starts in a tmux session** named `hq-<project>-<agent>`.
   - Sandbox mode runs `sbx run`; Local mode runs `claude`.
   - Its live terminal appears in the agent's drawer.
4. **Hooks report the agent's state** (working, needs you, finished) and the office updates.
5. **The agent joins the Team MCP** (server `hq`). The lead creates boards and tasks and assigns them; anyone can `send_message`. HQ delivers each message right away if the agent is idle, or when its current turn ends if it's busy. You can message any agent from its **Messages** tab, or assign tasks from **Boards**.

Try it: start John and Bob, then message John: *"Plan two tiny tasks for Bob and assign the first one."*

You can also attach to an agent from any terminal: `tmux attach -t hq-<project>-<agent>`.

**Clean up a test project:** press **Stop** on each agent, then `sbx rm -f hq-<project>-<agent>` and `rm -rf ~/.jsmhq/<project>`.

HQ saves the team and workflow in `<your repo>/.jsmhq/config.json` (safe to commit) and boards in `.jsmhq/plan.json`.

6. **PRs and reviews come from GitHub** (read-only, through your `gh` login, every ~20s). PRs are matched to tasks by `[TASK-ID]` in the title. When the review tool (CodeRabbit, Greptile, Copilot or a human) leaves comments, HQ tells the PR's agent to fix them. When a PR passes, the lead hears it's ready to merge. When you merge, the task is done. HQ never merges itself.

7. **Sandbox settings apply through `sbx`** (Settings → Sandbox). *This agent:* resources, allowed and blocked domains (`sbx policy … --sandbox`, read back as "rules in effect"), service keys for that sandbox only, and an env file for app variables. *This machine:* the base policy (read-only), the upstream proxy, and keys for every sandbox. HQ never stores key values and only removes rules it added.

**Coming next:** a Codex adapter and `npx jsm-hq` packaging. See `context/plans/`.

Debugging message delivery: start HQ with `HQ_DEBUG=1` to log why a queued message is waiting.

## Keyboard

`1`–`9` jump to an agent · `Esc` closes panels · `D` toggles debug · `+` / `-` zoom. Drag to pan, scroll to zoom.

## Scripts

| Command          | Does                                                    |
| ---------------- | ------------------------------------------------------- |
| `pnpm dev`       | Demo UI with mock data                                  |
| `pnpm dev:hq`    | HQ server + UI with hot reload (`HQ_REPO=<path>`)       |
| `pnpm hq`        | Builds the UI, then runs HQ without hot reload (like a release). Options: `--repo <path> --port 7420` |
| `pnpm build`     | Type-check UI + server and build the UI to `dist/`      |
| `pnpm typecheck` | Type-check only                                         |

## Project layout

```
src/
  data/      Domain types, the OfficeDataSource interface, mock (data/mock) and real (data/ws) sources
  store/     Zustand stores; the only code that talks to the data source
  office/    The PixiJS pixel office: layout generator, sprites, agents, belt
  ui/        Top bar, team panel, activity feed, drawers, settings, setup checklist
server/      Local HQ server: setup checks, agent folders, tmux + sbx sessions, hooks, WebSocket
docs/        Product idea and build spec
context/     Implementation plans
```
