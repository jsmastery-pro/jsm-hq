import { useState, type ReactNode } from "react";
import type { AgentConfig, OfficeSnapshot } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { ui, type AgentTab } from "../../store/ui";
import { ago, Dot, Portrait, ReviewChip, SectionTitle, StateChip, Tabs, useNow } from "../kit";
import { DrawerHeader } from "./Drawer";
import { TerminalView } from "./TerminalView";

const POLICY = { open: "Open", balanced: "Balanced", locked: "Locked Down" } as const;

export function AgentDrawer({ id, initialTab }: { id: string; initialTab?: AgentTab }) {
  const snap = useOffice((s) => s.snap);
  const [tab, setTab] = useState<AgentTab>(initialTab ?? "terminal");
  const agent = snap?.config.team.find((a) => a.id === id);
  const status = snap?.agents.find((a) => a.agentId === id);
  if (!snap || !agent || !status) {
    return (
      <>
        <DrawerHeader>
          <b>Agent removed</b>
        </DrawerHeader>
      </>
    );
  }
  const unread = snap.messages.filter((m) => m.toId === id).length;

  return (
    <>
      <DrawerHeader>
        <Portrait color={agent.color} lead={agent.isLead} size={36} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <b className="text-[18px]">{agent.name}</b>
            <StateChip state={status.state} />
          </div>
          <div className="truncate font-term text-[17px] text-muted">
            {agent.role} · {agent.model} · {agent.mode === "sandbox" ? "Docker Sandbox" : "local worktree"}
          </div>
        </div>
      </DrawerHeader>
      {status.note && (
        <div className={`border-b-[3px] border-ink px-3 py-1.5 text-[14px] ${status.state === "needs-input" ? "bg-[#ffe1ea] text-red" : "bg-cream-2"}`}>
          {status.note}
          {status.state === "needs-input" && <span className="ml-2 text-muted">— answer in the terminal and press Enter</span>}
        </div>
      )}
      <div className="border-b-[3px] border-ink px-3 py-2">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "terminal", label: "Terminal" },
            { id: "task", label: "Task" },
            { id: "sandbox", label: "Sandbox" },
            { id: "messages", label: `Messages${unread ? ` · ${unread}` : ""}` },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "terminal" && <TerminalView agentId={id} />}
        {tab === "task" && <TaskTab snap={snap} agent={agent} taskId={status.currentTaskId} />}
        {tab === "sandbox" && <SandboxTab snap={snap} agent={agent} />}
        {tab === "messages" && <MessagesTab snap={snap} agent={agent} />}
      </div>
    </>
  );
}

function TaskTab({ snap, agent, taskId }: { snap: OfficeSnapshot; agent: AgentConfig; taskId: string | null }) {
  const task = taskId ? snap.tasks.find((t) => t.id === taskId) : null;
  const pr = task?.prNumber ? snap.pullRequests.find((p) => p.number === task.prNumber) : null;
  const active = snap.boards.filter((b) => b.status === "active");
  const free = snap.tasks.filter((t) => t.status === "todo" && active.some((b) => b.id === t.boardId));
  const [pick, setPick] = useState("");

  if (agent.isLead) {
    return (
      <div className="scroll-thin h-full overflow-y-auto p-4">
        <SectionTitle>Planning</SectionTitle>
        <p className="mb-3 text-[15px]">The lead plans and assigns work through the HQ Team MCP. It writes no app code.</p>
        {active.map((b) => {
          const tasks = snap.tasks.filter((t) => t.boardId === b.id);
          const count = (s: string) => tasks.filter((t) => t.status === s).length;
          return (
            <button key={b.id} className="panel mb-2 block w-full px-3 py-2 text-left" onClick={() => ui.openBoards(b.id)}>
              <b>{b.title}</b>
              <div className="font-term text-[17px] text-muted">
                {count("todo")} to do · {count("in-progress")} in progress · {count("in-review")} in review · {count("done")} done
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4">
      <SectionTitle>Current task</SectionTitle>
      {task ? (
        <div className="panel mb-4 px-3 py-2">
          <div className="font-term text-[18px] text-muted">{task.id} · {snap.boards.find((b) => b.id === task.boardId)?.title}</div>
          <b className="text-[17px]">{task.title}</b>
          <div className="mt-1 text-[14px]">Status: {task.status}</div>
          {task.needs.length > 0 && (
            <div className="text-[14px]">
              Needs: {task.needs.map((n) => `${n} (${snap.tasks.find((t) => t.id === n)?.status ?? "?"})`).join(", ")}
            </div>
          )}
          {pr && (
            <div className="mt-2 flex items-center gap-2 text-[14px]">
              <button className="font-semibold underline" onClick={() => ui.openPrs()}>
                PR #{pr.number}
              </button>
              <ReviewChip review={pr.review} merged={pr.merged} />
              {pr.openComments > 0 && <span>{pr.openComments} comments</span>}
            </div>
          )}
        </div>
      ) : (
        <p className="mb-4 text-[15px] text-muted">No task right now.</p>
      )}
      <SectionTitle>Assign a task</SectionTitle>
      <div className="flex gap-2">
        <select className="field" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Task to assign">
          <option value="">Pick a to-do task…</option>
          {free.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id} {t.title}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!pick} onClick={() => (officeActions.assignTask(pick, agent.id), setPick(""))}>
          Assign
        </button>
      </div>
      <p className="mt-1 text-[12px] text-muted">If {agent.name} is free, the lead tells them to start right away.</p>
    </div>
  );
}

function SandboxTab({ snap, agent }: { snap: OfficeSnapshot; agent: AgentConfig }) {
  const env = snap.environments.find((e) => e.agentId === agent.id);
  const now = useNow(5000);
  const sb = agent.sandbox;
  const row = (k: string, v: ReactNode) => (
    <div className="grid grid-cols-[140px_1fr] gap-2 border-t border-dashed border-cream-3 py-1.5 text-[14px] first:border-t-0">
      <span className="text-muted">{k}</span>
      <span className="min-w-0 break-words">{v}</span>
    </div>
  );
  return (
    <div className="scroll-thin h-full overflow-y-auto p-4">
      <SectionTitle>Sandbox</SectionTitle>
      <div className="panel mb-4 px-3 py-1">
        {row("Mode", agent.mode === "sandbox" ? "Docker Sandbox (microVM), full access inside the VM" : "Local worktree, permission prompts on")}
        {row("Network policy", POLICY[sb.policy])}
        {row("Allowed", sb.allow.length ? sb.allow.join(", ") : "—")}
        {row("Blocked", sb.deny.length ? sb.deny.join(", ") : "—")}
        {row("HQ access", <span className="font-term text-[17px]">host.docker.internal:{snap.config.project.hqPort} (added by HQ)</span>)}
        {row("Proxy", sb.proxy ?? "—")}
        {row("Secrets", sb.secrets.length ? sb.secrets.map((s) => <span key={s} className="chip mr-1 mb-1 font-term text-[14px]">{s}</span>) : "—")}
        {row("Skills", agent.skills.join(", ") || "—")}
      </div>
      {env && (
        <>
          <SectionTitle>Environment</SectionTitle>
          <button className="panel mb-4 block w-full px-3 py-2 text-left" onClick={() => ui.openEnv(env.name)}>
            <div className="font-term text-[17px]">{env.url}</div>
            <div className="text-[14px] text-muted">
              {env.status} · deployed {ago(env.lastDeployAt, now)} ago
            </div>
          </button>
        </>
      )}
      <button className="btn" onClick={() => ui.openSettings("sandbox", agent.id)}>
        Edit sandbox settings
      </button>
    </div>
  );
}

function MessagesTab({ snap, agent }: { snap: OfficeSnapshot; agent: AgentConfig }) {
  const now = useNow(1000);
  const list = snap.messages.filter((m) => m.fromId === agent.id || m.toId === agent.id);
  const name = (id: string) => snap.config.team.find((a) => a.id === id);
  return (
    <div className="scroll-thin h-full overflow-y-auto p-4">
      <SectionTitle>Team MCP messages</SectionTitle>
      <p className="mb-3 text-[13px] text-muted">Agents can't reach each other's sandboxes. Every message goes through HQ.</p>
      {list.length === 0 && <p className="text-[15px] text-muted">No messages yet.</p>}
      <ul className="flex flex-col gap-2">
        {list.map((m) => {
          const out = m.fromId === agent.id;
          const other = name(out ? m.toId : m.fromId);
          return (
            <li key={m.id} className={`border-2 border-ink px-2.5 py-1.5 ${out ? "ml-8 bg-white" : "mr-8 bg-cream-2"}`}>
              <div className="flex items-center gap-1.5 text-[13px] text-muted">
                {other && <Dot color={other.color} size={8} />}
                {out ? `To ${other?.name ?? "?"}` : `From ${other?.name ?? "?"}`}
                <span className="ml-auto font-term text-[15px]">{ago(m.at, now)}</span>
              </div>
              <div className="text-[15px]">{m.text}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
