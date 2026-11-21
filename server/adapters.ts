// Per-CLI differences: which files HQ writes into the agent's folder and how
// the agent is launched. Everything else (hooks → state, Team MCP, delivery)
// is shared — Codex and Claude Code send the same hook payloads.
//
// The other CLIs (OpenCode, Kilo Code, Mistral Vibe, Cline, Freebuff) send no hooks: HQ follows them by
// reading their screen (see Sessions.reconcileHookless) and hands them their role as a first message.

import { join } from "node:path";
import { agentWrite } from "./lib/agentFs";
import { CLI_INFO, type AgentCli, type AgentConfig, type HqConfig } from "../src/data/types";
import {
  adoptRoleFile,
  excludeFromGit,
  HOOK_SCRIPT,
  HQ_TOOL_SCRIPT,
  type RoleExtras,
  hookCommand,
  hookScriptFor,
  hqUrl,
  MCP_CONFIG,
  ROLE_FILE,
  roleMd,
  writeClaudeFiles,
  writeHookScript,
  writeHqToolScript,
} from "./agentFiles";
import { run, shq } from "./lib/exec";
import { resolveCommand } from "./backends/pty";

export interface Launch {
  /** Agent for `sbx run`: a built-in kit ("claude", "codex", "opencode"), or "shell" with sandboxScript. */
  sbxAgent: string;
  args: string[]; // the CLI's own arguments (not shell-quoted)
  /** Extra environment for the CLI (Local mode; shell-sandbox CLIs get it from sandboxScript). */
  env?: Record<string, string>;
  /** Shell-sandbox CLIs: the bash script sbx's shell agent runs (installs the CLI on first start, then runs it). */
  sandboxScript?: string;
}

export interface CliAdapter {
  /** Writes HQ's files into the agent's folder (all git-excluded). */
  writeFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string, extras?: RoleExtras): Promise<void>;
  launch(agent: AgentConfig, dir: string): Launch;
}

const modelOf = (agent: AgentConfig) => {
  const m = agent.model.trim();
  return m && !/^default$/i.test(m) ? m : null;
};

/** A repo that commits a CLI's config can't take HQ's without HQ changing a tracked file. */
async function refuseTracked(dir: string, file: string, cli: AgentCli) {
  const tracked = await run("git", ["ls-files", "--error-unmatch", file], { cwd: dir });
  if (tracked.ok)
    throw new Error(`This repo commits ${file}, so HQ can't add its ${CLI_INFO[cli].label} settings without changing a tracked file. Use another coding agent for this agent, or remove that file from the repo.`);
}

// ---------------------------------------------------------------- Claude Code

const claude: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    const ownRole = await adoptRoleFile(dir);
    writeClaudeFiles(dir, agent, cfg, token, { ...extras, ownRole });
  },
  launch(agent) {
    // "Opus" / "Sonnet" / "Haiku" → Claude Code's aliases; anything else is passed as a full model id.
    const m = agent.model.trim();
    const model = !m || /^default$/i.test(m) ? null : /^(opus|sonnet|haiku)$/i.test(m) ? m.toLowerCase() : m;
    // Relative to the agent's folder, where it starts. An absolute path would be the host's, and on
    // Windows the folder has a different path inside the sandbox (C:\x on the host, /c/x in the sandbox).
    return { sbxAgent: "claude", args: ["--mcp-config", MCP_CONFIG, ...(model ? ["--model", model] : [])] };
  },
};

// ---------------------------------------------------------------- Codex

export const CODEX_CONFIG = ".codex/config.toml";
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop", "SessionEnd"];

/** TOML basic string (JSON's escaping is valid TOML for these characters). */
const t = (s: string) => JSON.stringify(s);

export function codexConfig(agent: AgentConfig, cfg: HqConfig, token: string, dir: string, extras: RoleExtras = {}): string {
  const url = hqUrl(agent, cfg.project.hqPort);
  const script = hookScriptFor(agent, dir);
  const lines = [
    "# Written by JSM HQ for this agent (git-excluded). Codex loads it once you trust this folder.",
    `developer_instructions = ${t(roleMd(agent, cfg, extras))}`,
    "",
    "[features]",
    "hooks = true",
    "",
    "[mcp_servers.hq]",
    `url = ${t(`${url}/mcp`)}`,
    `http_headers = { Authorization = ${t(`Bearer ${token}`)}, "X-HQ-Agent" = ${t(agent.id)} }`,
  ];
  for (const event of CODEX_EVENTS)
    lines.push("", `[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${t(hookCommand(url, token, agent.id, event, script))}`);
  return lines.join("\n") + "\n";
}

const codex: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    await refuseTracked(dir, CODEX_CONFIG, "codex");
    // The role goes in the config (developer_instructions); the folder's own ROLE.md is included, never overwritten.
    const ownRole = await adoptRoleFile(dir);
    agentWrite(dir, CODEX_CONFIG, codexConfig(agent, cfg, token, dir, { ...extras, ownRole }), { mode: 0o600 });
    if (hookScriptFor(agent, dir)) writeHookScript(dir);
    excludeFromGit(dir, [CODEX_CONFIG, HOOK_SCRIPT]);
  },
  launch(agent) {
    const model = modelOf(agent);
    return { sbxAgent: "codex", args: model ? ["-m", model] : [] };
  },
};

// ---------------------------------------------------------------- shared by the hook-less CLIs

/** Team MCP headers: the agent token and which agent this is. */
const mcpHeaders = (agent: AgentConfig, token: string) => ({ Authorization: `Bearer ${token}`, "X-HQ-Agent": agent.id });

/** Writes the role file (the folder's own ROLE.md included). */
async function writeRole(dir: string, agent: AgentConfig, cfg: HqConfig, extras: RoleExtras) {
  agentWrite(dir, ROLE_FILE, roleMd(agent, cfg, { ...extras, ownRole: await adoptRoleFile(dir) }));
}

/** Where sbx's shell sandbox puts tools: uv's bin folder and the npm global prefix (both on its PATH). */
const NPM_PREFIX = "/usr/local/share/npm-global";
/**
 * The shell sandbox has Python and uv but no Node, and its policy blocks apt. Node comes from PyPI
 * (nodejs-wheel, which ships node and npm), which the sandbox may reach like any package registry.
 */
const npmInstall = (pkg: string) => `{ command -v npm >/dev/null 2>&1 || uv tool install -q nodejs-wheel; } && npm install -g --prefix ${NPM_PREFIX} ${pkg}`;

interface ShellLaunch {
  cli: AgentCli;
  /** Installs the CLI (run only when its binary is missing). */
  install: string;
  args: string[];
  /** Values are shell code (already quoted, so "$PWD/x" can expand). */
  env?: Record<string, string>;
  /** Hosts the CLI needs before it can start. HQ allows them for this sandbox (see sandboxHosts); the script waits for the rule. */
  hosts?: string[];
}

/** The script sbx's shell agent runs (bash -l -c): install on first start, then exec the CLI. */
export function shellScript(o: ShellLaunch): string {
  const { label, binary } = CLI_INFO[o.cli];
  const lines = [`export PATH="$HOME/.local/bin:${NPM_PREFIX}/bin:$PATH"`];
  for (const host of o.hosts ?? [])
    // The sandbox's proxy answers 403 until HQ's allow rule for this host is in place (a few seconds after the sandbox exists).
    lines.push(
      `n=0; while [ $n -lt 45 ]; do c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://${host}); [ "$c" != 403 ] && [ "$c" != 000 ] && break; [ $n = 0 ] && echo "Waiting for HQ to allow ${host} for this sandbox…"; n=$((n+1)); sleep 2; done`,
    );
  lines.push(
    `if ! command -v ${binary} >/dev/null 2>&1; then echo "Installing ${label} in this sandbox (first start only)…"; (${o.install}) || { echo "Couldn't install ${label}. If a website was blocked, allow it in this agent's drawer (Sandbox tab), then start the agent again."; exit 1; }; fi`,
  );
  for (const [k, v] of Object.entries(o.env ?? {})) lines.push(`export ${k}=${v}`);
  lines.push(["exec", binary, ...o.args.map(shq)].join(" "));
  return lines.join("\n");
}

/** Builds a Launch for a CLI that runs in sbx's shell sandbox (or plainly on the host in Local mode). */
function shellLaunch(agent: AgentConfig, o: ShellLaunch & { localEnv?: Record<string, string> }): Launch {
  if (agent.mode === "local") return { sbxAgent: "shell", args: o.args, env: o.localEnv };
  return { sbxAgent: "shell", args: [], sandboxScript: shellScript(o) };
}

/** Hosts a CLI needs, allowed for its sandbox by HQ (on top of the agent's own allow list). */
export function sandboxHosts(cli: AgentCli): string[] {
  // Freebuff downloads its binary from codebuff.com on first run, and the sandbox policy blocks it.
  return cli === "freebuff" ? ["codebuff.com"] : [];
}

// ---------------------------------------------------------------- OpenCode and Kilo Code

/**
 * OpenCode's project config (Kilo Code is an OpenCode fork and reads the same shape from kilo.json).
 * instructions loads HQ's role; mcp.hq is the Team MCP. In a sandbox, permissions are open (the sandbox
 * is the boundary, as with the Claude Code and Codex kits); in Local mode the CLI keeps asking.
 */
export function openCodeConfig(agent: AgentConfig, cfg: HqConfig, token: string, schema: string): string {
  const model = modelOf(agent);
  const config = {
    $schema: schema,
    instructions: [ROLE_FILE],
    ...(model ? { model } : {}),
    ...(agent.mode === "sandbox" ? { permission: { edit: "allow", bash: "allow", webfetch: "allow" } } : {}),
    mcp: { hq: { type: "remote", url: `${hqUrl(agent, cfg.project.hqPort)}/mcp`, enabled: true, headers: mcpHeaders(agent, token) } },
  };
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * OpenCode 2's TUI attaches to one background service per machine (a fixed port), started with whichever
 * folder came first, and a second one can't start while yours runs. --standalone gives each agent its
 * own server, reading its own folder's config, that stops with the session. Older versions lack the flag.
 */
let openCodeStandalone: boolean | null = null;
async function hasStandaloneFlag(): Promise<boolean> {
  if (openCodeStandalone !== null) return openCodeStandalone;
  try {
    // Resolved like the launch (on Windows npm installs opencode.cmd, which execFile can't run directly).
    const { file, args } = await resolveCommand("opencode", ["--help"]);
    const help = await run(file, args, { timeoutMs: 8000 });
    // Only a probe that ran is remembered; a failed one is tried again on the next start.
    if (help.ok) openCodeStandalone = help.stdout.includes("--standalone");
    return help.ok && help.stdout.includes("--standalone");
  } catch {
    return false; // not on PATH
  }
}

/** The probe's answer for each agent's latest start (writeFiles runs just before launch). */
const standaloneFor = new Map<string, boolean>();

function openCodeLike(cli: "opencode" | "kilo", file: string, schema: string): CliAdapter {
  return {
    async writeFiles(dir, agent, cfg, token, extras = {}) {
      await refuseTracked(dir, file, cli);
      await writeRole(dir, agent, cfg, extras);
      agentWrite(dir, file, openCodeConfig(agent, cfg, token, schema), { mode: 0o600 });
      excludeFromGit(dir, [ROLE_FILE, file]);
      if (cli === "opencode" && agent.mode === "local") standaloneFor.set(agent.id, await hasStandaloneFlag());
    },
    launch(agent) {
      // In a sandbox the VM has its own OpenCode, and the kit decides how it runs.
      if (cli === "opencode") return { sbxAgent: "opencode", args: agent.mode === "local" && standaloneFor.get(agent.id) ? ["--standalone"] : [] };
      return shellLaunch(agent, { cli, install: npmInstall("@kilocode/cli"), args: [] });
    },
  };
}

const opencode = openCodeLike("opencode", "opencode.json", "https://opencode.ai/config.json");
const kilo = openCodeLike("kilo", "kilo.json", "https://app.kilo.ai/config.json");

// ---------------------------------------------------------------- Mistral Vibe

export const VIBE_CONFIG = ".vibe/config.toml";

/** Vibe's project config: the Team MCP over streamable HTTP, with HQ's headers as static auth. */
export function vibeConfig(agent: AgentConfig, cfg: HqConfig, token: string): string {
  const h = mcpHeaders(agent, token);
  return [
    "# Written by JSM HQ for this agent (git-excluded). Vibe loads it once you trust this folder.",
    "[[mcp_servers]]",
    'name = "hq"',
    'transport = "streamable-http"',
    `url = ${t(`${hqUrl(agent, cfg.project.hqPort)}/mcp`)}`,
    "",
    "[mcp_servers.auth]",
    'type = "static"',
    `headers = { Authorization = ${t(h.Authorization)}, "X-HQ-Agent" = ${t(h["X-HQ-Agent"])} }`,
    "",
  ].join("\n");
}

const vibe: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    await refuseTracked(dir, VIBE_CONFIG, "vibe");
    await writeRole(dir, agent, cfg, extras);
    agentWrite(dir, VIBE_CONFIG, vibeConfig(agent, cfg, token), { mode: 0o600 });
    excludeFromGit(dir, [ROLE_FILE, VIBE_CONFIG]);
  },
  launch(agent) {
    const model = modelOf(agent);
    return shellLaunch(agent, {
      cli: "vibe",
      install: "uv tool install -q mistral-vibe",
      args: [],
      // sbx's proxy adds the stored Mistral key (`sbx secret set mistral`) to Vibe's API calls; the
      // variable only has to exist so Vibe doesn't stop to ask for one. A real key from App variables wins.
      env: { MISTRAL_API_KEY: '"${MISTRAL_API_KEY:-sbx-proxy}"', ...(model ? { VIBE_ACTIVE_MODEL: shq(model) } : {}) },
      localEnv: model ? { VIBE_ACTIVE_MODEL: model } : undefined,
    });
  },
};

// ---------------------------------------------------------------- Cline

/** Cline keeps MCP servers in its home folder; CLINE_MCP_SETTINGS_PATH points it at HQ's file instead. */
export const CLINE_MCP = ".jsmhq/cline-mcp.json";

export function clineMcpConfig(agent: AgentConfig, cfg: HqConfig, token: string): string {
  const hq = { type: "streamableHttp", url: `${hqUrl(agent, cfg.project.hqPort)}/mcp`, headers: mcpHeaders(agent, token), disabled: false };
  return JSON.stringify({ mcpServers: { hq } }, null, 2) + "\n";
}

const cline: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    await refuseTracked(dir, CLINE_MCP, "cline");
    await writeRole(dir, agent, cfg, extras);
    agentWrite(dir, CLINE_MCP, clineMcpConfig(agent, cfg, token), { mode: 0o600 });
    excludeFromGit(dir, [ROLE_FILE, CLINE_MCP]);
  },
  launch(agent, dir) {
    const model = modelOf(agent);
    // --tui: the interactive terminal UI. Cline auto-approves by default: fine in a sandbox, not on the host.
    const args = ["--tui", ...(agent.mode === "local" ? ["--auto-approve", "false"] : []), ...(model ? ["-m", model] : [])];
    return shellLaunch(agent, {
      cli: "cline",
      install: npmInstall("cline"),
      args,
      env: { CLINE_MCP_SETTINGS_PATH: `"$PWD/${CLINE_MCP}"` },
      localEnv: { CLINE_MCP_SETTINGS_PATH: join(dir, CLINE_MCP) },
    });
  },
};

// ---------------------------------------------------------------- Freebuff

/** Freebuff has no MCP: its role tells it to call HQ's tools with HQ_TOOL_SCRIPT (node is there: Freebuff is an npm package). */
const freebuff: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    await writeRole(dir, agent, cfg, { ...extras, toolsVia: "script" });
    writeHqToolScript(dir, agent, cfg.project.hqPort, token);
    excludeFromGit(dir, [ROLE_FILE, HQ_TOOL_SCRIPT]);
  },
  launch(agent) {
    return shellLaunch(agent, { cli: "freebuff", install: npmInstall("freebuff"), args: [], hosts: sandboxHosts("freebuff") });
  },
};

export const adapters: Record<AgentCli, CliAdapter> = { claude, codex, opencode, kilo, vibe, cline, freebuff };

/** The command a Local-mode agent runs on the host. */
export const localBinary = Object.fromEntries(Object.entries(CLI_INFO).map(([cli, info]) => [cli, info.binary])) as Record<AgentCli, string>;
