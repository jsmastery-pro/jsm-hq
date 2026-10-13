import { agentPalette } from "../../theme/tokens";
import type { OfficeDataSource, OfficeEvent, SimSpeed } from "../source";
import type { AgentConfig, AgentPatch, Board, NewAgentInput, ProjectConfig, SandboxSettings, WorkflowPatch } from "../types";
import { defaultPresetId, presets, type Preset } from "./presets";
import { Simulation } from "./simulation";
import * as T from "./terminalScripts";
import { World } from "./world";

const TICK_MS = 50;
const TERM_MS = 30;

const policyLabel: Record<SandboxSettings["policy"], string> = { open: "Open", balanced: "Balanced", locked: "Locked Down" };

export function createMockSource(): OfficeDataSource {
  let presetId = defaultPresetId;
  let world = new World(findPreset(presetId));
  let sim = new Simulation(world);
  let listener: ((e: OfficeEvent) => void) | null = null;
  let timers: number[] = [];
  let last = 0;
  let inputBuf = new Map<string, string>();

  function findPreset(id: string): Preset {
    return presets.find((p) => p.id === id) ?? presets[0];
  }

  /** Fresh world for the current preset (keeps the speed). */
  function reset() {
    const speed = world.speed;
    world.clearTimers();
    world.setEmitter(null);
    world = new World(findPreset(presetId));
    world.speed = speed;
    sim = new Simulation(world);
    inputBuf = new Map();
  }

  function boot() {
    world.setEmitter((e) => listener?.(e));
    listener?.({ type: "snapshot", snapshot: structuredClone(world.snap) });
    sim.start();
  }

  function loop() {
    const t = performance.now();
    const dt = Math.min(0.25, (t - last) / 1000) * world.speed;
    last = t;
    world.advance(dt);
    sim.tick(dt);
  }

  function hostCmd(agentId: string, text: string) {
    world.write(agentId, [{ text: `\x1b[38;2;102;114;159mhq ▸ ${text}\x1b[0m` }]);
  }

  const source: OfficeDataSource = {
    connect(onEvent) {
      listener = onEvent;
      last = performance.now();
      reset();
      boot();
      timers = [
        window.setInterval(loop, TICK_MS),
        window.setInterval(() => world.flushTerminals(Math.max(1, Math.round(world.speed * 1.3))), TERM_MS),
      ];
      return () => {
        timers.forEach((id) => window.clearInterval(id));
        timers = [];
        world.clearTimers();
        world.setEmitter(null);
        listener = null;
      };
    },

    sendTerminalInput(agentId, data) {
      // Echo printable input; act on Enter.
      let buf = inputBuf.get(agentId) ?? "";
      for (const ch of data) {
        if (ch === "\r") {
          const text = buf.trim();
          buf = "";
          listener?.({ type: "terminal.output", agentId, data: "\r\n" });
          if (!text) continue;
          const st = world.status(agentId);
          if (st?.state === "needs-input") {
            world.after(0.6, () => sim.answer(agentId, "you"));
          } else {
            world.after(1, () => world.write(agentId, T.cannedReply(!!world.cfg(agentId)?.isLead, text.length)));
          }
        } else if (ch === "\x7f") {
          if (buf.length) {
            buf = buf.slice(0, -1);
            listener?.({ type: "terminal.output", agentId, data: "\b \b" });
          }
        } else if (ch >= " ") {
          buf += ch;
          listener?.({ type: "terminal.output", agentId, data: ch });
        }
      }
      inputBuf.set(agentId, buf);
    },

    assignTask(taskId, agentId) {
      const task = world.task(taskId);
      const agent = world.cfg(agentId);
      if (!task || !agent || agent.isLead || task.status !== "todo") return;
      world.patchTask(taskId, { ownerId: agentId });
      world.activity("task.assigned", null, `You assigned ${taskId} ${task.title} to ${agent.name}`);
      if (!sim.hasJob(agentId) && world.status(agentId)?.state === "idle") {
        world.message(world.lead().id, agentId, `Pull main, start ${taskId}.`);
        world.after(1, () => sim.begin(agentId, taskId), agentId);
      }
    },

    addAgent(input: NewAgentInput) {
      const team = world.snap.config.team;
      const base = T.slug(input.name) || "agent";
      let id = base;
      for (let i = 2; team.some((a) => a.id === id); i++) id = `${base}-${i}`;
      const used = new Set(team.map((a) => a.color));
      const color = agentPalette.find((c) => !used.has(c)) ?? agentPalette[team.length % agentPalette.length];
      const lead = world.lead();
      const agent: AgentConfig = {
        id, name: input.name.trim() || "Agent", role: input.role.trim() || "Developer", isLead: false,
        model: input.model, mode: input.mode, color, skills: ["plan", "review"],
        roleMd: `# ${input.name} — ${input.role}\n\nYou build the tasks assigned to you.`,
        sandbox: structuredClone(lead.sandbox),
      };
      team.push(agent);
      world.snap.agents.push({ agentId: id, state: "idle", currentTaskId: null, stateSince: new Date().toISOString(), note: null });
      world.configChanged();
      world.emit({ type: "agent.updated", agent: { ...world.snap.agents[world.snap.agents.length - 1] } });
      world.syncEnvironments();
      world.activity("config", null, `Added ${agent.name} (${agent.role}) — new sandbox starting`);
      world.write(id, T.banner(agent.name, agent.role, world.snap.config.project.repo, agent.mode));
      hostCmd(id, `sbx run claude · policy ${policyLabel[agent.sandbox.policy]} · allow host.docker.internal:${world.snap.config.project.hqPort}`);
      sim.startWorker(id, 2);
    },

    updateAgent(id, patch: AgentPatch) {
      const agent = world.cfg(id);
      if (!agent) return;
      Object.assign(agent, patch);
      world.configChanged();
    },

    removeAgent(id) {
      const agent = world.cfg(id);
      if (!agent || agent.isLead) return;
      sim.stopAgent(id);
      world.snap.config.team = world.snap.config.team.filter((a) => a.id !== id);
      world.snap.agents = world.snap.agents.filter((a) => a.agentId !== id);
      for (const t of world.snap.tasks)
        if (t.ownerId === id && t.status !== "done") world.patchTask(t.id, { ownerId: null, status: t.status === "in-progress" ? "todo" : t.status });
      world.emit({ type: "agent.removed", agentId: id });
      world.configChanged();
      world.syncEnvironments();
      world.activity("config", null, `Removed ${agent.name} — sandbox stopped`);
    },

    updateSandbox(agentId, patch: Partial<SandboxSettings>) {
      const agent = world.cfg(agentId);
      if (!agent) return;
      Object.assign(agent.sandbox, structuredClone(patch));
      world.configChanged();
      if (patch.policy) hostCmd(agentId, `sbx policy set ${patch.policy}`);
      if (patch.allow) hostCmd(agentId, `sbx policy allow network ${patch.allow.join(" ") || "(none)"}`);
      if (patch.deny) hostCmd(agentId, `sbx policy deny network ${patch.deny.join(" ") || "(none)"}`);
      if (patch.proxy !== undefined) hostCmd(agentId, patch.proxy ? `upstream proxy → ${patch.proxy}` : "upstream proxy off");
      world.activity("config", agentId, `Updated ${agent.name}'s sandbox settings`);
    },

    setSecret(agentId, name, value) {
      const agent = world.cfg(agentId);
      const key = name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (!agent || !key) return;
      void value; // A real source passes this to `sbx secret set`; HQ never keeps it.
      if (!agent.sandbox.secrets.includes(key)) agent.sandbox.secrets.push(key);
      world.configChanged();
      hostCmd(agentId, `sbx secret set ${key} (value sent to Docker's secret store)`);
      world.activity("config", agentId, `Set secret ${key} for ${agent.name}`);
    },

    removeSecret(agentId, name) {
      const agent = world.cfg(agentId);
      if (!agent) return;
      agent.sandbox.secrets = agent.sandbox.secrets.filter((s) => s !== name);
      world.configChanged();
      hostCmd(agentId, `sbx secret rm ${name}`);
    },

    updateWorkflow(patch: WorkflowPatch) {
      const wf = world.snap.config.workflow;
      Object.assign(wf.review, patch.review);
      Object.assign(wf.merge, patch.merge);
      Object.assign(wf.deploy, patch.deploy);
      world.configChanged();
      world.syncEnvironments();
      sim.workflowChanged();
      world.activity("config", null, "Workflow updated");
    },

    updateProject(patch: Partial<ProjectConfig>) {
      Object.assign(world.snap.config.project, patch);
      world.configChanged();
      world.syncEnvironments();
    },

    createBoard(title) {
      const clean = title.trim();
      if (!clean) return;
      const base = clean.split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 3) || "B";
      let id = base;
      for (let i = 2; world.snap.boards.some((b) => b.id === id); i++) id = `${base}${i}`;
      const board: Board = { id, title: clean, status: "planned", order: world.snap.boards.length };
      world.snap.boards.push(board);
      world.emit({ type: "board.updated", board: { ...board } });
      world.activity("config", null, `Created board ${clean}`);
    },

    updateBoard(id, patch) {
      const board = world.snap.boards.find((b) => b.id === id);
      if (!board) return;
      Object.assign(board, patch);
      world.emit({ type: "board.updated", board: { ...board } });
    },

    dev: {
      presets: presets.map((p) => ({ id: p.id, label: p.label })),
      loadPreset(id) {
        presetId = id;
        reset();
        boot();
      },
      setSpeed(multiplier: SimSpeed) {
        world.speed = multiplier;
      },
    },
  };

  return source;
}
