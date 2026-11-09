# Getting started with JSM HQ

This guide takes you from a fresh machine to a team of AI agents working on your repo. It takes about 15 minutes, most of it installing tools. You only do it once.

**You'll need:**

- A Mac (Apple silicon, macOS 14+), Linux (Ubuntu 24.04+), or a Windows 11 PC.
- A [Docker](https://app.docker.com/signup) account (free) for Docker Sandboxes.
- A [GitHub](https://github.com/signup) account and a repo for your project.
- A Claude (Pro, Max or API), ChatGPT or Gemini (API key) account for the agents themselves.

HQ checks everything below when it starts and shows a **setup checklist** with the exact command for anything missing, so you can also skip ahead to [step 6](#6-run-hq) and follow the checklist.

## 1. Install Node.js, git and the GitHub CLI

| | macOS | Linux (Ubuntu) | Windows 11 (PowerShell) |
|---|---|---|---|
| Node.js 20+ | `brew install node` | [nodesource](https://github.com/nodesource/distributions) or `nvm install 22` | `winget install OpenJS.NodeJS.LTS` |
| git | `xcode-select --install` | `sudo apt install git` | `winget install Git.Git` |
| GitHub CLI | `brew install gh` | `sudo apt install gh` | `winget install GitHub.cli` |
| tmux | `brew install tmux` | `sudo apt install tmux` | not needed |

No Homebrew on your Mac? Install it from [brew.sh](https://brew.sh) first.

On Windows, close and reopen the terminal after installing so the new commands are found.

Then sign in to GitHub:

```bash
gh auth login
```

## 2. Install Docker Sandboxes

Every agent runs in its own Docker Sandbox: a small VM with its own copy of your repo. Agents can't touch the rest of your machine.

| macOS | Linux (Ubuntu 24.04+, needs KVM) | Windows 11 |
|---|---|---|
| `brew trust docker/tap && brew install docker/tap/sbx` | `curl -fsSL https://get.docker.com \| sudo SBX=1 sh` | `winget install Docker.sbx` |

**Windows only:** turn on **Windows Hypervisor Platform** (Start → "Turn Windows features on or off"), then restart.

Check it worked:

```bash
sbx version
```

## 3. Sign in and choose a network policy

```bash
sbx login
```

This opens your browser to sign in with your Docker account.

Next, choose what sandboxes are allowed to reach on the internet. **This is required once on every new install**; sandboxes can't start until it's set:

```bash
sbx policy init balanced
```

| Policy | Sandboxes can reach |
|---|---|
| **balanced** (recommended) | Typical development traffic: AI services, package registries, GitHub. Everything else is blocked unless you allow it. |
| allow-all | Anything on the internet. |
| deny-all | Nothing, unless you allow it domain by domain. |

You can allow extra domains for one agent later in **Settings → Sandbox**. To start over with a different policy, run `sbx policy reset`. HQ never changes this policy; it only adds one rule so sandboxes can reach HQ itself.

## 4. Give sandboxes access to GitHub

Agents push branches and open pull requests from inside their sandbox. Store your GitHub token in Docker's secret store; the sandbox proxy adds it to GitHub requests, so the token itself never enters the VM:

```bash
sbx secret set github --command "gh auth token"
```

Using **Codex** agents? Also sign in with ChatGPT once:

```bash
sbx secret set openai --oauth
```

Using **Gemini CLI** agents in a sandbox? Store a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) (Gemini's own sign-in is turned off in sandboxes):

```bash
sbx secret set google
```

In **Local** mode, Gemini CLI uses your own setup on this machine: install it with `npm install -g @google/gemini-cli`, then set `GEMINI_API_KEY` or sign in once by running `gemini` in a terminal. The first time an agent starts, Gemini asks you to trust its folder: choose **Trust folder** in the agent's terminal.

Using **Antigravity CLI** agents? They run in **Local** mode only (Docker Sandboxes has no Antigravity agent). Install `agy` from the [install page](https://antigravity.google/docs/install?tab=cli) and sign in once in the agent's terminal; it opens your browser. HQ can't see Antigravity's approval prompts, so check its terminal if an agent seems stuck, and choose "always allow" for the `hq` tools.

Claude Code agents ask you to sign in the first time they start. Do it in the agent's terminal inside HQ.

### Optional: run agents on a local model (Ollama)

Claude Code and Codex agents can use a model on your own machine instead of a cloud account. In **Settings → Team**, open an agent's **More** panel, set **Model provider** to **Ollama**, and enter a model name. Gemini CLI agents can't use Ollama.

```bash
ollama pull qwen3-coder        # or any model that lists "tools"
ollama serve                   # if Ollama isn't already running
```

- Needs Ollama 0.14 or newer (Claude Code talks to its Anthropic-compatible API). Use a context window of at least 64k tokens.
- In a sandbox, HQ points the agent at `http://host.docker.internal:11434` and adds that one allow rule to the network policy. Your base policy is never changed.
- Ollama on another machine? Set **Ollama address** in the same panel (for example `http://192.168.1.20:11434`). That machine must accept connections from yours (`OLLAMA_HOST=0.0.0.0`).
- Tool-calling quality varies a lot by model. If an agent can't use HQ's tools, try another model.
- The setup checklist adds **Ollama** and **Models** checks once an agent uses it; the fix for a missing model is `ollama pull <model>`.

## 5. Prepare a GitHub repo

HQ works on a git repo that has a GitHub remote called `origin`. Each agent clones it, works on its own branch, and opens pull requests there. HQ follows those PRs and their reviews.

**An existing project** that's already on GitHub: nothing to do. Just open a terminal in its folder.

**A new project:**

```bash
mkdir my-app && cd my-app
git init -b main
echo "# My app" > README.md
git add . && git commit -m "Initial commit"
gh repo create my-app --private --source . --push
```

Tip: add a short `plan.md` (stack, features, phases) and push it before starting. The lead agent reads it to plan the work. Don't name it `docs/plan.md`; HQ can write that file itself (Settings → Project → Export plan).

## 6. Run HQ

From your project's folder:

```bash
npx @therealjsmastery/jsm-hq@latest
```

`@latest` makes sure npx doesn't reuse an old version it cached. HQ opens your browser. If it doesn't, open the `http://127.0.0.1:7420/?token=…` link printed in the terminal.

- **Welcome:** name the project, pick a lead and workers (Claude Code, Codex, Gemini CLI or Antigravity CLI for each) and a review tool. Optionally pick your stack (frameworks, auth, payments, database, analytics, security): agents then get those tools' agent skills and know what the project uses. This is saved to `.jsmhq/config.json` in your repo.
- **Setup checklist:** anything still missing shows here with a **Copy** button and, for safe commands, **Run in terminal**. Press **Check again** after fixing something.

Leave the terminal running while you work. On macOS and Linux, agents keep running even if you close HQ; on Windows they stop with it (see [Windows](how-it-works.md#windows)).

## 7. Start the team

1. Press **Start team** in the top bar. The first start takes a minute or two while each sandbox is created.
2. Click the lead (or press **1**) and open the **Messages** tab. Tell them what to build, for example:
   > Read plan.md. Create a board for Phase 1, plan its tasks with the files each one touches, and assign them.
3. Watch the office: tasks appear on the plan wall, agents work at their desks, and PRs roll through the review gate.
4. Review and merge PRs on GitHub yourself. HQ never merges. When you merge, the task is marked done.

An agent with a red **Needs input** badge is waiting for you. Click them and answer in their terminal.

To give agents MCP servers (Supabase, Stripe, your own…), use **Settings → MCP**: add the server, sign in if it asks, and tick the agents that should get it.

When an agent needs a website its sandbox blocks (a tool's docs, an API), it asks instead of guessing: its drawer shows the domain and why, with **Allow for this agent / Allow for everyone / Deny**. To allow your stack's docs up front, use **Settings → Stack → Network access**.

## Something not working?

| Problem | Fix |
|---|---|
| Start fails with "network policy has not been initialized" | Step 3: `sbx policy init balanced`. |
| Start fails with a Docker sign-in error | Your sign-in expired: `sbx login`, then **Check again**. |
| Agents can't push or open PRs | Step 4 (`sbx secret set github …`), and check the repo has a GitHub `origin` (step 5). |
| A Codex agent waits on "Do you trust this folder?" | Answer it once in the agent's terminal. HQ never answers trust prompts for you. |
| A Gemini agent waits on "Do you trust the files in this folder?" | Choose **Trust folder** in the agent's terminal. Until you do, Gemini ignores HQ's hooks and tools. |
| "Port 7420 is in use" | Another HQ is running. Stop it or use `--port 7421`. |
| Windows: `listen EACCES` | Windows reserved that port. Use `--port 8420`. |

More in the [README](../README.md#troubleshooting). To learn what HQ does behind the office, read [How it works](how-it-works.md).
