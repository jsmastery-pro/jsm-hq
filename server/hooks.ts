// Claude Code hooks → agent state. Each agent's hooks POST to
// /hook/<agentId>/<Event> with the hook's JSON payload.

import type { Hub } from "./hub";

interface HookPayload {
  prompt?: string;
  tool_name?: string;
  message?: string;
  notification_type?: string;
}

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function handleHook(hub: Hub, agentId: string, event: string, body: HookPayload) {
  const st = hub.status(agentId);
  const name = hub.name(agentId);
  if (!st) return false;

  switch (event) {
    case "SessionStart":
      hub.setStatus(agentId, { state: "idle", note: "Ready" });
      break;
    case "UserPromptSubmit":
      hub.setStatus(agentId, { state: "working", note: body.prompt ? clip(body.prompt.replace(/\s+/g, " ")) : null });
      if (st.state !== "working") hub.activity("task.started", agentId, `${name} is working`);
      break;
    case "PreToolUse":
      // Also clears "needs input" once a permission prompt is answered.
      if (st.state !== "working" || st.note?.startsWith("Asking")) hub.setStatus(agentId, { state: "working", note: body.tool_name ? `Using ${body.tool_name}` : null });
      break;
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
    case "Stop":
      hub.setStatus(agentId, { state: "idle", note: "Finished — ready for the next instruction" });
      hub.activity("agent.answered", agentId, `${name} finished a turn`);
      break;
    case "SessionEnd":
      hub.setStatus(agentId, { state: "idle", note: "Session ended" });
      break;
    default:
      return false;
  }
  return true;
}
