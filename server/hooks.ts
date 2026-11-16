// Claude Code / Codex / Antigravity hooks → agent state. Each agent's hooks POST to
// /hook/<agentId>/<Event> with the hook's JSON payload.

import type { Hub } from "./hub";
import type { Inbox } from "./inbox";

interface HookPayload {
  prompt?: string;
  tool_name?: string;
  message?: string;
  notification_type?: string;
  lastUserInput?: string;
  toolCall?: { name?: string; args?: unknown };
  hookEventName?: string;
}

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Whether the agent is inside a turn (prompt submitted, no Stop yet). Hooks can
 * arrive late or out of order (e.g. a PreToolUse after Stop), so only a new prompt
 * may turn an idle agent back to "working".
 */
const turnOpen = new Map<string, boolean>();

export interface HookResult {
  ok: boolean;
  /** JSON printed by the hook command; CLIs act on it (Stop: Claude uses block, Antigravity uses continue). */
  response?: Record<string, unknown>;
}

export function handleHook(hub: Hub, inbox: Inbox, agentId: string, event: string, body: HookPayload): HookResult {
  const st = hub.status(agentId);
  const name = hub.name(agentId);
  if (!st) return { ok: false };
  inbox.noteHook(agentId, event);

  switch (event) {
    case "SessionStart":
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Ready" });
      break;
    case "UserPromptSubmit":
    case "PreInvocation": {
      turnOpen.set(agentId, true);
      const prompt = body.prompt ?? body.lastUserInput;
      hub.setStatus(agentId, { state: "working", note: prompt ? clip(prompt.replace(/\s+/g, " ")) : null });
      if (st.state !== "working") hub.activity("task.started", agentId, `${name} is working`);
      break;
    }
    case "PreToolUse": {
      // Stale: the turn already ended. (Unknown, e.g. after an HQ restart, is allowed.)
      if (turnOpen.get(agentId) === false) break;
      const toolName = body.tool_name ?? body.toolCall?.name;
      // Also clears "needs input" once a permission prompt is answered.
      if (st.state !== "working" || st.note?.startsWith("Asking")) hub.setStatus(agentId, { state: "working", note: toolName ? `Using ${toolName}` : null });
      break;
    }
    case "PostToolUse":
      // A tool finished: if it was waiting on the user (a question or a permission), they answered.
      if (turnOpen.get(agentId) === false) break;
      if (st.state === "needs-input") hub.setStatus(agentId, { state: "working", note: "Continuing after your answer" });
      break;
    case "PermissionRequest": {
      // Codex: an approval prompt is waiting in the terminal.
      const what = body.tool_name ? `Approve ${body.tool_name}?` : "Approval needed in the terminal";
      hub.setStatus(agentId, { state: "needs-input", note: `Asking: ${what}` });
      hub.activity("agent.needs-input", agentId, `${name} needs you: ${what}`);
      break;
    }
    case "Notification": {
      const msg = body.message ?? "Needs your attention";
      // "Waiting for your input" fires after a finished turn sits idle — not urgent.
      if (/waiting for your input/i.test(msg) || body.notification_type === "idle_prompt") {
        hub.setStatus(agentId, { state: "idle", note: "Waiting for you" });
        break;
      }
      hub.setStatus(agentId, { state: "needs-input", note: `Asking: ${clip(msg)}` });
      hub.activity("agent.needs-input", agentId, `${name} needs you: ${clip(msg, 60)}`);
      break;
    }
    case "Stop": {
      // Messages that arrived while the agent was busy: hand them over now,
      // and the agent continues with them instead of stopping.
      const queued = inbox.takeForStop(agentId);
      if (queued) {
        turnOpen.set(agentId, true); // Agent continues: same turn
        hub.setStatus(agentId, { state: "working", note: "Reading new messages" });
        const cli = hub.cfg(agentId)?.cli;
        const decision = cli === "antigravity" ? "continue" : "block";
        return { ok: true, response: { decision, reason: queued } };
      }
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Finished — ready for the next instruction" });
      hub.activity("agent.answered", agentId, `${name} finished a turn`);
      break;
    }
    case "SessionEnd":
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Session ended" });
      break;
    default:
      return { ok: false };
  }
  return { ok: true };
}
