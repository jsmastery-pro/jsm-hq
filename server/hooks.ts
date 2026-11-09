// Claude Code / Codex / Gemini CLI / Antigravity CLI hooks → agent state. Each agent's hooks POST to
// /hook/<agentId>/<Event> with the hook's JSON payload. Gemini CLI's own event
// names (BeforeAgent, AfterTool…) are mapped to these in its settings file (see
// adapters.ts), so only its Notification payload needs reshaping here. Antigravity CLI's
// payload uses camelCase names (lastUserInput, toolCall) and its Stop reply is {"decision":"continue"}.

import type { Hub } from "./hub";
import type { Inbox } from "./inbox";

interface HookPayload {
  prompt?: string;
  tool_name?: string;
  message?: string;
  notification_type?: string;
  /** Gemini CLI's Notification: what is being approved (it has no top-level tool_name). */
  details?: { title?: string; toolName?: string; command?: string };
  /** Antigravity CLI's names for the prompt and the tool. */
  lastUserInput?: string;
  toolCall?: { name?: string };
}

/** Gives every CLI's payload the field names handleHook reads. */
const normalize = (body: HookPayload): HookPayload => ({ ...body, prompt: body.prompt ?? body.lastUserInput, tool_name: body.tool_name ?? body.toolCall?.name });

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** What a permission prompt asks, from Codex's tool_name or Gemini CLI's notification details. */
function permissionQuestion(body: HookPayload): string {
  const tool = body.tool_name ?? body.details?.toolName;
  if (tool) return `Approve ${tool}?`;
  if (body.details?.command) return `Approve: ${clip(body.details.command.replace(/\s+/g, " "), 60)}`;
  if (body.details?.title) return `Approve: ${clip(body.details.title, 60)}`;
  return "Approval needed in the terminal";
}

/**
 * Whether the agent is inside a turn (prompt submitted, no Stop yet). Hooks can
 * arrive late or out of order (e.g. a PreToolUse after Stop), so only a new prompt
 * may turn an idle agent back to "working".
 */
const turnOpen = new Map<string, boolean>();

export interface HookResult {
  ok: boolean;
  /** JSON printed by the hook command; Claude Code acts on it (Stop: block = continue). */
  response?: Record<string, unknown>;
}

export function handleHook(hub: Hub, inbox: Inbox, agentId: string, event: string, payload: HookPayload): HookResult {
  const body = normalize(payload);
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
      turnOpen.set(agentId, true);
      hub.setStatus(agentId, { state: "working", note: body.prompt ? clip(body.prompt.replace(/\s+/g, " ")) : null });
      if (st.state !== "working") hub.activity("task.started", agentId, `${name} is working`);
      break;
    case "PreToolUse":
      // Stale: the turn already ended. (Unknown, e.g. after an HQ restart, is allowed.)
      if (turnOpen.get(agentId) === false) break;
      // Also clears "needs input" once a permission prompt is answered.
      if (st.state !== "working" || st.note?.startsWith("Asking")) hub.setStatus(agentId, { state: "working", note: body.tool_name ? `Using ${body.tool_name}` : null });
      break;
    case "PostToolUse":
      // A tool finished: if it was waiting on the user (a question or a permission), they answered.
      if (turnOpen.get(agentId) === false) break;
      if (st.state === "needs-input") hub.setStatus(agentId, { state: "working", note: "Continuing after your answer" });
      break;
    case "PermissionRequest": {
      // Codex and Gemini CLI: an approval prompt is waiting in the terminal.
      const what = permissionQuestion(body);
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
      // and Claude Code continues with them instead of stopping.
      const queued = inbox.takeForStop(agentId);
      if (queued) {
        turnOpen.set(agentId, true); // Claude continues: same turn
        hub.setStatus(agentId, { state: "working", note: "Reading new messages" });
        // Claude Code, Codex and Gemini CLI take "block" (keep going with this as the next prompt); Antigravity takes "continue".
        return { ok: true, response: { decision: hub.cfg(agentId)?.cli === "antigravity" ? "continue" : "block", reason: queued } };
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
