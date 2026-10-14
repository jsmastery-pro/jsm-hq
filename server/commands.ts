// Browser commands → server actions. Names match OfficeDataSource methods.

import type { AgentPatch, Board, NewAgentInput, ProjectConfig, SandboxSettings, SetupCheckId, WorkflowPatch } from "../src/data/types";
import { agentPalette } from "../src/theme/tokens";
import { Hub } from "./hub";
import type { Inbox } from "./inbox";
import type { Planner } from "./planner";
import type { Sessions } from "./sessions";
import { newAgent } from "./store";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "agent";
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function makeCommands(hub: Hub, sessions: Sessions, planner: Planner, inbox: Inbox) {
  const team = () => hub.snap.config.team;

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    sendTerminalInput: (id, data) => sessions.input(str(id, 80), str(data, 100_000)),
    resizeTerminal: (id, cols, rows) => sessions.resize(str(id, 80), num(cols), num(rows)),
    startAgent: (id) => sessions.start(str(id, 80)),
    stopAgent: (id) => sessions.stop(str(id, 80)),
    openWorkspace: (id) => sessions.openWorkspace(str(id, 80)),
    recreateSandbox: (id) => sessions.recreate(str(id, 80)),
    recheckSetup: () => sessions.recheckSetup(),
    runSetupFix: (id) => sessions.runFix(str(id, 40) as SetupCheckId),

    // You → agent: same delivery path as the lead's assign_task / send_message.
    assignTask: (taskId, agentId) => planner.assign(str(taskId, 40), str(agentId, 80), "you"),
    sendMessage: (toId, text) => planner.message("you", str(toId, 80), str(text, 2000)),

    addAgent: (raw) => {
      const input = (raw ?? {}) as Partial<NewAgentInput>;
      const name = str(input.name, 40).trim() || "Agent";
      let id = slug(name);
      for (let i = 2; team().some((a) => a.id === id); i++) id = `${slug(name)}-${i}`;
      const used = new Set(team().map((a) => a.color));
      const color = agentPalette.find((c) => !used.has(c)) ?? agentPalette[team().length % agentPalette.length];
      const agent = newAgent(id, name, str(input.role, 40).trim() || "Developer", color, false);
      agent.model = str(input.model, 20) || agent.model;
      agent.mode = input.mode === "local" ? "local" : "sandbox";
      const lead = team().find((a) => a.isLead);
      if (lead) agent.sandbox = structuredClone(lead.sandbox);
      team().push(agent);
      const status = Hub.freshStatus(id);
      hub.snap.agents.push(status);
      hub.configChanged();
      hub.emit({ type: "agent.updated", agent: structuredClone(status) });
      hub.activity("config", null, `Added ${agent.name} (${agent.role}). Press Start to launch their session.`);
    },

    updateAgent: (id, patch) => {
      const agent = hub.cfg(str(id));
      if (!agent) return;
      const p = (patch ?? {}) as AgentPatch;
      for (const k of ["name", "role", "model", "color", "roleMd"] as const) if (typeof p[k] === "string") agent[k] = str(p[k], 8000);
      if (p.mode === "sandbox" || p.mode === "local") agent.mode = p.mode;
      if (Array.isArray(p.skills)) agent.skills = p.skills.map((s) => str(s, 60)).filter(Boolean);
      if (p.workspacePath !== undefined) agent.workspacePath = p.workspacePath ? str(p.workspacePath, 500).trim() || null : null;
      hub.configChanged();
    },

    removeAgent: async (id) => {
      const agent = hub.cfg(str(id));
      if (!agent || agent.isLead) return;
      await sessions.stop(agent.id);
      hub.snap.config.team = team().filter((a) => a.id !== agent.id);
      hub.snap.agents = hub.snap.agents.filter((a) => a.agentId !== agent.id);
      inbox.forget(agent.id);
      hub.emit({ type: "agent.removed", agentId: agent.id });
      hub.configChanged();
      hub.activity("config", null, `Removed ${agent.name}. Their folder is kept.`);
    },

    updateSandbox: (id, patch) => {
      // Phase D applies these to sbx; for now they are saved.
      const agent = hub.cfg(str(id));
      if (!agent) return;
      const p = (patch ?? {}) as Partial<SandboxSettings>;
      if (p.policy === "open" || p.policy === "balanced" || p.policy === "locked") agent.sandbox.policy = p.policy;
      if (Array.isArray(p.allow)) agent.sandbox.allow = p.allow.map((d) => str(d, 200));
      if (Array.isArray(p.deny)) agent.sandbox.deny = p.deny.map((d) => str(d, 200));
      if (p.proxy !== undefined) agent.sandbox.proxy = p.proxy ? str(p.proxy, 300) : null;
      if (p.resources) {
        // Same limits as sbx: ≥1 CPU up to the host; 0.5 GB up to 75% of RAM.
        const m = hub.snap.setup.machine;
        const cpus = p.resources.cpus === null ? null : Math.round(Math.min(m.cpus, Math.max(1, num(p.resources.cpus))));
        const maxMem = Math.max(0.5, Math.floor(m.memoryGb * 0.75 * 2) / 2);
        const memoryGb = p.resources.memoryGb === null ? null : Math.min(maxMem, Math.max(0.5, Math.round(num(p.resources.memoryGb) * 2) / 2));
        agent.sandbox.resources = { cpus, memoryGb };
      }
      hub.configChanged();
    },

    setSecret: (id) => {
      hub.activity("config", str(id), "Setting secrets from HQ comes in a later phase. Use `sbx secret set` for now.");
    },
    removeSecret: (id) => {
      hub.activity("config", str(id), "Removing secrets from HQ comes in a later phase. Use `sbx secret rm` for now.");
    },

    updateWorkflow: (patch) => {
      const p = (patch ?? {}) as WorkflowPatch;
      const wf = hub.snap.config.workflow;
      Object.assign(wf.review, p.review ?? {});
      Object.assign(wf.merge, p.merge ?? {});
      Object.assign(wf.deploy, p.deploy ?? {});
      hub.configChanged();
    },

    updateProject: (patch) => {
      const p = (patch ?? {}) as Partial<ProjectConfig>;
      const project = hub.snap.config.project;
      if (typeof p.name === "string" && p.name.trim()) project.name = str(p.name, 80);
      if (typeof p.repo === "string" && p.repo.trim()) project.repo = str(p.repo, 200);
      hub.configChanged();
    },

    createBoard: (title) => planner.createBoard(str(title, 80)),

    updateBoard: (id, patch) => {
      const p = (patch ?? {}) as Partial<Board>;
      const status = p.status === "active" || p.status === "planned" || p.status === "done" ? p.status : undefined;
      planner.updateBoard(str(id, 20), { title: typeof p.title === "string" ? p.title : undefined, status });
    },
  };

  return commands;
}
