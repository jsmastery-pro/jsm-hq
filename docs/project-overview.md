# JSM HQ: project overview

Written for: developers who want to understand, maintain or contribute to the codebase. For end-user setup see [getting started](getting-started.md); for runtime behaviour seen from the user's side see [how it works](how-it-works.md).

## What the project is

JSM HQ (`@therealjsmastery/jsm-hq`, currently v0.7.5, MIT) is a local tool that runs a team of AI coding agents (Claude Code, Codex, OpenCode, Kilo Code, Mistral Vibe, Cline or Freebuff) against a git repository. One **lead** agent plans work into boards and tasks. **Worker** agents each take a task, work on their own branch in their own copy of the repo, and open a pull request. HQ follows those PRs on GitHub and reports back to the agents. A pixel-art office in the browser shows the whole team, its boards and its PRs.

The product is a single npm package with two halves:

- a **Node server** (`server/`) that owns all state and talks to the OS, Docker Sandboxes, GitHub and the agents;
- a **React + PixiJS web UI** (`src/`) that the server serves and that reflects server state in real time.

Everything runs on the user's machine. The server binds to `127.0.0.1` only.

## Repository layout

| Path | Contents |
| --- | --- |
| `bin/jsm-hq.mjs` | The `jsm-hq` CLI: parses `--repo`, `--port`, `--no-open`, `--version`, `--help`, checks Node 20+, then starts the server. |
| `server/` | The HQ server (about 4,300 lines in the top-level modules, plus `lib/` and `backends/`). See [Server modules](#server-modules). |
| `src/` | The browser UI: `data/`, `store/`, `office/`, `ui/`, `theme/`, `lib/`. |
| `scripts/` | Build helpers and cross-platform tests (see [Build, test and release](#build-test-and-release)). |
| `context/` | Implementation plans (`context/plans/001` to `011`) and the original UI build brief (`context/001-ui-build-context.md`). Historical, but useful for the reasoning behind features. |
| `docs/` | User guides and this overview. `docs/images/` holds the README screenshots. |
| `.agents/skills/` | Project skills for agents working on HQ itself (`plan`, `review`, `remember`, `architect`, `audit`, `teach`, `debug`, `document`, `honest`, `mvp`). |
| `.github/workflows/ci.yml` | CI on Ubuntu, macOS and Windows, plus a bare Linux container check. |

Both `server/` and the root have their own `tsconfig.json`. `pnpm-workspace.yaml` only sets pnpm's build-script allowlist (only `esbuild` may run install scripts).

## Tech stack

**Web UI**

- React 18.3 and TypeScript (strict), built with Vite 6 and `@vitejs/plugin-react`.
- PixiJS 8 for the office canvas, driven imperatively (not through `@pixi/react`). Sprites are drawn in code from character grids (`src/office/draw/`, `src/office/engine/`).
- Zustand 5 for state (`src/store/`).
- Tailwind CSS 4 through `@tailwindcss/vite`.
- xterm.js for terminals (`@xterm/xterm`, `addon-fit`, `addon-web-links`).
- framer-motion for HUD animation.
- Fonts are bundled through `@fontsource` (Inter, JetBrains Mono, Pixelify Sans, VT323), so the UI needs no network for fonts.

**Server**

- Plain Node `http` plus the `ws` package for the browser WebSocket.
- `@modelcontextprotocol/sdk` for the Team MCP server that agents connect to.
- `zod` 4 for validation.
- `@lydell/node-pty` for Windows ptys and `@xterm/headless` for reading agent screens.
- Built to `dist-server/` with esbuild (`scripts/build-server.mjs`); run with `tsx` in development.

**Tooling**: pnpm 10 or 11, `tsx`, `concurrently`, TypeScript 5.8.

## Architecture

```
  browser (React + Pixi)
  ┌──────────────────────────────┐
  │ zustand stores ◄── wsSource  │
  └──────────────▲───────────────┘
                 │ WebSocket /ws (browser token)
┌────────────────┴─────────────────────────────────────────────────┐
│ HQ server (127.0.0.1)                                            │
│                                                                  │
│  http.ts ── /ws, /hook/<agent>/<event>, /mcp, /api/health, UI    │
│     │                                                            │
│     ▼                                                            │
│  Hub (hub.ts): single source of truth, emits OfficeEvents        │
│     ▲            ▲             ▲             ▲                   │
│  Sessions     Planner       Inbox        GitHubSync               │
│  (tmux/pty)   (boards,      (delivers    (polls gh for PRs,      │
│  hooks, setup  tasks)        messages)    reviews, merges)       │
│     │                                                            │
│  Sbx / SbxMcp ── Docker Sandboxes (sbx CLI), attach MCP servers  │
│  access.ts, actionItems.ts, commands.ts, skills.ts, workspace.ts │
└─────┬──────────────────────────────┬─────────────────────────────┘
      │ tmux (macOS/Linux)           │ HTTP: Team MCP (/mcp) and hooks
      │ or HQ-owned pty (Windows)    │ (agent token)
      ▼                              ▼
  Claude Code / Codex agent processes, one per agent, each in its own
  folder (~/.jsmhq/<project>/<agent>/) and, by default, its own Docker Sandbox.
```

### The Hub is the single source of truth

`server/hub.ts` holds one `OfficeSnapshot`: setup state, sandbox state, config, agent status, boards, tasks, pull requests, environments, messages and activity. Every mutation goes through a `Hub` method that:

1. updates the snapshot,
2. emits a matching `OfficeEvent` (defined in `src/data/source.ts`) to every subscriber, and
3. saves config or plan to the repo when needed (`server/store.ts`).

The WebSocket layer in `http.ts` subscribes to the hub and forwards events to connected browsers. Browsers send commands rather than changing state themselves, and the server applies them through the hub. Keeping one owner for state means several browser tabs and the agents' MCP calls all see the same thing.

### The browser data layer

The UI talks to the server only through the `OfficeDataSource` interface in `src/data/source.ts`. There are two implementations:

- `src/data/ws/wsSource.ts`: the real one, connected to `/ws` with the browser token.
- `src/data/mock/`: a fake source with presets and a simulation, used by `pnpm dev` (demo, no server).

Stores in `src/store/` are the only code that calls the data source. Components read from stores; the office canvas (`src/office/`) reads the same stores, kept in step by `sceneSync.ts`. Because the data source is an interface, the whole UI runs offline with mock data, which is how the project started (see `context/001-ui-build-context.md`).

### Server modules

| Module | Responsibility |
| --- | --- |
| `main.ts` | Entry point. Reads args, resolves the repo, loads config, runs setup checks, wires the modules together, starts HTTP and the background loops. |
| `http.ts` | HTTP and WebSocket server on `127.0.0.1`. Routes: `GET /ws`, `POST /hook/<agent>/<event>`, `/mcp`, `GET /api/health`, and static files from `dist/`. Tokens are compared with `timingSafeEqual`; the WebSocket checks the `Origin` header. |
| `hub.ts` | State owner and event emitter (above). |
| `store.ts` | Reads and writes `.jsmhq/config.json` (team and workflow, safe to commit) and `.jsmhq/plan.json` (boards and tasks). Writes are atomic (temp file, then rename). |
| `paths.ts` | Per-project home `~/.jsmhq/<project>/`, the two tokens, and session names (`hq-<project>-<agent>`). |
| `repo.ts` | Detects the git repo root and its GitHub remote. |
| `setup.ts` | The setup checklist: Node, git, `gh`, `sbx`, tmux, sign-ins and so on. Each check has a status and a fix command. |
| `sessions.ts` | Starts, attaches to, types into and stops agent sessions. Polls their state and handles hook events. |
| `backends/` | The session backend. `tmux.ts` (macOS, Linux) keeps agents alive when HQ stops; `pty.ts` (Windows) keeps the process inside HQ. `types.ts` holds the shared interface; `index.ts` picks one (`HQ_SESSION_BACKEND=pty\|tmux` overrides it for testing). |
| `adapters.ts` | The only place that knows how the coding agent CLIs differ: which config files to write into the agent's folder, and how to launch each CLI (a Docker Sandboxes kit, or sbx's `shell` sandbox plus an install-on-first-start script). The CLIs and their metadata are listed in `CLI_INFO` in `src/data/types.ts`. Claude Code and Codex send hooks; the others are followed by reading their screen (`Sessions.reconcileHookless`) and get their role as a first `[HQ]` message. Freebuff has no MCP, so it calls the Team MCP through `.jsmhq-hq.mjs`. |
| `agentFiles.ts`, `lib/agentFs.ts` | Writes `.jsmhq-role.md`, the hook script, `.mcp.json` and the Claude settings into an agent's folder, and adds them to git's exclude list. An existing `ROLE.md` is included and never overwritten. |
| `workspace.ts` | Creates each agent's full clone under `~/.jsmhq/<project>/<agent>/` and keeps it current. |
| `sbx.ts` | Wraps the Docker Sandboxes `sbx` CLI: create, start, stop, recreate, network policy, per-agent rules, ports and secret names. |
| `mcp.ts` | The Team MCP server: stateless Streamable HTTP at `/mcp`, authenticated by the agent token. Tools cover boards, tasks, assignment and messages. The lead manages the plan; any agent can message any other. |
| `sbxMcp.ts` | Attaches user-configured MCP servers to sandboxes. |
| `planner.ts`, `planExport.ts` | Boards, tasks, assignments and messages. The Team MCP tools (agents) and browser commands (you) both use these, so they follow the same rules. `planExport.ts` writes a readable plan file. |
| `inbox.ts` | Delivers messages to agents. If an agent is idle at its prompt, HQ types the message into its terminal. If it's busy, the message waits and is handed over by the agent's Stop hook when its turn ends. |
| `hooks.ts` | Turns hook payloads (`POST /hook/<agentId>/<Event>`, from Claude Code and Codex) into agent state. |
| `githubSync.ts` | Polls `gh` for PRs, checks, reviews and merge state. Minimum interval 20 s, maximum 5 min, adaptive. Matches a PR to a task by the `[TASK-ID]` title prefix. |
| `github.ts` | Thin wrapper around `gh` commands. |
| `access.ts` | The network-access workflow: an agent's `request_access` call, and allow or deny decisions applied as per-sandbox rules. |
| `actionItems.ts` | The Action items list: agent questions (`ask_user`), missing keys and blocked websites. |
| `commands.ts` | Browser commands (names match the `OfficeDataSource` methods) mapped to server actions: create agent, change settings and so on. |
| `skills.ts` | Installs the project's stack skills once into a cache with the `skills` CLI, then copies them into each agent's folder (`.claude/skills/` for Claude Code, `.agents/skills/` for Codex). |
| `lib/` | Helpers: `exec.ts` (child processes), `json.ts`, `log.ts` (`HQ_DEBUG=1` for verbose logs), `ptyFix.ts` (makes the node-pty helper executable). |

## Core flows

### Starting a team

1. `bin/jsm-hq.mjs` checks Node and arguments, then starts `server/main.ts`.
2. `main.ts` resolves the repo, loads or creates `.jsmhq/config.json`, and runs the setup checks.
3. The HTTP server starts on `127.0.0.1:<port>` (default 7420). The browser opens and connects to `/ws` with the browser token.
4. "Start team" in the UI starts each agent's session (tmux or pty) in its workspace. In sandbox mode the agent's sandbox is started first, and HQ writes the agent's files and MCP config.

### A task's life

1. The lead creates boards and tasks through the Team MCP and assigns one task to a free worker.
2. The worker pulls `main` into its clone, makes a branch, codes, and opens a PR titled `[TASK-ID] …`.
3. `githubSync.ts` sees the PR. Review comments go back to the author. When the review gate passes, the lead is told the PR is ready to merge. Merge conflicts go back to the author.
4. When the PR merges, its task is marked done. HQ never merges a PR itself.

### Messages

Agent-to-agent messages go through the Team MCP. `inbox.ts` delivers them: an idle agent gets the message typed straight into its terminal (`typeInto`, `pressEnter` on the session backend); a busy agent gets it when its Stop hook fires at the end of its turn.

### Sandboxes and access

With sandbox mode on, each agent runs inside a Docker Sandbox created with `sbx`. HQ adds one network rule that lets the sandbox reach HQ at `host.docker.internal:<port>`. It never changes the user's base network policy. An agent that needs a blocked website calls `request_access`; the decision is stored as a rule for that sandbox only.

## Security model

- **Local only.** The server listens on `127.0.0.1`. The browser WebSocket needs the browser token, and its origin must be on the allow list.
- **Two tokens.** The agent token is stable per project and stored `0600` in `~/.jsmhq/<project>/agent-token`; it authenticates hooks and the Team MCP. The browser token is new on each start (except in `--dev`, where it survives reloads).
- **Isolation.** Each agent has its own clone. In sandbox mode each agent also has its own VM with a restricted network policy.
- **Secrets.** HQ stores secret and variable names, never values. For Local-mode agents, an env file is passed to the agent and HQ does not read it (see the comment on `LaunchSpec.envFile` in `server/backends/types.ts`).
- **Human control.** HQ does not merge, does not answer Codex trust prompts, and routes every question to the user through Action items.

Report vulnerabilities through the private channel in [SECURITY.md](../SECURITY.md).

## Persistence

| What | Where | Committed? |
| --- | --- | --- |
| Team and workflow config | `<repo>/.jsmhq/config.json` | Yes, safe to commit |
| Boards and tasks | `<repo>/.jsmhq/plan.json` | Owned by HQ |
| Agent clones | `~/.jsmhq/<project>/<agent>/` | No |
| Agent token | `~/.jsmhq/<project>/agent-token` (0600) | No |
| UI panel widths and similar preferences | browser local storage | No |

To delete a project, remove each agent in Settings → Team, then delete `~/.jsmhq/<project>`.

## Build, test and release

| Command | Does |
| --- | --- |
| `pnpm dev` | Vite dev server with mock data. No agents, no server. |
| `pnpm dev:hq` | Real server and UI with hot reload. Needs `HQ_REPO=<path>`. |
| `pnpm hq` | Builds the UI and runs HQ as a release would. |
| `pnpm typecheck` | `tsc --noEmit` for both the UI and the server. |
| `pnpm build` | Typecheck, Vite build to `dist/`, server build to `dist-server/`. |
| `npm pack` | Builds the tarball. The `prepack` script runs `pnpm build` first. |

**Tests.** The repo has no unit-test runner. Verification is done by scripts that CI runs on every OS:

- `scripts/session-backend-test.ts`: drives each session backend with a fake agent (create, attach, type, read screen, exit code, kill).
- `scripts/workspace-test.ts`: checks that git clones and the sandbox agree on line endings, using a simulated CRLF host.
- `scripts/smoke-test.mjs`: installs the packed tarball into an empty folder as a new user would, then starts HQ and checks that the UI and a snapshot are served.
- `bin/jsm-hq.mjs --version` and `--help` run in CI as a CLI smoke test.

CI also runs a `linux-bare` job in a `node:22-bookworm-slim` container with no compilers, to prove nothing is compiled from source on install. `scripts/fix-node-pty.mjs` runs as `postinstall` and fixes permissions on the prebuilt node-pty helper.

**Release.** `prepack` builds the package, and `publishConfig` publishes it publicly to npm. The `files` list limits the tarball to `bin`, `dist`, `dist-server`, the fix script, and the license and docs files.

## Conventions

- **Plans first.** Features start as numbered plans in `context/plans/`, which record the decisions behind them.
- **Keep the UI and server in step.** New server events are declared in `src/data/source.ts`, emitted from `hub.ts`, and consumed in `src/store/`.
- **Adapter boundary.** Anything CLI-specific goes in `server/adapters.ts` or `agentFiles.ts`. Shared behaviour belongs in the hub, sessions or MCP layers.
- **Platform differences stay in backends.** tmux versus pty, and Windows line endings, are handled in `server/backends/` and `workspace.ts`, not in callers.
- **Debugging.** Start HQ with `HQ_DEBUG=1` to see why a queued message is waiting.

## Where to look first

| If you want to... | Start with |
| --- | --- |
| Change what an agent sees or how it starts | `server/adapters.ts`, `server/agentFiles.ts` |
| Add another coding agent CLI | `CLI_INFO` in `src/data/types.ts`, then an adapter in `server/adapters.ts` |
| Add a Team MCP tool for agents | `server/mcp.ts`, then `server/planner.ts` or `server/hub.ts` |
| Change how PRs and reviews are followed | `server/githubSync.ts`, `server/github.ts` |
| Change sandbox or network behaviour | `server/sbx.ts`, `server/access.ts` |
| Change a session's lifecycle or terminal | `server/sessions.ts`, `server/backends/` |
| Add a UI panel or drawer | `src/ui/`, with state in `src/store/` |
| Change the office scene | `src/office/` (`layout/`, `actors/`, `draw/`) |
| Change the setup checklist | `server/setup.ts`, `src/ui/setup/SetupChecklist.tsx` |
