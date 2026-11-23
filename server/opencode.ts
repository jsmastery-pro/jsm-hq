// OpenCode (experimental, Sandbox mode only). OpenCode has no command hooks, but its plugins
// see its live events, so HQ writes a small plugin into the agent's folder that reports them
// to HQ's hook endpoint with the same event names Claude Code's hooks use. Verified with
// OpenCode 2.3 in `sbx run opencode`.

import type { AgentConfig, HqConfig } from "../src/data/types";
import { excludeFromGit, hqUrl, ROLE_FILE, roleMd, type RoleExtras, adoptRoleFile } from "./agentFiles";
import { agentWrite } from "./lib/agentFs";
import { run } from "./lib/exec";

export const OPENCODE_CONFIG = ".opencode/opencode.jsonc";
export const OPENCODE_PLUGIN = ".opencode/plugins/jsmhq.js";

/** OpenCode's project config: the model, HQ's Team MCP and the role as instructions. */
export function opencodeConfig(agent: AgentConfig, cfg: HqConfig, token: string): string {
  const model = agent.model.trim();
  const config = {
    $schema: "https://opencode.ai/config.json",
    ...(model && !/^default$/i.test(model) ? { model } : {}),
    instructions: [ROLE_FILE],
    mcp: {
      hq: {
        type: "remote",
        url: `${hqUrl(agent, cfg.project.hqPort)}/mcp`,
        enabled: true,
        headers: { Authorization: `Bearer ${token}`, "X-HQ-Agent": agent.id },
      },
    },
  };
  return `// Written by JSM HQ for this agent (git-excluded).\n${JSON.stringify(config, null, 2)}\n`;
}

/**
 * The plugin. Events → HQ: a prompt starting (UserPromptSubmit), tools (Pre/PostToolUse) and the
 * turn ending (Stop). Sub-sessions (OpenCode's subagents) are ignored, so they don't flip the
 * agent's state. Stop asks HQ not to hand over queued messages in its reply: HQ types them into
 * the prompt once the agent is idle, as it does for any agent.
 */
export function opencodePlugin(agent: AgentConfig, cfg: HqConfig, token: string): string {
  const url = `${hqUrl(agent, cfg.project.hqPort)}/hook/${agent.id}`;
  return `// Written by JSM HQ (git-excluded). Reports this agent's state to HQ.
const URL = ${JSON.stringify(url)};
const TOKEN = ${JSON.stringify(token)};

function send(event, body = {}) {
  return fetch(\`\${URL}/\${event}\`, {
    method: "POST",
    headers: { Authorization: \`Bearer \${TOKEN}\`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  }).catch(() => {});
}

export default {
  id: "jsmhq",
  async setup(ctx) {
    const children = new Set();
    let prompt = "";
    const controller = new AbortController();
    void send("SessionStart");
    (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
          const p = ev.properties ?? ev.data ?? {};
          if (ev.type === "session.created" && p.parentID) children.add(p.sessionID);
          if (p.sessionID && children.has(p.sessionID)) continue;
          if (ev.type === "session.inbox.enqueued" && p.item?.type === "user") prompt = String(p.item.payload?.text ?? "");
          else if (ev.type === "session.execution.started") void send("UserPromptSubmit", { prompt });
          else if (ev.type === "session.execution.succeeded" || ev.type === "session.execution.failed") void send("Stop", { no_reply: true });
        }
      } catch {}
    })();
    try {
      await ctx.tool.hook("execute.before", (e) => void send("PreToolUse", { tool_name: e.tool }));
      await ctx.tool.hook("execute.after", (e) => void send("PostToolUse", { tool_name: e.tool }));
    } catch {}
    return () => controller.abort();
  },
};
`;
}

export async function writeOpencodeFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string, extras: RoleExtras = {}) {
  // A repo that commits these files can't take HQ's without changing a tracked file.
  for (const file of [OPENCODE_CONFIG, OPENCODE_PLUGIN]) {
    const tracked = await run("git", ["ls-files", "--error-unmatch", file], { cwd: dir });
    if (tracked.ok) throw new Error(`This repo commits ${file}, so HQ can't add its OpenCode settings without changing a tracked file. Use Claude Code for this agent, or remove that file from the repo.`);
  }
  const ownRole = await adoptRoleFile(dir);
  agentWrite(dir, ROLE_FILE, roleMd(agent, cfg, { ...extras, ownRole }));
  agentWrite(dir, OPENCODE_CONFIG, opencodeConfig(agent, cfg, token), { mode: 0o600 });
  agentWrite(dir, OPENCODE_PLUGIN, opencodePlugin(agent, cfg, token), { mode: 0o600 });
  excludeFromGit(dir, [ROLE_FILE, OPENCODE_CONFIG, OPENCODE_PLUGIN]);
}
